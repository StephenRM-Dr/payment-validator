import { NextResponse } from "next/server";
import { obtenerSql } from "../../../lib/db.ts";
import { verificarPinAdmin } from "../../../lib/http.ts";

const RONDAS = 5;

// Ruta TEMPORAL de diagnóstico: mide la latencia real de ida y vuelta hacia Neon, medida
// DESDE DENTRO de una función de Vercel — la única forma de saber lo que la app realmente
// experimenta, en vez de medir desde una red distinta (una máquina local, por ejemplo) que
// no representa la ruta real. Solo devuelve tiempos, nunca datos ni la cadena de conexión.
// Se borra en cuanto se tenga la lectura — no debe quedar como parte permanente de la app.
export async function GET(request: Request) {
  const rechazo = await verificarPinAdmin(request, "Diagnostico/Latencia");
  if (rechazo) return rechazo;

  const sql = obtenerSql();
  const tiempos: number[] = [];

  for (let i = 0; i < RONDAS; i++) {
    const inicio = performance.now();
    try {
      await sql`SELECT 1`;
      tiempos.push(Math.round((performance.now() - inicio) * 10) / 10);
    } catch (error) {
      return NextResponse.json(
        { ok: false, ronda: i + 1, error: error instanceof Error ? error.message : String(error), tiempos },
        { status: 502 }
      );
    }
  }

  const enRegimen = tiempos.slice(1);
  const promedioEnRegimenMs = enRegimen.length
    ? Math.round((enRegimen.reduce((a, b) => a + b, 0) / enRegimen.length) * 10) / 10
    : null;

  return NextResponse.json({ ok: true, tiemposMs: tiempos, promedioEnRegimenMs }, { status: 200 });
}
