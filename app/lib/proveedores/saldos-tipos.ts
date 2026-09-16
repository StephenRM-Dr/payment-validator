// Forma común de una fila de saldo, sin importar el banco: la usan tanto Sofitasa (Balance
// Consult, saldo en tiempo real vía el puente) como BDV (derivado del último movimiento, sin
// endpoint de saldo dedicado) — así saldos_historial y el panel no necesitan saber de qué
// proveedor viene cada fila, solo mostrarla.

export type ProveedorSaldo = "SOFITASA" | "BDV";
export type EmpresaSaldo = "acme" | "beta";

export interface FilaSaldo {
  proveedor: ProveedorSaldo;
  empresa: EmpresaSaldo;
  cuenta: string;
  producto: string | null; // concepto propio de Sofitasa; null en BDV
  moneda: string;
  saldo: number;
}

export type ResultadoSaldoCuenta =
  | { proveedor: ProveedorSaldo; empresa: EmpresaSaldo; ok: true; filas: FilaSaldo[] }
  | { proveedor: ProveedorSaldo; empresa: EmpresaSaldo; ok: false; mensaje: string };
