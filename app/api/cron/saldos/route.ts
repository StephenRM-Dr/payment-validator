import { NextResponse } from "next/server";
import { obtenerSql, conReintentos } from "../../../lib/db.ts";
import { autorizaCron } from "../../../lib/auth-cron.ts";
import { consultarTodosLosSaldos } from "../../../lib/proveedores/saldos.ts";
import type { FilaSaldo } from "../../../lib/proveedores/saldos-tipos.ts";

// Corte diario de saldos: lo dispara Vercel Cron (ver vercel.json) al cierre de operaciones.
// A diferencia de /api/admin/saldos (en vivo, sin guardar nada), esta ruta SÍ persiste una
// fila por cuenta en saldos_historial, para poder ver la serie de días en el panel.
export async function GET(request: Request) {
  const secreto = process.env.CRON_SECRET || "";
  if (!autorizaCron(request.headers.get("authorization"), secreto)) {
    console.warn("⛔ [Cron/Saldos] Intento de acceso sin credencial de cron válida.");
    return NextResponse.json({ error: "No autorizado." }, { status: 401 });
  }

  const resultados = await consultarTodosLosSaldos();

  const filas: FilaSaldo[] = [];
  const fallos: { proveedor: string; empresa: string; mensaje: string }[] = [];
  // Dos comparaciones explícitas, no if/else: el proyecto compila con strict desactivado, y
  // ahí TypeScript solo estrecha la unión discriminada con una comparación explícita por
  // rama (mismo motivo documentado en sofitasa.ts) — un "else" no hereda el estrechamiento.
  for (const resultado of resultados) {
    if (resultado.ok === true) filas.push(...resultado.filas);
    if (resultado.ok === false) fallos.push({ proveedor: resultado.proveedor, empresa: resultado.empresa, mensaje: resultado.mensaje });
  }

  if (fallos.length) {
    console.error("⚠️ [Cron/Saldos] Alguna cuenta no respondió:", fallos);
  }

  if (filas.length === 0) {
    // Ninguna empresa respondió: no hay nada que guardar, y devolver 502 hace que quede
    // registrado en los logs de Cron de Vercel como una ejecución fallida, no silenciosa.
    return NextResponse.json({ ok: false, guardadas: 0, fallos }, { status: 502 });
  }

  try {
    const sql = obtenerSql();
    // Un INSERT por fila, cada uno con su propio reintento: esta tabla es un registro de
    // monitoreo sin restricción de unicidad, así que una fila duplicada por un reintento de
    // red no representa ningún problema de datos (ver comentario en la migración 009).
    await Promise.all(
      filas.map((fila) =>
        conReintentos(() => sql`
          INSERT INTO saldos_historial (proveedor, empresa, cuenta, producto, moneda, saldo)
          VALUES (${fila.proveedor}, ${fila.empresa}, ${fila.cuenta}, ${fila.producto}, ${fila.moneda}, ${fila.saldo});
        `)
      )
    );
  } catch (error) {
    console.error("❌ [Cron/Saldos] No se pudo guardar el historial:", error);
    return NextResponse.json({ ok: false, guardadas: 0, error: "Fallo al guardar en la base de datos." }, { status: 500 });
  }

  console.log(`✅ [Cron/Saldos] Guardadas ${filas.length} fila(s) de saldos.${fallos.length ? ` (${fallos.length} empresa(s) fallaron)` : ""}`);
  return NextResponse.json({ ok: true, guardadas: filas.length, fallos }, { status: 200 });
}
