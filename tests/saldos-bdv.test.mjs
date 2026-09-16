import { test } from "node:test";
import assert from "node:assert/strict";
import { movimientoMasReciente } from "../app/lib/proveedores/bdv.ts";
import { EMPRESA_POR_CUENTA_BDV } from "../app/lib/proveedores/cuentas-bdv.ts";
import { EMPRESA_POR_SUCURSAL } from "../app/lib/proveedores/empresas-sofitasa.ts";
import { CUENTA_POR_SUCURSAL } from "../app/lib/proveedores/cuentas-bdv.ts";

function movimiento(nroMov, extra = {}) {
  return { referencia: "x", descripcion: null, fecha: "2026-08-20", hora: "1200", mov: "CREDITO", saldo: "0,00", importe: "0,00", nroMov, observacion: null, ...extra };
}

test("movimientoMasReciente: elige el nroMov más alto, sin importar la posición en el arreglo", () => {
  const movimientos = [movimiento("100"), movimiento("305"), movimiento("204")];
  assert.equal(movimientoMasReciente(movimientos).nroMov, "305");
});

test("movimientoMasReciente: funciona igual si ya viene ordenado descendente", () => {
  const movimientos = [movimiento("305"), movimiento("204"), movimiento("100")];
  assert.equal(movimientoMasReciente(movimientos).nroMov, "305");
});

test("movimientoMasReciente: un solo movimiento se devuelve tal cual", () => {
  const [m] = [movimiento("42")];
  assert.equal(movimientoMasReciente([m]), m);
});

test("movimientoMasReciente: sin movimientos, devuelve null", () => {
  assert.equal(movimientoMasReciente([]), null);
});

test("movimientoMasReciente: nroMov no numérico no descarta al resto de candidatos válidos", () => {
  const movimientos = [movimiento("100"), movimiento("no-es-numero"), movimiento("204")];
  assert.equal(movimientoMasReciente(movimientos).nroMov, "204");
});

// El diseño de saldos-bdv.ts asume que EMPRESA_POR_CUENTA_BDV refleja el MISMO reparto de
// sucursales por empresa que ya usa Sofitasa (EMPRESA_POR_SUCURSAL) y BDV mismo
// (CUENTA_POR_SUCURSAL) — las dos empresas son las mismas personas jurídicas en los dos
// bancos. Si algún día se edita uno de los tres repartos sin los otros dos, esta prueba
// debe fallar en vez de dejar que el panel muestre el banco equivocado bajo cada empresa.
test("EMPRESA_POR_CUENTA_BDV: coincide con el reparto de sucursales de Sofitasa y de BDV", () => {
  for (const [sucursal, empresaSofitasa] of Object.entries(EMPRESA_POR_SUCURSAL)) {
    const claveBdv = CUENTA_POR_SUCURSAL[sucursal];
    const empresaBdv = EMPRESA_POR_CUENTA_BDV[claveBdv];
    assert.equal(empresaBdv, empresaSofitasa, `${sucursal}: BDV dice ${empresaBdv}, Sofitasa dice ${empresaSofitasa}`);
  }
});
