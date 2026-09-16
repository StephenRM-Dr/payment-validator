// Utilidades del lado del navegador compartidas por los paneles de cajero y administración.

// Mismo techo que exige el backend (ver app/lib/imagenes.ts) — vive duplicado aquí a
// propósito, igual que en app/cajero/page.tsx: es una constante primitiva, no vale la pena
// forzar una dependencia solo para compartir un número.
const LONGITUD_MAX_IMAGEN_COMPROBANTE = 2_500_000;

// Convierte el archivo elegido (foto de cámara o galería) en un data-URI JPEG que respeta
// el límite de tamaño del backend — misma lógica de compresión progresiva que usa
// app/cajero/page.tsx, extraída aquí para el panel de seguimiento de Bancamiga
// (app/admin/bancamiga-seguimiento/), que también necesita adjuntar el comprobante.
//
// No se toca app/cajero/page.tsx para reusar esto: esa pantalla envuelve la compresión en
// una red de seguridad de temporizadores atada al flujo de escaneo por IA (ver los
// comentarios ahí), y no vale el riesgo de tocar ese camino en producción solo para
// deduplicar código. Aquí queda la misma lógica de compresión, sin esa capa.
export async function procesarImagenComprobante(archivo: File): Promise<string> {
  const esHeic = archivo.type === "image/heic" || archivo.type === "image/heif" || /\.hei[cf]$/i.test(archivo.name);
  let archivoParaLeer: Blob = archivo;
  if (esHeic) {
    try {
      const heic2any = (await import("heic2any")).default;
      const resultado = await heic2any({ blob: archivo, toType: "image/jpeg", quality: 0.9 });
      archivoParaLeer = Array.isArray(resultado) ? resultado[0] : resultado;
    } catch (error) {
      console.error("[Imagen] Falló la conversión HEIC:", error);
      throw new Error("No se pudo leer esta foto (formato HEIC no compatible). Prueba con otra imagen.");
    }
  }

  const dataUriOriginal = await new Promise<string>((resolve, reject) => {
    const lector = new FileReader();
    lector.onerror = () => reject(new Error("No se pudo leer el archivo. Intenta tomar la foto de nuevo."));
    lector.onload = (evento) => resolve(evento.target?.result as string);
    lector.readAsDataURL(archivoParaLeer);
  });

  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const imagen = new Image();
    imagen.onerror = () => reject(new Error("Esta imagen no se pudo abrir. Elige otro archivo."));
    imagen.onload = () => resolve(imagen);
    imagen.src = dataUriOriginal;
  });

  const canvas = document.createElement("canvas");
  const MAX_LADO = 1400;
  let width = img.width;
  let height = img.height;
  if (width > height) {
    if (width > MAX_LADO) { height *= MAX_LADO / width; width = MAX_LADO; }
  } else if (height > MAX_LADO) {
    width *= MAX_LADO / height;
    height = MAX_LADO;
  }
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("El navegador no pudo procesar la imagen.");
  ctx.drawImage(img, 0, 0, width, height);

  let calidad = 0.85;
  let base64Comprimido = canvas.toDataURL("image/jpeg", calidad);
  while (base64Comprimido.length > LONGITUD_MAX_IMAGEN_COMPROBANTE && calidad > 0.5) {
    calidad -= 0.1;
    base64Comprimido = canvas.toDataURL("image/jpeg", calidad);
  }
  return base64Comprimido;
}

// Lee el cuerpo JSON de una respuesta sin lanzar: una pasarela caída o un error del
// runtime devuelven HTML, y un `res.json()` pelado convertía ese caso en "fallo de red",
// ocultando el código de estado real que sí explica lo que pasó.
export async function leerJson<T = Record<string, unknown>>(respuesta: Response): Promise<T | null> {
  try {
    return (await respuesta.json()) as T;
  } catch (error) {
    console.error(`[HTTP] Respuesta ${respuesta.status} de ${respuesta.url} sin JSON válido:`, error);
    return null;
  }
}

// Mensaje de error legible a partir de una respuesta fallida: usa el que envía el backend
// y, si no hay cuerpo interpretable, deja constancia del código de estado en vez de un texto vacío.
export function mensajeDeError(
  respuesta: Response,
  cuerpo: { error?: unknown; message?: unknown } | null,
  porDefecto: string
): string {
  const delBackend = cuerpo?.error ?? cuerpo?.message;
  if (typeof delBackend === "string" && delBackend.trim()) return delBackend;
  return `${porDefecto} (código ${respuesta.status})`;
}

// localStorage/sessionStorage lanzan cuando el navegador bloquea el almacenamiento
// (modo privado de Safari, cookies de terceros deshabilitadas). Sin esta protección,
// la excepción sube al render de React y deja la pantalla en blanco.
export function leerAlmacenamiento(almacen: "local" | "sesion", clave: string): string | null {
  try {
    return (almacen === "local" ? window.localStorage : window.sessionStorage).getItem(clave);
  } catch (error) {
    console.error(`[Almacenamiento] No se pudo leer "${clave}":`, error);
    return null;
  }
}

export function escribirAlmacenamiento(almacen: "local" | "sesion", clave: string, valor: string): void {
  try {
    (almacen === "local" ? window.localStorage : window.sessionStorage).setItem(clave, valor);
  } catch (error) {
    console.error(`[Almacenamiento] No se pudo guardar "${clave}":`, error);
  }
}

export function borrarAlmacenamiento(almacen: "local" | "sesion", clave: string): void {
  try {
    (almacen === "local" ? window.localStorage : window.sessionStorage).removeItem(clave);
  } catch (error) {
    console.error(`[Almacenamiento] No se pudo borrar "${clave}":`, error);
  }
}

const INTENTOS_MAXIMOS_RED = 3;
const ESPERA_ENTRE_INTENTOS_MS = 500;

// Reintenta solo ante un FALLO DE RED (fetch() lanzó: sin señal, conexión caída a medio
// camino) — nunca ante una respuesta HTTP, buena o mala, que sube tal cual sin reintentar.
// Confirmado en producción: varios cajeros con señal móvil débil (1 barra de LTE en el
// mostrador es normal) ven "Hubo un problema de red al conectar con el servidor" al validar
// un pago que en sí no tiene ningún problema — solo el teléfono no llegó a completar la
// petición. Mismo principio que el reintento del puente Sofitasa (sofitasa.ts).
async function fetchConReintentos(url: string, init?: RequestInit): Promise<Response> {
  for (let intento = 1; intento <= INTENTOS_MAXIMOS_RED; intento++) {
    try {
      return await fetch(url, init);
    } catch (error) {
      if (intento === INTENTOS_MAXIMOS_RED) throw error;
      console.warn(`[Cajero] Fallo de red hacia ${url} (intento ${intento}/${INTENTOS_MAXIMOS_RED}), reintentando...`, error);
      await new Promise((resolver) => setTimeout(resolver, ESPERA_ENTRE_INTENTOS_MS));
    }
  }
  throw new Error("fetchConReintentos: estado inesperado"); // inalcanzable, el bucle siempre retorna o lanza antes
}

// Las peticiones del cajero se autorizan con una cookie firmada que emite el middleware
// al cargar /cajero. La app está instalada como PWA en los teléfonos del mostrador, y
// Android suele restaurarla desde segundo plano en vez de navegar de nuevo: el middleware
// no llega a ejecutarse, la cookie del turno anterior ya caducó y el primer escaneo del
// día se rechazaba con 403 "Acceso no autorizado", sin más salida que cerrar la app y
// volver a abrirla (algo que el cajero no tiene por qué saber).
//
// Aquí se recupera solo: ante un 403 se pide /cajero —que renueva la cookie— y se
// reintenta una única vez. Si el segundo intento vuelve a fallar, se devuelve tal cual
// para que el llamador muestre el error real.
export async function fetchCajero(url: string, init?: RequestInit): Promise<Response> {
  const respuesta = await fetchConReintentos(url, init);
  if (respuesta.status !== 403) return respuesta;

  console.warn("[Cajero] Credencial caducada; renovando la sesión y reintentando.");
  // Basta con tocar la ruta: el middleware responde con la cookie nueva.
  await fetch("/cajero", { cache: "no-store" }).catch(() => null);

  // El reintento reutiliza 'init' sin problema porque el cuerpo siempre es una cadena
  // JSON, no un stream: un ReadableStream ya consumido no se podría reenviar.
  return fetchConReintentos(url, init);
}
