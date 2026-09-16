import { NextResponse } from "next/server";
import { respuestaDeError, verificarPinAdmin } from "../../../lib/http.ts";
import { consultarTodosLosSaldos } from "../../../lib/proveedores/saldos.ts";

// Saldo EN VIVO de las cuentas de Sofitasa y BDV, por petición del administrador — no lee ni
// escribe saldos_historial. Ese historial diario lo llena aparte el cron (ver
// app/api/cron/saldos), que sí persiste.
export async function GET(request: Request) {
  const rechazo = await verificarPinAdmin(request, "Saldos");
  if (rechazo) return rechazo;

  try {
    const resultados = await consultarTodosLosSaldos();
    return NextResponse.json({ resultados }, { status: 200 });
  } catch (error) {
    return respuestaDeError(error, {
      contexto: "Saldos",
      mensajeGenerico: "No se pudieron consultar los saldos.",
    });
  }
}
