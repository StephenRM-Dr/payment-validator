// Interruptor de emergencia ("freno de mano") leído en CADA intento de pago — Binance,
// BDV, Sofitasa y Bancamiga (cajero y seguimiento admin), de todas las sucursales. Antes,
// cada uno de esos 5 endpoints hacía su propio SELECT a configuracion_sistema (una tabla de
// una sola fila que casi nunca cambia), multiplicando por 5 la consulta más frecuente de
// toda la app. Se centraliza aquí con una caché en memoria de vida corta: en Fluid Compute
// la misma instancia atiende varias peticiones seguidas, así que la mayoría de esas lecturas
// se resuelven sin tocar la base de datos.
//
// TTL corto (no un caché largo tipo bancamiga-historial-cache) a propósito: este interruptor
// existe para cortar el sistema YA ante un problema en producción, y una caché de varios
// minutos retrasaría ese corte. 5 segundos ya elimina la enorme mayoría de las repeticiones
// dentro de una racha de ventas seguidas, sin sacrificar la reacción del freno de mano.
//
// Vive en memoria de la instancia, no en base de datos: si la instancia se recicla (cold
// start), el peor caso es una lectura de más — igual que si no hubiera caché.

import { obtenerSql, conReintentos } from "./db.ts";

const TTL_MS = 5000;

export interface ConfigSistema {
  sistemaActivo: boolean;
  mensajeBloqueo: string | null;
}

let cache: { valor: ConfigSistema; expiraEn: number } | null = null;

export async function obtenerConfigSistema(): Promise<ConfigSistema> {
  if (cache && Date.now() < cache.expiraEn) {
    return cache.valor;
  }

  const sql = obtenerSql();
  const [fila] = await conReintentos(() => sql`
    SELECT sistema_activo, mensaje_bloqueo FROM configuracion_sistema LIMIT 1;
  `);

  // Sin fila (tabla vacía o aún no migrada): se interpreta como sistema activo, igual que
  // el `if (config && !config.sistema_activo)` que hacía cada endpoint antes de esta caché.
  const valor: ConfigSistema = {
    sistemaActivo: fila ? Boolean(fila.sistema_activo) : true,
    mensajeBloqueo: fila?.mensaje_bloqueo ?? null,
  };

  cache = { valor, expiraEn: Date.now() + TTL_MS };
  return valor;
}
