import { NextResponse } from "next/server";
import { obtenerSql, conReintentos, esErrorDeConexion } from "../../../lib/db";
import { VALORES_SUCURSALES } from "../../../lib/sucursales";
import { verificarAccesoAdmin } from "../../../lib/auth-admin";
import { verificarPinAdmin, comoTexto } from "../../../lib/http";
import { LONGITUD_MAX_IMAGEN } from "../../../lib/imagenes";
import {
  buscarEnListaBancamiga,
  encontrarMovimientoPorReferenciaBancamiga,
  confirmarPagoBancamiga,
  buscarTransferenciaBancamiga,
  consultarPagoMovilDirecto,
  telefonoAFormatoBancamiga,
  digitosDeCruceBancamiga,
  type MovimientoBancamiga,
  type DatosPagadorBancamiga,
  type MovimientoTransferenciaBancamiga,
} from "../../../lib/proveedores/bancamiga";
import { obtenerHistorialConCache } from "../../../lib/proveedores/bancamiga-cache";
import { registrarPagoBancamiga } from "../../../lib/proveedores/bancamiga-registro";
import { obtenerConfigSistema } from "../../../lib/config-sistema";
import { distanciaReferencias, sufijoReferencia, limpiarReferencia } from "../../../lib/proveedores/referencias";
import { normalizarCodigoBanco } from "../../../lib/bancos";
import { LONGITUD_MAX_COMANDA } from "../../../lib/validacion";
import { normalizarImporte } from "../../../lib/proveedores/prompts";

// Panel de SEGUIMIENTO de Bancamiga, para el equipo (no para el cajero) — reintenta un pago
// que el flujo normal (app/api/transacciones/verificar-bancamiga/route.ts) no pudo cerrar en
// el momento, casi siempre porque el historial del banco todavía no lo reflejaba (el extracto
// del día se completa con retraso, igual que en BDV — ver docs/informe-pruebas-fraude-...).
//
// Mismas tres vías que el flujo del cajero (historial → transferencia/depósito), MÁS una
// cuarta: la consulta PUNTUAL y directa (pm/find/secure, consultarPagoMovilDirecto() en
// bancamiga.ts) cuando quien hace el seguimiento consigue el teléfono de origen completo del
// pagador (el comprobante lo muestra parcialmente oculto, ej. "04**-***3119" — hay que
// pedírselo al cliente o mirar su propio teléfono). Esa cuarta vía es autoritativa por sí
// misma (es la MISMA llamada que el paso de confirmación del cajero), así que si responde
// VERIFICADO no hace falta ningún paso adicional antes de registrar.
//
// Protegido con el PIN admin (verificarAccesoAdmin), no con el token de cajero: esta es una
// herramienta de investigación para el equipo, no parte del flujo de venta en mostrador.
//
// El registro final (duplicado + INSERT + aviso a Telegram) es EXACTAMENTE el mismo código
// que usa el cajero — ver bancamiga-registro.ts — para que una corrección de ese código no
// tenga que hacerse dos veces.

// Solo para que la pantalla de login del panel (app/admin/bancamiga-seguimiento/page.tsx)
// pueda comprobar el PIN al momento de ingresar, sin efectos secundarios: a diferencia del
// POST de esta misma ruta, un GET nunca busca ni registra nada. Antes de agregar esto, el
// formulario aceptaba cualquier PIN escrito y solo se enteraba de que era incorrecto hasta
// el final, después de llenar todo el formulario — un 403 que parecía "el panel no
// valida bien" cuando en realidad era el PIN.
export async function GET(request: Request) {
  const rechazo = await verificarPinAdmin(request, "Bancamiga/Seguimiento");
  if (rechazo) return rechazo;
  return NextResponse.json({ ok: true });
}

interface EntradaValida {
  comanda: string;
  ciudad: string;
  imagen: string;
  fechaCajero: string;
  referencia: string;
  importe: number;
  fechaPago: string;
  telefonoOrigen: string | null; // ya normalizado a 58XXXXXXXXXX, o null si no se aportó/es inválido
  bancoOrigen: string | null; // código de 4 dígitos, o null
}

function validarEntrada(body: Record<string, unknown>): { ok: true; datos: EntradaValida } | { ok: false; mensaje: string } {
  const comanda = comoTexto(body.comanda).trim().slice(0, LONGITUD_MAX_COMANDA);
  if (!comanda) {
    return { ok: false, mensaje: "⚠️ Introduce el Número de Venta / Comanda para poder registrar el pago." };
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
    return { ok: false, mensaje: "⚠️ La imagen del comprobante es demasiado pesada." };
  }

  const referencia = comoTexto(body.referencia).replace(/\D/g, "");
  if (referencia.length < 1 || referencia.length > 20) {
    return { ok: false, mensaje: "⚠️ La referencia del pago debe tener entre 1 y 20 dígitos." };
  }

  const importeTexto = normalizarImporte(comoTexto(body.importe));
  const importe = importeTexto !== null ? Number.parseFloat(importeTexto) : NaN;
  if (!Number.isFinite(importe) || importe <= 0) {
    return { ok: false, mensaje: "⚠️ El monto del pago no es válido." };
  }

  const fechaPago = comoTexto(body.fecha_pago).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaPago)) {
    return { ok: false, mensaje: "⚠️ La fecha del pago debe tener el formato AAAA-MM-DD." };
  }

  const fechaCruda = comoTexto(body.fecha_cajero);
  const fechaCajero = !Number.isNaN(Date.parse(fechaCruda)) ? new Date(fechaCruda).toISOString() : new Date().toISOString();

  // Ambos opcionales: sin ellos, simplemente no se intenta la vía directa (igual que hoy).
  // Un valor inválido se trata como "no aportado" en vez de rechazar toda la petición — quien
  // hace seguimiento puede no tener aún el dato completo y solo quiere probar historial/
  // transferencia primero.
  const telefonoOrigen = telefonoAFormatoBancamiga(body.telefono_origen);
  const bancoOrigen = normalizarCodigoBanco(comoTexto(body.banco_origen));

  return { ok: true, datos: { comanda, ciudad, imagen, fechaCajero, referencia, importe, fechaPago, telefonoOrigen, bancoOrigen } };
}

export async function POST(request: Request) {
  console.log("🚀 [Bancamiga/Seguimiento] Petición de seguimiento recibida.");

  try {
    // 🔒 1. Solo con el PIN admin — herramienta del equipo, no del cajero.
    const acceso = await verificarAccesoAdmin(request);
    if (acceso.ok === false) {
      return NextResponse.json({ message: acceso.error }, { status: acceso.estado });
    }

    const body = await request.json().catch(() => null);
    if (!body) {
      return NextResponse.json({ message: "Cuerpo de petición inválido." }, { status: 400 });
    }

    const entrada = validarEntrada(body);
    if (entrada.ok === false) {
      return NextResponse.json({ message: entrada.mensaje }, { status: 400 });
    }
    const { comanda, ciudad, imagen, fechaCajero, referencia, importe, fechaPago, telefonoOrigen, bancoOrigen } = entrada.datos;

    const sql = obtenerSql();

    // 🚨 2. Freno de mano de emergencia (mismo interruptor que el flujo del cajero)
    const config = await obtenerConfigSistema();
    if (!config.sistemaActivo) {
      return NextResponse.json({ message: config.mensajeBloqueo || "Sistema suspendido." }, { status: 503 });
    }

    const sufijo = digitosDeCruceBancamiga(referencia) ?? limpiarReferencia(referencia);
    const referenciaBancoConfirmada = comoTexto(body.referencia_banco).trim();

    // 🏦 3. VÍA 1: historial del día (con caché, igual que el cajero)
    const historial = await obtenerHistorialConCache(ciudad, fechaPago);
    if (historial.ok === false) {
      console.warn(`⚠️ [Bancamiga/Seguimiento] Sin respuesta del banco (historial): ${historial.detalle}`);
      return NextResponse.json({ message: historial.mensaje }, { status: 503 });
    }

    let movimiento: MovimientoBancamiga | null = null;
    let pagador: DatosPagadorBancamiga | null = null;
    let movimientoTransferencia: MovimientoTransferenciaBancamiga | null = null;
    let movimientoDirecto: Record<string, unknown> | null = null;

    if (referenciaBancoConfirmada) {
      const resultado = encontrarMovimientoPorReferenciaBancamiga(historial.lista, referenciaBancoConfirmada, importe);
      if (resultado.estado === "NO_ENCONTRADO") {
        return NextResponse.json({ message: resultado.mensaje, via: "HISTORIAL" }, { status: 404 });
      }
      movimiento = resultado.movimiento;
      pagador = resultado.pagador;
    } else {
      const resultado = buscarEnListaBancamiga(historial.lista, referencia, importe);

      if (resultado.estado === "ENCONTRADO") {
        movimiento = resultado.movimiento;
        pagador = resultado.pagador;
      } else {
        // VÍA 2: transferencia/depósito — mismo respaldo que ya usa el cajero.
        console.log(`🔀 [Bancamiga/Seguimiento] Pago Móvil no dio match limpio (${resultado.estado}) para ${sufijo}. Probando transferencia/depósito...`);
        const transferencia = await buscarTransferenciaBancamiga(referencia, importe, fechaPago);

        if (transferencia.estado === "SIN_RESPUESTA") {
          console.warn(`⚠️ [Bancamiga/Seguimiento] Sin respuesta del banco (transferencia): ${transferencia.detalle}`);
          return NextResponse.json({ message: transferencia.mensaje, via: "TRANSFERENCIA" }, { status: 503 });
        }

        if (transferencia.estado === "ENCONTRADO") {
          movimientoTransferencia = transferencia.movimiento;
        } else if (telefonoOrigen && bancoOrigen) {
          // VÍA 3 (NUEVA, solo en este panel): consulta puntual y directa contra Bancamiga,
          // sin depender del historial. Requiere el teléfono de origen completo — quien hace
          // el seguimiento lo consiguió del cliente o de su comprobante sin ocultar.
          console.log(`🎯 [Bancamiga/Seguimiento] Tampoco se halló como transferencia. Probando consulta directa (pm/find/secure)...`);
          const directo = await consultarPagoMovilDirecto({
            telefonoOrigen,
            banco: bancoOrigen,
            monto: importe,
            referencia,
            fecha: fechaPago,
            sucursal: ciudad,
          });

          if (directo.estado === "SIN_RESPUESTA") {
            console.warn(`⚠️ [Bancamiga/Seguimiento] Sin respuesta del banco (consulta directa): ${directo.detalle}`);
            return NextResponse.json({ message: directo.mensaje, via: "DIRECTO" }, { status: 503 });
          }
          if (directo.estado === "VERIFICADO") {
            console.log(`✅ [Bancamiga/Seguimiento] Encontrado por consulta directa tras fallar historial y transferencia.`);
            movimientoDirecto = directo.movimiento;
          } else {
            // RECHAZADO: el banco no confirma este pago ni siquiera por la vía directa —
            // ahora sí, agotadas las tres vías, se conserva el diagnóstico más informativo.
            console.log(`🚫 [Bancamiga/Seguimiento] Consulta directa rechazada (${directo.codigo}): ${directo.mensaje}`);
            return NextResponse.json({
              message: `Se probó por historial, transferencia y consulta directa; ninguna la confirmó. Último detalle (consulta directa): ${directo.mensaje}`,
              via: "NINGUNA",
              codigo: directo.codigo,
            }, { status: directo.noExiste ? 404 : 422 });
          }
        } else {
          // Sin teléfono/banco de origen aportados: no se puede probar la vía directa.
          let mensajeFinal: string;
          if (resultado.estado === "MONTO_DISTINTO") {
            mensajeFinal = resultado.mensaje;
          } else if (resultado.estado === "CANDIDATOS_POR_MONTO") {
            const candidatos = resultado.candidatos
              .map(({ movimiento: m, pagador: p }) => {
                const refBanco = m.NroReferencia || m.NroReferenciaCorto;
                return {
                  referenciaBanco: refBanco,
                  hora: m.HoraMovimiento ?? null,
                  monto: m.Amount,
                  identificacion: p.telefonoPagador,
                  bancoOrigen: p.bancoOrigen,
                  correcciones: distanciaReferencias(sufijo, sufijoReferencia(refBanco, sufijo.length)),
                };
              })
              .sort((a, b) => a.correcciones - b.correcciones);
            return NextResponse.json({
              message: `No encontré esa referencia por Pago Móvil ni como transferencia, pero hay ${candidatos.length} pago(s) por el monto exacto en el historial. Elige cuál es, o aporta el teléfono de origen para probar la consulta directa.`,
              via: "NINGUNA",
              candidatos,
            }, { status: 409 });
          } else {
            mensajeFinal = transferencia.estado === "NO_ENCONTRADO"
              ? `${resultado.mensaje} Tampoco se halló como transferencia (motivos probados: ${transferencia.motivosIntentados.join(", ") || "ninguno, referencia muy corta"}).`
              : resultado.mensaje;
          }
          return NextResponse.json({
            message: `${mensajeFinal} Para probar también la consulta directa, aporta el teléfono de origen y el banco emisor.`,
            via: "NINGUNA",
          }, { status: 404 });
        }
      }
    }

    const esTransferencia = movimientoTransferencia !== null;
    const esDirecto = movimientoDirecto !== null;

    // Resolución de los datos finales según la vía que encontró el pago. Non-null: cada rama
    // de arriba o retorna antes, o deja resuelta exactamente una de las tres variables.
    let telefonoDestino: string | null;
    let referenciaFinal: string;
    let montoFinal: number;
    let bancoOrigenFinal: string | null;
    let telefonoPagadorFinal: string | null;
    let nombrePagadorTransferencia: string | null = null;
    let cedulaPagadorTransferencia: string | null = null;
    let crudoFinal: unknown;

    if (esTransferencia) {
      telefonoDestino = null;
      referenciaFinal = movimientoTransferencia!.referenciaConsultada;
      montoFinal = movimientoTransferencia!.monto;
      bancoOrigenFinal = null;
      telefonoPagadorFinal = null;
      nombrePagadorTransferencia = movimientoTransferencia!.nombre;
      cedulaPagadorTransferencia = movimientoTransferencia!.nroDocumento;
      crudoFinal = movimientoTransferencia;
    } else if (esDirecto) {
      // La cuenta consultada es la misma cuya caché de historial acabamos de leer arriba.
      telefonoDestino = historial.telefonoDestino;
      referenciaFinal = referencia;
      montoFinal = importe;
      bancoOrigenFinal = bancoOrigen;
      telefonoPagadorFinal = telefonoOrigen;
      crudoFinal = movimientoDirecto;
    } else {
      // Pago Móvil por historial: falta el paso de confirmación (§5 más abajo) antes de
      // tener crudoFinal, salvo Mérida — igual que el flujo del cajero.
      telefonoDestino = movimiento!.PhoneDest;
      referenciaFinal = movimiento!.NroReferencia || movimiento!.NroReferenciaCorto;
      montoFinal = movimiento!.Amount;
      bancoOrigenFinal = pagador!.bancoOrigen;
      telefonoPagadorFinal = pagador!.telefonoPagador;
      crudoFinal = null; // se resuelve en el paso 5
    }

    // 🛡️ 4. Duplicado evidente, antes de gastar el paso de confirmación (igual razón que en
    // el flujo del cajero — ver el comentario extenso allá).
    const [yaCobrado] = await conReintentos(() =>
      telefonoDestino === null
        ? sql`SELECT comanda, ciudad FROM transacciones WHERE proveedor = 'BANCAMIGA' AND telefono_destino IS NULL AND referencia = ${referenciaFinal} LIMIT 1;`
        : sql`SELECT comanda, ciudad FROM transacciones WHERE proveedor = 'BANCAMIGA' AND telefono_destino = ${telefonoDestino} AND referencia = ${referenciaFinal} LIMIT 1;`
    );
    if (yaCobrado) {
      return NextResponse.json({
        message: `❌ Este pago YA fue validado anteriormente en la sucursal de: ${yaCobrado.ciudad} (Comanda: ${yaCobrado.comanda || "Sin ID"}). No se puede duplicar.`,
      }, { status: 409 });
    }

    // 🏦 5. Paso de confirmación — solo aplica a la vía de Pago Móvil por historial, y solo
    // fuera de Mérida (mismo contrato sin confirmar que documenta la ruta del cajero).
    let etiquetaProveedor: string;
    if (esTransferencia) {
      etiquetaProveedor = "Transferencia Bancamiga (seguimiento)";
    } else if (esDirecto) {
      etiquetaProveedor = "Pago Móvil Bancamiga (seguimiento directo)";
    } else if (ciudad === "Merida") {
      console.warn(`⚠️ [Bancamiga/Seguimiento] Sucursal Mérida: se registra confiando en el match del historial, sin confirmación final.`);
      crudoFinal = movimiento;
      etiquetaProveedor = "Pago Móvil Bancamiga (seguimiento)";
    } else {
      const confirmacion = await confirmarPagoBancamiga(movimiento!, ciudad, fechaPago);
      if (confirmacion.estado === "SIN_RESPUESTA") {
        console.warn(`⚠️ [Bancamiga/Seguimiento] Sin respuesta del banco al confirmar: ${confirmacion.detalle}`);
        return NextResponse.json({ message: confirmacion.mensaje }, { status: 503 });
      }
      if (confirmacion.estado === "RECHAZADO") {
        console.log(`🚫 [Bancamiga/Seguimiento] El banco rechazó la confirmación (${confirmacion.codigo}): ${confirmacion.mensaje}`);
        return NextResponse.json({ message: confirmacion.mensaje, codigo: confirmacion.codigo }, { status: confirmacion.noExiste ? 404 : 422 });
      }
      crudoFinal = confirmacion.movimiento;
      etiquetaProveedor = "Pago Móvil Bancamiga (seguimiento)";
    }

    // 💾 6-7. Duplicado (a prueba de carrera), INSERT y aviso a Telegram — código compartido
    // con la ruta del cajero, ver bancamiga-registro.ts.
    const resultado = await registrarPagoBancamiga({
      esTransferencia,
      referenciaFinal,
      telefonoDestino,
      bancoOrigen: bancoOrigenFinal,
      telefonoPagador: telefonoPagadorFinal,
      cedulaPagador: cedulaPagadorTransferencia,
      nombrePagador: nombrePagadorTransferencia,
      motivoTransferencia: esTransferencia ? movimientoTransferencia!.motivo : null,
      crudo: crudoFinal,
      monto: montoFinal,
      comanda,
      ciudad,
      imagen,
      fechaCajero,
      fechaPago,
      etiquetaProveedor,
    });

    if (resultado.estado === "DUPLICADO_PREVIO") {
      return NextResponse.json({
        message: `❌ Este pago YA fue validado anteriormente en la sucursal de: ${resultado.ciudad} (Comanda: ${resultado.comanda || "Sin ID"}). No se puede duplicar.`,
      }, { status: 409 });
    }
    if (resultado.estado === "DUPLICADO_CARRERA") {
      return NextResponse.json({
        message: `❌ Este pago acaba de ser validado por otra sesión en: ${resultado.ciudad} (Comanda: ${resultado.comanda || "Sin ID"}). No se puede duplicar.`,
      }, { status: 409 });
    }

    const via = esTransferencia ? "TRANSFERENCIA" : esDirecto ? "DIRECTO" : "HISTORIAL";
    console.log(`✅ [Bancamiga/Seguimiento] Pago ${referenciaFinal} registrado (vía ${via}) como transacción ${resultado.id}.`);

    return NextResponse.json({
      message: resultado.notificacionTelegram
        ? "¡Pago confirmado y registrado con éxito!"
        : "¡Pago confirmado y registrado con éxito! (No se pudo enviar el aviso al grupo de Telegram.)",
      notificacionTelegram: resultado.notificacionTelegram,
      via,
      pago: { referencia: referenciaFinal, monto: montoFinal },
    }, { status: 200 });

  } catch (error) {
    console.error("❌ [Bancamiga/Seguimiento] Error:", error);
    if (esErrorDeConexion(error)) {
      return NextResponse.json(
        { message: "⚠️ Fallo temporal de conexión con la base de datos. Inténtalo de nuevo en unos segundos." },
        { status: 503 }
      );
    }
    return NextResponse.json({ message: "Error interno en el servidor." }, { status: 500 });
  }
}
