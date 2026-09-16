import { NextResponse } from "next/server";
import { obtenerSql, conReintentos, esErrorDeConexion } from "../../../../../lib/db";
import { verificarAccesoAdmin } from "../../../../../lib/auth-admin";

// Trae la foto del comprobante de UNA sola transacción, bajo demanda.
// Separado de /api/admin/auditoria a propósito: esa lista se recarga cada 15s por el
// auto-refresco del panel y nunca debe cargar las fotos (~100 KB cada una) de las 20 filas
// visibles — solo esta ruta, invocada al pulsar "Ver", transfiere la imagen real.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    // 🔒 Mismo control de acceso que el resto del panel administrativo
    const acceso = await verificarAccesoAdmin(request);
    if (acceso.ok === false) {
      return NextResponse.json({ error: acceso.error }, { status: acceso.estado });
    }

    const { id: idParam } = await params;
    const id = Number.parseInt(idParam, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return NextResponse.json({ error: "ID de transacción inválido." }, { status: 400 });
    }

    const sql = obtenerSql();
    const [fila] = await conReintentos(() => sql`
      SELECT imagen_comprobante_base64 FROM transacciones WHERE id = ${id} LIMIT 1;
    `);

    // Se distinguen los dos casos: para una auditoría no es lo mismo que la transacción
    // no exista a que exista y le falte el comprobante.
    if (!fila) {
      return NextResponse.json({ error: "No existe una transacción con ese ID." }, { status: 404 });
    }
    if (!fila.imagen_comprobante_base64) {
      return NextResponse.json({ error: "Esta transacción no tiene comprobante adjunto." }, { status: 404 });
    }

    // Se devuelve la imagen BINARIA, no un JSON con base64: el base64 añade ~33% sobre los
    // bytes reales y obliga al navegador a parsear una cadena de ~140 KB. La cabecera de
    // caché evita volver a descargarla cuando el administrador reabre el mismo comprobante
    // (es privada: no debe quedar en cachés compartidas).
    // Se corta por la primera coma en vez de aplicar una regex sobre toda la cadena:
    // la imagen ronda los 140 KB y solo interesa la cabecera "data:image/jpeg;base64".
    const dataUri = String(fila.imagen_comprobante_base64);
    const separador = dataUri.indexOf(",");
    const cabecera = separador >= 0 ? dataUri.slice(0, separador) : "";
    const base64 = separador >= 0 ? dataUri.slice(separador + 1) : dataUri;
    const tipoMime = /^data:([^;]+);base64$/.exec(cabecera)?.[1] || "image/jpeg";
    const binario = Buffer.from(base64, "base64");

    return new NextResponse(new Uint8Array(binario), {
      status: 200,
      headers: {
        "Content-Type": tipoMime,
        "Content-Length": String(binario.length),
        "Cache-Control": "private, max-age=86400, immutable",
      },
    });

  } catch (error) {
    console.error("❌ [Imagen] Error al obtener el comprobante:", error);

    if (esErrorDeConexion(error)) {
      return NextResponse.json(
        { error: "⚠️ Fallo temporal de conexión con la base de datos. Inténtalo de nuevo." },
        { status: 503 }
      );
    }

    return NextResponse.json({ error: "Fallo interno al obtener el comprobante." }, { status: 500 });
  }
}
