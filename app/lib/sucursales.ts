// Lista única de sucursales del negocio.
// El formulario del cajero, el panel administrativo y las APIs validan contra esta misma
// lista: agregar o quitar una sucursal aquí actualiza todo el sistema de forma consistente.
// 'valor' es lo que se guarda en la base de datos (sin acentos, estable);
// 'etiqueta' es lo que ve el usuario en pantalla.
export const SUCURSALES = [
  { valor: "San Cristobal", etiqueta: "San Cristóbal" },
  { valor: "Merida", etiqueta: "Mérida" },
  { valor: "Barinas", etiqueta: "Barinas" },
  { valor: "Caracas", etiqueta: "Caracas" },
  { valor: "Valencia", etiqueta: "Valencia" },
  { valor: "Maracaibo", etiqueta: "Maracaibo" },
  { valor: "Concordia", etiqueta: "Concordia" },
] as const;

// Valores tal como se guardan en la columna 'ciudad'
export const VALORES_SUCURSALES: string[] = SUCURSALES.map((s) => s.valor);

// Proveedores de pago conciliados por el sistema. Cada uno tiene su propio flujo:
// BINANCE es *push* (el worker detecta el pago y el cajero lo reclama contra una fila
// que ya existe). BDV, SOFITASA y BANCAMIGA son *pull* (el cajero pregunta al banco —a
// través de su extracto/historial de solo lectura, nunca a ciegas— y la fila nace
// verificada). Ver los puentes `servidor-sofitasa/` y `servidor-bancamiga/` para el
// backend de estos dos últimos: corren fuera de Vercel, no en esta función serverless.
export const PROVEEDORES = [
  { valor: "BINANCE", etiqueta: "Binance Pay" },
  { valor: "BDV", etiqueta: "Pago Móvil BDV" },
  { valor: "SOFITASA", etiqueta: "Pago Móvil Sofitasa" },
  { valor: "BANCAMIGA", etiqueta: "Pago Móvil Bancamiga" },
] as const;

export type Proveedor = (typeof PROVEEDORES)[number]["valor"];

export const VALORES_PROVEEDORES: string[] = PROVEEDORES.map((p) => p.valor);

// Monedas por proveedor. Se mantienen separadas porque no son intercambiables:
// un pago de Binance nunca llega en bolívares y un Pago Móvil nunca en USDT. El panel
// tampoco las suma entre sí — mezclar Bs con USDT en un total daría una cifra sin sentido.
export const MONEDAS_BINANCE: string[] = ["USDT", "BTC", "ETH"];
export const MONEDA_BDV = "VES";
export const MONEDA_SOFITASA = "VES";
export const MONEDA_BANCAMIGA = "VES";

// Unión de todas, para las validaciones genéricas que no distinguen proveedor.
// Set porque BDV/Sofitasa/Bancamiga comparten la misma moneda (VES) y no tiene sentido
// repetirla tres veces en la lista.
export const MONEDAS_VALIDAS: string[] = [...new Set([...MONEDAS_BINANCE, MONEDA_BDV, MONEDA_SOFITASA, MONEDA_BANCAMIGA])];

// Longitud del sufijo del ID de Binance que se usa para cruzar el pago.
// Fuente única: la IA extrae hasta el máximo, el input del cajero lo limita y el backend
// lo valida con estos mismos números (antes cada capa usaba un rango distinto: 6-10, 10 y 6-12).
export const SUFIJO_ID_MIN = 6;   // lo mínimo que el cajero teclea a mano
export const SUFIJO_ID_MAX = 10;  // lo máximo que la IA logra leer con fiabilidad
