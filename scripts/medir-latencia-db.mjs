/**
 * ⏱️ Mide la latencia de ida y vuelta contra la base de datos: varias rondas de un SELECT 1
 * trivial, para separar "conexión fría" (la primera) de latencia de red en régimen (las
 * siguientes). Solo imprime tiempos — nunca la cadena de conexión ni ningún dato de la base.
 *
 * Uso:
 *   node scripts/medir-latencia-db.mjs                       (usa DATABASE_URL de .env.local o .env)
 *   DATABASE_URL="postgres://..." node scripts/medir-latencia-db.mjs   (para probar otra base, ej. producción)
 */

import { readFileSync, existsSync } from "node:fs";
import { neon } from "@neondatabase/serverless";

if (!process.env.DATABASE_URL) {
  for (const archivo of [".env.local", ".env"]) {
    const ruta = new URL(`../${archivo}`, import.meta.url);
    if (!existsSync(ruta)) continue;
    const coincidencia = /^DATABASE_URL=(.+)$/m.exec(readFileSync(ruta, "utf8"));
    if (coincidencia) {
      process.env.DATABASE_URL = coincidencia[1].trim().replace(/^["']|["']$/g, "");
      break;
    }
  }
}

if (!process.env.DATABASE_URL) {
  console.error("❌ No se encontró DATABASE_URL (ni en el entorno ni en .env.local/.env).");
  process.exit(1);
}

const RONDAS = 5;
const sql = neon(process.env.DATABASE_URL);

console.log(`⏱️  Midiendo ${RONDAS} rondas de "SELECT 1"...\n`);

const tiempos = [];
for (let i = 1; i <= RONDAS; i++) {
  const inicio = performance.now();
  try {
    await sql`SELECT 1`;
    const ms = performance.now() - inicio;
    tiempos.push(ms);
    console.log(`  Ronda ${i}: ${ms.toFixed(1)} ms${i === 1 ? "  (incluye handshake/conexión fría)" : ""}`);
  } catch (error) {
    console.error(`  Ronda ${i}: ❌ falló — ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (tiempos.length > 1) {
  const enRegimen = tiempos.slice(1);
  const promedio = enRegimen.reduce((a, b) => a + b, 0) / enRegimen.length;
  console.log(`\n📊 Promedio en régimen (rondas 2-${RONDAS}): ${promedio.toFixed(1)} ms`);
}
