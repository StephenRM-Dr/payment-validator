import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluarCredencialReporte, nombreVariableClaveSucursal } from "../app/lib/auth-admin.ts";

test("nombreVariableClaveSucursal: sucursal con espacio", () => {
  assert.equal(nombreVariableClaveSucursal("San Cristobal"), "REPORTES_CLAVE_SAN_CRISTOBAL");
});

test("nombreVariableClaveSucursal: sucursal sin espacio", () => {
  assert.equal(nombreVariableClaveSucursal("Caracas"), "REPORTES_CLAVE_CARACAS");
});

test("evaluarCredencialReporte: PIN admin correcto autoriza sin importar la clave", () => {
  const ok = evaluarCredencialReporte({
    pinAdminEnviado: "1234",
    pinAdminCorrecto: "1234",
    claveEnviada: null,
    claveCorrectaSucursal: "abc",
  });
  assert.equal(ok, true);
});

test("evaluarCredencialReporte: PIN admin incorrecto no cae a la clave de sucursal aunque sea correcta", () => {
  const ok = evaluarCredencialReporte({
    pinAdminEnviado: "0000",
    pinAdminCorrecto: "1234",
    claveEnviada: "abc",
    claveCorrectaSucursal: "abc",
  });
  assert.equal(ok, false);
});

test("evaluarCredencialReporte: sin PIN, clave correcta de la sucursal autoriza", () => {
  const ok = evaluarCredencialReporte({
    pinAdminEnviado: null,
    pinAdminCorrecto: "1234",
    claveEnviada: "abc",
    claveCorrectaSucursal: "abc",
  });
  assert.equal(ok, true);
});

test("evaluarCredencialReporte: clave que no coincide con la de esta sucursal rechaza", () => {
  const ok = evaluarCredencialReporte({
    pinAdminEnviado: null,
    pinAdminCorrecto: "1234",
    claveEnviada: "clave-de-otra-sucursal",
    claveCorrectaSucursal: "abc",
  });
  assert.equal(ok, false);
});

test("evaluarCredencialReporte: sucursal sin clave configurada rechaza aunque envíen algo", () => {
  const ok = evaluarCredencialReporte({
    pinAdminEnviado: null,
    pinAdminCorrecto: "1234",
    claveEnviada: "cualquier-cosa",
    claveCorrectaSucursal: null,
  });
  assert.equal(ok, false);
});

test("evaluarCredencialReporte: sin ninguna credencial rechaza", () => {
  const ok = evaluarCredencialReporte({
    pinAdminEnviado: null,
    pinAdminCorrecto: "1234",
    claveEnviada: null,
    claveCorrectaSucursal: "abc",
  });
  assert.equal(ok, false);
});
