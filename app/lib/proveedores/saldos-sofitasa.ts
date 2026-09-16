// Junta las consultas de saldo de las dos empresas de Sofitasa en un solo resultado, en la
// forma común que define saldos-tipos.ts — la misma que usa saldos-bdv.ts para el otro
// banco, para que ambos proveedores puedan mostrarse y guardarse juntos.

import { obtenerSaldosSofitasa, type SaldoCuentaSofitasa } from "./sofitasa.ts";
import { EMPRESAS_SOFITASA, type EmpresaSofitasa } from "./empresas-sofitasa.ts";
import type { FilaSaldo, ResultadoSaldoCuenta } from "./saldos-tipos.ts";

// Aplana la lista de cuentas que devuelve el puente para una empresa en filas listas para
// mostrar en el panel o insertar en saldos_historial — misma forma en los dos casos, así
// que no hay dos versiones del mismo dato divergiendo con el tiempo.
export function aplanarSaldos(empresa: EmpresaSofitasa, cuentas: SaldoCuentaSofitasa[]): FilaSaldo[] {
  return cuentas.map((cuenta) => ({
    proveedor: "SOFITASA",
    empresa,
    cuenta: cuenta.Cuenta,
    producto: cuenta.producto || null,
    moneda: cuenta.moneda,
    saldo: Number(cuenta.saldo),
  }));
}

/**
 * Consulta el saldo de las dos empresas EN PARALELO. Si el banco falla para una, la otra
 * igual se resuelve: cada resultado dice por sí mismo si esa empresa respondió o no, en vez
 * de que un solo fallo tire toda la consulta (acme y beta son independientes).
 */
export async function consultarSaldosTodasLasEmpresas(): Promise<ResultadoSaldoCuenta[]> {
  return Promise.all(
    EMPRESAS_SOFITASA.map(async (empresa): Promise<ResultadoSaldoCuenta> => {
      const resultado = await obtenerSaldosSofitasa(empresa);
      if (resultado.estado === "OK") {
        return { proveedor: "SOFITASA", empresa, ok: true, filas: aplanarSaldos(empresa, resultado.cuentas) };
      }
      return { proveedor: "SOFITASA", empresa, ok: false, mensaje: resultado.mensaje };
    })
  );
}
