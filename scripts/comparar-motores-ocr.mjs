/**
 * ⚖️ Compara los motores de OCR (Gemini vs OpenAI) sobre la MISMA imagen.
 *
 * Mide para cada modelo: qué extrajo, si acertó contra los valores esperados,
 * cuánto tardó y si falló por cuota/red. Sirve para decidir con datos —no por
 * intuición— cuál motor conviene para el escaneo de comprobantes.
 *
 * Uso:
 *   node scripts/comparar-motores-ocr.mjs <ruta-imagen> [monto_esperado] [sufijo_esperado]
 *
 * Los modelos a probar se listan en GEMINI_MODELOS_PRUEBA / OPENAI_MODELOS_PRUEBA.
 * En OpenAI se puede fijar el nivel de detalle visual por modelo con "modelo:detalle"
 * (low | high | auto), porque 'low' reescala la imagen a 512px y eso decide si los
 * dígitos largos del ID de la orden sobreviven o no. Ejemplo:
 *
 *   OPENAI_MODELOS_PRUEBA="gpt-4o-mini:low,gpt-4o-mini:high" node scripts/comparar-motores-ocr.mjs foto.png 12.45 440249234310701056
 *
 * Lee las claves de .env.local y .env (en ese orden de prioridad, como Next.js).
 */

import { readFileSync, existsSync } from "node:fs";
import { GoogleGenAI, Type } from "@google/genai";

// ── Carga de variables de entorno (.env.local pisa a .env, igual que Next.js) ──
function cargarEnv() {
  const vars = {};
  for (const archivo of [".env", ".env.local"]) {
    const ruta = new URL(`../${archivo}`, import.meta.url);
    if (!existsSync(ruta)) continue;
    for (const linea of readFileSync(ruta, "utf8").split("\n")) {
      const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(linea.trim());
      if (m) vars[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  }
  // Las variables del entorno del proceso tienen prioridad, para poder probar
  // modelos puntuales sin editar los archivos .env
  return { ...vars, ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v)) };
}

const env = cargarEnv();
const [, , rutaImagen, montoEsperado, sufijoEsperado] = process.argv;

if (!rutaImagen) {
  console.error("Uso: node scripts/comparar-motores-ocr.mjs <ruta-imagen> [monto_esperado] [sufijo_esperado]");
  process.exit(1);
}

const binario = readFileSync(rutaImagen);
const base64 = binario.toString("base64");
// El tipo real importa: mandar un PNG anunciado como JPEG degrada la lectura en
// algunos proveedores, y el ID de la orden es justo lo primero que se pierde.
const tipoMime = binario[0] === 0x89 && binario[1] === 0x50 ? "image/png" : "image/jpeg";

const PROMPT = `
  Analiza minuciosamente esta imagen que corresponde a un comprobante de pago de Binance Pay titulado "Detalles del pago".
  Extrae de forma exacta los datos financieros requeridos y responde según el esquema JSON provisto.

  Reglas críticas de extracción basadas en el formato del comprobante:
  1. En 'monto', localiza la cifra principal debajo de "Monto". Si el número tiene un signo de resta o guion delante (ejemplo: "-0.01 USDT"), ignora por completo el signo menos y guarda solo el número absoluto como flotante positivo (ej: 0.01).
  2. En 'moneda', identifica las siglas de la criptomoneda que acompañan al monto (ej: "USDT", "BTC", "ETH").
  3. En 'binance_id', busca el campo llamado "ID de la orden" y transcribe su valor COMPLETO, carácter por carácter, sin omitir ninguno y sin recortarlo. No cuentes caracteres ni devuelvas solo una parte: copia el valor entero tal como aparece. Por ejemplo, si el ID es "440249234310701056", debes devolver exactamente "440249234310701056". Cuidado: NO lo confundas con "ID de transacción", que es un campo distinto y más largo.
  4. En 'legible', indica honestamente con 'true' si pudiste leer con confianza los tres campos anteriores directamente del comprobante, o 'false' si la imagen está borrosa, cortada, oscura, no es un comprobante de Binance Pay, o tuviste que adivinar algún valor.
`;

const CAMPOS = {
  monto: "Monto del pago, siempre positivo.",
  moneda: "Siglas de la criptomoneda, ej: USDT, BTC, ETH.",
  binance_id: "Valor COMPLETO del ID de la orden, sin recortar.",
  legible: "true si los tres campos se leyeron con confianza.",
};

async function probarGemini(modelo) {
  const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  const r = await ai.models.generateContent({
    model: modelo,
    contents: [PROMPT, { inlineData: { mimeType: tipoMime, data: base64 } }],
    config: {
      temperature: 0,
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          monto: { type: Type.NUMBER, description: CAMPOS.monto },
          moneda: { type: Type.STRING, description: CAMPOS.moneda },
          binance_id: { type: Type.STRING, description: CAMPOS.binance_id },
          legible: { type: Type.BOOLEAN, description: CAMPOS.legible },
        },
        required: ["monto", "moneda", "binance_id", "legible"],
      },
    },
  });
  return JSON.parse(r.text.trim());
}

// Se llama por HTTP y no con el SDK 'openai' para no añadir una dependencia que
// solo usaría este script; la ruta de producción hace exactamente lo mismo.
async function probarOpenAI(modelo, detalle) {
  // Los modelos GPT-5.x rechazan temperature != 1; se reintenta sin ese parámetro
  // en vez de descartar el modelo por un detalle de compatibilidad.
  try {
    return await llamarOpenAI(modelo, detalle, { temperature: 0 });
  } catch (error) {
    if (error?.status === 400 && /temperature/i.test(error?.message || "")) {
      return await llamarOpenAI(modelo, detalle, {});
    }
    throw error;
  }
}

async function llamarOpenAI(modelo, detalle, extra) {
  const respuesta = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: modelo,
      ...extra,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: PROMPT },
          { type: "image_url", image_url: { url: `data:${tipoMime};base64,${base64}`, detail: detalle } },
        ],
      }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "comprobante_binance",
          strict: true,
          schema: {
            type: "object",
            properties: {
              monto: { type: "number", description: CAMPOS.monto },
              moneda: { type: "string", description: CAMPOS.moneda },
              binance_id: { type: "string", description: CAMPOS.binance_id },
              legible: { type: "boolean", description: CAMPOS.legible },
            },
            required: ["monto", "moneda", "binance_id", "legible"],
            additionalProperties: false,
          },
        },
      },
    }),
  });

  if (!respuesta.ok) {
    const detalleError = await respuesta.text().catch(() => "");
    const error = new Error(detalleError.slice(0, 200));
    error.status = respuesta.status;
    throw error;
  }

  const cuerpo = await respuesta.json();
  return JSON.parse(cuerpo.choices[0].message.content.trim());
}

const pruebas = [];
if (env.GEMINI_API_KEY) {
  for (const m of (env.GEMINI_MODELOS_PRUEBA || "gemini-flash-latest,gemini-3.5-flash-lite").split(",")) {
    const modelo = m.trim();
    pruebas.push([modelo, () => probarGemini(modelo)]);
  }
}
if (env.OPENAI_API_KEY) {
  const lista = env.OPENAI_MODELOS_PRUEBA || `${env.OPENAI_MODELO_RAPIDO || "gpt-4o-mini"},${env.OPENAI_MODELO_POTENTE || "gpt-4o"}`;
  for (const m of lista.split(",")) {
    // "modelo:detalle" permite comparar el mismo modelo a distinta resolución
    const [modelo, detalle = env.OPENAI_DETALLE || "auto"] = m.trim().split(":");
    pruebas.push([`${modelo}:${detalle}`, () => probarOpenAI(modelo, detalle)]);
  }
} else {
  console.log("⚠️  OPENAI_API_KEY vacía en .env.local: se omiten los modelos de OpenAI.\n");
}

console.log(`Imagen: ${rutaImagen} (${tipoMime}, ${(binario.length / 1024).toFixed(0)} KB)`);
if (montoEsperado) console.log(`Esperado -> monto: ${montoEsperado} | sufijo: ${sufijoEsperado}\n`);

for (const [nombre, ejecutar] of pruebas) {
  const inicio = Date.now();
  try {
    const datos = await ejecutar();
    const ms = Date.now() - inicio;
    const crudo = String(datos.binance_id ?? datos.binance_id_sufijo ?? "").replace(/[^a-z0-9]/gi, "").toLowerCase();
    // El recorte a 10 lo hace el codigo, igual que normalizarDatos en la ruta
    const sufijo = crudo.slice(-10);
    let veredicto = "";
    if (montoEsperado) {
      const montoOk = Math.abs(Number(datos.monto) - Number(montoEsperado)) < 0.001;
      // Acierta si su sufijo es un sufijo válido del ID esperado (puede leer 6-10 dígitos)
      const sufijoOk = sufijoEsperado ? sufijoEsperado.endsWith(sufijo) && sufijo.length >= 6 : true;
      veredicto = montoOk && sufijoOk ? "✅ CORRECTO" : `❌ FALLÓ${montoOk ? "" : " (monto)"}${sufijoOk ? "" : " (sufijo)"}`;
    }
    console.log(`${nombre.padEnd(24)} ${String(ms + "ms").padEnd(8)} monto=${datos.monto} ${datos.moneda} sufijo=${sufijo} legible=${datos.legible} ${veredicto}`);
  } catch (error) {
    const ms = Date.now() - inicio;
    const status = error?.status ?? error?.code ?? "";
    const motivo = status === 429 ? "CUOTA EXCEDIDA (429)" : `${status} ${error?.message?.slice(0, 90) || error}`;
    console.log(`${nombre.padEnd(24)} ${String(ms + "ms").padEnd(8)} ⛔ ${motivo}`);
  }
}
