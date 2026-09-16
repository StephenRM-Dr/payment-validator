// Especificaciones de lectura OCR por proveedor de pago.
//
// El escáner tenía el prompt y el esquema JSON de Binance Pay incrustados en la ruta, con
// una función de normalización específica del "ID de la orden". Al entrar un segundo
// proveedor eso deja de escalar: lo que cambia entre Binance y BDV es QUÉ se le pide al
// modelo, no CÓMO se le pide. La cadena de motores (OpenAI barato → OpenAI caro → Gemini),
// los reintentos y el manejo de errores son idénticos para ambos y siguen viviendo en la ruta.
//
// Regla que se mantiene de la implementación original y que aplica a todos los proveedores:
// **la normalización la hace el código, nunca el modelo**. Pedirle a la IA que recorte,
// cuente o formatee produce errores silenciosos (el caso real: se le pedía "los últimos 10
// caracteres" y devolvía 8). Aquí se le pide el valor tal como aparece y se ajusta después.
// Si un campo no se lee con confianza queda en null y el cajero lo completa a mano: un dato
// inventado que se le manda al banco solo produce un rechazo que nadie sabe explicar.

import { Type } from "@google/genai";
import type { Proveedor } from "../sucursales";
// Misma limpieza que aplica el cruce contra el extracto: lo que el cajero ve en el
// formulario es exactamente lo que se buscará en el banco.
// Extensión explícita, igual que en bdv.ts: los scripts de prueba importan este archivo
// con node a secas, y su resolvedor ESM —a diferencia del de Next— no la completa.
import { limpiarReferencia } from "./referencias.ts";
import { normalizarCodigoBanco } from "../bancos.ts";

// Forma común que devuelven todas las especificaciones. 'campos' se envía tal cual al
// formulario del cajero, así que sus claves coinciden con los nombres de los inputs.
export interface ResultadoOcr {
  legible: boolean;
  campos: Record<string, string | number | null>;
}

export interface EspecOcr {
  // Nombre del esquema que exige OpenAI en response_format
  nombreEsquema: string;
  prompt: string;
  esquemaGemini: Record<string, unknown>;
  esquemaOpenAI: Record<string, unknown>;
  normalizar: (crudo: Record<string, unknown> | null | undefined) => ResultadoOcr;
  // Decide si la cadena de motores puede detenerse o debe escalar al siguiente modelo
  estaCompleto: (resultado: ResultadoOcr) => boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilidades de normalización compartidas
// ─────────────────────────────────────────────────────────────────────────────

function comoTextoLimpio(valor: unknown): string {
  return typeof valor === "string" ? valor.trim() : typeof valor === "number" ? String(valor) : "";
}

// Monto positivo con dos decimales y punto como separador, que es lo que exige el manual
// del BDV. Acepta tanto "1.234,56" (formato venezolano) como "1234.56".
//
// Exportada a propósito: las rutas verificar-bdv/verificar-sofitasa/verificar-bancamiga la
// reusan para parsear el campo 'importe' tal como llega en el body, porque ese campo no
// siempre lo rellena el OCR — el cajero lo edita o lo teclea a mano cuando la IA no lo lee
// con confianza (ver la nota de cabecera de este archivo), y en ese momento puede escribir
// cualquiera de los dos formatos. Antes cada ruta lo parseaba con su propia lógica ingenua
// (Number.parseFloat directo, o una función pensada solo para el formato del extracto del
// banco): las dos interpretaban "1,000.00" o "1.000,00" como 1 en vez de 1000 — un bug real,
// no hipotético, encontrado al escribir las pruebas de fraude (ver
// tests/fraude-normalizacion.test.mjs). Esta es la única función del proyecto que detecta
// el separador decimal correcto mirando cuál de los dos aparece más a la derecha.
export function normalizarImporte(valor: unknown): string | null {
  let texto = comoTextoLimpio(valor);
  if (!texto) return null;

  // Si hay coma y punto, el separador decimal es el que aparece más a la derecha
  const ultimaComa = texto.lastIndexOf(",");
  const ultimoPunto = texto.lastIndexOf(".");
  if (ultimaComa > -1 && ultimoPunto > -1) {
    const decimal = ultimaComa > ultimoPunto ? "," : ".";
    const millar = decimal === "," ? "." : ",";
    texto = texto.split(millar).join("").replace(decimal, ".");
  } else if (ultimaComa > -1) {
    // Solo coma: decimal si deja 1-2 dígitos detrás ("120,50"), separador de millar si no ("1,200")
    texto = texto.length - ultimaComa - 1 <= 2 ? texto.replace(",", ".") : texto.split(",").join("");
  }

  const numero = Math.abs(Number.parseFloat(texto.replace(/[^\d.-]/g, "")));
  return Number.isFinite(numero) && numero > 0 ? numero.toFixed(2) : null;
}

// Hasta dónde se acepta la fecha de un comprobante que se está validando en caja.
//
// Sirve de detector de invenciones. Cuando la foto se toma de lejos y el texto queda
// diminuto, el modelo no devuelve vacío: rellena. El caso real que lo destapó fue un
// comprobante del 13/08/2026 leído como 11/09/2023 — una fecha que ninguna deformación de
// esos dígitos produce, y que además habría hecho consultar el extracto de un día de hace
// tres años. Devolviendo null, la lectura queda incompleta y la cadena escala al modelo de
// alta resolución en vez de dar por buena la invención.
//
// El margen es amplio a propósito: solo tiene que descartar lo imposible, no juzgar lo
// inusual. Y si un día hay que validar un pago más antiguo, el campo sigue siendo editable.
const DIAS_ANTIGUEDAD_MAX = 90;
const DIAS_FUTURO_MAX = 1; // tolerancia por la diferencia horaria entre el servidor y la tienda

function fechaEsPlausible(fecha: string): boolean {
  const dia = 86_400_000;
  const delComprobante = new Date(`${fecha}T00:00:00Z`).getTime();
  const hoy = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z").getTime();
  return delComprobante <= hoy + DIAS_FUTURO_MAX * dia && delComprobante >= hoy - DIAS_ANTIGUEDAD_MAX * dia;
}

// Meses en español que algunas apps bancarias imprimen en texto en vez de numérico (visto
// en producción en un comprobante de Sofitasa: "17 Agosto 2026"). Sin acentos: se comparan
// ya normalizados con NFD.
const MESES_ES: Record<string, string> = {
  enero: "01", febrero: "02", marzo: "03", abril: "04", mayo: "05", junio: "06",
  julio: "07", agosto: "08", septiembre: "09", setiembre: "09", octubre: "10",
  noviembre: "11", diciembre: "12",
};

// Rango Unicode "Combining Diacritical Marks" (U+0300–U+036F), lo que separa 'normalize("NFD")'
// de la letra base. Construido con String.fromCodePoint (no con literales de acento en el
// fuente) para no depender de que el archivo se guarde/lea siempre en UTF-8 sin cambios —
// mismo motivo ya documentado en servidor-bancamiga/src/config.mjs.
const RANGO_DIACRITICOS = new RegExp(
  "[" + String.fromCodePoint(0x0300) + "-" + String.fromCodePoint(0x036f) + "]",
  "g"
);

// AAAA-MM-DD estricto. El manual del BDV es explícito: no se puede usar "/" como
// separador, y una fecha mal formada devuelve un 400 que no dice qué campo falló.
function normalizarFecha(valor: unknown): string | null {
  const texto = comoTextoLimpio(valor);
  if (!texto) return null;

  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(texto);
  const partes = iso
    ? { anio: iso[1], mes: iso[2], dia: iso[3] }
    : (() => {
        // Formato venezolano DD/MM/AAAA (o con guiones/puntos), que es el que imprimen
        // la mayoría de los comprobantes de pago móvil.
        const local = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})/.exec(texto);
        if (local) {
          const anio = local[3].length === 2 ? `20${local[3]}` : local[3];
          return { anio, mes: local[2].padStart(2, "0"), dia: local[1].padStart(2, "0") };
        }
        // Mes en texto: "17 Agosto 2026" o "17 de agosto de 2026".
        const conNombre = /^(\d{1,2})\s+(?:de\s+)?([a-záéíóúñ]+)\s+(?:de\s+)?(\d{4})/i.exec(texto);
        if (!conNombre) return null;
        const nombreMes = conNombre[2].normalize("NFD").replace(RANGO_DIACRITICOS, "").toLowerCase();
        const mes = MESES_ES[nombreMes];
        if (!mes) return null;
        return { anio: conNombre[3], mes, dia: conNombre[1].padStart(2, "0") };
      })();

  if (!partes) return null;

  const fecha = `${partes.anio}-${partes.mes}-${partes.dia}`;
  // Comprobación real de calendario: descarta "2024-02-31" y meses fuera de rango, que
  // el formato por sí solo no detecta.
  const comoObjeto = new Date(`${fecha}T00:00:00Z`);
  if (Number.isNaN(comoObjeto.getTime()) || comoObjeto.toISOString().slice(0, 10) !== fecha) return null;

  // Una fecha bien formada pero imposible delata una lectura inventada, no una mal leída
  if (!fechaEsPlausible(fecha)) {
    console.warn(`⚠️ [Escáner] Fecha descartada por imposible: ${fecha}. La lectura se marca incompleta.`);
    return null;
  }

  return fecha;
}

// ─────────────────────────────────────────────────────────────────────────────
// Binance Pay — el flujo original, sin cambios de comportamiento
// ─────────────────────────────────────────────────────────────────────────────

const ESPEC_BINANCE: EspecOcr = {
  nombreEsquema: "comprobante_binance",

  prompt: `
  Analiza minuciosamente esta imagen: es un comprobante de pago de Binance Pay. Puede ser la pantalla
  titulada "Detalles del pago" o la titulada "Pago exitoso"; ambas son válidas y contienen los mismos datos.
  A menudo NO es una captura de pantalla, sino una FOTO de la pantalla de otro teléfono, con reflejos,
  brillos y en ángulo: fíjate con especial cuidado en los dígitos antes de darlos por leídos.
  Extrae de forma exacta los datos financieros requeridos y responde según el esquema JSON provisto.

  Reglas críticas de extracción basadas en el formato del comprobante:
  1. En 'monto', localiza la cifra principal (aparece debajo de "Monto", o en grande junto a la moneda en la pantalla "Pago exitoso"). Si el número tiene un signo de resta o guion delante (ejemplo: "-0.01 USDT"), ignora por completo el signo menos y guarda solo el número absoluto como flotante positivo (ej: 0.01).
  2. En 'moneda', identifica las siglas de la criptomoneda que acompañan al monto (ej: "USDT", "BTC", "ETH").
  3. En 'binance_id', busca el campo rotulado "ID de la orden" o "ID de orden" y transcribe su valor COMPLETO, dígito por dígito, sin omitir ninguno y sin recortarlo. No cuentes caracteres ni devuelvas solo una parte: copia el valor entero tal como aparece. Suele tener 18 dígitos. Por ejemplo, si el ID es "440249234310701056", debes devolver exactamente "440249234310701056".
     Cuidado con los números vecinos, que NO son este campo: el "ID de transacción", y el número que acompaña al alias del destinatario en la línea "A" (junto a "Agregar alias"), que es más corto. Si dudas de algún dígito, marca 'legible' como false en vez de adivinarlo.
  4. En 'legible', indica honestamente con 'true' si pudiste leer con confianza los tres campos anteriores directamente del comprobante, o 'false' si la imagen está borrosa, cortada, oscura, no es un comprobante de Binance Pay, o tuviste que adivinar algún valor.
`,

  esquemaGemini: {
    type: Type.OBJECT,
    properties: {
      monto: { type: Type.NUMBER, description: "Monto del pago, siempre positivo." },
      moneda: { type: Type.STRING, description: "Siglas de la criptomoneda, ej: USDT, BTC, ETH." },
      binance_id: { type: Type.STRING, description: "Valor COMPLETO del ID de la orden, sin recortar." },
      legible: { type: Type.BOOLEAN, description: "true si los tres campos se leyeron con confianza." },
    },
    required: ["monto", "moneda", "binance_id", "legible"],
  },

  esquemaOpenAI: {
    type: "object",
    properties: {
      monto: { type: "number", description: "Monto del pago, siempre positivo." },
      moneda: { type: "string", description: "Siglas de la criptomoneda, ej: USDT, BTC, ETH." },
      binance_id: { type: "string", description: "Valor COMPLETO del ID de la orden, sin recortar." },
      legible: { type: "boolean", description: "true si los tres campos se leyeron con confianza." },
    },
    required: ["monto", "moneda", "binance_id", "legible"],
    additionalProperties: false,
  },

  normalizar(crudo) {
    const montoCrudo = Math.abs(Number.parseFloat(String(crudo?.monto)));
    const monto = Number.isFinite(montoCrudo) && montoCrudo > 0 ? montoCrudo : null;

    // ⚠️ El recorte a los últimos 10 lo hace el código, NUNCA la IA. Cuando se le pedía al
    // modelo que devolviera "los últimos 10 caracteres" se equivocaba al contarlos y
    // entregaba 8 ó 9, y ese sufijo corto provocaba coincidencias falsas entre órdenes
    // distintas al validar. Pidiéndole el ID completo y recortando aquí, el conteo deja de
    // depender del modelo: medido sobre la misma imagen, pasó de 0/4 aciertos a 4/4.
    //
    // Se acepta 'binance_id_sufijo' como alias por si algún modelo repite el nombre viejo.
    const idCrudo = crudo?.binance_id ?? crudo?.binance_id_sufijo ?? "";
    const sufijoCrudo = String(idCrudo).replace(/[^a-z0-9]/gi, "").slice(-10).toLowerCase();
    const sufijo = /^[a-z0-9]{6,10}$/.test(sufijoCrudo) ? sufijoCrudo : null;

    return {
      legible: Boolean(crudo?.legible),
      campos: {
        monto,
        // Si la IA no leyó la moneda se devuelve null, igual que con el monto y el ID:
        // rellenar "USDT" por defecto la mostraba como si se hubiera leído del comprobante.
        moneda: typeof crudo?.moneda === "string" && crudo.moneda.trim() ? crudo.moneda.trim().toUpperCase() : null,
        binance_id_sufijo: sufijo,
      },
    };
  },

  estaCompleto: (r) => r.legible && Boolean(r.campos.monto) && Boolean(r.campos.binance_id_sufijo),
};

// ─────────────────────────────────────────────────────────────────────────────
// Pago Móvil BDV
// ─────────────────────────────────────────────────────────────────────────────

const ESPEC_BDV: EspecOcr = {
  nombreEsquema: "comprobante_pago_movil",

  // ⚠️ Del comprobante solo se le piden TRES datos, y esto es una decisión, no una
  // limitación del modelo: el pago se concilia contra el extracto de nuestra propia cuenta,
  // y el extracto ya trae el banco emisor, el teléfono y la cédula del pagador en el campo
  // 'observacion'. Pedírselos a la IA solo reintroduciría el error que costó una sesión
  // entera: el comprobante muestra a las dos partes y el modelo devolvía las del
  // beneficiario (nuestro propio teléfono y el RIF de la empresa).
  prompt: `
  Analiza esta imagen: es el comprobante de un Pago Móvil venezolano (transferencia entre teléfonos).
  Puede provenir de cualquier banco emisor (Banesco, Mercantil, Provincial, Banco de Venezuela, etc.), así que el diseño varía.
  Extrae los datos exactamente como aparecen impresos y responde según el esquema JSON provisto.

  Reglas críticas de extracción:
  1. En 'importe', el monto en bolívares del pago. Transcríbelo tal como aparece, conservando su separador decimal (ej: "1.234,56" o "1234.56"). Ignora cualquier signo negativo.
  2. En 'fechaPago', la fecha en que se realizó la operación, copiada tal cual aparece (ej: "12/02/2024" o "2024-02-12"). Si el comprobante muestra fecha y hora, devuelve solo la fecha.
  3. En 'referencia', el número de referencia u operación del pago, solo los dígitos. Suele estar rotulado como "Referencia", "Nro. de referencia", "Operación" o "Comprobante".
     Es el campo más importante de los tres. Cópialo EXACTAMENTE como está impreso, dígito a dígito y en el mismo orden.
     - Transcribe solo los dígitos que ves. NO añadas ceros delante para completar una longitud, y NO quites ninguno de los que sí aparecen.
     - Presta especial atención a los dígitos REPETIDOS seguidos ("00", "11", "99"): cuenta cuántos hay y transcríbelos todos. Omitir uno solo desplaza el resto del número y lo vuelve inservible. Si el comprobante muestra "000993610016", devuelve los doce dígitos, no once.
     - No supongas que la referencia tiene un largo determinado: cada banco usa el suyo. Si ves 9 dígitos devuelve 9, si ves 12 devuelve 12.
     - NO la confundas con el número de cuenta, ni con el teléfono, ni con la cédula, ni con el monto.
  4. En 'legible', indica honestamente 'true' solo si pudiste leer con confianza el importe, la fecha y la referencia directamente del comprobante. Pon 'false' si la imagen está borrosa, cortada, oscura, no es un comprobante de pago móvil, o tuviste que adivinar algún valor.
  5. En 'bancoReceptor', el banco DESTINO del pago: aquel donde está registrado el teléfono al que se envió el dinero. Suele aparecer rotulado como "Banco" justo debajo o al lado del campo "Destino" (el teléfono del que recibe). Si no encuentras ese campo con claridad, deja 'bancoReceptor' como cadena vacía; NO adivines ni copies el nombre del banco emisor.
     ⚠️ No lo confundas con el banco EMISOR (el del logo o encabezado de la app, que es el banco de quien PAGA, no de quien recibe) ni con el campo "Origen" (la cuenta de quien envía). Un comprobante de Banco Plaza, por ejemplo, puede indicar "Destino: 04241234567 / Banco: Banesco": ahí 'bancoReceptor' es "Banesco", nunca "Banco Plaza".

  No inventes ningún dato: cualquier campo que no puedas leer con certeza va como cadena vacía.
`,

  esquemaGemini: {
    type: Type.OBJECT,
    properties: {
      importe: { type: Type.STRING, description: "Monto en bolívares, tal como aparece impreso." },
      fechaPago: { type: Type.STRING, description: "Fecha de la operación, tal como aparece impresa." },
      referencia: { type: Type.STRING, description: "Número de referencia u operación, completo y solo dígitos." },
      bancoReceptor: { type: Type.STRING, description: "Nombre del banco DESTINO (el que recibe el dinero), o cadena vacía si no se distingue del emisor." },
      legible: { type: Type.BOOLEAN, description: "true si el importe, la fecha y la referencia se leyeron con confianza." },
    },
    required: ["importe", "fechaPago", "referencia", "bancoReceptor", "legible"],
  },

  esquemaOpenAI: {
    type: "object",
    properties: {
      importe: { type: "string", description: "Monto en bolívares, tal como aparece impreso." },
      fechaPago: { type: "string", description: "Fecha de la operación, tal como aparece impresa." },
      referencia: { type: "string", description: "Número de referencia u operación, completo y solo dígitos." },
      bancoReceptor: { type: "string", description: "Nombre del banco DESTINO (el que recibe el dinero), o cadena vacía si no se distingue del emisor." },
      legible: { type: "boolean", description: "true si el importe, la fecha y la referencia se leyeron con confianza." },
    },
    required: ["importe", "fechaPago", "referencia", "bancoReceptor", "legible"],
    additionalProperties: false,
  },

  normalizar(crudo) {
    // Se limpia con la misma función que usa el cruce contra el extracto: solo dígitos y
    // sin ceros de relleno delante. Así el cajero ve en el formulario exactamente el número
    // que se va a buscar en el banco, y no una versión rellena que no se parece a su recibo.
    const referenciaCruda = limpiarReferencia(crudo?.referencia);

    return {
      legible: Boolean(crudo?.legible),
      campos: {
        importe: normalizarImporte(crudo?.importe),
        fechaPago: normalizarFecha(crudo?.fechaPago),
        referencia: /^\d{6,20}$/.test(referenciaCruda) ? referenciaCruda : null,
        // Solo se expone si se resolvió a un código inequívoco: un nombre ambiguo o mal
        // leído no debe generar una alarma falsa de "pago enviado al banco equivocado".
        // No forma parte de 'estaCompleto': muchos comprobantes no traen este campo, y
        // exigirlo escalaría la cadena de modelos en vano buscando algo que no está.
        bancoReceptor: normalizarCodigoBanco(crudo?.bancoReceptor),
      },
    };
  },

  // Los tres campos son imprescindibles para localizar el pago en el extracto, así que
  // aquí sí compensa que la cadena escale al siguiente modelo si alguno no salió.
  estaCompleto: (r) =>
    r.legible &&
    Boolean(r.campos.importe) &&
    Boolean(r.campos.fechaPago) &&
    Boolean(r.campos.referencia),
};

// ─────────────────────────────────────────────────────────────────────────────
// Pago Móvil Sofitasa / Bancamiga
// ─────────────────────────────────────────────────────────────────────────────
//
// Mismo shape que ESPEC_BDV, sin ningún campo extra: el pago se busca primero en el
// estado de cuenta/historial de solo lectura del banco (ver sofitasa.ts/bancamiga.ts), que
// es de ahí de donde sale el teléfono del pagador — no hace falta pedírselo a la IA ni al
// cajero, igual que en BDV.
function especPagoMovil(nombreBanco: string, nombreEsquema: string): EspecOcr {
  return {
    nombreEsquema,

    prompt: `
  Analiza esta imagen: es el comprobante de un Pago Móvil venezolano (transferencia entre teléfonos), enviado a una cuenta de ${nombreBanco}.
  Puede provenir de cualquier banco emisor (Banesco, Mercantil, Provincial, Banco de Venezuela, etc.), así que el diseño varía.
  Extrae los datos exactamente como aparecen impresos y responde según el esquema JSON provisto.

  Reglas críticas de extracción:
  1. En 'importe', el monto en bolívares del pago. Transcríbelo tal como aparece, conservando su separador decimal (ej: "1.234,56" o "1234.56"). Ignora cualquier signo negativo.
  2. En 'fechaPago', la fecha en que se realizó la operación, copiada tal cual aparece (ej: "12/02/2024" o "2024-02-12"). Si el comprobante muestra fecha y hora, devuelve solo la fecha.
  3. En 'referencia', el número de referencia u operación del pago, solo los dígitos. Suele estar rotulado como "Referencia", "Nro. de referencia", "Operación" o "Comprobante".
     Es el campo más importante de los tres. Cópialo EXACTAMENTE como está impreso, dígito a dígito y en el mismo orden.
     - Transcribe solo los dígitos que ves. NO añadas ceros delante para completar una longitud, y NO quites ninguno de los que sí aparecen.
     - Presta especial atención a los dígitos REPETIDOS seguidos ("00", "11", "99"): cuenta cuántos hay y transcríbelos todos. Omitir uno solo desplaza el resto del número y lo vuelve inservible.
     - No supongas que la referencia tiene un largo determinado: cada banco usa el suyo.
     - NO la confundas con el número de cuenta, ni con el teléfono, ni con la cédula, ni con el monto.
  4. En 'legible', indica honestamente 'true' solo si pudiste leer con confianza el importe, la fecha y la referencia directamente del comprobante. Pon 'false' si la imagen está borrosa, cortada, oscura, no es un comprobante de pago móvil, o tuviste que adivinar algún valor.
  5. En 'bancoReceptor', el banco DESTINO del pago: aquel donde está registrado el teléfono al que se envió el dinero. Suele aparecer rotulado como "Banco" justo debajo o al lado del campo "Destino" (el teléfono del que recibe). Si no encuentras ese campo con claridad, deja 'bancoReceptor' como cadena vacía; NO adivines ni copies el nombre del banco emisor.
     ⚠️ No lo confundas con el banco EMISOR (el del logo o encabezado de la app, que es el banco de quien PAGA, no de quien recibe) ni con el campo "Origen" (la cuenta de quien envía).

  No inventes ningún dato: cualquier campo que no puedas leer con certeza va como cadena vacía.
`,

    esquemaGemini: {
      type: Type.OBJECT,
      properties: {
        importe: { type: Type.STRING, description: "Monto en bolívares, tal como aparece impreso." },
        fechaPago: { type: Type.STRING, description: "Fecha de la operación, tal como aparece impresa." },
        referencia: { type: Type.STRING, description: "Número de referencia u operación, completo y solo dígitos." },
        bancoReceptor: { type: Type.STRING, description: "Nombre del banco DESTINO (el que recibe el dinero), o cadena vacía si no se distingue del emisor." },
        legible: { type: Type.BOOLEAN, description: "true si el importe, la fecha y la referencia se leyeron con confianza." },
      },
      required: ["importe", "fechaPago", "referencia", "bancoReceptor", "legible"],
    },

    esquemaOpenAI: {
      type: "object",
      properties: {
        importe: { type: "string", description: "Monto en bolívares, tal como aparece impreso." },
        fechaPago: { type: "string", description: "Fecha de la operación, tal como aparece impresa." },
        referencia: { type: "string", description: "Número de referencia u operación, completo y solo dígitos." },
        bancoReceptor: { type: "string", description: "Nombre del banco DESTINO (el que recibe el dinero), o cadena vacía si no se distingue del emisor." },
        legible: { type: "boolean", description: "true si el importe, la fecha y la referencia se leyeron con confianza." },
      },
      required: ["importe", "fechaPago", "referencia", "bancoReceptor", "legible"],
      additionalProperties: false,
    },

    normalizar(crudo) {
      // A diferencia de ESPEC_BDV, aquí NO se pasa por limpiarReferencia(): esa función quita
      // los ceros de relleno de la izquierda, pensada para el cruce por sufijo de Pago Móvil
      // (que igual vuelve a extraer su propia cola de dígitos más abajo, así que no depende de
      // este valor). Bancamiga además verifica transferencias/depósitos vía consulta/trx, que
      // exige el ancho EXACTO de dígitos de la referencia larga del banco, ceros de relleno
      // incluidos (ver intentosTransferenciaBancamiga() en bancamiga.ts) — quitarlos aquí, antes
      // de que el cajero siquiera vea el campo, los perdía sin remedio para esa vía. Bug real:
      // una transferencia con referencia "00226837" llegaba al formulario ya como "226837" y
      // nunca se pudo probar contra consulta/trx.
      const referenciaCruda = String(crudo?.referencia ?? "").replace(/\D/g, "");
      return {
        legible: Boolean(crudo?.legible),
        campos: {
          importe: normalizarImporte(crudo?.importe),
          fechaPago: normalizarFecha(crudo?.fechaPago),
          // Sin mínimo de 6 dígitos aquí a propósito (a diferencia de ESPEC_BDV): algunos
          // bancos emisores (visto en producción: BBVA Provincial) imprimen referencias que,
          // tras quitarles los ceros de relleno, quedan en solo 5 dígitos significativos. El
          // mínimo de DIGITOS_REFERENCIA_MIN ya lo aplica digitosAComparar() al buscar en el
          // banco — si la referencia es demasiado corta para un cruce directo, la búsqueda
          // cae sola al respaldo por monto (candidatos), no hace falta duplicar esa regla
          // aquí de forma más estricta y bloquear el campo por completo.
          referencia: /^\d{1,20}$/.test(referenciaCruda) ? referenciaCruda : null,
          bancoReceptor: normalizarCodigoBanco(crudo?.bancoReceptor),
        },
      };
    },

    estaCompleto: (r) => r.legible && Boolean(r.campos.importe) && Boolean(r.campos.fechaPago) && Boolean(r.campos.referencia),
  };
}

const ESPEC_SOFITASA: EspecOcr = especPagoMovil("Sofitasa", "comprobante_pago_movil_sofitasa");
const ESPEC_BANCAMIGA: EspecOcr = especPagoMovil("Bancamiga", "comprobante_pago_movil_bancamiga");

const ESPECS: Record<Proveedor, EspecOcr> = {
  BINANCE: ESPEC_BINANCE,
  BDV: ESPEC_BDV,
  SOFITASA: ESPEC_SOFITASA,
  BANCAMIGA: ESPEC_BANCAMIGA,
};

// Devuelve la especificación del proveedor pedido. Ante un valor desconocido cae en
// BINANCE, que es el comportamiento que tenía el escáner antes de existir el selector:
// así una petición vieja sin el campo 'proveedor' sigue funcionando igual.
export function especDeProveedor(valor: unknown): { proveedor: Proveedor; espec: EspecOcr } {
  const nombre = String(valor ?? "").trim().toUpperCase();
  const proveedor: Proveedor =
    nombre === "BDV" || nombre === "SOFITASA" || nombre === "BANCAMIGA" ? (nombre as Proveedor) : "BINANCE";
  return { proveedor, espec: ESPECS[proveedor] };
}
