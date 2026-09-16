import { test } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { armarWorkbookSaldos } from "../app/lib/reportes/saldos-excel.ts";

const FILAS_EJEMPLO = [
  // Sofitasa trae USD/COP/VES por empresa (Balance Consult); solo VES entra al reporte.
  { proveedor: "SOFITASA", empresa: "acme", cuenta: "1370000000000000001", producto: "021", moneda: "VES", saldo: 168845.21 },
  { proveedor: "SOFITASA", empresa: "acme", cuenta: "1370000000000000002", producto: "", moneda: "USD", saldo: 120.5 },
  { proveedor: "SOFITASA", empresa: "beta", cuenta: "1370000000000000003", producto: null, moneda: "VES", saldo: 5081246.15 },
  { proveedor: "BDV", empresa: "acme", cuenta: "01020000000000000001", producto: null, moneda: "VES", saldo: 541075.46 },
  { proveedor: "BDV", empresa: "beta", cuenta: "01020000000000000002", producto: null, moneda: "VES", saldo: 1014299.52 },
];

async function cargar(buffer) {
  const libro = new ExcelJS.Workbook();
  await libro.xlsx.load(buffer);
  return libro.worksheets[0];
}

function filasComoObjeto(hoja) {
  const mapa = {};
  for (let i = 1; i <= hoja.rowCount; i++) {
    const [etiqueta, monto] = hoja.getRow(i).values.slice(1);
    mapa[etiqueta] = monto;
  }
  return mapa;
}

test("arma las 12 líneas fijas de CTAS JURIDICAS, en orden, más el título y el Sub TOTAL", async () => {
  const hoja = await cargar(await armarWorkbookSaldos(FILAS_EJEMPLO, new Date()));
  assert.equal(hoja.rowCount, 14); // título + 12 bancos + Sub TOTAL
  assert.equal(hoja.getRow(1).values.slice(1)[0], "CTAS JURIDICAS");
  assert.equal(hoja.getRow(14).values.slice(1)[0], "Sub TOTAL");
});

test("BDV y Sofitasa muestran el saldo VES real de cada empresa", async () => {
  const hoja = await cargar(await armarWorkbookSaldos(FILAS_EJEMPLO, new Date()));
  const filas = filasComoObjeto(hoja);
  assert.equal(filas["Vzla Acme Corp"], 541075.46);
  assert.equal(filas["Vzla Beta Corp"], 1014299.52);
  assert.equal(filas["Sofitasa acme"], 168845.21);
  assert.equal(filas["Sofitasa beta"], 5081246.15);
});

test("ignora las cuentas en USD/COP de Sofitasa: no se cuelan en el saldo VES", async () => {
  const hoja = await cargar(await armarWorkbookSaldos(FILAS_EJEMPLO, new Date()));
  const filas = filasComoObjeto(hoja);
  // Si se colara el USD (120.5), "Sofitasa acme" no daría exactamente el VES de la cuenta.
  assert.equal(filas["Sofitasa acme"], 168845.21);
});

test("bancos sin consulta integrada quedan en 0", async () => {
  const hoja = await cargar(await armarWorkbookSaldos(FILAS_EJEMPLO, new Date()));
  const filas = filasComoObjeto(hoja);
  for (const banco of ["Banesco Acme Corp", "Banesco Beta Corp", "Bancamiga Acme", "Bancamiga Merida", "Plaza acme", "Plaza beta", "Mercantil", "Provincial"]) {
    assert.equal(filas[banco], 0, `${banco} debería estar en 0`);
  }
});

test("el Sub TOTAL suma las 12 líneas, solo VES", async () => {
  const hoja = await cargar(await armarWorkbookSaldos(FILAS_EJEMPLO, new Date()));
  const filas = filasComoObjeto(hoja);
  const esperado = 168845.21 + 5081246.15 + 541075.46 + 1014299.52; // sin el USD de Sofitasa
  assert.ok(Math.abs(filas["Sub TOTAL"] - esperado) < 0.001);
});

test("sin ninguna fila (todo falló), igual arma las 12 líneas en 0 y Sub TOTAL en 0", async () => {
  const hoja = await cargar(await armarWorkbookSaldos([], new Date()));
  assert.equal(hoja.rowCount, 14);
  const filas = filasComoObjeto(hoja);
  assert.equal(filas["Sub TOTAL"], 0);
});
