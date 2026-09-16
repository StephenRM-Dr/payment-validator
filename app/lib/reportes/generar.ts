import { obtenerSql, conReintentos, type SqlNeon } from "../db.ts";
import { rangoDelDiaEnVenezuela, fechaISOVenezuela } from "./tiempo.ts";
import { armarWorkbookExcel, type FilaReporte } from "./excel.ts";
import { nombreDeArchivo } from "./nombres.ts";
export { nombreDeArchivo };

export interface ReporteGenerado {
  nombre: string;
  buffer: Buffer;
}

// Fila cruda de la consulta SQL. Postgres NUMERIC llega como texto por el driver
// (evita perder precisión con floats) — de ahí que 'monto' sea string aquí también.
interface FilaCruda {
  proveedor: string;
  monto: string;
  moneda: string;
  comanda: string | null;
  fecha_validacion: string | Date;
  binance_id_completo: string | null;
  referencia: string | null;
  pagador: string | null;
  telefono_pagador: string | null;
  cedula_pagador: string | null;
}

async function filasVerificadasDeSucursal(sql: SqlNeon, sucursal: string, inicio: Date, fin: Date): Promise<FilaReporte[]> {
  const filas = (await conReintentos(() => sql`
    SELECT proveedor, monto, moneda, comanda,
           fecha_validacion AT TIME ZONE 'UTC' AS fecha_validacion,
           binance_id_completo, referencia, pagador, telefono_pagador, cedula_pagador
    FROM transacciones
    WHERE estado = 'VERIFICADO'
      AND (anulada IS NOT TRUE)
      AND ciudad = ${sucursal}
      AND fecha_validacion >= ${inicio.toISOString()}
      AND fecha_validacion <  ${fin.toISOString()}
    ORDER BY fecha_validacion;
  `)) as unknown as FilaCruda[];

  return filas.map((fila) => ({
    // AT TIME ZONE 'UTC' en la consulta obliga al driver a devolver un instante UTC
    // inequívoco — sin eso, un timestamp sin zona se interpreta según la hora local del
    // proceso Node (distinta en desarrollo y en producción). Mismo fix que
    // /api/admin/auditoria/route.ts.
    fecha: new Date(fila.fecha_validacion),
    comanda: fila.comanda,
    proveedor: fila.proveedor,
    monto: fila.monto,
    moneda: fila.moneda,
    referencia: fila.proveedor === "BINANCE" ? fila.binance_id_completo : fila.referencia,
    pagador: fila.pagador || fila.telefono_pagador || fila.cedula_pagador,
  }));
}

// null = sin pagos verificados ese día (no es un error: el endpoint lo traduce a 204).
export async function generarReporteExcel(fecha: Date, sucursal: string): Promise<ReporteGenerado | null> {
  const sql = obtenerSql();
  const { inicio, fin } = rangoDelDiaEnVenezuela(fecha);

  const filas = await filasVerificadasDeSucursal(sql, sucursal, inicio, fin);
  if (filas.length === 0) return null;

  const buffer = await armarWorkbookExcel(filas);
  const nombre = nombreDeArchivo(sucursal, fechaISOVenezuela(inicio));
  return { nombre, buffer };
}
