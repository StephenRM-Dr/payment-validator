import { obtenerSql } from "./db.ts";
import { comparacionSegura, ipDeLaPeticion } from "./seguridad.ts";

// Portero del panel administrativo.
//
// El PIN da acceso al historial financiero completo y a la edición de registros
// contables. Sin límite de intentos, un PIN de 4 dígitos son 10.000 combinaciones que
// un script agota en minutos. Aquí se añaden las tres defensas que faltaban:
// comparación en tiempo constante, límite de intentos por IP y registro de los fallos.
//
// El contador vive en la base de datos (no en memoria) porque en Vercel cada petición
// puede atenderla una instancia distinta: un contador en memoria se reiniciaría solo.

const MAX_INTENTOS = 5;             // fallos permitidos antes de bloquear
const MINUTOS_BLOQUEO = 15;         // duración del bloqueo por IP
const LONGITUD_PIN_RECOMENDADA = 6; // por debajo de esto se avisa en los logs

export type ResultadoAcceso =
  | { ok: true }
  | { ok: false; estado: number; error: string; reintentarEn?: number };

// Registra el fallo y bloquea la IP si superó el límite. Nunca lanza: un problema
// con la tabla de intentos no debe impedir que la petición se rechace correctamente.
async function registrarFallo(ip: string): Promise<void> {
  try {
    const sql = obtenerSql();
    await sql`
      INSERT INTO intentos_admin (ip, intentos, bloqueado_hasta, actualizado_en)
      VALUES (${ip}, 1, NULL, NOW())
      ON CONFLICT (ip) DO UPDATE SET
        intentos = intentos_admin.intentos + 1,
        bloqueado_hasta = CASE
          WHEN intentos_admin.intentos + 1 >= ${MAX_INTENTOS}
          THEN NOW() + (${MINUTOS_BLOQUEO} || ' minutes')::interval
          ELSE intentos_admin.bloqueado_hasta
        END,
        actualizado_en = NOW();
    `;
  } catch (error) {
    console.error("❌ [Admin] No se pudo registrar el intento fallido:", error);
  }
}

async function limpiarIntentos(ip: string): Promise<void> {
  try {
    const sql = obtenerSql();
    // Borra el historial de la IP que acertó y, de paso, los registros viejos de todas
    await sql`DELETE FROM intentos_admin WHERE ip = ${ip} OR actualizado_en < NOW() - interval '1 day';`;
  } catch (error) {
    console.error("❌ [Admin] No se pudo limpiar el registro de intentos:", error);
  }
}

// Devuelve los segundos que le quedan de bloqueo a la IP, o 0 si puede intentar.
async function segundosDeBloqueo(ip: string): Promise<number> {
  try {
    const sql = obtenerSql();
    const [fila] = await sql`
      SELECT GREATEST(0, CEIL(EXTRACT(EPOCH FROM (bloqueado_hasta - NOW()))))::int AS restan
      FROM intentos_admin
      WHERE ip = ${ip} AND bloqueado_hasta IS NOT NULL AND bloqueado_hasta > NOW()
      LIMIT 1;
    `;
    return fila?.restan ?? 0;
  } catch (error) {
    // Si la tabla aún no existe (despliegue previo a la migración), no bloquear la operación
    console.error("❌ [Admin] No se pudo consultar el bloqueo por intentos:", error);
    return 0;
  }
}

export async function verificarAccesoAdmin(request: Request): Promise<ResultadoAcceso> {
  const pinCorrecto = process.env.ADMIN_PIN;

  if (!pinCorrecto) {
    console.error("❌ [Admin] La variable de entorno ADMIN_PIN no está configurada.");
    return { ok: false, estado: 503, error: "Servicio no disponible." };
  }

  if (pinCorrecto.length < LONGITUD_PIN_RECOMENDADA) {
    console.warn(
      `⚠️ [Admin] ADMIN_PIN tiene ${pinCorrecto.length} caracteres. Con menos de ${LONGITUD_PIN_RECOMENDADA} el espacio de combinaciones es pequeño; conviene alargarlo.`
    );
  }

  const ip = ipDeLaPeticion(request);

  const restan = await segundosDeBloqueo(ip);
  if (restan > 0) {
    console.warn(`⛔ [Admin] IP ${ip} bloqueada por intentos fallidos; le restan ${restan}s.`);
    return {
      ok: false,
      estado: 429,
      error: `⛔ Demasiados intentos fallidos. Vuelve a intentarlo en ${Math.ceil(restan / 60)} minuto(s).`,
      reintentarEn: restan,
    };
  }

  const pinEnviado = request.headers.get("X-Admin-Pin");
  if (!pinEnviado || !comparacionSegura(pinEnviado, pinCorrecto)) {
    console.warn(`⚠️ [Admin] PIN incorrecto desde la IP ${ip}.`);
    await registrarFallo(ip);
    return { ok: false, estado: 403, error: "❌ Acceso denegado. PIN incorrecto o no suministrado." };
  }

  await limpiarIntentos(ip);
  return { ok: true };
}

// Nombre de la variable de entorno que guarda la clave scoped de una sucursal para
// descargar su propio reporte (ej. "San Cristobal" → "REPORTES_CLAVE_SAN_CRISTOBAL").
// Los valores de VALORES_SUCURSALES ya vienen sin acentos (ver app/lib/sucursales.ts).
export function nombreVariableClaveSucursal(sucursal: string): string {
  return `REPORTES_CLAVE_${sucursal.toUpperCase().replace(/\s+/g, "_")}`;
}

// Decide si la credencial de la petición autoriza a descargar el reporte de una sucursal.
// El PIN admin (si se envía) es la única vía evaluada: no cae a la clave de sucursal aunque
// esta también se haya enviado y sea correcta, para que el comportamiento sea predecible.
// Función pura para poder probarla sin tocar el entorno ni la base de datos.
export function evaluarCredencialReporte(datos: {
  pinAdminEnviado: string | null;
  pinAdminCorrecto: string;
  claveEnviada: string | null;
  claveCorrectaSucursal: string | null;
}): boolean {
  if (datos.pinAdminEnviado !== null) {
    return comparacionSegura(datos.pinAdminEnviado, datos.pinAdminCorrecto);
  }
  if (datos.claveEnviada !== null && datos.claveCorrectaSucursal !== null) {
    return comparacionSegura(datos.claveEnviada, datos.claveCorrectaSucursal);
  }
  return false;
}

// Portero del endpoint de descarga de reportes. Acepta el PIN admin de siempre (cualquier
// sucursal) o, si no se envía, una clave scoped por sucursal (REPORTES_CLAVE_<SUCURSAL>)
// que solo autoriza el reporte de esa sucursal. Reusa el mismo bloqueo por IP que el resto
// del panel admin — ver el comentario al inicio del archivo.
export async function verificarAccesoReporte(request: Request, sucursal: string): Promise<ResultadoAcceso> {
  const pinAdminCorrecto = process.env.ADMIN_PIN;
  if (!pinAdminCorrecto) {
    console.error("❌ [Admin] La variable de entorno ADMIN_PIN no está configurada.");
    return { ok: false, estado: 503, error: "Servicio no disponible." };
  }

  const ip = ipDeLaPeticion(request);

  const restan = await segundosDeBloqueo(ip);
  if (restan > 0) {
    console.warn(`⛔ [Admin] IP ${ip} bloqueada por intentos fallidos; le restan ${restan}s.`);
    return {
      ok: false,
      estado: 429,
      error: `⛔ Demasiados intentos fallidos. Vuelve a intentarlo en ${Math.ceil(restan / 60)} minuto(s).`,
      reintentarEn: restan,
    };
  }

  const { searchParams } = new URL(request.url);
  const autorizado = evaluarCredencialReporte({
    pinAdminEnviado: request.headers.get("X-Admin-Pin"),
    pinAdminCorrecto,
    claveEnviada: searchParams.get("clave"),
    claveCorrectaSucursal: process.env[nombreVariableClaveSucursal(sucursal)] || null,
  });

  if (!autorizado) {
    console.warn(`⚠️ [Admin] Credencial de reporte inválida para "${sucursal}" desde la IP ${ip}.`);
    await registrarFallo(ip);
    return { ok: false, estado: 403, error: "❌ Acceso denegado. Credencial inválida o no suministrada." };
  }

  await limpiarIntentos(ip);
  return { ok: true };
}
