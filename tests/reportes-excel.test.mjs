import { test } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { armarWorkbookExcel } from "../app/lib/reportes/excel.ts";

test("arma una fila por pago, con las columnas esperadas", async () => {
  const buffer = await armarWorkbookExcel([
    {
      fecha: new Date("2026-08-20T14:30:00Z"),
      comanda: "1234",
      proveedor: "BINANCE",
      monto: "150.50",
      moneda: "USDT",
      referencia: "REF123",
      pagador: "Juan Perez",
    },
  ]);

  const libro = new ExcelJS.Workbook();
  await libro.xlsx.load(buffer);
  const hoja = libro.worksheets[0];

  assert.equal(hoja.rowCount, 2); // encabezado + 1 fila
  assert.deepEqual(hoja.getRow(1).values.slice(1), [
    "Fecha", "Comanda", "Proveedor", "Monto", "Moneda", "Referencia", "Pagador",
  ]);

  const fila = hoja.getRow(2).values.slice(1);
  assert.equal(fila[0], "2026-08-20 10:30");
  assert.equal(fila[1], "1234");
  assert.equal(fila[2], "BINANCE");
  assert.equal(fila[3], 150.5); // número, no texto — para que sume en Excel
  assert.equal(fila[4], "USDT");
  assert.equal(fila[5], "REF123");
  assert.equal(fila[6], "Juan Perez");
});

test("comanda o referencia ausentes se escriben como celda vacía, no 'null'", async () => {
  const buffer = await armarWorkbookExcel([
    { fecha: new Date("2026-08-20T14:30:00Z"), comanda: null, proveedor: "BDV", monto: "50", moneda: "VES", referencia: null, pagador: null },
  ]);
  const libro = new ExcelJS.Workbook();
  await libro.xlsx.load(buffer);
  const fila = libro.worksheets[0].getRow(2).values.slice(1);
  assert.equal(fila[1], undefined); // exceljs deja undefined una celda de texto vacío, no la cadena "null"
});

test("sin filas, arma solo el encabezado", async () => {
  const buffer = await armarWorkbookExcel([]);
  const libro = new ExcelJS.Workbook();
  await libro.xlsx.load(buffer);
  assert.equal(libro.worksheets[0].rowCount, 1);
});
