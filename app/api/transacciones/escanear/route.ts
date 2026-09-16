import { NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import { leerCuerpoJson } from "../../../lib/http";
import { esImagenValida } from "../../../lib/imagenes";
import { peticionDeCajeroValida } from "../../../lib/token-cajero";
import { especDeProveedor, type EspecOcr, type ResultadoOcr } from "../../../lib/proveedores/prompts";

// ⚠️ Los modelos de la generación 2.5 quedaron obsoletos: Google retiró
// 'gemini-2.5-flash' y las API keys nuevas reciben 404 ("no longer available to new
// users"). Con eso, cada escaneo fallaba en el primer intento y caía al reintento con
// 'gemini-2.5-pro', agotando su cuota gratuita de 5 req/min — esa era la causa real de
// los fallos recurrentes del escáner. Configurables por entorno para poder cambiarlos
// sin desplegar código cuando Google vuelva a retirar una generación.
const MODELO_RAPIDO = process.env.GEMINI_MODELO_RAPIDO || "gemini-3.5-flash-lite";
const MODELO_POTENTE = process.env.GEMINI_MODELO_POTENTE || "gemini-flash-latest";

const OPENAI_RAPIDO = process.env.OPENAI_MODELO_RAPIDO || "gpt-4o-mini";
const OPENAI_POTENTE = process.env.OPENAI_MODELO_POTENTE || "gpt-4o";

// Vercel corta las funciones a los 10 s por defecto, y ahí el cajero no recibe respuesta
// ninguna: la petición muere sin cuerpo y el formulario se queda en "analizando" hasta que
// salta su propio temporizador de 90 s. Cuatro motores encadenados no caben en 10 s.
export const maxDuration = 60;

// Ningún proveedor de IA garantiza responder. Sin límite propio, una petición colgada se
// come el presupuesto entero de la función y ninguno de los motores siguientes llega a
// probarse — el fallo de UN proveedor deja al cajero sin escáner. Medido sobre fotos
// reales, el motor más lento tardó 3,8 s; 20 s es holgado sin llegar a ser un cuelgue.
const TIEMPO_MAXIMO_MOTOR_MS = 20_000;

// Presupuesto de la cadena completa. Deja margen para responder dentro de maxDuration:
// más vale devolver una lectura parcial que el cajero corrige a mano, que morir sin
// respuesta después de haberla conseguido.
const PRESUPUESTO_CADENA_MS = 45_000;

// El prompt, el esquema JSON y la normalización de cada tipo de comprobante viven en
// lib/proveedores/prompts.ts. Lo que cambia entre Binance y BDV es QUÉ se le pide al
// modelo; la cadena de motores, los reintentos y el manejo de errores de este archivo
// son idénticos para ambos y por eso siguen aquí.

async function intentarGemini(ai: GoogleGenAI, modelo: string, base64Limpio: string, espec: EspecOcr): Promise<ResultadoOcr | null> {
  console.log(`🤖 [Escáner] Enviando imagen a ${modelo}...`);

  const respuesta = await ai.models.generateContent({
    model: modelo,
    contents: [
      espec.prompt,
      {
        inlineData: {
          mimeType: "image/jpeg",
          data: base64Limpio
        }
      }
    ],
    config: {
      // Extracción determinista: no queremos creatividad, sino el mismo resultado
      // ante la misma imagen en cada intento.
      temperature: 0,
      responseMimeType: "application/json",
      responseSchema: espec.esquemaGemini,
      abortSignal: AbortSignal.timeout(TIEMPO_MAXIMO_MOTOR_MS)
    }
  });

  const textoCrudo = respuesta.text?.trim() || "{}";
  console.log(`📝 [Escáner] Respuesta cruda de ${modelo}:`, textoCrudo);

  try {
    return espec.normalizar(JSON.parse(textoCrudo));
  } catch (parseError) {
    console.error(`❌ [Escáner] Error al parsear el JSON de ${modelo}:`, textoCrudo, parseError);
    return null;
  }
}

// Se llama por HTTP en vez de con el SDK 'openai' para no añadir otra dependencia al
// bundle: la petición es una sola y el contrato de chat/completions es estable.
async function intentarOpenAI(apiKey: string, modelo: string, dataUri: string, detalle: "low" | "high", espec: EspecOcr): Promise<ResultadoOcr | null> {
  console.log(`🤖 [Escáner] Enviando imagen a ${modelo} (detalle ${detalle})...`);

  const respuesta = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: modelo,
      // Misma extracción determinista que en Gemini: la misma imagen debe dar el mismo dato.
      temperature: 0,
      response_format: {
        type: "json_schema",
        json_schema: { name: espec.nombreEsquema, strict: true, schema: espec.esquemaOpenAI }
      },
      messages: [{
        role: "user",
        content: [
          { type: "text", text: espec.prompt },
          // Siempre 'high': 'low' reescala a 512px y confunde los dígitos de las fotos
          // reales del mostrador. El porqué, con las mediciones, está en construirCadena.
          { type: "image_url", image_url: { url: dataUri, detail: detalle } }
        ]
      }]
    }),
    // El fetch nativo ignora en silencio la opción 'timeout' de node-fetch: tiene que ser
    // una señal, o la petición se queda colgada hasta que Vercel mata la función.
    signal: AbortSignal.timeout(TIEMPO_MAXIMO_MOTOR_MS)
  });

  // Un 4xx/5xx del proveedor debe propagarse como excepción, no devolver null: null
  // significa "respondió algo ilegible", y de esa distinción depende que el cajero
  // reciba un 502 (reintentable) en vez de un 500.
  if (!respuesta.ok) {
    const detalle = await respuesta.text().catch(() => "");
    throw new Error(`OpenAI respondió ${respuesta.status}: ${detalle.slice(0, 300)}`);
  }

  const cuerpo = await respuesta.json();
  const textoCrudo = cuerpo?.choices?.[0]?.message?.content?.trim() || "{}";
  console.log(`📝 [Escáner] Respuesta cruda de ${modelo}:`, textoCrudo);

  try {
    return espec.normalizar(JSON.parse(textoCrudo));
  } catch (parseError) {
    console.error(`❌ [Escáner] Error al parsear el JSON de ${modelo}:`, textoCrudo, parseError);
    return null;
  }
}

// 'detalle' solo aplica a OpenAI: decide a qué resolución mira la imagen y con ello
// cuántos tokens cuesta la lectura. Sobre una foto típica del cajero (647x1400) son
// ~2.850 tokens con 'low' frente a ~36.850 con 'high': casi 13 veces más.
type Motor = { proveedor: "openai" | "gemini"; modelo: string; detalle?: "low" | "high" };

// Orden de intentos: primero los dos modelos del proveedor principal (rápido y luego
// potente), y si ninguno sirve se cae al otro proveedor completo. Así una caída total
// de un proveedor —cuota agotada, modelo retirado, caída del servicio— no deja al
// cajero sin escáner. PROVEEDOR_OCR decide cuál manda.
//
// Manda Gemini porque sobre la misma foto real del mostrador lee igual de bien que
// OpenAI y cuesta 33 veces menos: 1.121 tokens de entrada frente a 36.850. OpenAI no
// trocea la imagen en cuadrículas de 512px como exige 'detail: high', que es de donde
// salía todo ese consumo. OpenAI queda de respaldo, siempre en alta resolución.
function construirCadena(): Motor[] {
  const principal = (process.env.PROVEEDOR_OCR || "gemini").trim().toLowerCase();

  // ⚠️ Nada de 'low' aquí, por mucho que ahorre tokens. Con fotos reales —el cajero
  // fotografía la pantalla del cliente, con brillos y en ángulo— 'low' reescala a 512px
  // y confunde los dígitos. Lo grave es CÓMO falla: devuelve dígitos plausibles y se
  // declara legible, así que la cadena da la lectura por buena y nunca escala. Un
  // comprobante real de Valencia (ID ...4808394752) se leyó como ...4038945752 en
  // producción, y al reproducirlo 'low' falló 2 de 2 mientras 'high' acertó 2 de 2.
  //
  // El mismo fallo se midió después en los comprobantes de Pago Móvil, que además son
  // siempre fotos: uno del 13/08/2026 se leyó con fecha 11/09/2023 y la referencia
  // cambiada por otra que correspondía a un pago real distinto. Vale para los dos
  // proveedores, así que no hay excepción por tipo de comprobante.
  //
  // La medición que justificó 'low' se hizo con imágenes sintéticas demasiado limpias:
  // no representaban lo que llega de verdad desde el mostrador.
  const openai: Motor[] = process.env.OPENAI_API_KEY
    ? [
        { proveedor: "openai", modelo: OPENAI_RAPIDO, detalle: "high" },
        { proveedor: "openai", modelo: OPENAI_POTENTE, detalle: "high" },
      ]
    : [];
  const gemini: Motor[] = process.env.GEMINI_API_KEY
    ? [{ proveedor: "gemini", modelo: MODELO_RAPIDO }, { proveedor: "gemini", modelo: MODELO_POTENTE }]
    : [];

  return principal === "gemini" ? [...gemini, ...openai] : [...openai, ...gemini];
}

// El cliente de Gemini se crea una sola vez por proceso y se reutiliza entre peticiones:
// siendo el motor principal, instanciarlo en cada escaneo sería trabajo repetido.
let clienteGemini: GoogleGenAI | null = null;

async function invocarMotor(motor: Motor, base64Limpio: string, dataUri: string, espec: EspecOcr): Promise<ResultadoOcr | null> {
  if (motor.proveedor === "openai") {
    return intentarOpenAI(process.env.OPENAI_API_KEY as string, motor.modelo, dataUri, motor.detalle ?? "high", espec);
  }

  if (!clienteGemini) {
    console.log("📡 [Escáner] Conectando con la SDK unificada de Google Gemini...");
    clienteGemini = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY as string });
  }
  return intentarGemini(clienteGemini, motor.modelo, base64Limpio, espec);
}

// Recorre la cadena hasta conseguir una lectura completa. Devuelve además el último error
// del proveedor, porque de esa distinción depende que el cajero reciba un 502 ("no
// respondieron, reintenta") en vez de un 500 ("respondieron algo ilegible").
//
// Cada intento va en su propio try a propósito: las funciones de escaneo solo devuelven
// null cuando falla el parseo del JSON, pero CUALQUIER error de la API (modelo retirado
// → 404, cuota agotada → 429, timeout de red) se propagaba hasta el catch general y
// respondía 500 sin llegar a probar el siguiente modelo. Fue exactamente lo que ocurrió
// al retirarse gemini-2.5-flash: el reintento existía pero nunca se ejecutaba.
async function recorrerCadena(
  cadena: Motor[],
  base64Limpio: string,
  dataUri: string,
  espec: EspecOcr
): Promise<{ datos: ResultadoOcr | null; errorProveedor: unknown }> {
  let mejor: ResultadoOcr | null = null;
  let errorProveedor: unknown = null;

  // "Mejor" se mide por cuántos campos llegaron rellenos: cada proveedor tiene sus
  // propios campos críticos, así que contar es lo único que sirve para ambos.
  const camposLeidos = (r: ResultadoOcr) => Object.values(r.campos).filter((v) => v !== null && v !== "").length;

  const comenzo = Date.now();

  for (const motor of cadena) {
    // Se comprueba ANTES de invocar: escalar al siguiente modelo solo tiene sentido si da
    // tiempo a devolver su resultado. Agotar la función intentándolo deja al cajero sin
    // respuesta y sin la lectura parcial que ya teníamos.
    const transcurrido = Date.now() - comenzo;
    if (transcurrido > PRESUPUESTO_CADENA_MS) {
      console.warn(`⏱️ [Escáner] Presupuesto agotado tras ${(transcurrido / 1000).toFixed(1)} s; no se prueba ${motor.modelo}.`);
      break;
    }

    let resultado: ResultadoOcr | null = null;
    const t0 = Date.now();
    try {
      resultado = await invocarMotor(motor, base64Limpio, dataUri, espec);
    } catch (error) {
      errorProveedor = error;
      // La duración va en el log: distingue un rechazo inmediato (modelo retirado, cuota
      // agotada) de un agotamiento del tiempo, que piden arreglos distintos.
      console.error(`❌ [Escáner] El modelo ${motor.modelo} falló tras ${Date.now() - t0} ms:`, error);
      continue;
    }
    console.log(`⏱️ [Escáner] ${motor.modelo} respondió en ${Date.now() - t0} ms.`);

    // Solo se pisa lo que ya teníamos si el nuevo intento leyó al menos tantos campos
    // (o si aún no había nada): un modelo posterior que devuelve basura no debe borrar
    // una lectura parcial anterior que al cajero todavía le sirve.
    if (resultado && (!mejor || camposLeidos(resultado) >= camposLeidos(mejor))) mejor = resultado;

    if (mejor && espec.estaCompleto(mejor)) break;
    console.log(`🔁 [Escáner] Resultado insuficiente de ${motor.modelo}, escalando al siguiente modelo...`);
  }

  return { datos: mejor, errorProveedor };
}

// Despertador de la función.
//
// En el plan gratuito la función se duerme tras un rato sin uso, y el primer escaneo del
// rato paga el arranque en frío: varios segundos en los que el cajero solo ve "analizando".
// El panel llama aquí al abrirse y al abrir la cámara —momentos en los que el cajero aún
// está hablando con el cliente o encuadrando la foto—, así que el arranque se paga en un
// hueco muerto en vez de con el comprobante ya delante.
//
// Deliberadamente no hace NADA: ni autentica, ni toca la base de datos, ni llama a la IA.
// Solo levantar el proceso ya carga el módulo y sus dependencias, que es de donde sale casi
// todo el retraso. Sin trabajo que hacer no hay nada que proteger ni cuota que gastar.
//
// ⚠️ No garantiza acierto: Vercel puede atender el POST posterior con otra instancia. Es
// una mejora de probabilidad, no un arreglo del arranque en frío — ese, en el plan
// gratuito, no se puede eliminar.
export function GET() {
  return new Response(null, { status: 204 });
}

export async function POST(request: Request) {
  console.log("🚀 [Escáner] Petición POST recibida desde el frontend del cajero.");

  try {
    // 🔒 Solo desde el panel del cajero (cookie firmada) o scripts internos con el token.
    // Cada llamada aquí consume cuota de pago del servicio de IA.
    if (!(await peticionDeCajeroValida(request))) {
      console.warn("⚠️ [Escáner] Petición rechazada: sin credencial de cajero.");
      return NextResponse.json({ message: "Acceso no autorizado." }, { status: 403 });
    }

    const body = await leerCuerpoJson(request);
    const imagenBase64 = typeof body?.imagenBase64 === "string" ? body.imagenBase64 : "";

    // Qué tipo de comprobante se está leyendo. Si no viene, se asume BINANCE: así las
    // peticiones anteriores al selector (y cualquier script interno) siguen funcionando.
    const { proveedor, espec } = especDeProveedor(body?.proveedor);
    console.log(`🔎 [Escáner] Leyendo un comprobante de tipo ${proveedor}.`);

    // Corta payloads malformados o abusivos antes de gastar una llamada al servicio de IA.
    if (!esImagenValida(imagenBase64)) {
      console.log("❌ [Escáner] Error: No se recibió ninguna imagen Base64 válida.");
      return NextResponse.json({ message: "No se proporcionó una imagen válida." }, { status: 400 });
    }

    const cadena = construirCadena();
    if (cadena.length === 0) {
      console.error("❌ [Escáner] ERROR CRÍTICO: no hay ninguna API key de IA definida (OPENAI_API_KEY o GEMINI_API_KEY).");
      return NextResponse.json({ message: "Error de configuración del servidor (Falta API Key)." }, { status: 500 });
    }

    // Limpiar el prefijo de metadatos Base64 generado por el Canvas del navegador
    const base64Limpio = imagenBase64.replace(/^data:image\/\w+;base64,/, "");
    // OpenAI, en cambio, espera el data URI completo; si el navegador no mandó prefijo
    // se asume JPEG, que es lo que produce el Canvas del panel del cajero.
    const dataUri = /^data:image\/\w+;base64,/.test(imagenBase64) ? imagenBase64 : `data:image/jpeg;base64,${base64Limpio}`;

    const { datos, errorProveedor } = await recorrerCadena(cadena, base64Limpio, dataUri, espec);

    // Los dos modelos fallaron: el cajero puede seguir a mano, así que se le dice explícitamente
    if (!datos) {
      console.error("❌ [Escáner] Ningún modelo pudo procesar la imagen.");
      // Se distingue "el proveedor de IA no respondió" (502, problema externo y transitorio)
      // de "respondió algo que no se pudo interpretar" (500), para que el cajero sepa si
      // vale la pena reintentar el escaneo o pasar directo al llenado manual.
      if (errorProveedor) {
        return NextResponse.json(
          { message: "El servicio de IA no está disponible en este momento. Escribe los datos del comprobante a mano." },
          { status: 502 }
        );
      }
      return NextResponse.json({ message: "El motor de IA no devolvió un formato estructurado legible." }, { status: 500 });
    }

    console.log("✅ [Escáner] Datos extraídos y normalizados con éxito:", datos.campos);

    // 'campos' se devuelve tal cual: sus claves son las de los inputs del formulario,
    // así que el frontend rellena lo que llegue sin conocer el proveedor. Para BINANCE
    // son las mismas tres claves de siempre (monto, moneda, binance_id_sufijo).
    return NextResponse.json({
      message: "Imagen procesada con éxito",
      proveedor,
      datos: datos.campos
    }, { status: 200 });

  } catch (error) {
    // El detalle queda en el log del servidor; al cliente no se le expone el error interno
    console.error("❌ [Escáner] Error crítico general en el backend:", error);
    return NextResponse.json({ message: "Error interno al procesar el OCR" }, { status: 500 });
  }
}
