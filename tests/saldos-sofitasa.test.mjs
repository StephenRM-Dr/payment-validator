import { test } from "node:test";
import assert from "node:assert/strict";
import { aplanarSaldos } from "../app/lib/proveedores/saldos-sofitasa.ts";

// Forma real de respuesta de Balance Consult (puerto 8006), tomada de una consulta contra
// producción: tres cuentas, una con saldo distinto de cero.
const CUENTAS_EJEMPLO = [
  { Cuenta: "1370000000000000002", producto: "", moneda: "USD", saldo: 0 },
  { Cuenta: "1370000000000000004", producto: "", moneda: "COP", saldo: 0 },
  { Cuenta: "1370000000000000001", producto: "021", moneda: "VES", saldo: 168845.21 },
];

test("aplanarSaldos: etiqueta cada cuenta con la empresa consultada", () => {
  const filas = aplanarSaldos("acme", CUENTAS_EJEMPLO);
  assert.equal(filas.length, 3);
  assert.ok(filas.every((f) => f.empresa === "acme"));
});

test("aplanarSaldos: mapea Cuenta/moneda/saldo a las columnas esperadas", () => {
  const [, , cuentaVES] = aplanarSaldos("beta", CUENTAS_EJEMPLO);
  assert.deepEqual(cuentaVES, {
    proveedor: "SOFITASA",
    empresa: "beta",
    cuenta: "1370000000000000001",
    producto: "021",
    moneda: "VES",
    saldo: 168845.21,
  });
});

test("aplanarSaldos: producto vacío se guarda como null, no como cadena vacía", () => {
  const [cuentaUSD] = aplanarSaldos("acme", CUENTAS_EJEMPLO);
  assert.equal(cuentaUSD.producto, null);
});

test("aplanarSaldos: sin cuentas, devuelve arreglo vacío", () => {
  assert.deepEqual(aplanarSaldos("acme", []), []);
});
