import { NextResponse } from "next/server";
import { obtenerSql, conReintentos, esErrorDeConexion } from "../../../lib/db";
import { VALORES_SUCURSALES, MONEDA_BDV } from "../../../lib/sucursales";
import { peticionDeCajeroValida } from "../../../lib/token-cajero";
import { notificarPagoVerificado } from "../../../lib/telegram";
import { buscarPagoEnMovimientos, confirmarMovimientoDelExtracto, importeANumero, digitosAComparar } from "../../../lib/proveedores/bdv";
import { normalizarImporte } from "../../../lib/proveedores/prompts";
import { distanciaReferencias, sufijoReferencia } from "../../../lib/proveedores/referencias";
import { credencialesDeSucursal } from "../../../lib/proveedores/cuentas-bdv";
import { LONGITUD_MAX_COMANDA } from "../../../lib/validacion";
import { comoTexto } from "../../../lib/http";
import { LONGITUD_MAX_IMAGEN } from "../../../lib/imagenes";
import { obtenerConfigSistema } from "../../../lib/config-sistema";

// Conciliación de Pagos Móviles del Banco de Venezuela.
//
// Binance funciona en modo *push*: un worker descubre el pago, el webhook inserta una fila
// PENDIENTE y validar consiste en reclamarla. Aquí es al revés: el cajero pregunta. Se
// descargan los movimientos del día de la cuenta del negocio y se busca el pago del
// comprobante entre ellos. Si el crédito está, el dinero entró, y la fila nace ya
// VERIFICADO — el extracto bancario ocupa el lugar que en Binance ocupa el worker.
//
// El cajero solo aporta tres datos del comprobante: monto, fecha y referencia. El teléfono,
// la cédula y el banco del pagador los publica el propio banco en cada movimiento, así que
// no hay que pedírselos al cliente ni arriesgarse a que la IA lea los del beneficiario.

interface EntradaValida {
  comanda: string;
  ciudad: string;
  imagen: string;
  fechaCajero: string;
  referencia: string;
  importe: number;
  fechaPago: string;
}

function validarEntrada(body: Record<string, unknown>): { ok: true; datos: EntradaValida } | { ok: false; mensaje: string } {
  // Comanda obligatoria: cada pago verificado debe quedar amarrado a una venta del negocio.
  const comanda = comoTexto(body.comanda).trim().slice(0, LONGITUD_MAX_COMANDA);
  if (!comanda) {
    return { ok: false, mensaje: "⚠️ Introduce el Número de Venta / Comanda para poder validar el pago." };
  }

  // Sucursal contra la lista oficial: evita registros con ciudades mal escritas
  // que después no aparecen en los filtros del panel administrativo.
  const ciudad = comoTexto(body.ciudad).trim();
  if (!VALORES_SUCURSALES.includes(ciudad)) {
    return { ok: false, mensaje: "⚠️ Sucursal no reconocida. Selecciona una sucursal válida de la lista." };
  }

  // Comprobante fotográfico obligatorio, igual que en el flujo de Binance: es la evidencia
  // que respalda el cobro si mañana se discute.
  const imagen = comoTexto(body.imagen_comprobante);
  if (!imagen.startsWith("data:image/")) {
    return { ok: false, mensaje: "⚠️ Es obligatorio adjuntar el escaneo del comprobante." };
  }
  if (imagen.length > LONGITUD_MAX_IMAGEN) {
    return { ok: false, mensaje: "⚠️ La imagen del comprobante es demasiado pesada. Vuelve a escanearla." };
  }

  // La referencia se compara por sus últimos 8 dígitos (es como el BDV la almacena), pero
  // se exigen al menos 6 para que identifique un pago y no medio extracto.
  const referencia = comoTexto(body.referencia).replace(/\D/g, "");
  if (referencia.length < 6 || referencia.length > 20) {
    return { ok: false, mensaje: "⚠️ La referencia del pago debe tener entre 6 y 20 dígitos." };
  }

  // 'importe' llega del OCR o lo teclea el cajero a mano; puede venir en cualquiera de los
  // dos formatos ("1.234,56" o "1,234.56"), así que se parsea con normalizarImporte (la
  // misma función que usa el escáner) y NO con importeANumero, que asume siempre coma
  // decimal/formato venezolano — correcto para leer el extracto del banco más abajo, pero
  // interpretaba mal un monto tecleado en formato estadounidense.
  const importeTexto = normalizarImporte(comoTexto(body.importe));
  const importe = importeTexto !== null ? Number.parseFloat(importeTexto) : NaN;
  if (!Number.isFinite(importe) || importe <= 0) {
    return { ok: false, mensaje: "⚠️ El monto del pago no es válido. Verifica la cifra del comprobante." };
  }

  const fechaPago = comoTexto(body.fecha_pago).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaPago)) {
    return { ok: false, mensaje: "⚠️ La fecha del pago debe tener el formato AAAA-MM-DD." };
  }

  // Fecha del cajero: si no llega o es inválida, se usa la hora del servidor
  const fechaCruda = comoTexto(body.fecha_cajero);
  const fechaCajero = !Number.isNaN(Date.parse(fechaCruda)) ? new Date(fechaCruda).toISOString() : new Date().toISOString();

  return { ok: true, datos: { comanda, ciudad, imagen, fechaCajero, referencia, importe, fechaPago } };
}

export async function POST(request: Request) {
  console.log("🚀 [BDV] Petición de verificación de Pago Móvil recibida.");

  try {
    // 🔒 1. Solo desde el panel del cajero (cookie firmada) o scripts internos con el token.
    // Este endpoint escribe en el libro contable y consume cuota de la API del banco.
    if (!(await peticionDeCajeroValida(request))) {
      console.warn("⚠️ [BDV] Petición rechazada: sin credencial de cajero.");
      return NextResponse.json({ message: "Acceso no autorizado." }, { status: 403 });
    }

    const body = await request.json().catch(() => null);
    if (!body) {
      return NextResponse.json({ message: "Cuerpo de petición inválido." }, { status: 400 });
    }

    const entrada = validarEntrada(body);
    if (entrada.ok === false) {
      return NextResponse.json({ message: entrada.mensaje }, { status: 400 });
    }
    const { comanda, ciudad, imagen, fechaCajero, referencia, importe, fechaPago } = entrada.datos;

    const sql = obtenerSql();

    // 🚨 2. FRENO DE MANO DE EMERGENCIA (mismo interruptor que el flujo de Binance)
    const config = await obtenerConfigSistema();
    if (!config.sistemaActivo) {
      return NextResponse.json({ message: config.mensajeBloqueo || "Sistema suspendido." }, { status: 503 });
    }

    // 🏦 3. CUENTA QUE LE CORRESPONDE A LA SUCURSAL
    // El negocio tiene dos cuentas BDV y cada sucursal cobra contra una de ellas. Se
    // resuelve antes de tocar el extracto porque de aquí en adelante todo depende de ella:
    // qué cuenta se consulta, contra qué filas se comprueba el duplicado y qué queda escrito.
    const cuentaSucursal = credencialesDeSucursal(ciudad);
    if (cuentaSucursal.ok === false) {
      // Es un fallo de configuración, no del cajero ni del pago. 503 y no 400: reintentar
      // con otros datos no arregla nada, pero sí lo arregla el administrador.
      console.error(`❌ [BDV] Sucursal sin cuenta utilizable: ${cuentaSucursal.detalle}`);
      return NextResponse.json({ message: cuentaSucursal.mensaje }, { status: 503 });
    }
    const credenciales = cuentaSucursal.credenciales;

    // 🛡️ 4. DUPLICADO EVIDENTE, ANTES DE DESCARGAR EL EXTRACTO
    // El riesgo real: el cliente enseña la misma captura en dos sucursales. Se comprueba
    // aquí para no descargar los movimientos del día por un comprobante ya cobrado y, sobre
    // todo, para decirle al cajero exactamente dónde se usó. Se compara por los últimos 8
    // dígitos porque la fila guarda la referencia completa del banco (13 dígitos) mientras
    // que el cajero teclea la de su comprobante. La carrera entre dos cajeros simultáneos
    // la resuelve el ON CONFLICT del paso 6.
    //
    // Acotado a la cuenta de la sucursal: la referencia la genera el banco del pagador, no
    // el nuestro, así que la misma puede aparecer en las dos cuentas sin ser el mismo pago.
    // Sin este filtro, un cobro legítimo en Maracaibo se rechazaría por uno de Caracas.
    const sufijo = referencia.slice(-digitosAComparar(referencia));
    const [yaCobrado] = await conReintentos(() => sql`
      SELECT comanda, ciudad
      FROM transacciones
      WHERE proveedor = 'BDV' AND cuenta_bdv = ${credenciales.clave} AND referencia LIKE ${"%" + sufijo}
      LIMIT 1;
    `);

    if (yaCobrado) {
      return NextResponse.json({
        message: `❌ Este pago móvil YA fue validado anteriormente en la sucursal de: ${yaCobrado.ciudad} (Comanda: ${yaCobrado.comanda || "Sin ID"}). No se puede duplicar.`
      }, { status: 409 });
    }

    // 🏦 5. BÚSQUEDA EN EL EXTRACTO DEL DÍA — aquí se comprueba que el dinero entró.
    //
    // Si el cajero ya eligió un movimiento entre los candidatos que se le ofrecieron, llega
    // 'referencia_banco' y se busca ese en concreto. Se vuelve a consultar al banco en vez
    // de aceptar lo que trae la petición: el segundo paso no puede ser una vía para
    // registrar un pago que el extracto no respalda.
    const referenciaBancoConfirmada = comoTexto(body.referencia_banco).trim();
    const resultado = referenciaBancoConfirmada
      ? await confirmarMovimientoDelExtracto(referenciaBancoConfirmada, importe, fechaPago, credenciales)
      : await buscarPagoEnMovimientos(referencia, importe, fechaPago, credenciales);

    if (resultado.estado === "SIN_RESPUESTA") {
      // El banco no contestó o no está configurado: es transitorio y reintentable, igual
      // que un fallo de red contra la base de datos. No se registra nada.
      console.warn(`⚠️ [BDV] Sin respuesta del banco: ${resultado.detalle}`);
      return NextResponse.json({ message: resultado.mensaje }, { status: 503 });
    }

    if (resultado.estado === "MONTO_DISTINTO") {
      // La referencia existe pero por otro monto. Se separa del "no encontrado" porque la
      // acción del cajero es distinta: no tiene que buscar otro comprobante, tiene que
      // corregir la cifra — y el mensaje ya le dice cuál registró el banco.
      console.log(`🚫 [BDV] Referencia ${sufijo} hallada con otro monto (banco: ${resultado.montoBanco}).`);
      return NextResponse.json({ message: resultado.mensaje }, { status: 409 });
    }

    // La referencia no está en el extracto, pero sí hay pagos por el monto exacto. Ocurre
    // con los pagos BDV a BDV, que el extracto numera con una referencia interna propia.
    // No se elige por el sistema ni cuando hay un solo candidato: el monto se repite entre
    // pagos distintos el mismo día en el 10,8% de los casos, y esto es un libro contable.
    if (resultado.estado === "CANDIDATOS_POR_MONTO") {
      console.log(`❓ [BDV] Referencia ${sufijo} no hallada; ${resultado.candidatos.length} pago(s) por Bs. ${importe.toFixed(2)} para confirmar.`);

      // A cada candidato se le mide cuánto se parece su referencia a la escaneada. El
      // escáner falla de vez en cuando un dígito al leer la foto de una pantalla, y sin
      // esta pista el cajero ve una referencia que no se parece a la suya y no se atreve a
      // confirmar el pago correcto. Se ordenan de más parecido a menos, pero ninguno se
      // elige solo: sigue haciendo falta que una persona lo confirme.
      const candidatos = resultado.candidatos
        .map(({ movimiento, pagador }) => ({
          referenciaBanco: movimiento.referencia,
          hora: movimiento.hora ?? null,
          monto: importeANumero(movimiento.importe),
          pagador: pagador.nombrePagador,
          identificacion: pagador.cedulaPagador ?? pagador.telefonoPagador,
          bancoOrigen: pagador.bancoOrigen,
          // Se comparan las colas del mismo largo, que es como se cruza el pago
          correcciones: distanciaReferencias(sufijo, sufijoReferencia(movimiento.referencia, sufijo.length)),
        }))
        .sort((a, b) => a.correcciones - b.correcciones);

      return NextResponse.json({
        message: candidatos.length === 1
          ? "No encontré esa referencia, pero sí un pago por el monto exacto. Comprueba que sea el del cliente y confírmalo."
          : `No encontré esa referencia, pero hay ${candidatos.length} pagos por el monto exacto. Elige cuál es el del cliente.`,
        // Solo lo que el cajero necesita para reconocer el pago; el resto del movimiento
        // no sale del servidor.
        candidatos,
      }, { status: 409 });
    }

    if (resultado.estado === "NO_ENCONTRADO") {
      console.log(`🚫 [BDV] Referencia ${sufijo} no aparece entre los ${resultado.movimientosRevisados} movimientos del ${fechaPago}.`);
      return NextResponse.json({ message: resultado.mensaje }, { status: 404 });
    }

    const { movimiento, pagador } = resultado;

    // 💾 6. REGISTRO DEL PAGO YA CONFIRMADO
    // Nace VERIFICADO y con sucursal asignada: a diferencia de Binance, no hay una etapa
    // PENDIENTE previa porque nadie descubrió este pago antes que el cajero.
    //
    // Se guarda la referencia COMPLETA del banco (no la que tecleó el cajero): es la forma
    // canónica y única, y es sobre ella que actúa el índice de la migración 004. El
    // ON CONFLICT resuelve la carrera: si dos cajeros validan el mismo comprobante a la vez,
    // ambos pueden pasar el paso 3 y ambos lo encuentran en el extracto —el banco no sabe
    // nada de nuestras ventas—, pero solo uno consigue insertar.
    const montoBanco = importeANumero(movimiento.importe) ?? importe;
    const [registrada] = await sql`
      INSERT INTO transacciones (
        proveedor, cuenta_bdv, referencia, banco_origen, telefono_pagador, telefono_destino, cedula_pagador,
        pagador, bdv_raw, monto, moneda, estado, comanda, ciudad, imagen_comprobante_base64,
        fecha_cajero, fecha_validacion, fecha_pago
      ) VALUES (
        'BDV',
        ${credenciales.clave},
        ${movimiento.referencia},
        ${pagador.bancoOrigen},
        ${pagador.telefonoPagador},
        ${credenciales.telefonoDestino},
        ${pagador.cedulaPagador},
        ${pagador.nombrePagador},
        ${JSON.stringify(movimiento)}::jsonb,
        ${montoBanco},
        ${MONEDA_BDV},
        'VERIFICADO',
        ${comanda},
        ${ciudad},
        ${imagen},
        ${fechaCajero},
        ${new Date().toISOString()},
        ${movimiento.fecha}
      )
      ON CONFLICT (COALESCE(cuenta_bdv, 'SIN_CUENTA'), referencia)
        WHERE proveedor = 'BDV' AND referencia IS NOT NULL DO NOTHING
      RETURNING id;
    `;

    if (!registrada) {
      // Otro cajero registró este mismo comprobante entre la comprobación y el INSERT
      const [ganador] = await sql`
        SELECT comanda, ciudad FROM transacciones
        WHERE proveedor = 'BDV' AND cuenta_bdv = ${credenciales.clave} AND referencia = ${movimiento.referencia}
        LIMIT 1;
      `;
      return NextResponse.json({
        message: `❌ Este pago móvil acaba de ser validado por otro cajero en: ${ganador?.ciudad || "otra sucursal"} (Comanda: ${ganador?.comanda || "Sin ID"}). No se puede duplicar.`
      }, { status: 409 });
    }

    console.log(`✅ [BDV/${credenciales.clave}] Pago ${movimiento.referencia} hallado en el extracto y registrado como transacción ${registrada.id}.`);

    // 📨 7. NOTIFICACIÓN AL GRUPO DE TELEGRAM (best-effort, nunca bloquea ni falla el registro)
    // Se espera aquí —y no en segundo plano— porque el runtime serverless puede congelar
    // la función apenas se envía la respuesta, cortando cualquier fetch pendiente.
    const notificacion = await notificarPagoVerificado({
      comanda,
      monto: montoBanco,
      moneda: MONEDA_BDV,
      ciudad,
      imagenBase64: imagen,
      proveedor: "Pago Móvil BDV",
      referencia: movimiento.referencia,
    });

    if (notificacion.enviada === false) {
      console.warn(`⚠️ [BDV] Pago ${registrada.id} verificado pero sin aviso a Telegram (${notificacion.motivo}): ${notificacion.detalle}`);
    }

    // Los datos del pagador vuelven al cajero para que pueda contrastarlos con el
    // comprobante que tiene delante: es la comprobación final de que cruzó el pago correcto.
    return NextResponse.json({
      message: notificacion.enviada
        ? "¡Pago móvil confirmado en el banco y registrado con éxito!"
        : "¡Pago móvil confirmado en el banco y registrado con éxito! (No se pudo enviar el aviso al grupo de Telegram.)",
      notificacionTelegram: notificacion.enviada,
      pago: {
        referencia: movimiento.referencia,
        monto: montoBanco,
        hora: movimiento.hora ?? null,
        pagador: pagador.nombrePagador,
        identificacion: pagador.cedulaPagador ?? pagador.telefonoPagador,
      },
    }, { status: 200 });

  } catch (error) {
    // El detalle queda en el log del servidor; al cliente no se le expone el error interno
    console.error("❌ [BDV] Error en la verificación:", error);

    if (esErrorDeConexion(error)) {
      return NextResponse.json(
        { message: "⚠️ Fallo temporal de conexión con la base de datos. Inténtalo de nuevo en unos segundos." },
        { status: 503 }
      );
    }

    return NextResponse.json({ message: "Error interno en el servidor." }, { status: 500 });
  }
}
