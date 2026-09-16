import { NextResponse } from "next/server";
import { obtenerSql, conReintentos, type SqlNeon } from "../../../lib/db";
import { respuestaDeError, verificarPinAdmin } from "../../../lib/http";
import { VALORES_SUCURSALES, VALORES_PROVEEDORES } from "../../../lib/sucursales";
import { LONGITUD_MAX_BUSQUEDA } from "../../../lib/validacion";

// Listas blancas de valores permitidos: cualquier valor fuera de estas listas se descarta.
// SIN_ASIGNAR representa las transacciones crudas del worker (columna 'ciudad' aún nula).
const SUCURSALES_VALIDAS = new Set(VALORES_SUCURSALES.map((s) => s.toUpperCase()));
const ESTADOS_VALIDOS = new Set(["VERIFICADO", "PENDIENTE"]);
const PROVEEDORES_VALIDOS = new Set(VALORES_PROVEEDORES);
const FORMATO_FECHA = /^\d{4}-\d{2}-\d{2}$/;
const LIMITE_MAXIMO = 100;

// Escapa los comodines de LIKE para que la búsqueda sea literal (un "%" del usuario no barre toda la tabla)
function escaparLike(texto: string): string {
  return texto.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// 📄 Lee y valida los parámetros de paginación, fechas, sucursal, estado y búsqueda
function extraerFiltros(searchParams: URLSearchParams) {
  const page = Math.max(1, Number.parseInt(searchParams.get("page") || "1", 10) || 1);
  const limit = Math.min(LIMITE_MAXIMO, Math.max(1, Number.parseInt(searchParams.get("limit") || "20", 10) || 20));

  const fechaInicioParam = searchParams.get("fechaInicio") || "";
  const fechaFinParam = searchParams.get("fechaFin") || "";

  const sucursalParam = (searchParams.get("sucursal") || "TODAS").toUpperCase();
  const estadoParam = (searchParams.get("estado") || "TODOS").toUpperCase();
  const proveedorParam = (searchParams.get("proveedor") || "TODOS").toUpperCase();

  return {
    page,
    limit,
    offset: (page - 1) * limit,
    fechaInicio: FORMATO_FECHA.test(fechaInicioParam) ? fechaInicioParam : "",
    fechaFin: FORMATO_FECHA.test(fechaFinParam) ? fechaFinParam : "",
    sucursal: SUCURSALES_VALIDAS.has(sucursalParam) || sucursalParam === "SIN_ASIGNAR" ? sucursalParam : "",
    estado: ESTADOS_VALIDOS.has(estadoParam) ? estadoParam : "",
    proveedor: PROVEEDORES_VALIDOS.has(proveedorParam) ? proveedorParam : "",
    comanda: (searchParams.get("comanda") || "").trim().slice(0, LONGITUD_MAX_BUSQUEDA),
    monto: (searchParams.get("monto") || "").trim().slice(0, LONGITUD_MAX_BUSQUEDA),
    referencia: (searchParams.get("referencia") || "").trim().slice(0, LONGITUD_MAX_BUSQUEDA),
    exportarTodo: searchParams.get("exportar") === "true",
  };
}

type Filtros = ReturnType<typeof extraerFiltros>;
// 🛠️ Construye la cláusula de filtrado (siempre con parámetros, nunca concatenando texto)
function construirClausulaWhere(sql: SqlNeon, filtros: Filtros) {
  let clausulaWhere = sql`WHERE 1=1`;

  // Filtro por Calendario (día completo UTC) — sobre la fecha real del pago según Binance;
  // las filas anteriores a la columna fecha_pago usan su fecha de inserción como respaldo.
  // Cada extremo se aplica por separado: antes se exigían ambos, así que poner solo "Desde"
  // no filtraba nada y el usuario no tenía forma de notarlo.
  if (filtros.fechaInicio) {
    clausulaWhere = sql`${clausulaWhere} AND COALESCE(fecha_pago, created_at) >= ${filtros.fechaInicio + " 00:00:00"}`;
  }
  if (filtros.fechaFin) {
    // Límite superior exclusivo (< día siguiente) en vez de 23:59:59: así entran también
    // los milisegundos del último segundo del día, que antes quedaban fuera.
    clausulaWhere = sql`${clausulaWhere} AND COALESCE(fecha_pago, created_at) < (${filtros.fechaFin}::date + interval '1 day')`;
  }

  // Filtro por Sucursal / Ciudad (SIN_ASIGNAR = transacciones crudas que el cajero aún no reclamó)
  if (filtros.sucursal === "SIN_ASIGNAR") {
    clausulaWhere = sql`${clausulaWhere} AND ciudad IS NULL`;
  } else if (filtros.sucursal) {
    clausulaWhere = sql`${clausulaWhere} AND UPPER(ciudad) = ${filtros.sucursal}`;
  }

  // Filtro por Estado de la transacción
  if (filtros.estado) {
    clausulaWhere = sql`${clausulaWhere} AND estado = ${filtros.estado}`;
  }

  // Filtro por proveedor de pago (Binance Pay / Pago Móvil BDV / Sofitasa / Bancamiga)
  if (filtros.proveedor) {
    clausulaWhere = sql`${clausulaWhere} AND proveedor = ${filtros.proveedor}`;
  }

  // Filtro puntual por comanda (N° de venta), parcial y sin distinguir mayúsculas.
  if (filtros.comanda) {
    const patron = `%${escaparLike(filtros.comanda)}%`;
    clausulaWhere = sql`${clausulaWhere} AND comanda ILIKE ${patron}`;
  }

  // Filtro puntual por monto exacto. Admite coma decimal (ej. "6,15"); si el término
  // no es numérico, montoBuscado queda NULL y la condición nunca coincide.
  if (filtros.monto) {
    const montoBuscado = /^\d+([.,]\d+)?$/.test(filtros.monto)
      ? filtros.monto.replace(",", ".")
      : null;
    clausulaWhere = sql`${clausulaWhere} AND monto = ${montoBuscado}::numeric`;
  }

  // Filtro puntual por referencia: ID de orden de Binance, referencia P_..., TXID o
  // referencia de pago móvil (BDV/Sofitasa/Bancamiga), parcial y sin distinguir mayúsculas.
  if (filtros.referencia) {
    const patron = `%${escaparLike(filtros.referencia)}%`;
    clausulaWhere = sql`${clausulaWhere} AND (id_orden ILIKE ${patron} OR binance_id_completo ILIKE ${patron} OR txid ILIKE ${patron} OR referencia ILIKE ${patron})`;
  }

  return clausulaWhere;
}

export async function GET(request: Request) {
  try {
    // 🔒 1. CONTROL DE ACCESO POR PIN
    const rechazo = await verificarPinAdmin(request, "Auditoría");
    if (rechazo) return rechazo;

    // 📄 2. PARÁMETROS Y CLÁUSULA DE FILTRADO
    const { searchParams } = new URL(request.url);
    const filtros = extraerFiltros(searchParams);
    const { page, limit, offset, exportarTodo } = filtros;

    const sql = obtenerSql();
    const clausulaWhere = construirClausulaWhere(sql, filtros);

    // 📊 3. MÉTRICAS Y CONTEO EN UNA SOLA CONSULTA (un único viaje a la base de datos
    // en lugar de tres: menos latencia y menos oportunidades de timeout de red)
    // Las transacciones anuladas (ej: devolución por cancelación del cliente) quedan FUERA
    // de los totales de dinero: sumarlas como venta buena era justo el problema — la nota
    // explicaba la devolución pero ninguna métrica la leía. Se reportan aparte para que el
    // dinero devuelto siga siendo visible y auditable, no simplemente oculto.
    //
    // Los totales van por moneda y NUNCA se suman entre sí: los pagos de Binance llegan en
    // USDT y los pagos móviles en bolívares, así que una sola cifra combinada no
    // representaría ninguna cantidad real de dinero. Convertirlos a una moneda común
    // exigiría una tasa de cambio y una política contable que hoy no existen.
    const [metricasResult] = await conReintentos(() => sql`
      SELECT
        COALESCE(SUM(monto) FILTER (WHERE estado = 'VERIFICADO' AND moneda = 'USDT' AND NOT anulada), 0) AS total_reclamado,
        COALESCE(SUM(monto) FILTER (WHERE estado = 'PENDIENTE' AND moneda = 'USDT' AND NOT anulada), 0) AS total_pendiente,
        COALESCE(SUM(monto) FILTER (WHERE moneda = 'USDT' AND anulada), 0) AS total_anulado,
        COALESCE(SUM(monto) FILTER (WHERE estado = 'VERIFICADO' AND moneda = 'VES' AND NOT anulada), 0) AS total_reclamado_ves,
        COALESCE(SUM(monto) FILTER (WHERE estado = 'PENDIENTE' AND moneda = 'VES' AND NOT anulada), 0) AS total_pendiente_ves,
        COALESCE(SUM(monto) FILTER (WHERE moneda = 'VES' AND anulada), 0) AS total_anulado_ves,
        -- Por moneda y no por proveedor: BDV, Sofitasa y Bancamiga son los tres pago
        -- móvil en bolívares, y este conteo decide si el panel muestra el bloque de
        -- métricas VES — contarlo solo por BDV lo ocultaría en una tienda que solo
        -- cobrara por Sofitasa o Bancamiga, pese a tener dinero real en bolívares.
        COUNT(*) FILTER (WHERE moneda = 'VES') AS registros_pago_movil,
        COUNT(*) FILTER (WHERE anulada) AS registros_anulados,
        COUNT(*) AS total_registros
      FROM transacciones ${clausulaWhere};
    `);

    // La agregación siempre devuelve una fila; si no llegara ninguna es un fallo real
    // de la consulta y se propaga al catch en vez de romper con un TypeError opaco.
    if (!metricasResult) {
      throw new Error("La consulta de métricas no devolvió resultados.");
    }

    const totalReclamado = Number.parseFloat(metricasResult.total_reclamado) || 0;
    const totalPendiente = Number.parseFloat(metricasResult.total_pendiente) || 0;
    const totalAnulado = Number.parseFloat(metricasResult.total_anulado) || 0;
    const totalReclamadoVES = Number.parseFloat(metricasResult.total_reclamado_ves) || 0;
    const totalPendienteVES = Number.parseFloat(metricasResult.total_pendiente_ves) || 0;
    const totalAnuladoVES = Number.parseFloat(metricasResult.total_anulado_ves) || 0;
    const registrosPagoMovil = Number.parseInt(metricasResult.registros_pago_movil, 10) || 0;
    const registrosAnulados = Number.parseInt(metricasResult.registros_anulados, 10) || 0;
    const totalTransaccionesGlobales = Number.parseInt(metricasResult.total_registros, 10) || 0;
    const totalPages = Math.max(1, Math.ceil(totalTransaccionesGlobales / limit));

    // 📋 4. OBTENCIÓN DE REGISTROS
    // La exportación trae el rango completo filtrado y omite la imagen base64 (payload pesado que el CSV no usa)
    let transacciones: Record<string, unknown>[];
    if (exportarTodo) {
      // AT TIME ZONE 'UTC' devuelve las fechas como instantes UTC inequívocos: sin ello,
      // el driver interpreta los timestamp sin zona según la hora local del servidor Node
      // (distinta en desarrollo y en producción) y las fechas llegan corridas al panel.
      transacciones = await conReintentos(() => sql`
        SELECT id, id_orden, comanda, nota, anulada, monto, moneda, binance_id_completo, txid, pagador, estado, ciudad,
               proveedor, referencia, banco_origen,
               fecha_pago AT TIME ZONE 'UTC' AS fecha_pago,
               created_at AT TIME ZONE 'UTC' AS created_at
        FROM transacciones
        ${clausulaWhere}
        ORDER BY COALESCE(fecha_pago, created_at) DESC;
      `);
    } else {
      // La foto del comprobante NUNCA viaja en esta lista: pesa ~100 KB en promedio y esta
      // consulta se repite cada 15s por el auto-refresco del panel, lo que multiplicaba el
      // tráfico de salida (Fast Origin Transfer de Vercel) sin necesidad — nadie mira las 20
      // fotos de la página en cada recarga. Solo se indica si existe; la foto real se trae
      // bajo demanda desde /api/admin/transacciones/[id]/imagen cuando el admin pulsa "Ver".
      transacciones = await conReintentos(() => sql`
        SELECT id, id_orden, comanda, nota, anulada, monto, moneda, binance_id_completo, txid, pagador, estado, ciudad,
               proveedor, referencia, banco_origen,
               fecha_pago AT TIME ZONE 'UTC' AS fecha_pago,
               created_at AT TIME ZONE 'UTC' AS created_at,
               (imagen_comprobante_base64 IS NOT NULL) AS tiene_comprobante
        FROM transacciones
        ${clausulaWhere}
        ORDER BY COALESCE(fecha_pago, created_at) DESC
        LIMIT ${limit} OFFSET ${offset};
      `);
    }

    return NextResponse.json({
      transacciones,
      metricas: {
        totalReclamadoUSDT: totalReclamado,
        totalPendienteUSDT: totalPendiente,
        totalAnuladoUSDT: totalAnulado,
        totalDineroFlujoUSDT: totalReclamado + totalPendiente,
        // Bolívares (Pago Móvil BDV / Sofitasa / Bancamiga), reportados aparte por las
        // razones de la consulta
        totalReclamadoVES,
        totalPendienteVES,
        totalAnuladoVES,
        totalDineroFlujoVES: totalReclamadoVES + totalPendienteVES,
        registrosPagoMovil,
        registrosAnulados
      },
      paginacion: {
        page,
        limit,
        totalPages,
        totalTransaccionesGlobales
      }
    }, { status: 200 });

  } catch (error) {
    return respuestaDeError(error, {
      contexto: "Auditoría",
      mensajeGenerico: "Fallo interno al procesar los registros contables.",
      mensajeConexion: "⚠️ No se pudo conectar con la base de datos (fallo temporal de red). Inténtalo de nuevo en unos segundos.",
    });
  }
}
