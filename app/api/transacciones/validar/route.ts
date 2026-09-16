import { NextResponse } from "next/server";
import { obtenerSql, conReintentos, esErrorDeConexion } from "../../../lib/db";
import { VALORES_SUCURSALES, MONEDAS_BINANCE, SUFIJO_ID_MIN, SUFIJO_ID_MAX } from "../../../lib/sucursales";
import { peticionDeCajeroValida } from "../../../lib/token-cajero";
import { notificarPagoVerificado } from "../../../lib/telegram";
import { obtenerConfigSistema } from "../../../lib/config-sistema";

// Límites de entrada: protegen la base de datos de payloads malformados o abusivos
const LONGITUD_MAX_COMANDA = 60;
// Acepta de 6 a 12 caracteres: el cajero solo necesita tipear 6 a mano, pero cuando
// la IA logra leer más dígitos del comprobante los envía todos — un sufijo más largo
// baja drásticamente la probabilidad de que dos pagos distintos coincidan (ver bug real:
// dos órdenes distintas terminaron ambas en "936704").
const FORMATO_ID_SUFIJO = new RegExp(`^[a-z0-9]{${SUFIJO_ID_MIN},${SUFIJO_ID_MAX}}$`);
// La imagen llega comprimida desde el cliente (~300 KB típico); 2.5M de caracteres base64
// (~1.8 MB reales) es un techo holgado que corta payloads anómalos.
const LONGITUD_MAX_IMAGEN = 2_500_000;

// Convierte un valor del body a texto solo si es un primitivo legítimo;
// objetos o arrays enviados con malicia se tratan como vacío (y fallan la validación).
function comoTexto(valor: unknown): string {
  if (typeof valor === "string") return valor;
  if (typeof valor === "number" && Number.isFinite(valor)) return String(valor);
  return "";
}

// Valida y normaliza el cuerpo de la petición. Devuelve los datos listos para usar,
// o un mensaje de error si algún campo no cumple las reglas del negocio.
function validarEntrada(body: Record<string, unknown>):
  | { ok: true; comanda: string; monto: number; moneda: string; idLimpio: string; ciudad: string; imagen: string; fechaCajero: string }
  | { ok: false; mensaje: string } {

  // Comanda obligatoria: cada pago validado debe quedar amarrado a una venta del negocio.
  // Se acepta 'id_orden' como alias por compatibilidad con versiones viejas del formulario.
  const comanda = comoTexto(body.comanda ?? body.id_orden).trim().slice(0, LONGITUD_MAX_COMANDA);
  if (!comanda) {
    return { ok: false, mensaje: "⚠️ Introduce el Número de Venta / Comanda para poder validar el pago." };
  }

  // Monto: número finito y positivo (un NaN aquí rompería la consulta de conciliación)
  const monto = Number.parseFloat(comoTexto(body.monto));
  if (!Number.isFinite(monto) || monto <= 0) {
    return { ok: false, mensaje: "⚠️ El monto del pago no es válido. Verifica la cifra del comprobante." };
  }

  // Solo las monedas de Binance: este endpoint concilia contra el worker de Binance, así
  // que un pago en bolívares aquí sería un error de enrutado (le corresponde a /verificar-bdv).
  const moneda = comoTexto(body.moneda).trim().toUpperCase();
  if (!MONEDAS_BINANCE.includes(moneda)) {
    return { ok: false, mensaje: "⚠️ Moneda no reconocida. Selecciona USDT, BTC o ETH." };
  }

  // Sufijo del ID: mínimo 6 caracteres (lo que el cajero tipea a mano), hasta 12 cuando
  // lo aporta la IA. 'binance_id_6_digitos' se acepta como alias legado.
  const idLimpio = comoTexto(body.binance_id_sufijo ?? body.binance_id_6_digitos).trim().toLowerCase();
  if (!FORMATO_ID_SUFIJO.test(idLimpio)) {
    return { ok: false, mensaje: "⚠️ El ID debe tener al menos los últimos 6 dígitos del comprobante (letras o números)." };
  }

  // Sucursal contra la lista oficial: evita registros con ciudades mal escritas
  // que después no aparecen en los filtros del panel administrativo.
  const ciudad = comoTexto(body.ciudad).trim();
  if (!VALORES_SUCURSALES.includes(ciudad)) {
    return { ok: false, mensaje: "⚠️ Sucursal no reconocida. Selecciona una sucursal válida de la lista." };
  }

  // Comprobante fotográfico obligatorio, con formato y tamaño razonables
  const imagen = comoTexto(body.imagen_comprobante);
  if (!imagen.startsWith("data:image/")) {
    return { ok: false, mensaje: "⚠️ Es obligatorio adjuntar el escaneo del comprobante." };
  }
  if (imagen.length > LONGITUD_MAX_IMAGEN) {
    return { ok: false, mensaje: "⚠️ La imagen del comprobante es demasiado pesada. Vuelve a escanearla." };
  }

  // Fecha del cajero: si no llega o es inválida, se usa la hora del servidor
  const fechaCruda = comoTexto(body.fecha_cajero);
  const fechaCajero = !Number.isNaN(Date.parse(fechaCruda)) ? new Date(fechaCruda).toISOString() : new Date().toISOString();

  return { ok: true, comanda, monto, moneda, idLimpio, ciudad, imagen, fechaCajero };
}

export async function POST(request: Request) {
  console.log("🚀 [Validar] Petición de validación contable recibida.");

  try {
    // 🔒 Solo desde el panel del cajero (cookie firmada) o scripts internos con el token.
    // Este endpoint marca pagos como verificados en el libro contable.
    if (!(await peticionDeCajeroValida(request))) {
      console.warn("⚠️ [Validar] Petición rechazada: sin credencial de cajero.");
      return NextResponse.json({ message: "Acceso no autorizado." }, { status: 403 });
    }

    const body = await request.json().catch(() => null);
    if (!body) {
      return NextResponse.json({ message: "Cuerpo de petición inválido." }, { status: 400 });
    }

    // ✅ 1. VALIDACIÓN ESTRICTA DE ENTRADAS
    const entrada = validarEntrada(body);
    if (entrada.ok === false) {
      return NextResponse.json({ message: entrada.mensaje }, { status: 400 });
    }
    const { comanda, monto, moneda, idLimpio, ciudad, imagen, fechaCajero } = entrada;

    const sql = obtenerSql();
    const patronSufijo = `%${idLimpio}`;

    // 🚨 2. FRENO DE MANO DE EMERGENCIA
    const config = await obtenerConfigSistema();
    if (!config.sistemaActivo) {
      return NextResponse.json({ message: config.mensajeBloqueo || "Sistema suspendido." }, { status: 503 });
    }

    // 🛡️ 3. PREVENCIÓN DE DUPLICADOS
    // Un registro ya está procesado si tiene la columna ciudad asignada. El cruce por
    // sufijo se hace contra id_orden (ID de orden numérico de Binance) con
    // binance_id_completo como respaldo para registros con el formato anterior.
    // ⚠️ Se exige también monto+moneda exactos: dos pagos DISTINTOS pueden coincidir por
    // azar en el sufijo del ID (ocurrió en producción con 6 dígitos), pero coincidir
    // además en el monto exacto es muchísimo más improbable. Sin este filtro, un cajero
    // podía recibir "ya fue validado" comparando contra un pago de otra tienda por otro monto.
    const [duplicadoReal] = await conReintentos(() => sql`
      SELECT id, comanda, ciudad
      FROM transacciones
      WHERE (id_orden ILIKE ${patronSufijo} OR binance_id_completo ILIKE ${patronSufijo})
        AND monto = ${monto}
        AND moneda = ${moneda}
        AND ciudad IS NOT NULL
      LIMIT 1;
    `);

    if (duplicadoReal) {
      return NextResponse.json({
        message: `❌ Este comprobante YA fue validado anteriormente en la sucursal de: ${duplicadoReal.ciudad} (Comanda: ${duplicadoReal.comanda || "Sin ID"}). No se puede duplicar.`
      }, { status: 409 });
    }

    // 📊 4. CONCILIACIÓN CONTABLE (VERIFICAR EL INGRESO DEL WORKER)
    // Solo se consideran transacciones crudas sin reclamar (ciudad IS NULL); si hubiera
    // más de una candidata se toma la más antigua para un comportamiento determinista.
    const [pagoDetectadoPorWorker] = await conReintentos(() => sql`
      SELECT id
      FROM transacciones
      WHERE monto = ${monto}
        AND moneda = ${moneda}
        AND (id_orden ILIKE ${patronSufijo} OR binance_id_completo ILIKE ${patronSufijo})
        AND ciudad IS NULL
      ORDER BY created_at ASC
      LIMIT 1;
    `);

    if (!pagoDetectadoPorWorker) {
      return NextResponse.json({
        message: "No se encontró coincidencia de fondos en Binance. Verifica el ID y el monto exacto del comprobante, o espera 1 minuto a que el sistema detecte el pago."
      }, { status: 404 });
    }

    // 💾 5. RECLAMO ATÓMICO DE LA TRANSACCIÓN
    // La condición "ciudad IS NULL" dentro del UPDATE garantiza que si dos cajeros validan
    // el mismo pago a la vez, solo uno lo reclama: el segundo no afecta ninguna fila.
    console.log(`💾 [Validar] Reclamando transacción ID ${pagoDetectadoPorWorker.id} para la sucursal: ${ciudad}`);

    const [reclamada] = await sql`
      UPDATE transacciones
      SET
        comanda = ${comanda},
        ciudad = ${ciudad},
        estado = 'VERIFICADO',
        fecha_cajero = ${fechaCajero},
        fecha_validacion = ${new Date().toISOString()},
        imagen_comprobante_base64 = ${imagen}
      WHERE id = ${pagoDetectadoPorWorker.id}
        AND ciudad IS NULL
      RETURNING id;
    `;

    if (!reclamada) {
      // Otro cajero reclamó esta misma transacción entre la búsqueda y el reclamo
      const [ganador] = await sql`
        SELECT comanda, ciudad FROM transacciones WHERE id = ${pagoDetectadoPorWorker.id};
      `;
      return NextResponse.json({
        message: `❌ Este comprobante acaba de ser validado por otro cajero en: ${ganador?.ciudad || "otra sucursal"} (Comanda: ${ganador?.comanda || "Sin ID"}). No se puede duplicar.`
      }, { status: 409 });
    }

    // 📨 6. NOTIFICACIÓN AL GRUPO DE TELEGRAM (best-effort, nunca bloquea ni falla la validación)
    // Se espera aquí —y no en segundo plano— porque el runtime serverless puede congelar
    // la función apenas se envía la respuesta, cortando cualquier fetch pendiente.
    // El pago ya está reclamado en la base de datos, así que un fallo aquí solo se reporta:
    // el cajero debe enterarse de que el aviso al grupo no salió, en vez de asumir que sí.
    const notificacion = await notificarPagoVerificado({ comanda, monto, moneda, ciudad, imagenBase64: imagen });
    if (notificacion.enviada === false) {
      console.warn(`⚠️ [Validar] Pago ${reclamada.id} verificado pero sin aviso a Telegram (${notificacion.motivo}): ${notificacion.detalle}`);
    }

    return NextResponse.json({
      message: notificacion.enviada
        ? "¡Pago verificado y reclamado con éxito!"
        : "¡Pago verificado y reclamado con éxito! (No se pudo enviar el aviso al grupo de Telegram.)",
      notificacionTelegram: notificacion.enviada,
    }, { status: 200 });

  } catch (error) {
    // El detalle queda en el log del servidor; al cliente no se le expone el error interno
    console.error("❌ Error en validación:", error);

    if (esErrorDeConexion(error)) {
      return NextResponse.json(
        { message: "⚠️ Fallo temporal de conexión con la base de datos. Inténtalo de nuevo en unos segundos." },
        { status: 503 }
      );
    }

    return NextResponse.json({ message: "Error interno en el servidor." }, { status: 500 });
  }
}
