/**
 * 🩺 Verifica que la base de datos tenga todo lo que el código espera.
 *
 * El problema que evita: el esquema vivía solo en Neon y las columnas se agregaban a mano.
 * Si un despliegue llegaba antes que el ALTER TABLE, el panel administrativo respondía 500
 * por completo (todas sus consultas seleccionan las columnas nuevas) — un fallo total, no
 * parcial, y sin ninguna pista de la causa.
 *
 * Uso:
 *   npm run db:check                       (usa DATABASE_URL de .env.local o .env)
 *   DATABASE_URL="postgres://..." npm run db:check
 *
 * Sale con código 1 si falta algo, para poder encadenarlo antes de un despliegue.
 */

import { readFileSync, existsSync } from "node:fs";
import { neon } from "@neondatabase/serverless";

function cargarUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  // .env.local tiene prioridad sobre .env, igual que en Next.js
  for (const archivo of [".env.local", ".env"]) {
    const ruta = new URL(`../${archivo}`, import.meta.url);
    if (!existsSync(ruta)) continue;
    const coincidencia = /^DATABASE_URL=(.+)$/m.exec(readFileSync(ruta, "utf8"));
    if (coincidencia) return coincidencia[1].trim().replace(/^["']|["']$/g, "");
  }
  throw new Error("No se encontró DATABASE_URL (ni en el entorno ni en .env.local/.env)");
}

// Lo que el código da por sentado. Al añadir una columna o índice nuevo, agrégalo aquí
// junto con su migración: así el despliegue avisa en vez de romperse en producción.
const COLUMNAS_ESPERADAS = {
  transacciones: [
    "id", "binance_id_completo", "id_orden", "txid", "pagador", "binance_raw",
    "monto", "moneda", "estado", "comanda", "ciudad", "imagen_comprobante_base64",
    "fecha_cajero", "fecha_validacion", "fecha_pago", "created_at", "nota", "anulada",
    // Multiproveedor (migración 003): 'proveedor' discrimina BINANCE/BDV y el resto
    // son los campos del Pago Móvil BDV, nulos en las filas de Binance.
    "proveedor", "referencia", "telefono_pagador", "telefono_destino",
    "cedula_pagador", "banco_origen", "bdv_raw",
    // Migración 005: a cuál de las dos cuentas BDV del negocio entró el dinero
    "cuenta_bdv",
    // Migración 006: Sofitasa (empresa_sofitasa, sofitasa_raw) y Bancamiga (bancamiga_raw)
    // reutilizan referencia/telefono_pagador/telefono_destino/banco_origen/cedula_pagador,
    // ya listados arriba.
    "empresa_sofitasa", "sofitasa_raw", "bancamiga_raw",
  ],
  configuracion_sistema: ["id", "sistema_activo", "mensaje_bloqueo"],
  intentos_admin: ["ip", "intentos", "bloqueado_hasta", "actualizado_en"],
  transacciones_historial: ["id", "transaccion_id", "campo", "valor_anterior", "valor_nuevo", "ip", "cambiado_en"],
  // Migración 007/011: caché del historial de Bancamiga para no chocar con el cooldown de 10
  // minutos del banco, cacheado por teléfono destino (cuenta real) y no por sucursal —
  // varias sucursales pueden compartir la misma cuenta (ver app/lib/proveedores/bancamiga-cache.ts).
  bancamiga_historial_cache: ["telefono_destino", "fecha", "lista", "sucursal", "actualizado_en"],
  // Migración 011: último teléfono conocido por sucursal, para resolver la clave de la caché
  // de arriba sin gastar una llamada al banco.
  bancamiga_sucursal_telefono: ["sucursal", "telefono_destino", "actualizado_en"],
};

// Índices únicos sin los cuales el sistema deja de protegerse contra duplicados.
// Cada uno sostiene un ON CONFLICT: sin el índice, el INSERT lanza error o —peor— dos
// cajeros simultáneos consiguen cobrar el mismo comprobante.
const INDICES_UNICOS_REQUERIDOS = [
  {
    tabla: "transacciones",
    columna: "binance_id_completo",
    porQue: "deduplicación de los reenvíos del worker de Binance",
  },
  {
    tabla: "transacciones",
    columna: "cuenta_bdv",
    // Se busca 'cuenta_bdv' y no 'referencia' a propósito: el índice global de la migración
    // 004 también contenía 'referencia', así que buscarla dejaría pasar una base a medio
    // migrar. La unicidad tiene que ser por cuenta o dos cuentas distintas se estorban.
    columnas: "(cuenta_bdv, referencia)",
    porQue: "impide cobrar dos veces el mismo Pago Móvil BDV en la misma cuenta",
  },
  {
    tabla: "transacciones",
    columna: "empresa_sofitasa",
    columnas: "(empresa_sofitasa, referencia)",
    porQue: "impide cobrar dos veces el mismo Pago Móvil Sofitasa en la misma empresa",
  },
  {
    tabla: "transacciones",
    // 'telefono_destino' y no 'referencia': el índice de BDV (arriba) también contiene
    // 'referencia', y buscarla dejaría pasar una base a medio migrar, igual que ya explica
    // el comentario del índice de BDV.
    columna: "telefono_destino",
    columnas: "(telefono_destino, referencia)",
    porQue: "impide cobrar dos veces el mismo Pago Móvil Bancamiga en la misma sucursal",
  },
];

const sql = neon(cargarUrl());
let fallos = 0;

console.log("🩺 Verificando el esquema de la base de datos...\n");

for (const [tabla, esperadas] of Object.entries(COLUMNAS_ESPERADAS)) {
  const filas = await sql`
    SELECT column_name FROM information_schema.columns WHERE table_name = ${tabla};
  `;

  if (filas.length === 0) {
    console.log(`❌ ${tabla}: la tabla NO existe`);
    fallos++;
    continue;
  }

  const presentes = new Set(filas.map((f) => f.column_name));
  const faltantes = esperadas.filter((c) => !presentes.has(c));

  if (faltantes.length > 0) {
    console.log(`❌ ${tabla}: faltan columnas → ${faltantes.join(", ")}`);
    fallos++;
  } else {
    console.log(`✅ ${tabla}: ${esperadas.length} columnas presentes`);
  }
}

for (const requerido of INDICES_UNICOS_REQUERIDOS) {
  const [indice] = await sql`
    SELECT indexdef FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = ${requerido.tabla}
      AND indexdef ILIKE ${"%UNIQUE%" + requerido.columna + "%"}
    LIMIT 1;
  `;

  if (indice) {
    console.log(`✅ índice único sobre ${requerido.tabla}.${requerido.columnas || requerido.columna} (${requerido.porQue})`);
  } else {
    console.log(`❌ falta el índice único sobre ${requerido.tabla}.${requerido.columnas || requerido.columna}: ${requerido.porQue}`);
    fallos++;
  }
}

console.log("");
if (fallos > 0) {
  console.log(`❌ ${fallos} problema(s). Aplica las migraciones pendientes de db/migrations/ antes de desplegar.`);
  process.exit(1);
}
console.log("✅ El esquema está completo: la aplicación puede desplegarse.");
