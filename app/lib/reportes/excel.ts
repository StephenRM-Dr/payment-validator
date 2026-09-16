import ExcelJS from "exceljs";
import { formatearFechaHoraVenezuela } from "./tiempo.ts";

// Fila normalizada, ya independiente de las diferencias entre proveedores (Binance usa
// binance_id_completo/pagador, Pago Móvil usa referencia/telefono_pagador/cedula_pagador):
// esa normalización vive en generar.ts, para que este módulo no sepa nada de esas
// diferencias y sea trivial de probar con datos de ejemplo.
export interface FilaReporte {
  fecha: Date;
  comanda: string | null;
  proveedor: string;
  monto: string; // NUMERIC de Postgres llega como texto por el driver — se convierte a número solo al escribir la celda
  moneda: string;
  referencia: string | null;
  pagador: string | null;
}

const ENCABEZADOS = ["Fecha", "Comanda", "Proveedor", "Monto", "Moneda", "Referencia", "Pagador"];

export async function armarWorkbookExcel(filas: FilaReporte[]): Promise<Buffer> {
  const libro = new ExcelJS.Workbook();
  const hoja = libro.addWorksheet("Pagos verificados");
  hoja.addRow(ENCABEZADOS);

  for (const fila of filas) {
    hoja.addRow([
      formatearFechaHoraVenezuela(fila.fecha),
      fila.comanda ?? null,
      fila.proveedor,
      Number(fila.monto), // como número: para que la sucursal pueda sumar la columna en Excel sin convertir texto
      fila.moneda,
      fila.referencia ?? null,
      fila.pagador ?? null,
    ]);
  }

  const buffer = await libro.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
