// Reglas de comparación de referencias de Pago Móvil, sin dependencias de entorno ni de red.
//
// Viven aparte de bdv.ts a propósito: el formulario del cajero necesita estas mismas reglas
// para mostrarle qué dígitos se van a buscar en el banco, y es un componente cliente.
// Importar bdv.ts desde el navegador arrastraría al bundle el cliente HTTP del banco y sus
// lecturas de process.env, que no pintan nada ahí. Aquí solo hay funciones puras.

// El extracto publica la referencia CONCATENADA: un prefijo interno del banco seguido del
// número que el cliente ve en su comprobante (0050930906155 ← ...30906155). Por eso el
// cruce nunca compara la referencia completa, sino su cola.
//
// Se comparan 8 dígitos, o menos cuando el comprobante trae menos: si el cliente enseña una
// referencia de 6, comparar 8 no casaría nunca. Por debajo de 6 no se acepta, porque deja
// de identificar un pago concreto.
export const DIGITOS_REFERENCIA_MAX = 8;
export const DIGITOS_REFERENCIA_MIN = 6;

// Limpia la referencia tal como llega del comprobante: solo dígitos y sin los ceros de
// relleno de la izquierda.
//
// Los ceros no son cosméticos. Los bancos imprimen la referencia rellena a un ancho fijo y
// la IA a veces añade los suyos (visto en producción: leyó "000091529601" donde el recibo
// decía "991529601"). Como el cruce compara las colas, un cero de más delante es inocuo en
// referencias largas, pero en una corta desplaza la ventana: "123456" convertido en
// "000000123456" haría comparar "00123456" contra el extracto, y no casaría con nada.
// Quitándolos, la ventana la fijan siempre los dígitos significativos.
export function limpiarReferencia(valor: unknown): string {
  return String(valor ?? "").replace(/\D/g, "").replace(/^0+/, "");
}

// Cuántos dígitos finales tiene sentido comparar para una referencia dada: 8 como norma,
// menos si el comprobante trae menos. Devuelve 0 cuando no hay suficientes para identificar
// un pago, y entonces el llamador debe rechazar la entrada en vez de buscar a ciegas.
export function digitosAComparar(referencia: unknown): number {
  // Se mide sobre la referencia ya limpia: son los dígitos significativos los que deciden
  // el ancho de la ventana, no los ceros de relleno que traiga el recibo o añada la IA.
  const digitos = limpiarReferencia(referencia).length;
  if (digitos < DIGITOS_REFERENCIA_MIN) return 0;
  return Math.min(digitos, DIGITOS_REFERENCIA_MAX);
}

// Cola de una referencia con la longitud indicada. Se aplica a los dos lados del cruce —a
// la del comprobante y a la del extracto— para que comparen siempre el mismo número de
// dígitos; ahí es donde se recorta el prefijo interno del banco.
export function sufijoReferencia(valor: unknown, largo = DIGITOS_REFERENCIA_MAX): string | null {
  const digitos = String(valor ?? "").replace(/\D/g, "");
  return digitos.length >= largo ? digitos.slice(-largo) : null;
}

// Los dígitos que se buscarán en el extracto, o null si la referencia es demasiado corta.
// Es lo que el formulario del cajero muestra bajo el campo.
export function digitosDeCruce(referencia: unknown): string | null {
  const largo = digitosAComparar(referencia);
  return largo > 0 ? sufijoReferencia(limpiarReferencia(referencia), largo) : null;
}

// Mismo criterio que digitosAComparar()/digitosDeCruce(), pero con un mínimo de dígitos
// significativos propio del proveedor en vez del de BDV (DIGITOS_REFERENCIA_MIN). Vive aquí,
// pura y sin red, para que tanto el cliente HTTP del proveedor (servidor) como el formulario
// del cajero (navegador) calculen exactamente lo mismo sin que el navegador tenga que
// importar el módulo del proveedor — ver la nota de cabecera de este archivo.
export function digitosACompararConMinimo(referencia: unknown, minimo: number): number {
  const digitos = limpiarReferencia(referencia).length;
  if (digitos < minimo) return 0;
  return Math.min(digitos, DIGITOS_REFERENCIA_MAX);
}

export function digitosDeCruceConMinimo(referencia: unknown, minimo: number): string | null {
  const largo = digitosACompararConMinimo(referencia, minimo);
  return largo > 0 ? sufijoReferencia(limpiarReferencia(referencia), largo) : null;
}

// Mínimo propio de Bancamiga, más bajo que DIGITOS_REFERENCIA_MIN (6, el de BDV). BDV lo
// exige así porque su extracto concatena un prefijo interno largo antes de la referencia del
// cliente; Bancamiga es distinto: NroReferenciaCorto es de ANCHO FIJO (6 caracteres, los
// últimos 6 de NroReferencia — no relleno, dígitos reales), y se ha visto en producción un
// caso real de solo 4-5 dígitos significativos (BBVA Provincial). Un mínimo más bajo no
// aumenta el riesgo de falso positivo porque el monto exacto sigue siendo obligatorio para
// dar un match por bueno — ver buscarEnListaBancamiga() en bancamiga.ts.
export const DIGITOS_MIN_BANCAMIGA = 4;

// Cuántas correcciones (cambiar, añadir o quitar un dígito) separan dos colas de referencia.
//
// Para qué: cuando el cruce por referencia falla y el sistema ofrece candidatos por monto,
// el cajero necesita saber si la del banco se parece a la que se escaneó. El caso real que
// lo motivó: el recibo decía 000993610016 y el escáner leyó 993610160 — perdió un cero y
// corrió los dígitos. Comparadas posición a posición esas dos colas solo coinciden en 5 de
// 8 y parecen ajenas; contando correcciones son 2, que es lo que de verdad significa "el
// modelo leyó mal un dígito" frente a "es otro pago distinto".
//
// Es distancia de Levenshtein, con la matriz reducida a dos filas: las referencias son de
// 8 dígitos, así que el coste es irrelevante, pero no hay motivo para reservar más.
export function distanciaReferencias(a: unknown, b: unknown): number {
  const uno = String(a ?? "").replace(/\D/g, "");
  const dos = String(b ?? "").replace(/\D/g, "");
  if (!uno || !dos) return Number.POSITIVE_INFINITY;

  let anterior = Array.from({ length: dos.length + 1 }, (_, i) => i);

  for (let i = 1; i <= uno.length; i++) {
    const actual = [i];
    for (let j = 1; j <= dos.length; j++) {
      actual[j] = Math.min(
        anterior[j] + 1,                                       // quitar un dígito
        actual[j - 1] + 1,                                     // añadir un dígito
        anterior[j - 1] + (uno[i - 1] === dos[j - 1] ? 0 : 1)  // cambiarlo
      );
    }
    anterior = actual;
  }

  return anterior[dos.length];
}

// A partir de cuántas correcciones deja de ser creíble que sea un error de lectura. Con 2 se
// cubren los fallos típicos del OCR sobre una foto de pantalla (un dígito mal leído, o uno
// perdido que corre a los demás); de ahí en adelante lo más probable es que sea otro pago,
// y marcarlo como "casi igual" empujaría al cajero a cobrar el equivocado.
export const CORRECCIONES_MAX_PARECIDO = 2;
