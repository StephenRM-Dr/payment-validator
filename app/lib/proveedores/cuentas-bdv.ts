// A qué cuenta del Banco de Venezuela le pertenece cada sucursal.
//
// El negocio tiene dos cuentas BDV afiliadas a Pago Móvil, cada una con su propia API Key
// de BDVenLinea Empresa. Un pago hecho a la cuenta 1 NO aparece en el extracto de la
// cuenta 2: consultar la cuenta equivocada devuelve "no encontrado" para un pago que sí
// existe, y el cajero no tendría forma de saber que el problema es de configuración.
//
// Por eso el reparto vive aquí y no en variables de entorno: es una regla del negocio, se
// revisa en el diff cuando cambia, y el tipo Record obliga a asignarle cuenta a toda
// sucursal nueva (ver la nota del mapa). Las credenciales, en cambio, sí son secretos y
// viven en el entorno.

import { SUCURSALES } from "../sucursales.ts";

export type ClaveCuentaBdv = "CUENTA_1" | "CUENTA_2";

// Las dos claves, para recorrerlas (ej. consultar el saldo de las dos) sin repetir el
// literal en cada llamador — mismo papel que EMPRESAS_SOFITASA para el otro banco.
export const CLAVES_CUENTA_BDV: readonly ClaveCuentaBdv[] = ["CUENTA_1", "CUENTA_2"];

// A qué empresa (persona jurídica) le pertenece cada cuenta — el mismo reparto que
// CUENTA_POR_SUCURSAL, visto desde el otro lado. Lo usa la consulta de saldos (ver
// saldos-bdv.ts), que agrupa por empresa y no por sucursal.
export const EMPRESA_POR_CUENTA_BDV: Record<ClaveCuentaBdv, "acme" | "beta"> = {
  CUENTA_1: "acme",
  CUENTA_2: "beta",
};

type Sucursal = (typeof SUCURSALES)[number]["valor"];

// Nombres neutros a propósito: el reparto no es geográfico (Concordia y San Cristóbal son
// vecinas y están en cuentas distintas), así que llamarlas "occidente"/"centro" mentiría.
//
// Record<Sucursal, ...> es la red de seguridad: si mañana se añade una sucursal a
// SUCURSALES y nadie la asigna aquí, el proyecto no compila. La alternativa —un objeto
// suelto con acceso por clave— habría dejado la sucursal nueva sin cuenta hasta que un
// cajero se topara con el fallo en plena caja.
export const CUENTA_POR_SUCURSAL: Record<Sucursal, ClaveCuentaBdv> = {
  "San Cristobal": "CUENTA_1",
  Merida: "CUENTA_1",
  Barinas: "CUENTA_1",
  Caracas: "CUENTA_1",
  Maracaibo: "CUENTA_2",
  Valencia: "CUENTA_2",
  Concordia: "CUENTA_2",
};

export interface CredencialesBdv {
  clave: ClaveCuentaBdv;
  cuenta: string;          // número de cuenta de 20 dígitos
  apiKey: string;
  telefonoDestino: string | null; // línea Pago Móvil afiliada; solo informativa en el registro
}

// Accesos estáticos a process.env, uno por cuenta, en vez de componer el nombre de la
// variable con una plantilla: Next.js sustituye estas expresiones en tiempo de compilación
// y un `process.env["BDV_API_KEY_" + n]` se quedaría en undefined según el runtime.
function leerEntorno(clave: ClaveCuentaBdv) {
  if (clave === "CUENTA_1") {
    return {
      cuenta: process.env.BDV_CUENTA_1,
      apiKey: process.env.BDV_API_KEY_1,
      telefonoDestino: process.env.BDV_TELEFONO_DESTINO_1,
    };
  }
  return {
    cuenta: process.env.BDV_CUENTA_2,
    apiKey: process.env.BDV_API_KEY_2,
    telefonoDestino: process.env.BDV_TELEFONO_DESTINO_2,
  };
}

type ResultadoCredenciales = { ok: true; credenciales: CredencialesBdv } | { ok: false; mensaje: string; detalle: string };

/**
 * Credenciales de una cuenta concreta, sin pasar por una sucursal — lo que necesita la
 * consulta de saldos (ver saldos-bdv.ts), que quiere las DOS cuentas, no la de una sucursal.
 */
export function credencialesDeCuenta(clave: ClaveCuentaBdv): ResultadoCredenciales {
  const entorno = leerEntorno(clave);
  const cuenta = (entorno.cuenta || "").trim();
  const apiKey = (entorno.apiKey || "").trim();

  if (!cuenta || !apiKey) {
    return {
      ok: false,
      mensaje: "La consulta a esta cuenta del Banco de Venezuela no está configurada. Avisa al administrador.",
      detalle: `Faltan BDV_CUENTA_${clave.slice(-1)} o BDV_API_KEY_${clave.slice(-1)} en el entorno.`,
    };
  }

  return {
    ok: true,
    credenciales: { clave, cuenta, apiKey, telefonoDestino: (entorno.telefonoDestino || "").trim() || null },
  };
}

/**
 * Credenciales de la cuenta que le toca a una sucursal.
 *
 * No lanza y no tiene respaldo: si la cuenta de esa sucursal no está configurada, la
 * verificación se detiene. Caer en la otra cuenta sería peor que fallar — daría por bueno
 * un pago contra un extracto que no es el suyo.
 */
export function credencialesDeSucursal(ciudad: string): ResultadoCredenciales {
  const clave = CUENTA_POR_SUCURSAL[ciudad as Sucursal];
  if (!clave) {
    return {
      ok: false,
      mensaje: "Esa sucursal todavía no tiene asignada una cuenta del Banco de Venezuela. Avisa al administrador.",
      detalle: `La sucursal "${ciudad}" no aparece en CUENTA_POR_SUCURSAL.`,
    };
  }

  const resultado = credencialesDeCuenta(clave);
  // El mensaje de credencialesDeCuenta es genérico ("esta cuenta"); aquí se sabe que vino de
  // una sucursal, así que el aviso original (más específico) se conserva sin cambios.
  if (resultado.ok === false) {
    return {
      ok: false,
      mensaje: "La verificación de Pago Móvil no está configurada para esta sucursal. Avisa al administrador.",
      detalle: resultado.detalle,
    };
  }
  return resultado;
}
