// A qué empresa (persona jurídica) de Sofitasa le pertenece cada sucursal.
//
// El negocio opera Sofitasa a nombre de dos empresas — Acme Corp y Beta Corp—, cada una
// con su propio ClienteCod, login e IP de origen ante el banco (ver servidor-sofitasa/).
// Un pago hecho a nombre de una empresa NO aparece en el estado de cuenta de la otra, así
// que consultar la empresa equivocada da "no encontrado" para un pago que sí existe.
//
// PENDIENTE DE CONFIRMAR: el reparto de abajo asume el mismo split que ya usa BDV
// (San Cristobal/Mérida/Barinas/Caracas vs. Maracaibo/Valencia/Concordia) porque el negocio
// no tenía, al escribir esto, el reparto real documentado en ningún otro lugar. Si el
// reparto de Sofitasa resulta distinto, este es el único archivo que hay que corregir.
//
// Mismo motivo que cuentas-bdv.ts para el Record exhaustivo: si se añade una sucursal a
// SUCURSALES y nadie la asigna aquí, el proyecto no compila.

import { SUCURSALES } from "../sucursales.ts";

export type EmpresaSofitasa = "acme" | "beta";

// Lista de las dos empresas, para recorrerlas (ej. consultar el saldo de ambas) sin repetir
// el literal en cada llamador.
export const EMPRESAS_SOFITASA: readonly EmpresaSofitasa[] = ["acme", "beta"];

type Sucursal = (typeof SUCURSALES)[number]["valor"];

export const EMPRESA_POR_SUCURSAL: Record<Sucursal, EmpresaSofitasa> = {
  "San Cristobal": "acme",
  Merida: "acme",
  Barinas: "acme",
  Caracas: "acme",
  Maracaibo: "beta",
  Valencia: "beta",
  Concordia: "beta",
};

/**
 * Empresa que le corresponde a una sucursal, o null si la sucursal no está en la lista
 * oficial (no debería pasar si ya se validó contra VALORES_SUCURSALES antes).
 */
export function empresaDeSucursal(ciudad: string): EmpresaSofitasa | null {
  return EMPRESA_POR_SUCURSAL[ciudad as Sucursal] ?? null;
}
