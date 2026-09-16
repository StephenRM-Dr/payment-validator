// Pruebas de intentosTransferenciaBancamiga() — decide qué motivos (CE/CI/CD) probar contra
// consulta/trx de Bancamiga y con qué referencia exacta.
//
// Bug real que motiva esta batería: una transferencia con referencia "00226837" (8 dígitos,
// con ceros de relleno reales del banco) terminaba sin verificarse ("motivos probados:
// ninguno, referencia muy corta") porque la función pasaba la referencia por
// limpiarReferencia() antes de contar el largo — esa limpieza quita los ceros de la izquierda
// (correcto para el cruce por sufijo de Pago Móvil, donde no importan), pero consulta/trx
// exige un ancho EXACTO de dígitos sobre la referencia larga del banco, que sí viene rellena.
// Ver el comentario de intentosTransferenciaBancamiga() en app/lib/proveedores/bancamiga.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { intentosTransferenciaBancamiga } from "../app/lib/proveedores/bancamiga.ts";
import { especDeProveedor } from "../app/lib/proveedores/prompts.ts";

const HOY_VE = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Caracas" }).format(new Date());
const FECHA_QUE_NUNCA_ES_HOY = "2020-01-01";

test("referencia con ceros de relleno (00226837) sí alcanza los 8 dígitos que exige CE", () => {
  const intentos = intentosTransferenciaBancamiga("00226837", FECHA_QUE_NUNCA_ES_HOY);
  const ce = intentos.find((i) => i.motivo === "CE");
  assert.ok(ce, "debe intentar CE");
  assert.equal(ce.referenciaConsultada, "00226837");
});

test("referencia genuinamente corta (6 dígitos, sin ceros) sigue sin intentar ningún motivo", () => {
  const intentos = intentosTransferenciaBancamiga("226837", FECHA_QUE_NUNCA_ES_HOY);
  assert.deepEqual(intentos, []);
});

test("CE trunca a los últimos 8 dígitos de una referencia más larga", () => {
  const intentos = intentosTransferenciaBancamiga("912345678", FECHA_QUE_NUNCA_ES_HOY); // 9 dígitos
  const ce = intentos.find((i) => i.motivo === "CE");
  assert.equal(ce.referenciaConsultada, "12345678");
});

test("CI se intenta con la referencia completa (9-12 dígitos), ceros de relleno incluidos", () => {
  const intentos = intentosTransferenciaBancamiga("012345678", FECHA_QUE_NUNCA_ES_HOY); // 9 dígitos, con un cero de relleno
  const ci = intentos.find((i) => i.motivo === "CI");
  assert.ok(ci, "debe intentar CI");
  assert.equal(ci.referenciaConsultada, "012345678");
});

test("CD solo se intenta si la fecha de pago es hoy (America/Caracas)", () => {
  const intentosAyer = intentosTransferenciaBancamiga("012345678", FECHA_QUE_NUNCA_ES_HOY);
  assert.ok(!intentosAyer.some((i) => i.motivo === "CD"));

  const intentosHoy = intentosTransferenciaBancamiga("012345678", HOY_VE);
  assert.ok(intentosHoy.some((i) => i.motivo === "CD"));
});

test("referencia de 13+ dígitos queda fuera de la ventana de CI/CD, pero CE sigue intentándose", () => {
  const intentos = intentosTransferenciaBancamiga("1234567890123", FECHA_QUE_NUNCA_ES_HOY); // 13 dígitos
  assert.ok(!intentos.some((i) => i.motivo === "CI"));
  assert.ok(!intentos.some((i) => i.motivo === "CD"));
  const ce = intentos.find((i) => i.motivo === "CE");
  assert.equal(ce.referenciaConsultada, "67890123");
});

// El bug real no estaba solo en intentosTransferenciaBancamiga(): el pipeline de OCR
// (prompts.ts) le aplicaba limpiarReferencia() al resultado de la IA ANTES de mostrárselo
// al cajero, así que una referencia con ceros de relleno reales ("00226837") ya llegaba al
// formulario como "226837" — los 8 dígitos nunca existieron para el resto del sistema.
test("el normalizador OCR de Bancamiga preserva los ceros de relleno de la referencia", () => {
  const { espec } = especDeProveedor("BANCAMIGA");
  const resultado = espec.normalizar({
    importe: "303.415,31",
    fechaPago: "10/09/2026",
    referencia: "00226837",
    bancoReceptor: "",
    legible: true,
  });
  assert.equal(resultado.campos.referencia, "00226837");
});
