/**
 * 🏦 Prueba manual: saldo actual de las dos cuentas BDV (Acme Corp y Beta Corp).
 *
 * Llama a ultimoSaldoBdv() tal cual la usa saldos-bdv.ts, sin pasar por el servidor HTTP ni
 * por el PIN admin — la forma más rápida de confirmar que el saldo se lee bien contra el
 * banco real antes de probar el flujo completo.
 *
 * Uso:  node scripts/probar-saldo-bdv.mjs
 */

import { readFileSync, existsSync } from "node:fs";

for (const archivo of [".env", ".env.local"]) {
  const ruta = new URL(`../${archivo}`, import.meta.url);
  if (!existsSync(ruta)) continue;
  for (const linea of readFileSync(ruta, "utf8").split(/\r?\n/)) {
    const coincidencia = /^([A-Z0-9_]+)=(.*)$/.exec(linea.trim());
    if (coincidencia) process.env[coincidencia[1]] = coincidencia[2].trim().replace(/^["']|["']$/g, "");
  }
}

const { ultimoSaldoBdv } = await import("../app/lib/proveedores/bdv.ts");
const { CLAVES_CUENTA_BDV, EMPRESA_POR_CUENTA_BDV, credencialesDeCuenta } = await import("../app/lib/proveedores/cuentas-bdv.ts");

for (const clave of CLAVES_CUENTA_BDV) {
  const empresa = EMPRESA_POR_CUENTA_BDV[clave];
  const credencial = credencialesDeCuenta(clave);
  if (credencial.ok === false) {
    console.error(`❌ ${empresa} (${clave}): ${credencial.detalle}`);
    continue;
  }

  console.log(`⏳ Consultando ${empresa} (${clave}, cuenta ${credencial.credenciales.cuenta})...`);
  const resultado = await ultimoSaldoBdv(credencial.credenciales);

  if (resultado.estado === "OK") {
    const { saldo, fecha, hora, nroMov } = resultado.datos;
    console.log(`✅ ${empresa}: Bs. ${saldo.toFixed(2)} (movimiento ${nroMov} del ${fecha} ${hora ?? ""})`);
  } else {
    console.error(`❌ ${empresa}: ${resultado.mensaje} — ${resultado.detalle}`);
  }
  console.log("");
}
