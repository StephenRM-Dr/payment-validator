import { NextResponse } from "next/server";
import { obtenerSql, conReintentos, esErrorDeConexion } from "../../../lib/db";
import { VALORES_SUCURSALES } from "../../../lib/sucursales";
import { peticionDeCajeroValida } from "../../../lib/token-cajero";
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
import { obtenerConfigSistema } from "../../../lib/config-sistema";
import { registrarPagoBancamiga } from "../../../lib/proveedores/bancamiga-registro";
import { distanciaReferencias, sufijoReferencia, limpiarReferencia } from "../../../lib/proveedores/referencias";
import { normalizarCodigoBanco } from "../../../lib/bancos";
import { LONGITUD_MAX_COMANDA } from "../../../lib/validacion";
import { normalizarImporte } from "../../../lib/proveedores/prompts";
import { comoTexto } from "../../../lib/http";
import { LONGITUD_MAX_IMAGEN } from "../../../lib/imagenes";

// Verificación de Bancamiga (Pago Móvil, y transferencias/depósitos como respaldo), a través
// del puente `servidor-bancamiga/`. Un solo botón/proveedor en el cajero — ver plan de
// "Bancamiga: validar transferencias/depósitos (consulta/trx) como respaldo del Pago Móvil".
//
// Mismo flujo de dos pasos que verificar-sofitasa/route.ts para Pago Móvil, aunque aquí ambos
// endpoints del puente son de solo lectura y repetibles:
//
//   1. Se busca el pago en el historial del día de la sucursal, cruzando por referencia y
//      monto — de ahí sale también el teléfono del pagador, que /bancamiga/verificar
//      necesita como filtro y que el cajero no tiene por qué conocer. El historial se
//      obtiene vía obtenerHistorialConCache() (bancamiga-cache.ts), no directo del puente:
//      el banco recomienda no consultarlo más de una vez cada 10 minutos por sucursal, y una
//      sucursal con varias ventas seguidas agotaría ese límite si cada verificación llamara
//      al puente por su cuenta.
//   2. Se confirma con /bancamiga/verificar usando ese teléfono ya conocido, como paso
//      final de más confianza antes de escribir en la base de datos. Sin cooldown — de solo
//      lectura y repetible sin límite del lado del banco.
//
// Si el paso 1 NO da un match limpio de Pago Móvil (NO_ENCONTRADO, pero también
// CANDIDATOS_POR_MONTO o MONTO_DISTINTO — un comprobante real puede coincidir por casualidad
// con la referencia o el monto de un movimiento de Pago Móvil ajeno cuando el pago de verdad
// es una transferencia distinta), se prueba TAMBIÉN como transferencia/depósito vía
// consulta/trx (buscarTransferenciaBancamiga(), probando motivo=CE/CI/CD) antes de responder
// con la ambigüedad del lado de Pago Móvil. Es un sistema bancario distinto al de Pago Móvil,
// sin teléfono ni lista de candidatos: el banco devuelve como máximo un resultado exacto por
// intento, así que ese caso es "buscar → insertar" directo, sin el paso 2 de confirmación (no
// aplica: no hay un segundo endpoint que confirme una transferencia ya encontrada por
// referencia exacta). Si tampoco se resuelve por esa vía, se conserva la respuesta ORIGINAL
// de Pago Móvil (NO_ENCONTRADO / CANDIDATOS_POR_MONTO / MONTO_DISTINTO), que sigue siendo la
// más informativa para el cajero en esos tres casos.

interface EntradaValida {
  comanda: string;
  ciudad: string;
  imagen: string;
  fechaCajero: string;
  referencia: string;
  importe: number;
  fechaPago: string;
  telefonoOrigen: string | null;
  bancoOrigen: string | null;
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

  // Ambos opcionales: sin ellos, simplemente no se intenta la vía directa (igual que antes de
  // este campo existir). Un valor inválido se trata como "no aportado" en vez de rechazar
  // toda la petición — el cajero puede no tener aún el dato completo y solo quiere probar
  // historial/transferencia primero. Mismo criterio que ya usa
  // app/api/admin/bancamiga-seguimiento/route.ts.
  const telefonoOrigen = telefonoAFormatoBancamiga(body.telefono_origen);
  const bancoOrigen = normalizarCodigoBanco(comoTexto(body.banco_origen));

  return { ok: true, datos: { comanda, ciudad, imagen, fechaCajero, referencia, importe, fechaPago, telefonoOrigen, bancoOrigen } };
}

export async function POST(request: Request) {
  console.log("🚀 [Bancamiga] Petición de verificación de Pago Móvil recibida.");

  try {
    // 🔒 1. Solo desde el panel del cajero
    if (!(await peticionDeCajeroValida(request))) {
      console.warn("⚠️ [Bancamiga] Petición rechazada: sin credencial de cajero.");
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
    const { comanda, ciudad, imagen, fechaCajero, referencia, importe, fechaPago, telefonoOrigen, bancoOrigen } = entrada.datos;

    const sql = obtenerSql();

    // 🚨 2. Freno de mano de emergencia
    const config = await obtenerConfigSistema();
    if (!config.sistemaActivo) {
      return NextResponse.json({ message: config.mensajeBloqueo || "Sistema suspendido." }, { status: 503 });
    }

    // digitosDeCruce() y no 'referencia.slice(-digitosAComparar(referencia))': con una
    // referencia demasiado corta (menos de DIGITOS_REFERENCIA_MIN dígitos significativos —
    // visto en producción con BBVA Provincial, 5 dígitos), digitosAComparar() devuelve 0 y
    // 'slice(-0)' en JavaScript equivale a 'slice(0)': devuelve el string COMPLETO en vez de
    // nada, porque -0 no cuenta como negativo. digitosDeCruce() ya maneja ese caso (null), y
    // aquí se cae a la referencia limpia completa como sufijo de respaldo. Solo se usa para
    // etiquetar candidatos y mensajes de log — el chequeo de duplicado real se hace más abajo,
    // una vez resuelto el movimiento (ver el comentario ahí).
    const sufijo = digitosDeCruceBancamiga(referencia) ?? limpiarReferencia(referencia);

    // 🏦 3. PASO 1: localizar el pago en el historial del día (con caché — ver el comentario
    // del import de arriba sobre el cooldown de 10 minutos del banco).
    const referenciaBancoConfirmada = comoTexto(body.referencia_banco).trim();

    const historial = await obtenerHistorialConCache(ciudad, fechaPago);
    if (historial.ok === false) {
      console.warn(`⚠️ [Bancamiga] Sin respuesta del banco (historial): ${historial.detalle}`);
      return NextResponse.json({ message: historial.mensaje }, { status: 503 });
    }

    let movimiento: MovimientoBancamiga | null = null;
    let pagador: DatosPagadorBancamiga | null = null;
    let movimientoTransferencia: MovimientoTransferenciaBancamiga | null = null;
    let movimientoDirecto: Record<string, unknown> | null = null;

    if (referenciaBancoConfirmada) {
      const resultado = encontrarMovimientoPorReferenciaBancamiga(historial.lista, referenciaBancoConfirmada, importe);
      if (resultado.estado === "NO_ENCONTRADO") {
        return NextResponse.json({ message: resultado.mensaje }, { status: 404 });
      }
      movimiento = resultado.movimiento;
      pagador = resultado.pagador;
    } else {
      const resultado = buscarEnListaBancamiga(historial.lista, referencia, importe);

      if (resultado.estado === "ENCONTRADO") {
        movimiento = resultado.movimiento;
        pagador = resultado.pagador;
      } else {
        // MONTO_DISTINTO, CANDIDATOS_POR_MONTO o NO_ENCONTRADO: antes de responder con la
        // ambigüedad del lado de Pago Móvil, se prueba TAMBIÉN como transferencia/depósito
        // (consulta/trx) — ver la nota de cabecera de este archivo sobre por qué.
        let razon: string;
        if (resultado.estado === "MONTO_DISTINTO") {
          razon = `otro monto (banco: Bs. ${resultado.montoBanco})`;
        } else if (resultado.estado === "CANDIDATOS_POR_MONTO") {
          razon = `${resultado.candidatos.length} candidato(s) ambiguos por monto`;
        } else {
          razon = `${resultado.movimientosRevisados} movimientos revisados, ninguno coincide`;
        }
        console.log(`🔀 [Bancamiga] Pago Móvil: referencia ${sufijo} con ${razon}. Probando también transferencia/depósito...`);

        const transferencia = await buscarTransferenciaBancamiga(referencia, importe, fechaPago);

        if (transferencia.estado === "SIN_RESPUESTA") {
          console.warn(`⚠️ [Bancamiga] Sin respuesta del banco (transferencia): ${transferencia.detalle}`);
          return NextResponse.json({ message: transferencia.mensaje }, { status: 503 });
        }
        if (transferencia.estado === "MONTO_DISTINTO") {
          console.log(`🚫 [Bancamiga] Transferencia hallada con otro monto (banco: ${transferencia.montoBanco}).`);
          return NextResponse.json({ message: transferencia.mensaje }, { status: 409 });
        }

        if (transferencia.estado === "ENCONTRADO") {
          console.log(`✅ [Bancamiga] Encontrada como transferencia (motivo ${transferencia.movimiento.motivo}) tras un resultado ambiguo en Pago Móvil.`);
          movimientoTransferencia = transferencia.movimiento;
        } else if (telefonoOrigen && bancoOrigen) {
          // VÍA 3: consulta puntual y directa contra Bancamiga (pm/find/secure), sin depender
          // del historial ni de consulta/trx — mismo respaldo que ya usa el panel de
          // seguimiento del equipo (bancamiga-seguimiento/route.ts). Requiere que el cajero
          // haya aportado el teléfono completo del pagador y su banco emisor.
          console.log(`🎯 [Bancamiga] Tampoco se halló como transferencia. Probando consulta directa (pm/find/secure)...`);
          const directo = await consultarPagoMovilDirecto({
            telefonoOrigen,
            banco: bancoOrigen,
            monto: importe,
            referencia,
            fecha: fechaPago,
            sucursal: ciudad,
          });

          if (directo.estado === "SIN_RESPUESTA") {
            console.warn(`⚠️ [Bancamiga] Sin respuesta del banco (consulta directa): ${directo.detalle}`);
            return NextResponse.json({ message: directo.mensaje }, { status: 503 });
          }
          if (directo.estado === "VERIFICADO") {
            console.log(`✅ [Bancamiga] Encontrado por consulta directa tras fallar historial y transferencia.`);
            movimientoDirecto = directo.movimiento;
          } else {
            // RECHAZADO: agotadas las tres vías, se conserva el diagnóstico más informativo.
            console.log(`🚫 [Bancamiga] Consulta directa rechazada (${directo.codigo}): ${directo.mensaje}`);
            return NextResponse.json({
              message: `Se probó por historial, transferencia y consulta directa; ninguna la confirmó. Último detalle (consulta directa): ${directo.mensaje}`,
              codigo: directo.codigo,
            }, { status: directo.noExiste ? 404 : 422 });
          }
        } else {
          // Tampoco se resolvió como transferencia (NO_ENCONTRADO) y no hay teléfono/banco de
          // origen para probar la vía directa: se conserva la respuesta ORIGINAL de Pago
          // Móvil, que sigue siendo la más informativa para el cajero en cada uno de los tres
          // casos — con una nota invitando a aportar el teléfono si lo tiene.
          if (resultado.estado === "MONTO_DISTINTO") {
            console.log(`🚫 [Bancamiga] Referencia ${sufijo} hallada con otro monto (banco: ${resultado.montoBanco}).`);
            return NextResponse.json({ message: resultado.mensaje }, { status: 409 });
          }
          if (resultado.estado === "CANDIDATOS_POR_MONTO") {
            console.log(`❓ [Bancamiga] Referencia ${sufijo} no hallada; ${resultado.candidatos.length} pago(s) por Bs. ${importe.toFixed(2)} para confirmar.`);
            const candidatos = resultado.candidatos
              .map(({ movimiento: m, pagador: p }) => {
                const refBanco = m.NroReferencia || m.NroReferenciaCorto;
                return {
                  referenciaBanco: refBanco,
                  hora: m.HoraMovimiento ?? null,
                  monto: m.Amount,
                  pagador: null as string | null,
                  identificacion: p.telefonoPagador,
                  bancoOrigen: p.bancoOrigen,
                  correcciones: distanciaReferencias(sufijo, sufijoReferencia(refBanco, sufijo.length)),
                };
              })
              .sort((a, b) => a.correcciones - b.correcciones);

            return NextResponse.json({
              message: (candidatos.length === 1
                ? "No encontré esa referencia, pero sí un pago por el monto exacto. Comprueba que sea el del cliente y confírmalo."
                : `No encontré esa referencia, pero hay ${candidatos.length} pagos por el monto exacto. Elige cuál es el del cliente.`) +
                " O, si tienes el teléfono de origen del pagador, aporta también el banco emisor para probar la consulta directa.",
              candidatos,
            }, { status: 409 });
          }
          // NO_ENCONTRADO
          console.log(`🚫 [Bancamiga] Tampoco se halló como transferencia (motivos probados: ${transferencia.motivosIntentados.join(", ") || "ninguno, referencia muy corta"}).`);
          return NextResponse.json({
            message: `${resultado.mensaje} Si tienes el teléfono de origen completo del pagador, aporta también el banco emisor para probar la consulta directa.`,
          }, { status: 404 });
        }
      }
    }

    const esTransferencia = movimientoTransferencia !== null;
    const esDirecto = movimientoDirecto !== null;

    // Non-null: cada rama de arriba o retorna antes, o deja exactamente una de las tres
    // variables (movimiento+pagador para Pago Móvil, movimientoTransferencia para
    // transferencia, movimientoDirecto para la consulta puntual) — TypeScript no lo infiere
    // aquí porque el proyecto compila sin strict.
    const telefonoDestino = esTransferencia ? null : esDirecto ? historial.telefonoDestino : movimiento!.PhoneDest;
    const referenciaFinal = esTransferencia
      ? movimientoTransferencia!.referenciaConsultada
      : esDirecto
        ? referencia
        : movimiento!.NroReferencia || movimiento!.NroReferenciaCorto;
    const montoFinal = esTransferencia ? movimientoTransferencia!.monto : esDirecto ? importe : movimiento!.Amount;
    const nombrePagadorTransferencia = esTransferencia ? movimientoTransferencia!.nombre : null;
    const cedulaPagadorTransferencia = esTransferencia ? movimientoTransferencia!.nroDocumento : null;

    // 🛡️ 4. Duplicado evidente, ya con el movimiento real resuelto — recién aquí se conoce el
    // telefono_destino real, que es la clave de unicidad de Bancamiga (migración 006), no el
    // sufijo de la referencia por sí solo. Comparación EXACTA (no LIKE por sufijo): varias
    // sucursales pueden compartir el mismo número registrado en el banco (ver conversación
    // sobre el número compartido de San Cristóbal), así que un LIKE sin acotar por teléfono
    // podía confundir pagos de sucursales distintas, y con referencias cortas (por debajo de
    // DIGITOS_MIN_BANCAMIGA) el sufijo de respaldo era casi la referencia completa sin acotar,
    // dando falsos positivos. Con el movimiento ya resuelto no hace falta LIKE: se compara la
    // referencia exacta del banco, igual que la restricción única real de la tabla. Este
    // chequeo se REPITE dentro de registrarPagoBancamiga() justo antes del INSERT (a prueba de
    // carrera entre dos verificaciones simultáneas) — aquí se hace temprano, antes de gastar la
    // llamada de confirmación del paso 5, para no confirmar con el banco algo que ya sabemos
    // que está duplicado.
    //
    // Una transferencia no tiene telefono_destino (consulta/trx no devuelve teléfono alguno):
    // se compara solo por referencia, acotado a telefono_destino IS NULL — ver migración 008,
    // el índice de la 006 no protege este caso porque Postgres nunca empareja NULL con NULL.
    const [yaCobrado] = await conReintentos(() =>
      esTransferencia
        ? sql`
            SELECT comanda, ciudad
            FROM transacciones
            WHERE proveedor = 'BANCAMIGA' AND telefono_destino IS NULL AND referencia = ${referenciaFinal}
            LIMIT 1;
          `
        : sql`
            SELECT comanda, ciudad
            FROM transacciones
            WHERE proveedor = 'BANCAMIGA' AND telefono_destino = ${telefonoDestino} AND referencia = ${referenciaFinal}
            LIMIT 1;
          `
    );
    if (yaCobrado) {
      return NextResponse.json({
        message: `❌ Este pago${esTransferencia ? "" : " móvil"} YA fue validado anteriormente en la sucursal de: ${yaCobrado.ciudad} (Comanda: ${yaCobrado.comanda || "Sin ID"}). No se puede duplicar.`,
      }, { status: 409 });
    }

    // 🏦 5. PASO 2: confirmar con /bancamiga/verificar, usando el teléfono ya conocido —
    // salvo en Mérida y salvo transferencias. Para Mérida, /bancamiga/verificar (pm/find, la
    // variante sin "/secure" que exige el teléfono propio de Mérida) no tiene un contrato
    // confirmado: rechazó pagos reales con "El teléfono no cumple el formato de 12 dígitos"
    // pese a tener el formato correcto, en dos formatos de teléfono distintos probados. Hasta
    // tener el contrato real, para Mérida se confía directamente en el match del historial
    // (referencia + monto exactos, la misma evidencia que ya usan las demás sucursales) —
    // decisión explícita del negocio: mejor registrar un pago real que bloquearlo por una
    // confirmación que no se puede completar.
    //
    // Para transferencias, el salto es una necesidad lógica, no una extensión de la excepción
    // de Mérida: /bancamiga/verificar envuelve pm/find/pm/find/secure, que exigen
    // Phone_orig/Phone_dest — una transferencia no tiene ninguno de los dos.
    // consulta/trx ya es en sí misma una consulta puntual y autoritativa (referencia+fecha+
    // motivo exactos), así que no hay un segundo endpoint de confirmación al que llamar.
    const esMerida = ciudad === "Merida";

    let crudoFinal: unknown;

    if (esTransferencia) {
      console.log(`✅ [Bancamiga] Transferencia confirmada vía consulta/trx (motivo ${movimientoTransferencia!.motivo}); sin paso de confirmación adicional (no aplica a este flujo).`);
      crudoFinal = movimientoTransferencia;
    } else if (esDirecto) {
      console.log(`✅ [Bancamiga] Pago confirmado vía consulta directa (pm/find/secure); sin paso de confirmación adicional (ya es la confirmación).`);
      crudoFinal = movimientoDirecto;
    } else if (esMerida) {
      console.warn(`⚠️ [Bancamiga] Sucursal Mérida: se registra confiando en el match del historial, sin confirmación final de /bancamiga/verificar (contrato de pm/find sin confirmar).`);
      crudoFinal = movimiento;
    } else {
      const confirmacion = await confirmarPagoBancamiga(movimiento!, ciudad, fechaPago);

      if (confirmacion.estado === "SIN_RESPUESTA") {
        console.warn(`⚠️ [Bancamiga] Sin respuesta del banco al confirmar: ${confirmacion.detalle}`);
        return NextResponse.json({ message: confirmacion.mensaje }, { status: 503 });
      }
      if (confirmacion.estado === "RECHAZADO") {
        console.log(`🚫 [Bancamiga] El banco rechazó la confirmación (${confirmacion.codigo}): ${confirmacion.mensaje}`);
        return NextResponse.json({ message: confirmacion.mensaje, codigo: confirmacion.codigo }, { status: confirmacion.noExiste ? 404 : 422 });
      }

      crudoFinal = confirmacion.movimiento;
    }

    // 💾 6-7. Duplicado (a prueba de carrera), INSERT y aviso a Telegram — lógica compartida
    // con el panel de seguimiento del equipo, ver bancamiga-registro.ts.
    const resultado = await registrarPagoBancamiga({
      esTransferencia,
      referenciaFinal,
      telefonoDestino,
      bancoOrigen: esTransferencia ? null : esDirecto ? bancoOrigen : pagador!.bancoOrigen,
      telefonoPagador: esTransferencia ? null : esDirecto ? telefonoOrigen : pagador!.telefonoPagador,
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
      etiquetaProveedor: esTransferencia ? "Transferencia Bancamiga" : esDirecto ? "Pago Móvil Bancamiga (directo)" : "Pago Móvil Bancamiga",
    });

    if (resultado.estado === "DUPLICADO_PREVIO") {
      return NextResponse.json({
        message: `❌ Este pago${esTransferencia ? "" : " móvil"} YA fue validado anteriormente en la sucursal de: ${resultado.ciudad} (Comanda: ${resultado.comanda || "Sin ID"}). No se puede duplicar.`,
      }, { status: 409 });
    }
    if (resultado.estado === "DUPLICADO_CARRERA") {
      return NextResponse.json({
        message: `❌ Este pago${esTransferencia ? "" : " móvil"} acaba de ser validado por otro cajero en: ${resultado.ciudad} (Comanda: ${resultado.comanda || "Sin ID"}). No se puede duplicar.`,
      }, { status: 409 });
    }

    const mensajeExito = esTransferencia
      ? "¡Transferencia confirmada en el banco y registrada con éxito!"
      : "¡Pago móvil confirmado en el banco y registrado con éxito!";

    return NextResponse.json({
      message: resultado.notificacionTelegram
        ? mensajeExito
        : `${mensajeExito} (No se pudo enviar el aviso al grupo de Telegram.)`,
      notificacionTelegram: resultado.notificacionTelegram,
      pago: {
        referencia: referenciaFinal,
        monto: montoFinal,
        pagador: esTransferencia ? nombrePagadorTransferencia : null,
        identificacion: esTransferencia ? cedulaPagadorTransferencia : pagador!.telefonoPagador,
      },
    }, { status: 200 });

  } catch (error) {
    console.error("❌ [Bancamiga] Error en la verificación:", error);

    if (esErrorDeConexion(error)) {
      return NextResponse.json(
        { message: "⚠️ Fallo temporal de conexión con la base de datos. Inténtalo de nuevo en unos segundos." },
        { status: 503 }
      );
    }

    return NextResponse.json({ message: "Error interno en el servidor." }, { status: 500 });
  }
}
