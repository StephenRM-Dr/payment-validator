import { NextResponse } from "next/server";
import { obtenerSql, conReintentos, esErrorDeConexion } from "../../../lib/db";

// Normaliza la fecha real del pago que envía el worker: acepta ISO 8601 (fecha_pago)
// o epoch en milisegundos (fecha_pago_ms). Devuelve ISO UTC, o null si no viene ninguna.
function normalizarFechaPago(fechaIso: unknown, fechaMs: unknown): string | null {
  if (typeof fechaIso === "string" && !Number.isNaN(Date.parse(fechaIso))) {
    return new Date(fechaIso).toISOString();
  }
  if (typeof fechaMs === "number" && Number.isFinite(fechaMs) && fechaMs > 0) {
    return new Date(fechaMs).toISOString();
  }
  return null;
}

export async function POST(request: Request) {
  try {
    // 🔒 1. VALIDACIÓN DE SEGURIDAD (WEBHOOK SECRET)
    const webhookSecretHeader = request.headers.get("X-Webhook-Secret");
    const WEBHOOK_SECRET_LOCAL = process.env.WEBHOOK_SECRET;

    if (!WEBHOOK_SECRET_LOCAL || webhookSecretHeader !== WEBHOOK_SECRET_LOCAL) {
      console.warn("⚠️ Intento de acceso no autorizado al webhook de Binance.");
      return NextResponse.json({ error: "🔒 No autorizado. Clave de Webhook inválida o ausente." }, { status: 401 });
    }

    // 📦 2. LEER DATOS ENVIADOS
    // Contrato del worker: binance_id_completo (ID de orden numérico de ~18 dígitos, o
    // "SPOT_<timestamp>" para depósitos Spot), monto y moneda son obligatorios.
    // txid (referencia alfanumérica P_...), id_orden, pagador, fecha_pago/fecha_pago_ms
    // y binance_raw son opcionales: los depósitos Spot no los traen.
    const body = await request.json().catch(() => null);
    if (!body) {
      return NextResponse.json({ error: "❌ Cuerpo de petición inválido." }, { status: 400 });
    }

    const { binance_id_completo, id_orden, monto, moneda, txid, pagador, binance_raw } = body;

    if (!binance_id_completo || monto === undefined || !moneda) {
      return NextResponse.json({ error: "❌ Faltan parámetros obligatorios en el cuerpo de la petición." }, { status: 400 });
    }

    // Monto numérico, finito y positivo (un NaN rompería el INSERT con un error interno)
    const montoNumero = Number.parseFloat(String(monto));
    if (!Number.isFinite(montoNumero) || montoNumero <= 0) {
      return NextResponse.json({ error: "❌ El monto recibido no es un número válido." }, { status: 400 });
    }

    // ⚠️ Los IDs de ~18 dígitos exceden Number.MAX_SAFE_INTEGER: siempre se manejan como string.
    const idCompleto = String(binance_id_completo).trim();
    const idOrden = id_orden ? String(id_orden).trim() : null;
    const txidLimpio = txid ? String(txid).trim() : null;
    const pagadorLimpio = pagador ? String(pagador).trim() : null;
    const fechaPago = normalizarFechaPago(body.fecha_pago, body.fecha_pago_ms);
    const rawJson = binance_raw ? JSON.stringify(binance_raw) : null;

    const sql = obtenerSql();

    // 🔍 3. IDEMPOTENCIA — el worker reenvía el historial completo en cada barrido:
    // si el ID ya está registrado, se responde éxito sin crear un duplicado.
    const [existente] = await conReintentos(() => sql`
      SELECT id FROM transacciones WHERE binance_id_completo = ${idCompleto} LIMIT 1;
    `);

    if (existente) {
      return NextResponse.json({
        message: "⚠️ Transacción ya registrada anteriormente.",
        id: existente.id
      }, { status: 200 });
    }

    // 🔄 4. MIGRACIÓN DE REGISTROS CON EL ID ALFANUMÉRICO VIEJO
    // Las filas históricas guardaron el txid (P_...) en binance_id_completo. Cuando el pago
    // se reenvía con su ID numérico, se actualiza esa fila PENDIENTE en lugar de duplicarla.
    if (txidLimpio) {
      const [filaVieja] = await conReintentos(() => sql`
        SELECT id FROM transacciones
        WHERE binance_id_completo = ${txidLimpio} AND estado = 'PENDIENTE'
        LIMIT 1;
      `);

      if (filaVieja) {
        await conReintentos(() => sql`
          UPDATE transacciones
          SET
            binance_id_completo = ${idCompleto},
            id_orden = ${idOrden},
            txid = ${txidLimpio},
            pagador = ${pagadorLimpio},
            fecha_pago = ${fechaPago},
            binance_raw = ${rawJson}::jsonb
          WHERE id = ${filaVieja.id};
        `);

        console.log(`🔄 Webhook: fila ${filaVieja.id} migrada del ID alfanumérico ${txidLimpio} al numérico ${idCompleto}.`);
        return NextResponse.json({
          message: "🔄 Registro existente migrado al nuevo ID numérico de Binance.",
          id: filaVieja.id
        }, { status: 200 });
      }
    }

    // 📝 5. REGISTRAR LA NUEVA TRANSACCIÓN
    // fecha_pago = fecha real del pago según Binance (UTC); created_at = hora de inserción,
    // se conserva para poder auditar el retraso de detección del worker.
    // ON CONFLICT apoya en el índice único: dos webhooks simultáneos no duplican la fila.
    const [insertada] = await conReintentos(() => sql`
      INSERT INTO transacciones (
        binance_id_completo,
        id_orden,
        txid,
        pagador,
        fecha_pago,
        binance_raw,
        monto,
        moneda,
        estado,
        created_at
      ) VALUES (
        ${idCompleto},
        ${idOrden},
        ${txidLimpio},
        ${pagadorLimpio},
        ${fechaPago},
        ${rawJson}::jsonb,
        ${montoNumero},
        ${String(moneda).toUpperCase()},
        'PENDIENTE',
        NOW()
      )
      ON CONFLICT (binance_id_completo) DO NOTHING
      RETURNING id;
    `);

    if (!insertada) {
      // Carrera perdida contra otro webhook idéntico que insertó primero: también es éxito.
      return NextResponse.json({ message: "⚠️ Transacción ya registrada anteriormente." }, { status: 200 });
    }

    console.log(`✅ Webhook procesado con éxito. Transacción guardada con ID: ${insertada.id}`);

    return NextResponse.json({
      message: "🚀 Transacción de Binance vinculada y registrada con éxito.",
      id: insertada.id
    }, { status: 201 });

  } catch (error) {
    // El detalle queda en el log del servidor; al cliente no se le expone el error interno
    console.error("❌ [Webhook Binance] Error crítico:", error);

    // Fallo de red hacia Neon: el 503 le indica al worker que el pago NO quedó registrado y
    // que debe reintentarlo en el próximo barrido (un 500 genérico se leía como definitivo).
    if (esErrorDeConexion(error)) {
      return NextResponse.json(
        { error: "⚠️ Fallo temporal de conexión con la base de datos. Reintenta el envío." },
        { status: 503 }
      );
    }

    return NextResponse.json({ error: "Error interno al registrar la transacción." }, { status: 500 });
  }
}
