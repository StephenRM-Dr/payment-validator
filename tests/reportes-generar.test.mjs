import { test } from "node:test";
import assert from "node:assert/strict";
import { nombreDeArchivo } from "../app/lib/reportes/generar.ts";

test("nombreDeArchivo: reemplaza espacios por guion bajo y usa la fecha ISO", () => {
  assert.equal(nombreDeArchivo("San Cristobal", "2026-08-20"), "Reporte_San_Cristobal_2026-08-20.xlsx");
});

test("nombreDeArchivo: sucursal sin espacios queda igual", () => {
  assert.equal(nombreDeArchivo("Caracas", "2026-08-20"), "Reporte_Caracas_2026-08-20.xlsx");
});
