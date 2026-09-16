// Registro compartido de un pago Bancamiga YA resuelto (chequeo de duplicado + INSERT +
// aviso a Telegram) — sea que se haya encontrado por Pago Móvil (historial), por
// transferencia/depósito (consulta/trx) o por la consulta directa (pm/find/secure, ver
// consultarPagoMovilDirecto() en bancamiga.ts).
//
// Vive aparte de app/api/transacciones/verificar-bancamiga/route.ts porque a partir de ahora
// dos rutas necesitan exactamente esta misma lógica de "ya con el movimiento identificado,
// falta comprobar duplicado y escribirlo": la del cajero, y el panel de seguimiento del
// equipo (app/api/admin/bancamiga-seguimiento/route.ts) que reintenta pagos que el cajero no
// pudo cerrar en el momento. Un bug de duplicado corregido en un solo sitio y no en el otro es
// peor que la duplicación de código que esto evita.

import { obtenerSql, conReintentos } from "../db.ts";
import { notificarPagoVerificado } from "../telegram.ts";
import { MONEDA_BANCAMIGA } from "../sucursales.ts";

export interface DatosRegistroBancamiga {
  esTransferencia: boolean;
  referenciaFinal: string;
  // null cuando esTransferencia: consulta/trx no devuelve teléfono, y el índice único de esa
  // vía (migración 008) exige telefono_destino IS NULL — ver la nota en la ruta del cajero.
  telefonoDestino: string | null;
  bancoOrigen: string | null;
  telefonoPagador: string | null;
  cedulaPagador: string | null; // solo transferencia
  nombrePagador: string | null; // solo transferencia
  motivoTransferencia: string | null; // solo transferencia (CE/CI/CD)
  crudo: unknown; // se guarda tal cual en bancamiga_raw, para auditoría
  monto: number;
  comanda: string;
  ciudad: string;
  imagen: string;
  fechaCajero: string;
  fechaPago: string;
  // Lo que se le muestra al grupo de Telegram y queda en los logs — distingue el origen
  // (cajero en el momento de la venta, vs. seguimiento posterior del equipo).
  etiquetaProveedor: string;
}

export type ResultadoRegistroBancamiga =
  | { estado: "REGISTRADO"; id: number; notificacionTelegram: boolean }
  // Ya estaba cobrado ANTES de intentar esta verificación.
  | { estado: "DUPLICADO_PREVIO"; ciudad: string; comanda: string | null }
  // Se perdió la carrera contra otra verificación simultánea, entre el chequeo y el INSERT.
  | { estado: "DUPLICADO_CARRERA"; ciudad: string; comanda: string | null };

async function buscarDuplicado(sql: ReturnType<typeof obtenerSql>, datos: DatosRegistroBancamiga) {
  const [fila] = await conReintentos(() =>
    datos.esTransferencia
      ? sql`
          SELECT comanda, ciudad
          FROM transacciones
          WHERE proveedor = 'BANCAMIGA' AND telefono_destino IS NULL AND referencia = ${datos.referenciaFinal}
          LIMIT 1;
        `
      : sql`
          SELECT comanda, ciudad
          FROM transacciones
          WHERE proveedor = 'BANCAMIGA' AND telefono_destino = ${datos.telefonoDestino} AND referencia = ${datos.referenciaFinal}
          LIMIT 1;
        `
  );
  return fila as { comanda: string | null; ciudad: string } | undefined;
}

/**
 * Comprueba duplicado, inserta el pago ya confirmado, y avisa a Telegram (best-effort).
 * No lanza por un aviso fallido a Telegram — solo se registra en el log, igual que en la
 * ruta del cajero (el pago ya quedó guardado, eso es lo que importa).
 */
export async function registrarPagoBancamiga(datos: DatosRegistroBancamiga): Promise<ResultadoRegistroBancamiga> {
  const sql = obtenerSql();

  // 🛡️ Duplicado evidente, ANTES de tocar el banco de nuevo o insertar.
  const yaCobrado = await buscarDuplicado(sql, datos);
  if (yaCobrado) {
    return { estado: "DUPLICADO_PREVIO", ciudad: yaCobrado.ciudad, comanda: yaCobrado.comanda };
  }

  // 💾 INSERT. Dos formas distintas: Postgres exige que el arbiter de ON CONFLICT empate
  // exactamente con un índice único existente, y Pago Móvil/directo comparten uno
  // (migración 006, por telefono_destino+referencia) mientras que transferencia usa otro
  // (migración 008, por referencia con telefono_destino IS NULL) — no se puede parametrizar
  // un solo INSERT para ambos casos.
  const [registrada] = datos.esTransferencia
    ? await sql`
        INSERT INTO transacciones (
          proveedor, referencia, banco_origen, telefono_pagador, telefono_destino,
          cedula_pagador, pagador, motivo_bancamiga,
          bancamiga_raw, monto, moneda, estado, comanda, ciudad, imagen_comprobante_base64,
          fecha_cajero, fecha_validacion, fecha_pago
        ) VALUES (
          'BANCAMIGA',
          ${datos.referenciaFinal},
          NULL,
          NULL,
          NULL,
          ${datos.cedulaPagador},
          ${datos.nombrePagador},
          ${datos.motivoTransferencia},
          ${JSON.stringify(datos.crudo)}::jsonb,
          ${datos.monto},
          ${MONEDA_BANCAMIGA},
          'VERIFICADO',
          ${datos.comanda},
          ${datos.ciudad},
          ${datos.imagen},
          ${datos.fechaCajero},
          ${new Date().toISOString()},
          ${datos.fechaPago}
        )
        ON CONFLICT (referencia)
          WHERE proveedor = 'BANCAMIGA' AND telefono_destino IS NULL AND referencia IS NOT NULL DO NOTHING
        RETURNING id;
      `
    : await sql`
        INSERT INTO transacciones (
          proveedor, referencia, banco_origen, telefono_pagador, telefono_destino,
          bancamiga_raw, monto, moneda, estado, comanda, ciudad, imagen_comprobante_base64,
          fecha_cajero, fecha_validacion, fecha_pago
        ) VALUES (
          'BANCAMIGA',
          ${datos.referenciaFinal},
          ${datos.bancoOrigen},
          ${datos.telefonoPagador},
          ${datos.telefonoDestino},
          ${JSON.stringify(datos.crudo)}::jsonb,
          ${datos.monto},
          ${MONEDA_BANCAMIGA},
          'VERIFICADO',
          ${datos.comanda},
          ${datos.ciudad},
          ${datos.imagen},
          ${datos.fechaCajero},
          ${new Date().toISOString()},
          ${datos.fechaPago}
        )
        ON CONFLICT (telefono_destino, referencia)
          WHERE proveedor = 'BANCAMIGA' AND referencia IS NOT NULL DO NOTHING
        RETURNING id;
      `;

  if (!registrada) {
    // Otra verificación registró este mismo comprobante entre el chequeo y el INSERT.
    const ganador = await buscarDuplicado(sql, datos);
    return { estado: "DUPLICADO_CARRERA", ciudad: ganador?.ciudad ?? "otra sucursal", comanda: ganador?.comanda ?? null };
  }

  console.log(`✅ [Bancamiga] Pago ${datos.referenciaFinal} confirmado y registrado como transacción ${registrada.id} (${datos.etiquetaProveedor}).`);

  // 📨 Notificación a Telegram (best-effort, nunca bloquea ni falla el registro)
  const notificacion = await notificarPagoVerificado({
    comanda: datos.comanda,
    monto: datos.monto,
    moneda: MONEDA_BANCAMIGA,
    ciudad: datos.ciudad,
    imagenBase64: datos.imagen,
    proveedor: datos.etiquetaProveedor,
    referencia: datos.referenciaFinal,
  });

  if (notificacion.enviada === false) {
    console.warn(`⚠️ [Bancamiga] Pago ${registrada.id} verificado pero sin aviso a Telegram (${notificacion.motivo}): ${notificacion.detalle}`);
  }

  return { estado: "REGISTRADO", id: registrada.id, notificacionTelegram: notificacion.enviada };
}
