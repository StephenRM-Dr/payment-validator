// Caché en base de datos del historial diario de Bancamiga, por CUENTA real (teléfono
// destino) — no por sucursal.
//
// Por qué existe: el banco recomienda no consultar /bancamiga/historial más de una vez cada
// 10 minutos por teléfono destino (BANCAMIGA_HISTORIAL_COOLDOWN_MS en servidor-bancamiga/,
// ver su README), y el puente hace respetar ese límite devolviendo 429. Pero
// buscarEnListaBancamiga necesita el historial del día en CADA verificación que haga un
// cajero — en una sucursal con varias ventas seguidas, eso agota el cooldown en minutos.
//
// Por qué por TELÉFONO y no por sucursal (migración 011): varias sucursales pueden compartir
// la misma cuenta Bancamiga — confirmado en producción (San Cristóbal, Barinas, Caracas,
// Valencia, Maracaibo y Concordia comparten un teléfono; Mérida tiene el suyo propio) — y el
// cooldown del banco es por teléfono. Cachear por sucursal dejaba a las demás sucursales de
// una misma cuenta sin nada que reusar cuando chocaban con el cooldown que YA había gastado
// otra sucursal hermana: la verificación fallaba en vez de reusar un historial que, al ser la
// misma cuenta, ya era idéntico. bancamiga_sucursal_telefono guarda el último teléfono
// conocido por sucursal para poder resolver la clave de caché sin gastar una llamada al banco
// (esa tabla es pura resolución local, no cuenta contra el cooldown).
//
// Esta capa vive separada de bancamiga.ts (que es un cliente HTTP puro, sin tocar la base de
// datos, igual que bdv.ts y sofitasa.ts) porque es la única pieza de la integración de
// Bancamiga que sí necesita persistencia.

import { obtenerSql, conReintentos } from "../db.ts";
import { consultarHistorialBancamiga, type MovimientoBancamiga } from "./bancamiga.ts";

// Bajado a propósito a 1 minuto (antes 9, justo debajo del cooldown real de 10 minutos del
// banco). Con 6 sucursales compartiendo una sola cuenta (Caracas, San Cristóbal, Barinas,
// Valencia, Maracaibo, Concordia — Mérida tiene la suya propia y no sufre esto), 9 minutos de
// caché compartida entre tanto tráfico dejaba pasar de largo pagos recién llegados.
//
// ⚠️ Esto NO trae datos más frescos del banco: el puente sigue haciendo cumplir el cooldown
// real de ~10 minutos y responde 429 si se le pide antes de tiempo (BANCAMIGA_HISTORIAL_
// COOLDOWN_MS en servidor-bancamiga/), y ese 429 hace que se reutilice la copia vieja en
// caché (ver el 'if (fila)' más abajo) — no hay downgrade a un error visible para el cajero.
// Lo que SÍ gana con un valor bajo: en cuanto el cooldown real del banco haya vencido, la
// siguiente verificación lo detecta casi al instante en vez de esperar hasta 9 minutos de
// caché local encima del cooldown ya vencido. El costo: más peticiones al puente que
// probablemente reciban 429 sin ningún beneficio, y una respuesta algo más lenta para el
// cajero en esos casos (hay un viaje de red de más antes de caer al respaldo).
const REFRESCO_MAXIMO_MS = 60 * 1000;

export type ResultadoHistorialConCache =
  | { ok: true; lista: MovimientoBancamiga[]; telefonoDestino: string }
  | { ok: false; mensaje: string; detalle: string };

/**
 * Historial del día de la cuenta de una sucursal, reutilizando la última copia guardada
 * mientras siga vigente (menos de 9 minutos) — de esta sucursal o de cualquier otra que
 * comparta el mismo teléfono. Si hace falta refrescar y el puente devuelve el cooldown activo
 * (u otro fallo), se usa la copia en caché aunque esté más vieja en vez de fallar la
 * verificación — un historial de hace 20 minutos sigue siendo casi todo útil; un 503 no.
 */
export async function obtenerHistorialConCache(sucursal: string, fechaIso: string): Promise<ResultadoHistorialConCache> {
  const sql = obtenerSql();

  const [mapeo] = await conReintentos(() => sql`
    SELECT telefono_destino FROM bancamiga_sucursal_telefono WHERE sucursal = ${sucursal} LIMIT 1;
  `);
  const telefonoConocido: string | null = mapeo?.telefono_destino ?? null;

  // Sin teléfono conocido todavía (primera vez que se ve esta sucursal, o tabla recién
  // migrada) no hay nada que buscar en caché: se cae directo a pedirle el historial al puente
  // más abajo, igual que si no hubiera caché.
  let fila: Record<string, any> | undefined;
  if (telefonoConocido) {
    [fila] = await conReintentos(() => sql`
      SELECT lista, actualizado_en FROM bancamiga_historial_cache
      WHERE telefono_destino = ${telefonoConocido} AND fecha = ${fechaIso}
      LIMIT 1;
    `);
  }

  const vigente = Boolean(fila) && Date.now() - new Date(fila!.actualizado_en).getTime() < REFRESCO_MAXIMO_MS;
  if (vigente) {
    // telefonoConocido no puede ser null aquí: 'fila' solo se consulta cuando sí lo es.
    return { ok: true, lista: fila!.lista as MovimientoBancamiga[], telefonoDestino: telefonoConocido! };
  }

  const resultado = await consultarHistorialBancamiga(sucursal, fechaIso);

  // '=== true'/'=== false' y no la condición desnuda: el proyecto compila con strict
  // desactivado, y ahí TypeScript solo estrecha la unión discriminada con una comparación
  // explícita (mismo motivo documentado en bdv.ts y bancamiga.ts).
  if (resultado.ok === true) {
    await conReintentos(() => sql`
      INSERT INTO bancamiga_historial_cache (telefono_destino, fecha, lista, sucursal, actualizado_en)
      VALUES (${resultado.telefonoDestino}, ${fechaIso}, ${JSON.stringify(resultado.lista)}::jsonb, ${sucursal}, now())
      ON CONFLICT (telefono_destino, fecha)
        DO UPDATE SET lista = EXCLUDED.lista, sucursal = EXCLUDED.sucursal, actualizado_en = EXCLUDED.actualizado_en;
    `);
    await conReintentos(() => sql`
      INSERT INTO bancamiga_sucursal_telefono (sucursal, telefono_destino, actualizado_en)
      VALUES (${sucursal}, ${resultado.telefonoDestino}, now())
      ON CONFLICT (sucursal)
        DO UPDATE SET telefono_destino = EXCLUDED.telefono_destino, actualizado_en = EXCLUDED.actualizado_en;
    `);
    return { ok: true, lista: resultado.lista, telefonoDestino: resultado.telefonoDestino };
  }

  // El refresco falló (posible cooldown activo — quizás ya gastado por otra sucursal de la
  // misma cuenta —, red, banco caído). Con un caché aunque esté viejo, mejor reusarlo que
  // devolverle un 503 al cajero por un límite que no depende de él.
  if (fila) {
    console.warn(`⚠️ [Bancamiga] No se pudo refrescar el historial de "${sucursal}"; se usa el caché existente (posible cooldown activo, compartido con otra sucursal de la misma cuenta): ${resultado.mensaje}`);
    // telefonoConocido no puede ser null aquí: 'fila' solo se consulta cuando sí lo es.
    return { ok: true, lista: fila.lista as MovimientoBancamiga[], telefonoDestino: telefonoConocido! };
  }

  return { ok: false, mensaje: resultado.mensaje, detalle: resultado.detalle };
}
