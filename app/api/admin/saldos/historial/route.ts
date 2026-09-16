import { NextResponse } from "next/server";
import { obtenerSql, conReintentos } from "../../../../lib/db.ts";
import { respuestaDeError, verificarPinAdmin } from "../../../../lib/http.ts";

const DIAS_POR_DEFECTO = 30;
const DIAS_MAXIMO = 90;

export async function GET(request: Request) {
  const rechazo = await verificarPinAdmin(request, "Saldos/Historial");
  if (rechazo) return rechazo;

  const { searchParams } = new URL(request.url);
  const diasParam = Number.parseInt(searchParams.get("dias") || "", 10);
  const dias = Number.isFinite(diasParam) && diasParam > 0 ? Math.min(diasParam, DIAS_MAXIMO) : DIAS_POR_DEFECTO;

  try {
    const sql = obtenerSql();
    const historial = await conReintentos(() => sql`
      SELECT proveedor, empresa, cuenta, producto, moneda, saldo, capturado_en AT TIME ZONE 'UTC' AS capturado_en
      FROM saldos_historial
      WHERE capturado_en >= NOW() - (${dias} || ' days')::interval
      ORDER BY capturado_en DESC;
    `);
    return NextResponse.json({ historial }, { status: 200 });
  } catch (error) {
    return respuestaDeError(error, {
      contexto: "Saldos/Historial",
      mensajeGenerico: "No se pudo consultar el historial de saldos.",
    });
  }
}
