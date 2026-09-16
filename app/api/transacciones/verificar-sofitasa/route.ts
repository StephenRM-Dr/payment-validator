import { NextResponse } from "next/server";
import { obtenerSql, conReintentos, esErrorDeConexion } from "../../../lib/db";
import { VALORES_SUCURSALES, MONEDA_SOFITASA } from "../../../lib/sucursales";
import { peticionDeCajeroValida } from "../../../lib/token-cajero";
import { notificarPagoVerificado } from "../../../lib/telegram";
import {
  buscarPagoEnMovimientosSofitasa,
  confirmarMovimientoDelExtractoSofitasa,
  confirmarPagoSofitasa,
  type MovimientoSofitasa,
  type DatosPagadorSofitasa,
} from "../../../lib/proveedores/sofitasa";
import { distanciaReferencias, sufijoReferencia, digitosDeCruce, limpiarReferencia } from "../../../lib/proveedores/referencias";
import { empresaDeSucursal } from "../../../lib/proveedores/empresas-sofitasa";
import { LONGITUD_MAX_COMANDA } from "../../../lib/validacion";
import { normalizarImporte } from "../../../lib/proveedores/prompts";
import { comoTexto } from "../../../lib/http";
import { LONGITUD_MAX_IMAGEN } from "../../../lib/imagenes";
import { obtenerConfigSistema } from "../../../lib/config-sistema";

// Verificación de Pago Móvil de Sofitasa, a través del puente `servidor-sofitasa/`.
//
// Flujo de DOS pasos, igual que BDV pero con una consecuencia distinta si se salta el
// primero: /sofitasa/verificar QUEMA la referencia en el banco, así que nunca se llama a
// ciegas con lo que teclea el cajero.
//
//   1. Se busca el pago en el estado de cuenta (solo lectura, repetible), cruzando por
//      referencia y monto — mismo cruce que BDV contra su extracto.
//   2. Solo con un match de confianza (o el candidato que el cajero confirmó) se llama al
//      endpoint que sí tiene efecto en el banco.

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
  const comanda = comoTexto(body.comanda).trim().slice(0, LONGITUD_MAX_COMANDA);
  if (!comanda) {
    return { ok: false, mensaje: "⚠️ Introduce el Número de Venta / Comanda para poder validar el pago." };
  }

  const ciudad = comoTexto(body.ciudad).trim();
  if (!VALORES_SUCURSALES.includes(ciudad)) {
    return { ok: false, mensaje: "⚠️ Sucursal no reconocida. Selecciona una sucursal válida de la lista." };
  }

  const imagen = comoTexto(body.imagen_comprobante);
  if (!imagen.startsWith("data:image/")) {
    return { ok: false, mensaje: "⚠️ Es obligatorio adjuntar el escaneo del comprobante." };
  }
  if (imagen.length > LONGITUD_MAX_IMAGEN) {
    return { ok: false, mensaje: "⚠️ La imagen del comprobante es demasiado pesada. Vuelve a escanearla." };
  }

  const referencia = comoTexto(body.referencia).replace(/\D/g, "");
  // Sin mínimo de 6 aquí: algunos bancos emisores (visto en producción: BBVA Provincial)
  // imprimen referencias que quedan en solo 5 dígitos significativos tras quitar los ceros
  // de relleno. El mínimo real para un cruce directo lo aplica digitosAComparar() al buscar
  // en el banco; una referencia más corta cae sola al respaldo por monto (candidatos).
  if (referencia.length < 1 || referencia.length > 20) {
    return { ok: false, mensaje: "⚠️ La referencia del pago debe tener entre 1 y 20 dígitos." };
  }

  // 'importe' llega del OCR o lo teclea el cajero a mano, en cualquiera de los dos formatos
  // ("1.234,56" o "1,234.56"). Number.parseFloat directo se detiene en el primer separador
  // que no entiende y devolvía 1 para cualquiera de los dos formatos con miles — un bug real
  // encontrado al escribir las pruebas de fraude (ver tests/fraude-normalizacion.test.mjs).
  const importeTexto = normalizarImporte(comoTexto(body.importe));
  const importe = importeTexto !== null ? Number.parseFloat(importeTexto) : NaN;
  if (!Number.isFinite(importe) || importe <= 0) {
    return { ok: false, mensaje: "⚠️ El monto del pago no es válido. Verifica la cifra del comprobante." };
  }

  const fechaPago = comoTexto(body.fecha_pago).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaPago)) {
    return { ok: false, mensaje: "⚠️ La fecha del pago debe tener el formato AAAA-MM-DD." };
  }

  const fechaCruda = comoTexto(body.fecha_cajero);
  const fechaCajero = !Number.isNaN(Date.parse(fechaCruda)) ? new Date(fechaCruda).toISOString() : new Date().toISOString();

  return { ok: true, datos: { comanda, ciudad, imagen, fechaCajero, referencia, importe, fechaPago } };
}

export async function POST(request: Request) {
  console.log("🚀 [Sofitasa] Petición de verificación de Pago Móvil recibida.");

  try {
    // 🔒 1. Solo desde el panel del cajero
    if (!(await peticionDeCajeroValida(request))) {
      console.warn("⚠️ [Sofitasa] Petición rechazada: sin credencial de cajero.");
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

    // 🚨 2. Freno de mano de emergencia
    const config = await obtenerConfigSistema();
    if (!config.sistemaActivo) {
      return NextResponse.json({ message: config.mensajeBloqueo || "Sistema suspendido." }, { status: 503 });
    }

    // 🏢 3. Empresa que le corresponde a la sucursal (Acme Corp / Beta Corp)
    const empresa = empresaDeSucursal(ciudad);
    if (!empresa) {
      console.error(`❌ [Sofitasa] Sucursal sin empresa asignada: ${ciudad}`);
      return NextResponse.json({
        message: "Esa sucursal todavía no tiene asignada una empresa de Sofitasa. Avisa al administrador.",
      }, { status: 503 });
    }

    // digitosDeCruce() y no 'referencia.slice(-digitosAComparar(referencia))': con una
    // referencia demasiado corta, digitosAComparar() devuelve 0 y 'slice(-0)' en JavaScript
    // equivale a 'slice(0)' (devuelve el string COMPLETO, no nada, porque -0 no es
    // negativo). digitosDeCruce() ya maneja ese caso (null); se cae a la referencia limpia
    // completa como sufijo de respaldo. Solo se usa para etiquetar candidatos y mensajes de
    // log — el chequeo de duplicado real se hace más abajo, una vez resuelto el movimiento
    // (ver el comentario ahí), y ANTES de llamar a /sofitasa/verificar (que sí quema la
    // referencia).
    const sufijo = digitosDeCruce(referencia) ?? limpiarReferencia(referencia);

    // 🏦 5. PASO 1: localizar el pago en el estado de cuenta (solo lectura, repetible).
    // Si el cajero ya eligió un candidato, se vuelve a consultar por su referencia exacta
    // en vez de confiar en lo que llega en la petición.
    const referenciaBancoConfirmada = comoTexto(body.referencia_banco).trim();

    let movimiento: MovimientoSofitasa;
    let pagador: DatosPagadorSofitasa;

    if (referenciaBancoConfirmada) {
      const resultado = await confirmarMovimientoDelExtractoSofitasa(referenciaBancoConfirmada, importe, fechaPago, empresa);
      if (resultado.estado === "SIN_RESPUESTA") {
        console.warn(`⚠️ [Sofitasa] Sin respuesta del banco (confirmar candidato): ${resultado.detalle}`);
        return NextResponse.json({ message: resultado.mensaje }, { status: 503 });
      }
      if (resultado.estado === "NO_ENCONTRADO") {
        return NextResponse.json({ message: resultado.mensaje }, { status: 404 });
      }
      movimiento = resultado.movimiento;
      pagador = resultado.pagador;
    } else {
      const resultado = await buscarPagoEnMovimientosSofitasa(referencia, importe, fechaPago, empresa);

      if (resultado.estado === "SIN_RESPUESTA") {
        console.warn(`⚠️ [Sofitasa] Sin respuesta del banco: ${resultado.detalle}`);
        return NextResponse.json({ message: resultado.mensaje }, { status: 503 });
      }
      if (resultado.estado === "MONTO_DISTINTO") {
        console.log(`🚫 [Sofitasa] Referencia ${sufijo} hallada con otro monto (banco: ${resultado.montoBanco}).`);
        return NextResponse.json({ message: resultado.mensaje }, { status: 409 });
      }
      if (resultado.estado === "CANDIDATOS_POR_MONTO") {
        console.log(`❓ [Sofitasa] Referencia ${sufijo} no hallada; ${resultado.candidatos.length} pago(s) por Bs. ${importe.toFixed(2)} para confirmar.`);
        const candidatos = resultado.candidatos
          .map(({ movimiento: m, pagador: p }) => {
            const refBanco = m.REFERENCEA || m.NUMCTRL;
            return {
              referenciaBanco: refBanco,
              hora: null as string | null,
              monto: m.AMOUNT,
              pagador: null as string | null,
              identificacion: p.cedulaPagador ?? p.telefonoPagador,
              bancoOrigen: p.bancoOrigen,
              correcciones: distanciaReferencias(sufijo, sufijoReferencia(refBanco, sufijo.length)),
            };
          })
          .sort((a, b) => a.correcciones - b.correcciones);

        return NextResponse.json({
          message: candidatos.length === 1
            ? "No encontré esa referencia, pero sí un pago por el monto exacto. Comprueba que sea el del cliente y confírmalo."
            : `No encontré esa referencia, pero hay ${candidatos.length} pagos por el monto exacto. Elige cuál es el del cliente.`,
          candidatos,
        }, { status: 409 });
      }
      if (resultado.estado === "NO_ENCONTRADO") {
        console.log(`🚫 [Sofitasa] Referencia ${sufijo} no aparece entre los ${resultado.movimientosRevisados} movimientos del ${fechaPago}.`);
        return NextResponse.json({ message: resultado.mensaje }, { status: 404 });
      }
      movimiento = resultado.movimiento;
      pagador = resultado.pagador;
    }

    // 🛡️ 6. Duplicado evidente, ya con el movimiento real resuelto — recién aquí se conoce la
    // referencia exacta del banco. Comparación EXACTA (no LIKE por sufijo): con referencias
    // cortas (por debajo de DIGITOS_REFERENCIA_MIN) el sufijo de respaldo era casi la
    // referencia completa sin acotar, y aun acotado por empresa_sofitasa (dos sucursales por
    // empresa) un LIKE podía confundir pagos de la sucursal hermana. Se hace ANTES de llamar
    // a /sofitasa/verificar: aquí importa más que en Bancamiga porque ese endpoint SÍ quema
    // la referencia, así que un duplicado que llegara a llamarlo desperdiciaría un pago real.
    const referenciaCandidata = movimiento.REFERENCEA || movimiento.NUMCTRL;
    const [yaCobrado] = await conReintentos(() => sql`
      SELECT comanda, ciudad
      FROM transacciones
      WHERE proveedor = 'SOFITASA' AND empresa_sofitasa = ${empresa} AND referencia = ${referenciaCandidata}
      LIMIT 1;
    `);
    if (yaCobrado) {
      return NextResponse.json({
        message: `❌ Este pago móvil YA fue validado anteriormente en la sucursal de: ${yaCobrado.ciudad} (Comanda: ${yaCobrado.comanda || "Sin ID"}). No se puede duplicar.`,
      }, { status: 409 });
    }

    // 🔥 7. PASO 2: confirmar con el banco — esto SÍ quema la referencia. Solo se llega
    // aquí con un match de confianza.
    const confirmacion = await confirmarPagoSofitasa(movimiento, pagador, empresa, fechaPago);

    let referenciaFinal: string;
    let montoFinal: number;
    let crudoFinal: unknown;

    if (confirmacion.estado === "SIN_RESPUESTA") {
      console.warn(`⚠️ [Sofitasa] Sin respuesta del banco al confirmar: ${confirmacion.detalle}`);
      return NextResponse.json({ message: confirmacion.mensaje }, { status: 503 });
    }

    if (confirmacion.estado === "YA_VERIFICADA") {
      // El banco dice que esta referencia ya se validó. Puede ser un pago nuestro que se
      // perdió entre el verify exitoso y el registro en esta base de datos — se registra
      // igual usando el rastro que el propio puente guarda en su auditoría local.
      const previa = confirmacion.verificacionesPrevias[0] as { referencia?: string; monto?: string } | undefined;
      if (!previa?.referencia) {
        return NextResponse.json({
          message: `❌ ${confirmacion.mensaje} No se pudo recuperar el detalle de esa verificación previa.`,
        }, { status: 409 });
      }
      console.warn("⚠️ [Sofitasa] Referencia ya verificada en el banco sin registro local; se registra usando el rastro del puente.");
      referenciaFinal = previa.referencia;
      montoFinal = Number(previa.monto) || movimiento.AMOUNT;
      crudoFinal = confirmacion.verificacionesPrevias;
    } else if (confirmacion.estado === "RECHAZADO") {
      console.log(`🚫 [Sofitasa] El banco rechazó la verificación (${confirmacion.codigo}): ${confirmacion.mensaje}`);
      return NextResponse.json({ message: confirmacion.mensaje, codigo: confirmacion.codigo }, { status: confirmacion.noExiste ? 404 : 422 });
    } else {
      referenciaFinal = movimiento.REFERENCEA || movimiento.NUMCTRL;
      montoFinal = movimiento.AMOUNT;
      crudoFinal = confirmacion.movimiento;
    }

    // 💾 8. Registro del pago ya confirmado
    const [registrada] = await sql`
      INSERT INTO transacciones (
        proveedor, empresa_sofitasa, referencia, banco_origen, telefono_pagador, cedula_pagador,
        sofitasa_raw, monto, moneda, estado, comanda, ciudad, imagen_comprobante_base64,
        fecha_cajero, fecha_validacion, fecha_pago
      ) VALUES (
        'SOFITASA',
        ${empresa},
        ${referenciaFinal},
        ${pagador.bancoOrigen},
        ${pagador.telefonoPagador},
        ${pagador.cedulaPagador},
        ${JSON.stringify(crudoFinal)}::jsonb,
        ${montoFinal},
        ${MONEDA_SOFITASA},
        'VERIFICADO',
        ${comanda},
        ${ciudad},
        ${imagen},
        ${fechaCajero},
        ${new Date().toISOString()},
        ${fechaPago}
      )
      ON CONFLICT (empresa_sofitasa, referencia)
        WHERE proveedor = 'SOFITASA' AND referencia IS NOT NULL DO NOTHING
      RETURNING id;
    `;

    if (!registrada) {
      // Otro cajero registró este mismo comprobante entre la comprobación y el INSERT
      const [ganador] = await sql`
        SELECT comanda, ciudad FROM transacciones
        WHERE proveedor = 'SOFITASA' AND empresa_sofitasa = ${empresa} AND referencia = ${referenciaFinal}
        LIMIT 1;
      `;
      return NextResponse.json({
        message: `❌ Este pago móvil acaba de ser validado por otro cajero en: ${ganador?.ciudad || "otra sucursal"} (Comanda: ${ganador?.comanda || "Sin ID"}). No se puede duplicar.`,
      }, { status: 409 });
    }

    console.log(`✅ [Sofitasa/${empresa}] Pago ${referenciaFinal} confirmado y registrado como transacción ${registrada.id}.`);

    // 📨 9. Notificación a Telegram (best-effort, nunca bloquea ni falla el registro)
    const notificacion = await notificarPagoVerificado({
      comanda,
      monto: montoFinal,
      moneda: MONEDA_SOFITASA,
      ciudad,
      imagenBase64: imagen,
      proveedor: "Pago Móvil Sofitasa",
      referencia: referenciaFinal,
    });

    if (notificacion.enviada === false) {
      console.warn(`⚠️ [Sofitasa] Pago ${registrada.id} verificado pero sin aviso a Telegram (${notificacion.motivo}): ${notificacion.detalle}`);
    }

    return NextResponse.json({
      message: notificacion.enviada
        ? "¡Pago móvil confirmado en el banco y registrado con éxito!"
        : "¡Pago móvil confirmado en el banco y registrado con éxito! (No se pudo enviar el aviso al grupo de Telegram.)",
      notificacionTelegram: notificacion.enviada,
      pago: {
        referencia: referenciaFinal,
        monto: montoFinal,
        pagador: null,
        identificacion: pagador.cedulaPagador ?? pagador.telefonoPagador,
      },
    }, { status: 200 });

  } catch (error) {
    console.error("❌ [Sofitasa] Error en la verificación:", error);

    if (esErrorDeConexion(error)) {
      return NextResponse.json(
        { message: "⚠️ Fallo temporal de conexión con la base de datos. Inténtalo de nuevo en unos segundos." },
        { status: 503 }
      );
    }

    return NextResponse.json({ message: "Error interno en el servidor." }, { status: 500 });
  }
}
