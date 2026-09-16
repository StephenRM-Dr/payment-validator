import { test } from "node:test";
import assert from "node:assert/strict";
import { autorizaCron } from "../app/lib/auth-cron.ts";

test("autorizaCron: Bearer con el secreto correcto autoriza", () => {
  assert.equal(autorizaCron("Bearer abc123", "abc123"), true);
});

test("autorizaCron: Bearer con secreto incorrecto rechaza", () => {
  assert.equal(autorizaCron("Bearer abc124", "abc123"), false);
});

test("autorizaCron: sin cabecera Authorization rechaza", () => {
  assert.equal(autorizaCron(null, "abc123"), false);
});

test("autorizaCron: cabecera sin el prefijo 'Bearer ' rechaza", () => {
  assert.equal(autorizaCron("abc123", "abc123"), false);
});

test("autorizaCron: CRON_SECRET sin configurar rechaza aunque envíen algo", () => {
  assert.equal(autorizaCron("Bearer cualquier-cosa", ""), false);
});
