// Junta la consulta de saldo de las dos cuentas BDV (Acme Corp y Beta Corp) en la misma
// forma común que usa saldos-sofitasa.ts (ver saldos-tipos.ts), para que ambos bancos puedan
// mostrarse y guardarse juntos en /admin/saldos y saldos_historial.

import { ultimoSaldoBdv } from "./bdv.ts";
import { CLAVES_CUENTA_BDV, EMPRESA_POR_CUENTA_BDV, credencialesDeCuenta } from "./cuentas-bdv.ts";
import type { FilaSaldo, ResultadoSaldoCuenta } from "./saldos-tipos.ts";

/**
 * Consulta las dos cuentas EN PARALELO. Si una falla (credencial faltante, banco sin
 * responder), la otra igual se resuelve — mismo espíritu que consultarSaldosTodasLasEmpresas
 * de Sofitasa.
 */
export async function consultarSaldosBdvTodasLasEmpresas(): Promise<ResultadoSaldoCuenta[]> {
  return Promise.all(
    CLAVES_CUENTA_BDV.map(async (clave): Promise<ResultadoSaldoCuenta> => {
      const empresa = EMPRESA_POR_CUENTA_BDV[clave];

      const credencial = credencialesDeCuenta(clave);
      if (credencial.ok === false) {
        return { proveedor: "BDV", empresa, ok: false, mensaje: credencial.mensaje };
      }

      const resultado = await ultimoSaldoBdv(credencial.credenciales);
      if (resultado.estado === "SIN_RESPUESTA") {
        return { proveedor: "BDV", empresa, ok: false, mensaje: resultado.mensaje };
      }

      const fila: FilaSaldo = {
        proveedor: "BDV",
        empresa,
        cuenta: credencial.credenciales.cuenta,
        producto: null,
        moneda: "VES",
        saldo: resultado.datos.saldo,
      };
      return { proveedor: "BDV", empresa, ok: true, filas: [fila] };
    })
  );
}
