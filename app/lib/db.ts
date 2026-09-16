import { neon } from "@neondatabase/serverless";

// Cliente SQL de Neon (HTTP serverless): una instancia por invocación es el patrón correcto.
// Si falta DATABASE_URL se falla de inmediato con un mensaje claro, en vez de dejar que el
// driver reviente más adelante con un error opaco de URL malformada.
export function obtenerSql() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL no está configurada en el entorno.");
  }
  return neon(url);
}

export type SqlNeon = ReturnType<typeof obtenerSql>;

// Detecta fallos transitorios de red hacia Neon (timeout de conexión, fetch failed, reset).
// Recorre la cadena de errores anidados (NeonDbError → sourceError → cause) buscando señales de red.
export function esErrorDeConexion(error: unknown): boolean {
  const mensajes: string[] = [];
  let actual: unknown = error;
  for (let profundidad = 0; actual instanceof Error && profundidad < 5; profundidad++) {
    mensajes.push(actual.name, actual.message, String((actual as { code?: string }).code ?? ""));
    actual = (actual as { sourceError?: unknown }).sourceError ?? actual.cause;
  }
  return /fetch failed|Connect Timeout|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR_CONNECT/i.test(mensajes.join(" "));
}

// Reintenta una consulta ante fallos transitorios de red (la conexión a Neon a veces
// tarda o se cae momentáneamente; un reintento con espera breve suele resolverlo).
// ⚠️ Usar solo con operaciones seguras de repetir: lecturas o escrituras idempotentes.
export async function conReintentos<T>(operacion: () => Promise<T>, intentos = 3): Promise<T> {
  let ultimoError: unknown;
  for (let intento = 1; intento <= intentos; intento++) {
    try {
      return await operacion();
    } catch (error) {
      ultimoError = error;
      if (!esErrorDeConexion(error) || intento === intentos) throw error;
      console.warn(`⚠️ [DB] Fallo de conexión con la base de datos (intento ${intento}/${intentos}). Reintentando...`);
      await new Promise((resolver) => setTimeout(resolver, 700 * intento));
    }
  }
  throw ultimoError;
}
