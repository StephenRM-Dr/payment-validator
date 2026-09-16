import { comparacionSegura } from "./seguridad.ts";

// Portero de las rutas que dispara Vercel Cron (no un navegador ni el puente Sofitasa).
//
// Vercel firma sus propias invocaciones de cron con 'Authorization: Bearer <CRON_SECRET>'
// automáticamente en cuanto el proyecto tiene la variable CRON_SECRET configurada — no hace
// falta guardar nada más en vercel.json. Sin CRON_SECRET configurado, la ruta se cierra a
// cualquiera en vez de quedar abierta por accidente.
export function autorizaCron(headerAutorizacion: string | null, secretoConfigurado: string): boolean {
  if (!secretoConfigurado) return false;
  if (!headerAutorizacion || !headerAutorizacion.startsWith("Bearer ")) return false;
  return comparacionSegura(headerAutorizacion.slice("Bearer ".length), secretoConfigurado);
}
