/**
 * 🧱 Aplica en orden todas las migraciones de db/migrations/ sobre DATABASE_URL.
 *
 * Por qué existe: las migraciones se documentaron para ejecutarse con `psql`, pero psql
 * no viene instalado con Laragon ni con Node, así que sembrar una base nueva (por ejemplo
 * la base de pruebas de una rama) exigía abrir la consola web de Neon y pegar los archivos
 * a mano, en orden y sin equivocarse. Este script hace eso mismo desde el repositorio.
 *
 * Todas las migraciones son idempotentes (CREATE ... IF NOT EXISTS / ADD COLUMN IF NOT
 * EXISTS), así que volver a correrlo sobre una base ya migrada no tiene efecto alguno.
 *
 * Uso:
 *   npm run db:migrate                       (usa DATABASE_URL de .env.local o .env)
 *   DATABASE_URL="postgres://..." npm run db:migrate
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { neon } from "@neondatabase/serverless";

// Misma resolución de DATABASE_URL que verificar-esquema.mjs: .env.local pisa a .env,
// igual que hace Next.js, para que el script apunte siempre a la misma base que la app.
function cargarUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const archivo of [".env.local", ".env"]) {
    const ruta = new URL(`../${archivo}`, import.meta.url);
    if (!existsSync(ruta)) continue;
    const coincidencia = /^DATABASE_URL=(.+)$/m.exec(readFileSync(ruta, "utf8"));
    if (coincidencia) return coincidencia[1].trim().replace(/^["']|["']$/g, "");
  }
  throw new Error("No se encontró DATABASE_URL (ni en el entorno ni en .env.local/.env)");
}

/**
 * Separa un archivo .sql en sentencias sueltas.
 *
 * El driver HTTP de Neon acepta UNA sentencia por petición, así que hay que trocear el
 * archivo. Partir por ";" a secas no sirve: 000_esquema_base.sql contiene un bloque
 * DO $$ ... $$ cuyo cuerpo lleva sus propios punto y coma, y trocearlo por ahí produce
 * fragmentos que no compilan. Por eso el recorrido reconoce el "dollar quoting" de
 * Postgres ($$ o $etiqueta$), los literales entre comillas y los comentarios de línea,
 * y solo corta en los ";" que quedan fuera de todos ellos.
 */
function separarSentencias(sql) {
  const sentencias = [];
  let actual = "";
  let i = 0;
  let etiquetaDolar = null; // etiqueta del bloque $...$ abierto, o null
  let comilla = null;       // ' o " si hay un literal abierto

  while (i < sql.length) {
    const resto = sql.slice(i);

    if (etiquetaDolar) {
      if (resto.startsWith(etiquetaDolar)) {
        actual += etiquetaDolar;
        i += etiquetaDolar.length;
        etiquetaDolar = null;
        continue;
      }
    } else if (comilla) {
      if (sql[i] === comilla) comilla = null;
    } else {
      // Comentario de línea: se copia entero para no perder la documentación al reejecutar
      if (resto.startsWith("--")) {
        const fin = sql.indexOf("\n", i);
        const corte = fin === -1 ? sql.length : fin;
        actual += sql.slice(i, corte);
        i = corte;
        continue;
      }
      const apertura = /^\$[A-Za-z_]*\$/.exec(resto);
      if (apertura) {
        etiquetaDolar = apertura[0];
        actual += etiquetaDolar;
        i += etiquetaDolar.length;
        continue;
      }
      if (sql[i] === "'" || sql[i] === '"') {
        comilla = sql[i];
      } else if (sql[i] === ";") {
        sentencias.push(actual.trim());
        actual = "";
        i++;
        continue;
      }
    }

    actual += sql[i];
    i++;
  }

  if (actual.trim()) sentencias.push(actual.trim());

  // Un fragmento que solo tiene comentarios no es una sentencia ejecutable
  return sentencias.filter((s) => s.split("\n").some((linea) => linea.trim() && !linea.trim().startsWith("--")));
}

const sql = neon(cargarUrl());
const carpeta = new URL("../db/migrations/", import.meta.url);
const archivos = readdirSync(carpeta).filter((n) => n.endsWith(".sql")).sort();

console.log(`🧱 Aplicando ${archivos.length} migraciones...\n`);

for (const archivo of archivos) {
  const contenido = readFileSync(new URL(archivo, carpeta), "utf8");
  const sentencias = separarSentencias(contenido);

  try {
    for (const sentencia of sentencias) {
      await sql.query(sentencia);
    }
    console.log(`✅ ${archivo} (${sentencias.length} sentencias)`);
  } catch (error) {
    // Se corta en el primer fallo: las migraciones posteriores suelen depender de la
    // anterior, y seguir adelante solo produciría una cascada de errores sin sentido.
    console.error(`❌ ${archivo}: ${error.message}`);
    process.exit(1);
  }
}

console.log("\n🎉 Migraciones aplicadas. Ejecuta `npm run db:check` para verificar el esquema.");
