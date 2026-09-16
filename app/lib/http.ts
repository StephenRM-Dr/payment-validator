import { NextResponse } from "next/server";
import { esErrorDeConexion } from "./db";
import { verificarAccesoAdmin } from "./auth-admin";

// Utilidades compartidas por las rutas de API: control de acceso, lectura del cuerpo,
// normalización de parámetros y traducción de errores a respuestas HTTP.
// Cada ruta usaba su propia copia de estas piezas; centralizarlas evita que las reglas
// (por ejemplo el control por PIN) se desincronicen entre endpoints.

// Algunas rutas responden con { error } y otras con { message }: la clave se elige
// en cada llamada para no romper los contratos que ya consumen los paneles.
export type ClaveMensaje = "error" | "message";

function respuesta(clave: ClaveMensaje, mensaje: string, status: number) {
  return NextResponse.json({ [clave]: mensaje }, { status });
}

// 🔒 Control de acceso del panel administrativo por cabecera X-Admin-Pin
// (nunca por query string: los parámetros quedan en logs e historial del navegador).
// Devuelve la respuesta de rechazo, o null si el acceso es válido.
//
// ⚠️ Delega en 'verificarAccesoAdmin' a propósito, en vez de comparar el PIN aquí: esa
// implementación añade comparación en tiempo constante y bloqueo por intentos fallidos.
// Una comparación directa con === y sin límite de intentos dejaría 10.000 combinaciones
// al alcance de un script en minutos, y el PIN da acceso al historial financiero completo.
export async function verificarPinAdmin(request: Request, contexto: string): Promise<NextResponse | null> {
  const acceso = await verificarAccesoAdmin(request);
  if (acceso.ok === false) {
    if (acceso.estado === 503) console.error(`❌ [${contexto}] Servicio de acceso no disponible.`);
    return respuesta("error", acceso.error, acceso.estado);
  }
  return null;
}

// Lee el cuerpo JSON de la petición; devuelve null si no es JSON válido.
export async function leerCuerpoJson(request: Request): Promise<Record<string, unknown> | null> {
  const body = await request.json().catch(() => null);
  return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
}

// Convierte un valor del body a texto solo si es un primitivo legítimo;
// objetos o arrays enviados con malicia se tratan como vacío (y fallan la validación).
export function comoTexto(valor: unknown): string {
  if (typeof valor === "string") return valor;
  if (typeof valor === "number" && Number.isFinite(valor)) return String(valor);
  return "";
}

// ID de transacción de la URL: entero positivo o null.
export function parsearIdTransaccion(idParam: string): number | null {
  const id = Number.parseInt(idParam, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// Traduce un error inesperado en respuesta HTTP: el detalle queda en el log del servidor
// y al cliente solo se le informa el fallo. Un fallo de red hacia Neon (aun después de
// los reintentos) se distingue como 503 temporal para que el usuario reintente.
export function respuestaDeError(
  error: unknown,
  opciones: { contexto: string; clave?: ClaveMensaje; mensajeGenerico: string; mensajeConexion?: string }
): NextResponse {
  const clave = opciones.clave ?? "error";
  console.error(`❌ [${opciones.contexto}] Error:`, error);

  if (esErrorDeConexion(error)) {
    return respuesta(
      clave,
      opciones.mensajeConexion ?? "⚠️ Fallo temporal de conexión con la base de datos. Inténtalo de nuevo en unos segundos.",
      503
    );
  }

  return respuesta(clave, opciones.mensajeGenerico, 500);
}
