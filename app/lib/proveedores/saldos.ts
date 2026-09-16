// Combina los saldos de todos los bancos soportados (Sofitasa + BDV) en una sola lista —
// el único punto que /api/admin/saldos y /api/cron/saldos necesitan importar. Añadir un
// tercer banco más adelante significa sumar una línea aquí, no tocar las dos rutas.

import { consultarSaldosTodasLasEmpresas } from "./saldos-sofitasa.ts";
import { consultarSaldosBdvTodasLasEmpresas } from "./saldos-bdv.ts";
import type { ResultadoSaldoCuenta } from "./saldos-tipos.ts";

export async function consultarTodosLosSaldos(): Promise<ResultadoSaldoCuenta[]> {
  const [sofitasa, bdv] = await Promise.all([
    consultarSaldosTodasLasEmpresas(),
    consultarSaldosBdvTodasLasEmpresas(),
  ]);
  return [...sofitasa, ...bdv];
}
