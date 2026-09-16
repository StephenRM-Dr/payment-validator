import { NextResponse } from "next/server";
import { respuestaDeError } from "../../../../lib/http";
import { verificarAccesoReporte } from "../../../../lib/auth-admin";
import { VALORES_SUCURSALES } from "../../../../lib/sucursales";
import { generarReporteExcel } from "../../../../lib/reportes/generar";
import { fechaISOVenezuela } from "../../../../lib/reportes/tiempo";

const FORMATO_FECHA = /^\d{4}-\d{2}-\d{2}$/;
const TIPO_MIME_XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const sucursal = searchParams.get("sucursal") || "";

  // La sucursal se valida antes que la credencial: verificarAccesoReporte necesita saber
  // cuál es para poder resolver la clave scoped correspondiente (REPORTES_CLAVE_<SUCURSAL>).
  if (!VALORES_SUCURSALES.includes(sucursal)) {
    return NextResponse.json({ error: "Sucursal desconocida." }, { status: 400 });
  }

  const acceso = await verificarAccesoReporte(request, sucursal);
  if (acceso.ok === false) {
    return NextResponse.json({ error: acceso.error }, { status: acceso.estado });
  }

  // Sin fecha: el día de hoy en Venezuela — así el enlace fijo de una tienda (sucursal +
  // clave) no necesita editarse cada día para ver el acumulado del día en curso.
  const fechaTexto = searchParams.get("fecha") || fechaISOVenezuela(new Date());

  if (!FORMATO_FECHA.test(fechaTexto)) {
    return NextResponse.json({ error: "Fecha inválida. Usa el formato AAAA-MM-DD." }, { status: 400 });
  }

  try {
    const [anio, mes, dia] = fechaTexto.split("-").map(Number);
    const fecha = new Date(Date.UTC(anio, mes - 1, dia));
    const reporte = await generarReporteExcel(fecha, sucursal);

    // Sin pagos verificados ese día: 204, no un archivo vacío (§3 del spec).
    if (!reporte) {
      return new NextResponse(null, { status: 204 });
    }

    return new NextResponse(new Uint8Array(reporte.buffer), {
      status: 200,
      headers: {
        "Content-Type": TIPO_MIME_XLSX,
        "Content-Disposition": `attachment; filename="${reporte.nombre}"`,
      },
    });
  } catch (error) {
    return respuestaDeError(error, {
      contexto: "Reportes/Descargar",
      mensajeGenerico: "No se pudo generar el reporte.",
    });
  }
}
