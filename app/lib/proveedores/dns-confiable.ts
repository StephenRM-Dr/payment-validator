import { Agent } from "undici";
import dns from "node:dns";
import type { LookupFunction } from "node:net";

// Confirmado en producción: el resolutor DNS por defecto de la red de Vercel a veces no
// logra resolver 'sistemamv.tail8af645.ts.net' (ENOTFOUND intermitente), aunque el
// hostname esté sano — reproducido varias veces contra el puente Sofitasa, incluso
// agotando reintentos en menos de 2 segundos. Este Agent fuerza la resolución por
// 1.1.1.1/8.8.8.8 en vez del resolutor del sistema, para esa ruta específica.
const SERVIDORES_CONFIABLES = ["1.1.1.1", "8.8.8.8"];

// No hay garantía de que el entorno permita DNS crudo por UDP hacia servidores arbitrarios
// (algunos entornos serverless lo restringen) — si el resolutor confiable se cuelga en vez
// de fallar rápido, esta cota evita que la resolución tarde MÁS que antes de este cambio.
const TIMEOUT_CONFIABLE_MS = 2_000;

// Firma compatible con dns.lookup: (hostname, options, callback). Solo se pide IPv4
// ('resolve4') porque es lo único que necesita este puente — no hay AAAA que resolver.
//
// Un dns.Resolver NUEVO por llamada, no uno compartido: cancel() aborta TODAS las
// consultas pendientes de la instancia, y una instancia compartida cancelaría por error
// la consulta de otra petición concurrente si Vercel reutiliza la misma función "tibia"
// para dos verificaciones a la vez (Fluid Compute).
const lookupConfiable: LookupFunction = (hostname, options, callback) => {
  const pideTodos = typeof options === "object" && options?.all === true;
  const resolutor = new dns.Resolver();
  resolutor.setServers(SERVIDORES_CONFIABLES);

  let resuelto = false;
  const caerAlResolutorDelSistema = () => {
    if (resuelto) return;
    resuelto = true;
    dns.lookup(hostname, options, callback);
  };

  const temporizador = setTimeout(() => {
    resolutor.cancel();
    caerAlResolutorDelSistema();
  }, TIMEOUT_CONFIABLE_MS);

  resolutor.resolve4(hostname, (error, direcciones) => {
    clearTimeout(temporizador);
    // Si el resolutor confiable TAMBIÉN falla (o ya se decidió por timeout), se cae al
    // resolutor del sistema en vez de devolver el error directamente: esto es un intento
    // adicional, nunca debe dejar la conexión peor de lo que ya estaba.
    if (resuelto) return;
    if (error || direcciones.length === 0) {
      caerAlResolutorDelSistema();
      return;
    }
    resuelto = true;
    if (pideTodos) {
      callback(null, direcciones.map((address) => ({ address, family: 4 })));
    } else {
      callback(null, direcciones[0], 4);
    }
  });
};

// Un solo Agent module-level: crear uno por petición perdería el pooling de conexiones
// que undici ya hace bien, y este puente no necesita aislar nada entre llamadas. El
// lookup en sí ya crea un Resolver nuevo por invocación (ver arriba), así que el Agent
// compartido no repite el problema que eso evita.
export const agenteDnsConfiable = new Agent({ connect: { lookup: lookupConfiable } });
