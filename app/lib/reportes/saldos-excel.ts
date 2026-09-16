import ExcelJS from "exceljs";
import type { FilaSaldo } from "../proveedores/saldos-tipos.ts";

const FORMATO_MONTO = "#,##0.00";

// Orden fijo del reporte contable "CTAS JURIDICAS" que ya usaba el negocio antes de este
// panel (una hoja de cálculo llevada a mano). Los bancos con 'origen: null' todavía no
// tienen una consulta de saldo integrada: quedan en 0,00 hasta que se sumen, igual que ya
// pasó con Sofitasa y BDV — así el formato no cambia otra vez cuando se agregue el próximo.
const LINEAS_CTAS_JURIDICAS: { etiqueta: string; origen: { proveedor: string; empresa: string } | null }[] = [
  { etiqueta: "Banesco Acme Corp", origen: null },
  { etiqueta: "Banesco Beta Corp", origen: null },
  { etiqueta: "Vzla Acme Corp", origen: { proveedor: "BDV", empresa: "acme" } },
  { etiqueta: "Vzla Beta Corp", origen: { proveedor: "BDV", empresa: "beta" } },
  { etiqueta: "Sofitasa acme", origen: { proveedor: "SOFITASA", empresa: "acme" } },
  { etiqueta: "Sofitasa beta", origen: { proveedor: "SOFITASA", empresa: "beta" } },
  { etiqueta: "Bancamiga Acme", origen: null },
  { etiqueta: "Bancamiga Merida", origen: null },
  { etiqueta: "Plaza acme", origen: null },
  { etiqueta: "Plaza beta", origen: null },
  { etiqueta: "Mercantil", origen: null },
  { etiqueta: "Provincial", origen: null },
];

// Saldo en VES de una empresa en un banco. Solo VES: el negocio opera en bolívares, así que
// las cuentas en USD/COP de Sofitasa (Balance Consult trae las tres) no aportan nada a este
// reporte y sumarlas confundiría el Sub TOTAL con monedas que no son la misma.
function saldoVES(filas: FilaSaldo[], proveedor: string, empresa: string): number {
  return filas
    .filter((f) => f.proveedor === proveedor && f.empresa === empresa && f.moneda === "VES")
    .reduce((acumulado, f) => acumulado + f.saldo, 0);
}

/**
 * Arma el .xlsx del reporte "CTAS JURIDICAS": una fila fija por banco (en el orden que ya
 * usaba el negocio), en bolívares, con 0,00 en los que aún no están integrados, y un Sub
 * TOTAL al final.
 */
export async function armarWorkbookSaldos(filas: FilaSaldo[], generadoEn: Date): Promise<Buffer> {
  const libro = new ExcelJS.Workbook();
  libro.created = generadoEn; // metadato del archivo, no una fila — no altera las posiciones de la hoja
  const hoja = libro.addWorksheet("Saldos");

  const filaTitulo = hoja.addRow(["CTAS JURIDICAS"]);
  filaTitulo.font = { bold: true };

  let subTotal = 0;
  for (const linea of LINEAS_CTAS_JURIDICAS) {
    const monto = linea.origen ? saldoVES(filas, linea.origen.proveedor, linea.origen.empresa) : 0;
    subTotal += monto;
    const fila = hoja.addRow([linea.etiqueta, monto]);
    fila.getCell(2).numFmt = FORMATO_MONTO;
  }

  const filaSubtotal = hoja.addRow(["Sub TOTAL", subTotal]);
  filaSubtotal.font = { bold: true };
  filaSubtotal.getCell(2).numFmt = FORMATO_MONTO;

  hoja.getColumn(1).width = 22;
  hoja.getColumn(2).width = 16;

  const buffer = await libro.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
