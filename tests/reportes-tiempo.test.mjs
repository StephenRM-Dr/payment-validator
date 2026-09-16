import { test } from "node:test";
import assert from "node:assert/strict";
import { rangoDelDiaEnVenezuela, fechaISOVenezuela, formatearFechaHoraVenezuela } from "../app/lib/reportes/tiempo.ts";

test("rangoDelDiaEnVenezuela: el 20 de agosto en Venezuela empieza a las 04:00 UTC", () => {
  const { inicio, fin } = rangoDelDiaEnVenezuela(new Date(Date.UTC(2026, 7, 20)));
  assert.equal(inicio.toISOString(), "2026-08-20T04:00:00.000Z");
  assert.equal(fin.toISOString(), "2026-08-21T04:00:00.000Z");
});

test("fechaISOVenezuela: las 02:00 UTC del 21 todavía son 20 en Venezuela", () => {
  assert.equal(fechaISOVenezuela(new Date("2026-08-21T02:00:00Z")), "2026-08-20");
});

test("fechaISOVenezuela: las 04:00 UTC del 21 ya son 21 en Venezuela", () => {
  assert.equal(fechaISOVenezuela(new Date("2026-08-21T04:00:00Z")), "2026-08-21");
});

test("formatearFechaHoraVenezuela: formatea fecha y hora local", () => {
  assert.equal(formatearFechaHoraVenezuela(new Date("2026-08-20T14:30:00Z")), "2026-08-20 10:30");
});
