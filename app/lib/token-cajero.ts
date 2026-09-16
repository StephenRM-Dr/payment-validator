// Portero de los endpoints del cajero.
//
// Los endpoints /api/transacciones/validar y /escanear escriben en el libro contable y
// gastan cuota de IA, pero el panel del cajero no tiene login (decisión de negocio: no
// se le pide nada al cajero). Para no dejarlos abiertos a cualquiera que descubra la URL:
//
//   • El navegador recibe una cookie firmada (HMAC) al cargar /cajero — la emite el
//     middleware, nunca viaja en el JavaScript de la página, y el cajero no ve nada.
//   • Los scripts internos (pruebas, worker) pueden usar la cabecera X-Cajero-Token
//     con el secreto directo, sin pasar por el navegador.
//
// Alcance honesto de esta protección: frena el escaneo automatizado de endpoints, los
// intentos con curl y el gasto de cuota de IA por terceros. NO es autenticación real —
// quien pueda abrir /cajero en un navegador obtiene una cookie válida. Para eso haría
// falta un login por usuario, que hoy está descartado a propósito.

import { comparacionSegura } from "./seguridad";

const NOMBRE_COOKIE = "vp_cajero";
// 7 días, y además se renueva en cada uso (ver middleware.ts). Antes eran 12 horas
// contadas desde el primer acceso, exactamente la duración de un turno: la credencial
// caducaba a mitad de jornada o de un día para otro, y como la app va instalada como PWA
// —Android la restaura desde segundo plano sin volver a pasar por el middleware— el
// primer escaneo del día se rechazaba sin que el cajero supiera por qué.
const VIGENCIA_SEGUNDOS = 60 * 60 * 24 * 7;

function obtenerSecreto(): string | null {
  return process.env.CAJERO_SECRET || null;
}

// HMAC-SHA256 con Web Crypto: disponible tanto en el runtime Edge (middleware)
// como en Node (rutas de API), así que el mismo código sirve en ambos lados.
async function firmar(mensaje: string, secreto: string): Promise<string> {
  const codificador = new TextEncoder();
  const clave = await crypto.subtle.importKey(
    "raw",
    codificador.encode(secreto),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const firma = await crypto.subtle.sign("HMAC", clave, codificador.encode(mensaje));
  return Buffer.from(new Uint8Array(firma)).toString("base64url");
}

export const COOKIE_CAJERO = NOMBRE_COOKIE;
export const VIGENCIA_COOKIE_SEGUNDOS = VIGENCIA_SEGUNDOS;

// Genera el valor de la cookie: "<emitidoEn>.<firma>"
export async function emitirTokenCajero(): Promise<string | null> {
  const secreto = obtenerSecreto();
  if (!secreto) return null;
  const emitidoEn = Date.now().toString();
  return `${emitidoEn}.${await firmar(emitidoEn, secreto)}`;
}

// Valida la petición: cookie firmada y vigente, o cabecera con el secreto directo.
// Si CAJERO_SECRET no está configurado, no bloquea nada (permite desplegar el cambio
// sin romper la operación mientras la variable se configura en el entorno).
export async function peticionDeCajeroValida(request: Request): Promise<boolean> {
  const secreto = obtenerSecreto();
  if (!secreto) {
    console.warn("⚠️ [Cajero] CAJERO_SECRET no configurado: los endpoints del cajero quedan sin protección.");
    return true;
  }

  // Vía 1: scripts internos (pruebas de integración, herramientas del equipo)
  const cabecera = request.headers.get("X-Cajero-Token");
  if (cabecera && comparacionSegura(cabecera, secreto)) return true;

  // Vía 2: navegador que cargó /cajero y recibió la cookie firmada
  const cookies = request.headers.get("cookie") || "";
  const valor = new RegExp(`(?:^|;\\s*)${NOMBRE_COOKIE}=([^;]+)`).exec(cookies)?.[1];
  if (!valor) return false;

  const [emitidoEn, firmaRecibida] = valor.split(".");
  if (!emitidoEn || !firmaRecibida) return false;

  const edadSegundos = (Date.now() - Number.parseInt(emitidoEn, 10)) / 1000;
  if (!Number.isFinite(edadSegundos) || edadSegundos < 0 || edadSegundos > VIGENCIA_SEGUNDOS) return false;

  return comparacionSegura(firmaRecibida, await firmar(emitidoEn, secreto));
}
