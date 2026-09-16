import { NextResponse } from "next/server";
import { respuestaDeError, verificarPinAdmin } from "../../../../lib/http.ts";
import { consultarTodosLosSaldos } from "../../../../lib/proveedores/saldos.ts";
import { armarWorkbookSaldos } from "../../../../lib/reportes/saldos-excel.ts";
import { fechaISOVenezuela } from "../../../../lib/reportes/tiempo.ts";

const TIPO_MIME_XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// .xlsx del saldo EN VIVO de las cuentas de Sofitasa y BDV — consulta fresca al momento de
// la descarga, igual que /api/admin/saldos; no lee saldos_historial.
export async function GET(request: Request) {
  const rechazo = await verificarPinAdmin(request, "Saldos/Exportar");
  if (rechazo) return rechazo;

  try {
    const resultados = await consultarTodosLosSaldos();

    const filas = [];
    const fallos: { proveedor: string; empresa: string; mensaje: string }[] = [];
    for (const resultado of resultados) {
      if (resultado.ok === true) filas.push(...resultado.filas);
      if (resultado.ok === false) fallos.push({ proveedor: resultado.proveedor, empresa: resultado.empresa, mensaje: resultado.mensaje });
    }

    if (fallos.length) {
      console.warn("⚠️ [Saldos/Exportar] Alguna cuenta no respondió, se exporta con lo disponible:", fallos);
    }

    const generadoEn = new Date();
    const buffer = await armarWorkbookSaldos(filas, generadoEn);
    const nombre = `Saldos_${fechaISOVenezuela(generadoEn)}.xlsx`;

    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type": TIPO_MIME_XLSX,
        "Content-Disposition": `attachment; filename="${nombre}"`,
      },
    });
  } catch (error) {
    return respuestaDeError(error, {
      contexto: "Saldos/Exportar",
      mensajeGenerico: "No se pudo generar el Excel de saldos.",
    });
  }
}
