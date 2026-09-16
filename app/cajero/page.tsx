"use client";

import { useState, useRef, useEffect } from "react";
import { SUCURSALES, PROVEEDORES, VALORES_PROVEEDORES, type Proveedor } from "../lib/sucursales";
import { leerJson, mensajeDeError, leerAlmacenamiento, escribirAlmacenamiento, fetchCajero } from "../lib/cliente";
import { digitosDeCruce, digitosDeCruceConMinimo, DIGITOS_MIN_BANCAMIGA, CORRECCIONES_MAX_PARECIDO } from "../lib/proveedores/referencias";
import { nombreDeBanco, CODIGO_BDV, CODIGO_SOFITASA, CODIGO_BANCAMIGA, BANCOS } from "../lib/bancos";

// Un pago del extracto/historial que coincide en monto pero no en referencia. Aparece con
// los pagos que el banco numera con una referencia interna propia (BDV a BDV, por ejemplo):
// el sistema no puede decidir cuál es el del cliente, así que se los muestra al cajero para
// que lo confirme. Misma forma para BDV, Sofitasa y Bancamiga — los tres son proveedores
// "pull" que preguntan al banco y pueden toparse con esta misma ambigüedad.
interface CandidatoBanco {
  referenciaBanco: string;
  hora: string | null;
  monto: number | null;
  pagador: string | null;
  identificacion: string | null;
  bancoOrigen: string | null;
  // Cuántos dígitos habría que corregir para que la referencia del banco fuese la escaneada.
  // El escáner falla algún dígito leyendo la foto de una pantalla, y sin esta pista el
  // cajero descarta el pago bueno porque "la referencia no es la mía".
  correcciones: number;
}

export default function FormularioCajero() {
  // Proveedor del comprobante que se está validando. Decide el prompt que usa el escáner,
  // qué campos pide el formulario y a qué endpoint se envía la validación.
  // Es un selector explícito y no una detección automática por IA: una clasificación
  // errónea gastaría un escaneo entero y el cajero no sabría por qué falló.
  const [proveedor, setProveedor] = useState<Proveedor>("BINANCE");

  // Estados para capturar los datos del formulario
  const [idOrden, setIdOrden] = useState("");
  const [monto, setMonto] = useState("");
  const [moneda, setMoneda] = useState("USDT");
  // Sufijo del ID de Binance: el cajero solo necesita tipear 6 caracteres a mano,
  // pero cuando la IA lee más dígitos del comprobante los guarda todos (hasta 10) —
  // un sufijo más largo evita que dos pagos distintos se confundan por coincidencia.
  const [binanceIdSufijo, setBinanceIdSufijo] = useState("");
  const [ciudad, setCiudad] = useState("San Cristobal"); // Ciudad por defecto inicial
  const [imagenRespaldada, setImagenRespaldada] = useState<string | null>(null);

  // Campos exclusivos del Pago Móvil BDV. Son los que exige la API del banco: sin todos
  // ellos (salvo la cédula, opcional) el banco no puede localizar el movimiento.
  const [importeBdv, setImporteBdv] = useState("");
  const [fechaPagoBdv, setFechaPagoBdv] = useState("");
  const [referenciaBdv, setReferenciaBdv] = useState("");
  // No hay estado para el banco, el teléfono ni la cédula del pagador: esos datos los
  // publica el propio banco en la observación de cada movimiento del extracto.

  // Mismos tres campos para Sofitasa y Bancamiga: el pago se busca primero en el estado de
  // cuenta/historial de solo lectura del banco (nunca a ciegas), y de ahí sale también el
  // teléfono del pagador — no hace falta pedírselo al cajero, igual que en BDV.
  const [importeSofitasa, setImporteSofitasa] = useState("");
  const [fechaPagoSofitasa, setFechaPagoSofitasa] = useState("");
  const [referenciaSofitasa, setReferenciaSofitasa] = useState("");

  const [importeBancamiga, setImporteBancamiga] = useState("");
  const [fechaPagoBancamiga, setFechaPagoBancamiga] = useState("");
  const [referenciaBancamiga, setReferenciaBancamiga] = useState("");
  // Opcionales — solo hacen falta si historial y transferencia no encuentran el pago (VÍA 3,
  // consulta directa). Mismo campo que ya existe en el panel de seguimiento del equipo.
  const [telefonoOrigenBancamiga, setTelefonoOrigenBancamiga] = useState("");
  const [bancoOrigenBancamiga, setBancoOrigenBancamiga] = useState("");

  // Estados para el manejo de la UI
  const [cargando, setCargando] = useState(false);
  const [escanearCargando, setEscanearCargando] = useState(false);
  // Aviso que sustituye al "Analizando imagen..." cuando la espera se alarga. Un escaneo
  // normal tarda 2-6 s; si pasa de ahí casi siempre es que el servidor estaba dormido y
  // está arrancando. Sin explicarlo, el cajero ve la pantalla congelada y vuelve a pulsar.
  const [escaneoLento, setEscaneoLento] = useState(false);
  const [mensajeAlerta, setMensajeAlerta] = useState<{ tipo: "exito" | "error" | "conflicto"; texto: string } | null>(null);
  // Un solo estado de candidatos: BDV, Sofitasa y Bancamiga comparten exactamente la misma
  // forma de ambigüedad, y solo un proveedor está activo a la vez en este formulario.
  const [candidatos, setCandidatos] = useState<CandidatoBanco[]>([]);

  const fileInputCamaraRef = useRef<HTMLInputElement>(null);
  const fileInputGaleriaRef = useRef<HTMLInputElement>(null);
  const origenCamaraRef = useRef(false);

  // 🏪 LEER LA ÚLTIMA CIUDAD Y EL ÚLTIMO PROVEEDOR AL CARGAR LA APP
  useEffect(() => {
    const ultimaCiudad = leerAlmacenamiento("local", "paymentvalidator_ultima_ciudad");
    if (ultimaCiudad) {
      setCiudad(ultimaCiudad);
    }
    // Una tienda que cobra casi siempre por pago móvil no debería reelegirlo en cada venta
    const ultimoProveedor = leerAlmacenamiento("local", "paymentvalidator_ultimo_proveedor");
    if (ultimoProveedor && VALORES_PROVEEDORES.includes(ultimoProveedor)) {
      setProveedor(ultimoProveedor as Proveedor);
    }
  }, []);

  // ☕ DESPERTAR LA FUNCIÓN DEL ESCÁNER
  // En el plan gratuito el servidor duerme la función tras un rato sin uso, y el primer
  // escaneo paga ese arranque con el comprobante ya delante del cajero. Se llama al abrir
  // el panel y al abrir la cámara: los dos son huecos muertos —el cajero está atendiendo o
  // encuadrando la foto— así que el arranque no le cuesta espera a nadie.
  //
  // Silencioso a propósito: es una optimización, no un requisito. Si falla, el escaneo
  // sigue funcionando exactamente igual, solo que más lento.
  const calentarEscaner = () => {
    fetch("/api/transacciones/escanear", { method: "GET", cache: "no-store" }).catch(() => null);
  };

  useEffect(calentarEscaner, []);

  // Guardar en localStorage cada vez que el cajero cambie la ciudad voluntariamente
  const handleCiudadChange = (nuevaCiudad: string) => {
    setCiudad(nuevaCiudad);
    escribirAlmacenamiento("local", "paymentvalidator_ultima_ciudad", nuevaCiudad);
  };

  // Cambiar de proveedor limpia los datos del pago: los campos de Binance y los de BDV no
  // son intercambiables, y arrastrar un monto en USDT a un formulario en bolívares solo
  // produce validaciones fallidas que el cajero no entiende. El comprobante escaneado
  // también se suelta, porque ya no corresponde al tipo de pago seleccionado.
  const handleProveedorChange = (nuevo: Proveedor) => {
    setProveedor(nuevo);
    escribirAlmacenamiento("local", "paymentvalidator_ultimo_proveedor", nuevo);
    limpiarDatosDelPago();
    setMensajeAlerta(null);
  };

  // Deja solo los datos que sobreviven a un pago: la sucursal y el proveedor elegidos.
  // Lo comparten el cambio de proveedor, el botón de resetear y el éxito de una validación.
  const limpiarDatosDelPago = () => {
    setMonto("");
    setMoneda("USDT");
    setBinanceIdSufijo("");
    setImporteBdv("");
    setFechaPagoBdv("");
    setReferenciaBdv("");

    setImporteSofitasa("");
    setFechaPagoSofitasa("");
    setReferenciaSofitasa("");

    setImporteBancamiga("");
    setFechaPagoBancamiga("");
    setReferenciaBancamiga("");
    setTelefonoOrigenBancamiga("");
    setBancoOrigenBancamiga("");

    setIdOrden("");
    setImagenRespaldada(null);
    setCandidatos([]);
  };

  // 💾 Guarda la foto tomada con la cámara también en el dispositivo móvil (Descargas/Galería)
  const guardarFotoEnDispositivo = (base64Imagen: string) => {
    try {
      const enlace = document.createElement("a");
      enlace.href = base64Imagen;
      enlace.download = `comprobante-paymentvalidator-${Date.now()}.jpg`;
      document.body.appendChild(enlace);
      enlace.click();
      document.body.removeChild(enlace);
    } catch (err) {
      console.error("[SCANNER] No se pudo guardar la foto en el dispositivo:", err);
    }
  };

  // 📸 Función para procesar y comprimir la imagen de la cámara o galería
  const handleEscanearImagen = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const archivo = e.target.files?.[0];
    if (!archivo) return;

    const vinoDeCamara = origenCamaraRef.current;

    setEscanearCargando(true);
    setMensajeAlerta(null);
    setImagenRespaldada(null);

    console.log("--- [SCANNER] Iniciando proceso de lectura fotográfica...");

    // 🛟 RED DE SEGURIDAD DEL ESCÁNER
    // El flujo pasa por callbacks anidados (FileReader → Image → canvas → fetch). Si alguno
    // falla sin avisar —foto corrupta, HEIC que se coló sin convertir, archivo que no es una
    // imagen— ni 'onload' ni el 'finally' llegan a ejecutarse: 'escanearCargando' se queda en
    // true, los botones de Cámara y Galería desaparecen y el cajero solo puede recargar la
    // página en plena atención al cliente. 'finalizar' garantiza que el formulario siempre
    // vuelva a quedar utilizable, pase lo que pase, y solo actúa una vez.
    let escaneoFinalizado = false;
    const finalizar = (mensaje?: { tipo: "exito" | "error" | "conflicto"; texto: string }) => {
      if (escaneoFinalizado) return;
      escaneoFinalizado = true;
      clearTimeout(temporizadorSeguridad);
      if (mensaje) setMensajeAlerta(mensaje);
      clearTimeout(temporizadorAviso);
      setEscaneoLento(false);
      setEscanearCargando(false);
      if (fileInputCamaraRef.current) fileInputCamaraRef.current.value = "";
      if (fileInputGaleriaRef.current) fileInputGaleriaRef.current.value = "";
    };

    // A los 8 s se le explica al cajero por qué sigue esperando. El servidor se duerme tras
    // un rato sin uso y el primer escaneo del rato paga el arranque; no es un fallo, pero
    // sin decirlo parece que la app se colgó.
    const temporizadorAviso = setTimeout(() => setEscaneoLento(true), 8_000);

    // Último recurso: si nada respondió en 90 s (el escaneo normal tarda 2-6 s), se libera igual
    const temporizadorSeguridad = setTimeout(() => {
      finalizar({ tipo: "conflicto", texto: "⚠️ El escaneo tardó demasiado. Vuelve a intentarlo o escribe los datos a mano." });
    }, 90_000);

    // 🍎 Las fotos de la galería de iPhone suelen venir en formato HEIC/HEIF, que la
    // mayoría de navegadores (fuera de Safari) no pueden decodificar en <canvas>.
    // Las convertimos a JPEG en el cliente antes de continuar con el flujo normal.
    const esHeic = archivo.type === "image/heic" || archivo.type === "image/heif" || /\.hei[cf]$/i.test(archivo.name);
    let archivoParaLeer: Blob = archivo;
    if (esHeic) {
      try {
        console.log("[SCANNER] Formato HEIC detectado, convirtiendo a JPEG...");
        const heic2any = (await import("heic2any")).default;
        const resultado = await heic2any({ blob: archivo, toType: "image/jpeg", quality: 0.9 });
        archivoParaLeer = Array.isArray(resultado) ? resultado[0] : resultado;
      } catch (err) {
        console.error("[SCANNER] Falló la conversión HEIC:", err);
        finalizar({ tipo: "conflicto", texto: "⚠️ No se pudo leer esta foto (formato HEIC no compatible). Usa la cámara o elige otra imagen." });
        return;
      }
    }

    const lector = new FileReader();

    // El archivo no se pudo leer del disco (permisos, archivo movido, lectura interrumpida)
    lector.onerror = () => {
      console.error("[SCANNER] FileReader no pudo leer el archivo:", lector.error);
      finalizar({ tipo: "conflicto", texto: "⚠️ No se pudo leer el archivo. Intenta tomar la foto de nuevo." });
    };

    lector.readAsDataURL(archivoParaLeer);
    lector.onload = async (evento) => {
      const img = new Image();

      // El navegador no pudo decodificar la imagen (formato no soportado, archivo corrupto,
      // o un PDF/documento renombrado como .jpg)
      img.onerror = (causa) => {
        console.error("[SCANNER] El navegador no pudo decodificar la imagen:", causa);
        finalizar({ tipo: "conflicto", texto: "⚠️ Esta imagen no se pudo abrir. Toma la foto otra vez o elige otro archivo." });
      };

      img.src = evento.target?.result as string;

      img.onload = async () => {
        try {
          // 📉 COMPRESIÓN DE IMAGEN EN EL CLIENTE
          // Resolución y calidad más altas que antes (1000px/0.7): el ID de orden y el
          // monto son texto pequeño y una imagen muy comprimida hace fallar el OCR de la IA.
          const canvas = document.createElement("canvas");
          const MAX_WIDTH = 1400;
          const MAX_HEIGHT = 1400;
          let width = img.width;
          let height = img.height;

          if (width > height) {
            if (width > MAX_WIDTH) {
              height *= MAX_WIDTH / width;
              width = MAX_WIDTH;
            }
          } else {
            if (height > MAX_HEIGHT) {
              width *= MAX_HEIGHT / height;
              height = MAX_HEIGHT;
            }
          }
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext("2d");
          // Sin contexto 2D no se dibuja nada: continuar produciría un comprobante en blanco
          // guardado como "evidencia" y un escaneo de IA sobre una imagen vacía.
          if (!ctx) {
            throw new Error("El navegador no pudo abrir un contexto 2D de canvas.");
          }
          ctx.drawImage(img, 0, 0, width, height);
          
          // Empezamos en calidad alta (0.85) para maximizar la legibilidad del texto
          // y bajamos solo si el resultado no cabe en el límite que acepta el backend.
          const LONGITUD_MAX_IMAGEN = 2_500_000;
          let calidad = 0.85;
          let base64Comprimido = canvas.toDataURL("image/jpeg", calidad);
          while (base64Comprimido.length > LONGITUD_MAX_IMAGEN && calidad > 0.5) {
            calidad -= 0.1;
            base64Comprimido = canvas.toDataURL("image/jpeg", calidad);
          }
          console.log(`[SCANNER] Imagen comprimida correctamente (calidad ${calidad.toFixed(2)}, ${width}x${height}).`);

          // ESTRATEGIA B: Guardar evidencia fotográfica obligatoria
          setImagenRespaldada(base64Comprimido);

          // 💾 Si la foto vino de la cámara, guardarla también en el dispositivo móvil
          if (vinoDeCamara) {
            guardarFotoEnDispositivo(base64Comprimido);
          }

          const respuesta = await fetchCajero("/api/transacciones/escanear", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ imagenBase64: base64Comprimido, proveedor }),
            // Corte propio del navegador. Cuando la función del servidor muere por tiempo
            // no devuelve nada —ni siquiera un código de error—, y sin esta señal el fetch
            // se queda esperando hasta que salta el temporizador de 90 s: eso es lo que el
            // cajero vive como "se quedó pegado". 70 s deja pasar el escaneo legítimo más
            // lento (el servidor se corta a los 60 s) y convierte el resto en un error claro.
            signal: AbortSignal.timeout(70_000),
          });

          // 'datos' llega con las claves propias del proveedor: el backend devuelve los
          // campos ya normalizados y aquí solo se reparten a los inputs correspondientes.
          const resultado = await leerJson<{ message?: string; datos?: Record<string, string | number | null> }>(respuesta);

          if (!respuesta.ok) {
            // El backend explica si la IA no está disponible o si el comprobante no sirvió;
            // ese mensaje se muestra tal cual en vez de un genérico "fallo de red".
            const texto = mensajeDeError(respuesta, resultado, "No se pudo procesar el comprobante con la IA");
            console.error(`[SCANNER] El escaneo falló con estado ${respuesta.status}: ${texto}`);
            setMensajeAlerta({ tipo: "conflicto", texto: `⚠️ ${texto} Digita el monto y el ID a mano (la foto quedó guardada).` });
            return;
          }

          if (resultado?.datos) {
            const d = resultado.datos;
            // Cada campo se rellena solo si la IA lo leyó: los que vuelven null se dejan
            // vacíos a propósito para que el cajero vea qué le falta completar, en vez de
            // recibir un valor por defecto que parece leído del comprobante.
            const rellenar = (valor: string | number | null | undefined, fijar: (v: string) => void) => {
              if (valor !== null && valor !== undefined && valor !== "") fijar(String(valor));
            };

            let completo: boolean;
            // Se rellena en los tres proveedores "banco pull" (BDV, Sofitasa, Bancamiga):
            // los tres piden exactamente los mismos tres campos, y el pago se busca luego en
            // el estado de cuenta/historial del banco correspondiente. bancoReceptor solo se
            // usa si el escáner logró resolver un código de banco inequívoco: ver la nota en
            // prompts.ts sobre por qué esto es deliberadamente best-effort.
            let bancoReceptorAjeno: string | null = null;
            const CAMPOS_BANCO_PULL: Partial<Record<Proveedor, { setImporte: (v: string) => void; setFecha: (v: string) => void; setReferencia: (v: string) => void; codigo: string }>> = {
              BDV: { setImporte: setImporteBdv, setFecha: setFechaPagoBdv, setReferencia: setReferenciaBdv, codigo: CODIGO_BDV },
              SOFITASA: { setImporte: setImporteSofitasa, setFecha: setFechaPagoSofitasa, setReferencia: setReferenciaSofitasa, codigo: CODIGO_SOFITASA },
              BANCAMIGA: { setImporte: setImporteBancamiga, setFecha: setFechaPagoBancamiga, setReferencia: setReferenciaBancamiga, codigo: CODIGO_BANCAMIGA },
            };
            const campoBancoPull = CAMPOS_BANCO_PULL[proveedor];

            if (campoBancoPull) {
              rellenar(d.importe, campoBancoPull.setImporte);
              rellenar(d.fechaPago, campoBancoPull.setFecha);
              rellenar(d.referencia, campoBancoPull.setReferencia);
              completo = Boolean(d.importe && d.fechaPago && d.referencia);
              if (typeof d.bancoReceptor === "string" && d.bancoReceptor && d.bancoReceptor !== campoBancoPull.codigo) {
                bancoReceptorAjeno = d.bancoReceptor;
              }
            } else {
              rellenar(d.monto, setMonto);
              rellenar(d.moneda, setMoneda);
              rellenar(d.binance_id_sufijo, setBinanceIdSufijo);
              completo = Boolean(d.monto && d.moneda && d.binance_id_sufijo);
            }

            if (!completo) {
              setMensajeAlerta({
                tipo: "conflicto",
                texto: "⚠️ IA: Comprobante difuso. Completa a mano los campos que quedaron vacíos. La foto quedó registrada para auditoría."
              });
            } else if (bancoReceptorAjeno && campoBancoPull) {
              // El comprobante mismo delata el problema antes de gastar una consulta al
              // banco: si el destino no es una cuenta del banco que corresponde, el dinero
              // no puede estar en NUESTRO extracto/historial, sin importar cuántas veces se
              // reintente. Validar solo confirmaría, tras la espera, lo que ya se sabe aquí.
              setMensajeAlerta({
                tipo: "conflicto",
                texto: `🚨 Este comprobante indica que el dinero se envió a una cuenta de ${nombreDeBanco(bancoReceptorAjeno)}, NO de ${nombreDeBanco(campoBancoPull.codigo)}. Es muy probable que el pago no haya llegado a esta tienda. Verifica con el cliente antes de validar.`
              });
            } else if (campoBancoPull) {
              // La referencia se destaca porque es la que localiza el pago en el
              // extracto/historial: un dígito mal leído da "no encontrado" y el cajero no
              // sabría dónde mirar.
              setMensajeAlerta({
                tipo: "exito",
                texto: "📷 Comprobante leído. Verifica sobre todo la REFERENCIA, y también el monto y la fecha; luego introduce la venta y valida."
              });
            } else {
              setMensajeAlerta({ tipo: "exito", texto: "📷 Comprobante procesado por IA. Verifica que los datos coincidan con el recibo (puedes corregirlos), introduce la venta y valida." });
            }
          } else {
            setMensajeAlerta({ tipo: "conflicto", texto: "⚠️ IA ilegible. Completa los campos manualmente (Evidencia fotográfica guardada)." });
          }
        } catch (err) {
          console.error("[SCANNER] Error inesperado al procesar el comprobante:", err);
          // El corte por tiempo se separa del fallo de red: la acción del cajero es la
          // misma, pero decirle "fallo de red" cuando hay cobertura le hace perder el
          // tiempo revisando el wifi en vez de seguir cobrando a mano.
          const seAgotoElTiempo = err instanceof DOMException && err.name === "TimeoutError";
          setMensajeAlerta({
            tipo: "conflicto",
            texto: seAgotoElTiempo
              ? "⚠️ El servidor no respondió a tiempo. Digita los datos a mano (la foto quedó guardada)."
              : "⚠️ Fallo de red en la IA. Digita los datos a mano (Foto guardada como respaldo).",
          });
        } finally {
          // Libera el formulario y cancela la red de seguridad (el mensaje ya se fijó arriba)
          finalizar();
        }
      };
    };
  };

  const handleLimpiarFormulario = () => {
    limpiarDatosDelPago();
    setMensajeAlerta(null);
  };

  // Envía la validación. 'referenciaBanco' solo viaja cuando el cajero ya eligió un pago
  // entre los candidatos que el banco devolvió por monto; el servidor lo vuelve a
  // comprobar contra el extracto, aquí no se decide nada.
  const handleSubmit = async (e: React.FormEvent | null, referenciaBanco?: string) => {
    e?.preventDefault();
    setCargando(true);
    setMensajeAlerta(null);
    setCandidatos([]);

    const fechaLocalIso = new Date().toISOString();

    // Cuatro flujos, cuatro endpoints: /validar cruza el comprobante contra un pago que el
    // worker de Binance ya detectó (push); /verificar-bdv, /verificar-sofitasa y
    // /verificar-bancamiga le preguntan cada uno a su banco por un pago que nadie ha visto
    // todavía (pull) — mismo cuerpo en los tres, solo cambia la URL.
    const comunes = {
      comanda: idOrden.trim(),
      ciudad: ciudad,
      fecha_cajero: fechaLocalIso,
      imagen_comprobante: imagenRespaldada,
    };

    const RUTAS_BANCO_PULL: Partial<Record<Proveedor, { url: string; importe: string; fechaPago: string; referencia: string }>> = {
      BDV: { url: "/api/transacciones/verificar-bdv", importe: importeBdv, fechaPago: fechaPagoBdv, referencia: referenciaBdv },
      SOFITASA: { url: "/api/transacciones/verificar-sofitasa", importe: importeSofitasa, fechaPago: fechaPagoSofitasa, referencia: referenciaSofitasa },
      BANCAMIGA: { url: "/api/transacciones/verificar-bancamiga", importe: importeBancamiga, fechaPago: fechaPagoBancamiga, referencia: referenciaBancamiga },
    };
    const rutaBancoPull = RUTAS_BANCO_PULL[proveedor];

    const destino = rutaBancoPull
      ? {
          url: rutaBancoPull.url,
          cuerpo: {
            ...comunes,
            importe: rutaBancoPull.importe.trim(),
            fecha_pago: rutaBancoPull.fechaPago,
            referencia: rutaBancoPull.referencia.trim(),
            ...(referenciaBanco ? { referencia_banco: referenciaBanco } : {}),
            // Solo Bancamiga tiene la vía directa; en BDV/Sofitasa estos campos simplemente
            // no existen del lado del servidor y se ignorarían, pero mejor no mandarlos.
            ...(proveedor === "BANCAMIGA" && telefonoOrigenBancamiga.trim()
              ? { telefono_origen: telefonoOrigenBancamiga.trim(), banco_origen: bancoOrigenBancamiga }
              : {}),
          },
        }
      : {
          url: "/api/transacciones/validar",
          cuerpo: {
            ...comunes,
            monto: parseFloat(monto),
            moneda: moneda,
            binance_id_sufijo: binanceIdSufijo.trim(),
          },
        };

    try {
      // fetchCajero y no fetch pelado: renueva la cookie del turno y reintenta ante un 403.
      // La URL sigue siendo la del proveedor elegido — cada uno tiene su propio endpoint.
      const respuesta = await fetchCajero(destino.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(destino.cuerpo),
      });

      const data = await leerJson<{ message?: string; candidatos?: CandidatoBanco[] }>(respuesta);

      if (respuesta.status === 200) {
        // Se limpian los datos del pago ya validado: antes quedaban en pantalla con el botón
        // habilitado, así que un segundo clic reenviaba lo mismo y devolvía un 409 confuso.
        // El comprobante escaneado también se suelta, de modo que el botón vuelve a exigir
        // una foto nueva antes de permitir otra validación.
        limpiarDatosDelPago();
        setMensajeAlerta({
          tipo: "exito",
          texto: "✅ ¡Pago verificado y respaldado con éxito! Escanea el siguiente comprobante cuando quieras."
        });
      } else if (respuesta.status === 409 && data?.candidatos?.length) {
        // No es un duplicado: el banco tiene pagos por ese monto pero con otra referencia,
        // y hace falta que una persona diga cuál es el del cliente.
        setCandidatos(data.candidatos);
        setMensajeAlerta({ tipo: "conflicto", texto: data.message || "Confirma cuál es el pago del cliente." });
      } else if (respuesta.status === 409) {
        setMensajeAlerta({ tipo: "conflicto", texto: mensajeDeError(respuesta, data, "Este comprobante ya fue validado") });
      } else if (data === null) {
        // leerJson devuelve null solo cuando el cuerpo no es JSON — y nuestra API SIEMPRE
        // responde JSON, hasta en sus propios errores (500 incluido). Que no lo sea significa
        // que la petición ni siquiera llegó a nuestro código: dominio equivocado, PWA fijada
        // a un despliegue viejo sin esta ruta, o el servidor caído. Mostrar aquí el mensaje de
        // rechazo de siempre ("el banco no confirmó el pago") sería mentirle al cajero: el
        // pago nunca llegó a consultarse, así que no hay base para desconfiar de él.
        console.error(`[VALIDAR] Respuesta sin JSON (estado ${respuesta.status}): la petición no llegó a la API de Payment Validator.`);
        setMensajeAlerta({
          tipo: "error",
          texto: `⚠️ No se pudo contactar con el servidor de Payment Validator (código ${respuesta.status}). Esto NO es un rechazo del pago: la petición no llegó a completarse. Recarga la página por completo (o borra y vuelve a crear el acceso directo) antes de decidir si el comprobante es válido.`,
        });
      } else {
        console.error(`[VALIDAR] La validación falló con estado ${respuesta.status}.`);
        const RESPALDOS: Partial<Record<Proveedor, string>> = {
          BDV: "El Banco de Venezuela no confirmó este pago",
          SOFITASA: "Sofitasa no confirmó este pago",
          BANCAMIGA: "Bancamiga no confirmó este pago",
        };
        const respaldo = RESPALDOS[proveedor] ?? "No se encontró coincidencia de fondos reales en Binance";
        setMensajeAlerta({ tipo: "error", texto: mensajeDeError(respuesta, data, respaldo) });
      }
    } catch (error) {
      console.error("[VALIDAR] Error de red al validar el pago:", error);
      setMensajeAlerta({ tipo: "error", texto: "Hubo un problema de red al conectar con el servidor." });
    } finally {
      setCargando(false);
    }
  };

  const esBdv = proveedor === "BDV";
  const esSofitasa = proveedor === "SOFITASA";
  const esBancamiga = proveedor === "BANCAMIGA";
  // Los tres son "banco pull": el cajero pregunta al banco (extracto/historial), no reclama
  // una fila que un worker ya descubrió, como sí hace Binance.
  const esBancoPull = esBdv || esSofitasa || esBancamiga;

  // Estado del botón de validación: requiere comprobante escaneado, número de venta y los
  // datos que el proveedor necesita. El texto le indica al cajero qué paso le falta.
  const faltaVenta = !idOrden.trim();
  // Para los "banco pull" faltan comprobar los tres campos del banco: enviar la petición sin
  // ellos solo gastaría una llamada a la API para recibir un rechazo previsible.
  const faltanDatosBdv = esBdv && !(importeBdv.trim() && fechaPagoBdv && referenciaBdv.trim());
  const faltanDatosSofitasa = esSofitasa && !(importeSofitasa.trim() && fechaPagoSofitasa && referenciaSofitasa.trim());
  const faltanDatosBancamiga = esBancamiga && !(importeBancamiga.trim() && fechaPagoBancamiga && referenciaBancamiga.trim());
  const faltanDatosBancoPull = faltanDatosBdv || faltanDatosSofitasa || faltanDatosBancamiga;

  // Los dígitos con los que se cruzará el pago contra el extracto/historial del banco. Sale
  // de la misma función que usa el servidor, así que lo que ve el cajero es literalmente lo
  // que se va a comparar, no una aproximación.
  const referenciaActiva = esBdv ? referenciaBdv : esSofitasa ? referenciaSofitasa : esBancamiga ? referenciaBancamiga : "";
  // Bancamiga usa un mínimo de dígitos significativos más bajo que BDV/Sofitasa (ver
  // DIGITOS_MIN_BANCAMIGA en referencias.ts) — con digitosDeCruce() a secas, una referencia
  // de 4-5 dígitos que el servidor sí va a cruzar no mostraba pista alguna aquí.
  const sufijoReferenciaActivo = esBancamiga
    ? digitosDeCruceConMinimo(referenciaActiva, DIGITOS_MIN_BANCAMIGA)
    : digitosDeCruce(referenciaActiva);
  const botonDeshabilitado = cargando || escanearCargando || !imagenRespaldada || faltaVenta || faltanDatosBancoPull;

  let textoBotonValidar = "Validar Transacción";
  if (cargando) {
    textoBotonValidar = esBancoPull ? "Buscando el pago en el banco..." : "Verificando fondos en Binance...";
  } else if (!imagenRespaldada) {
    textoBotonValidar = "⚠️ Escanea el Comprobante Primero";
  } else if (faltaVenta) {
    textoBotonValidar = "⚠️ Introduce el Número de Venta";
  } else if (faltanDatosBancoPull) {
    textoBotonValidar = "⚠️ Completa Monto, Fecha y Referencia";
  }

  // Estilos repetidos en cada campo del formulario. Se extraen porque ahora hay el doble de
  // inputs y copiarlos en cada uno hacía imposible ver qué campo tiene algo distinto.
  const estiloEtiqueta: React.CSSProperties = {
    fontSize: "14px", color: "#a6adc8", display: "flex", flexDirection: "column", gap: "5px"
  };
  const estiloCampo: React.CSSProperties = {
    width: "100%", padding: "12px", borderRadius: "6px", border: "1px solid #45475a",
    background: "#313244", color: "#fff", fontSize: "16px", boxSizing: "border-box"
  };

  return (
    <div style={{
      maxWidth: "500px", width: "90%", margin: "20px auto", padding: "20px",
      background: "#1e1e2e", borderRadius: "12px", color: "#fff", 
      fontFamily: "sans-serif", boxShadow: "0 4px 15px rgba(0,0,0,0.3)", boxSizing: "border-box"
    }}>
      <h2 style={{ textAlign: "center", marginBottom: "20px", color: "#cba6f7", fontSize: "22px" }}>Payment Validator - Panel de Cajero</h2>

      {/* 🏦 TIPO DE PAGO: va antes del escáner porque decide cómo la IA lee el comprobante.
          Si se eligiera después, el escaneo ya se habría hecho con el prompt equivocado. */}
      <div style={{ marginBottom: "20px" }}>
        <label style={estiloEtiqueta}>
          Tipo de Pago a Validar:
          <div style={{ display: "flex", gap: "10px", marginTop: "3px" }}>
            {PROVEEDORES.map((p) => {
              const activo = proveedor === p.valor;
              return (
                <button
                  key={p.valor}
                  type="button"
                  onClick={() => handleProveedorChange(p.valor)}
                  disabled={escanearCargando || cargando}
                  aria-pressed={activo}
                  style={{
                    flex: 1, padding: "14px 8px", borderRadius: "8px", fontSize: "15px", fontWeight: "bold",
                    border: activo ? "2px solid #cba6f7" : "2px solid #45475a",
                    background: activo ? "#cba6f7" : "#313244",
                    color: activo ? "#11111b" : "#a6adc8",
                    cursor: escanearCargando || cargando ? "not-allowed" : "pointer",
                    boxSizing: "border-box",
                  }}
                >
                  {p.etiqueta}
                </button>
              );
            })}
          </div>
        </label>
      </div>

      {/* 📸 SECCIÓN ESCÁNER DE COMPROBANTE: elegir entre Cámara o Galería */}
      <div style={{ marginBottom: "20px" }}>
        <input
          id="escaner-camara" type="file" accept="image/*" capture="environment"
          ref={fileInputCamaraRef} onChange={handleEscanearImagen} style={{ display: "none" }} disabled={escanearCargando}
        />
        <input
          id="escaner-galeria" type="file" accept="image/*,.heic,.heif"
          ref={fileInputGaleriaRef} onChange={handleEscanearImagen} style={{ display: "none" }} disabled={escanearCargando}
        />

        {escanearCargando ? (
          <div style={{
            display: "block", width: "100%", padding: "16px", borderRadius: "8px",
            border: "2px dashed #cba6f7", background: "#585b70",
            color: "#a6adc8", fontWeight: "bold", fontSize: "16px", textAlign: "center", boxSizing: "border-box"
          }}>
            {escaneoLento ? (
              <>
                ⏳ El servidor estaba inactivo y está arrancando…
                <div style={{ fontWeight: "normal", fontSize: "13px", marginTop: "6px" }}>
                  Espera unos segundos más. No vuelvas a pulsar ni recargues.
                </div>
              </>
            ) : (
              "🤖 Analizando Imagen..."
            )}
          </div>
        ) : (
          <div style={{ display: "flex", gap: "10px" }}>
            <label
              htmlFor="escaner-camara"
              onClick={() => { origenCamaraRef.current = true; calentarEscaner(); }}
              style={{
                flex: 1, display: "block", padding: "16px", borderRadius: "8px",
                border: "2px dashed #cba6f7", background: "rgba(203, 166, 247, 0.1)",
                color: "#cba6f7", fontWeight: "bold", fontSize: "15px",
                cursor: "pointer", boxSizing: "border-box", textAlign: "center"
              }}
            >
              📷 Usar Cámara
            </label>
            <label
              htmlFor="escaner-galeria"
              onClick={() => { origenCamaraRef.current = false; calentarEscaner(); }}
              style={{
                flex: 1, display: "block", padding: "16px", borderRadius: "8px",
                border: "2px dashed #cba6f7", background: "rgba(203, 166, 247, 0.1)",
                color: "#cba6f7", fontWeight: "bold", fontSize: "15px",
                cursor: "pointer", boxSizing: "border-box", textAlign: "center"
              }}
            >
              🖼️ Abrir Galería
            </label>
          </div>
        )}
      </div>

      {imagenRespaldada && (
        <button type="button" onClick={handleLimpiarFormulario} style={{
          width: "100%", padding: "10px", background: "#f38ba8", color: "#11111b", border: "none",
          borderRadius: "6px", fontWeight: "bold", marginBottom: "15px", cursor: "pointer"
        }}>
          🔄 Resetear y Escanear Otro Comprobante
        </button>
      )}

      <hr style={{ border: "0", height: "1px", background: "#45475a", marginBottom: "20px" }} />

      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "15px" }}>
        
        {/* 🏬 SELECTOR DE CIUDAD (Auto-guardado permanente) */}
        <label style={estiloEtiqueta}>
          Ciudad / Tienda Sucursal:
          <select value={ciudad} onChange={(e) => handleCiudadChange(e.target.value)}
            style={{ ...estiloCampo, fontWeight: "bold" }}>
            {SUCURSALES.map((s) => (
              <option key={s.valor} value={s.valor}>{s.etiqueta}</option>
            ))}
          </select>
        </label>

        {/* Campo Número de Venta / Comanda (obligatorio en ambos proveedores:
            sin venta a la que amarrar el pago no se puede validar) */}
        <label style={estiloEtiqueta}>
          Número de Venta / Comanda:
          <input type="text" value={idOrden} onChange={(e) => setIdOrden(e.target.value)} required placeholder="Ej: VENTA-405"
            style={estiloCampo} />
        </label>

        {/* ───── Campos de Binance Pay ───── */}
        {proveedor === "BINANCE" && (
          <>
            <label style={estiloEtiqueta}>
              Monto del Pago:
              <input type="number" step="0.01" value={monto} onChange={(e) => setMonto(e.target.value)} required placeholder="Escanea para rellenar"
                style={estiloCampo} />
            </label>

            <label style={estiloEtiqueta}>
              Moneda Usada:
              <select value={moneda} onChange={(e) => setMoneda(e.target.value)} style={estiloCampo}>
                <option value="USDT">USDT</option>
                <option value="BTC">BTC</option>
                <option value="ETH">ETH</option>
              </select>
            </label>

            {/* El cajero solo necesita tipear los últimos 6 dígitos; si la IA leyó más
                (hasta 10) se conservan tal cual para reducir coincidencias falsas. */}
            <label style={estiloEtiqueta}>
              ID Transacción Binance (mínimo Últimos 6 dígitos):
              <input type="text" maxLength={10} minLength={6} value={binanceIdSufijo} onChange={(e) => setBinanceIdSufijo(e.target.value)} required placeholder="Escanea para rellenar"
                style={{ ...estiloCampo, textTransform: "lowercase" }} />
            </label>
          </>
        )}

        {/* ───── Campos de Pago Móvil "banco pull" (BDV / Sofitasa / Bancamiga) ─────
            Solo tres en los tres: el pago se busca primero en el extracto/historial de solo
            lectura del banco correspondiente, cruzando referencia, monto y fecha. El banco,
            el teléfono y (cuando aplica) la cédula del pagador los aporta el propio
            movimiento bancario, así que no se le piden a nadie. */}
        {esBdv && (
          <>
            <label style={estiloEtiqueta}>
              Monto del Pago (Bs.):
              <input type="number" step="0.01" inputMode="decimal" value={importeBdv} onChange={(e) => setImporteBdv(e.target.value)} required placeholder="Escanea para rellenar"
                style={estiloCampo} />
            </label>

            <label style={estiloEtiqueta}>
              Fecha del Pago:
              <input type="date" value={fechaPagoBdv} onChange={(e) => setFechaPagoBdv(e.target.value)} required
                style={estiloCampo} />
            </label>

            {/* Se le muestra al cajero qué dígitos se van a buscar en el banco. El extracto
                publica la referencia con un prefijo propio, así que el cruce solo usa la
                cola: si la IA leyó mal el principio, aquí se ve que da igual, y si leyó mal
                el final, se ve antes de gastar una consulta al banco. */}
            <label style={estiloEtiqueta}>
              Referencia del Pago:
              <input type="text" inputMode="numeric" value={referenciaBdv} onChange={(e) => setReferenciaBdv(e.target.value.replace(/\D/g, ""))} required placeholder="Solo números"
                style={{ ...estiloCampo, fontFamily: "monospace" }} />
              {sufijoReferenciaActivo && (
                <span style={{ fontSize: "12px", color: "#a6adc8" }}>
                  Se buscará por: <strong style={{ fontFamily: "monospace", color: "#a6e3a1" }}>{sufijoReferenciaActivo}</strong>
                  {" "}— compara estos dígitos con los del comprobante del cliente.
                </span>
              )}
            </label>

            <p style={{ margin: 0, fontSize: "12px", color: "#6c7086", lineHeight: 1.5 }}>
              🏦 El banco, el teléfono y la cédula del pagador los toma el sistema del
              extracto bancario. No hace falta preguntarle nada al cliente.
            </p>
          </>
        )}

        {esSofitasa && (
          <>
            <label style={estiloEtiqueta}>
              Monto del Pago (Bs.):
              <input type="number" step="0.01" inputMode="decimal" value={importeSofitasa} onChange={(e) => setImporteSofitasa(e.target.value)} required placeholder="Escanea para rellenar"
                style={estiloCampo} />
            </label>

            <label style={estiloEtiqueta}>
              Fecha del Pago:
              <input type="date" value={fechaPagoSofitasa} onChange={(e) => setFechaPagoSofitasa(e.target.value)} required
                style={estiloCampo} />
            </label>

            <label style={estiloEtiqueta}>
              Referencia del Pago:
              <input type="text" inputMode="numeric" value={referenciaSofitasa} onChange={(e) => setReferenciaSofitasa(e.target.value.replace(/\D/g, ""))} required placeholder="Solo números"
                style={{ ...estiloCampo, fontFamily: "monospace" }} />
              {sufijoReferenciaActivo && (
                <span style={{ fontSize: "12px", color: "#a6adc8" }}>
                  Se buscará por: <strong style={{ fontFamily: "monospace", color: "#a6e3a1" }}>{sufijoReferenciaActivo}</strong>
                  {" "}— compara estos dígitos con los del comprobante del cliente.
                </span>
              )}
            </label>

            <p style={{ margin: 0, fontSize: "12px", color: "#6c7086", lineHeight: 1.5 }}>
              🏦 El banco y el teléfono del pagador los toma el sistema del estado de cuenta
              de Sofitasa. No hace falta preguntarle nada al cliente.
            </p>
          </>
        )}

        {esBancamiga && (
          <>
            <label style={estiloEtiqueta}>
              Monto del Pago (Bs.):
              <input type="number" step="0.01" inputMode="decimal" value={importeBancamiga} onChange={(e) => setImporteBancamiga(e.target.value)} required placeholder="Escanea para rellenar"
                style={estiloCampo} />
            </label>

            <label style={estiloEtiqueta}>
              Fecha del Pago:
              <input type="date" value={fechaPagoBancamiga} onChange={(e) => setFechaPagoBancamiga(e.target.value)} required
                style={estiloCampo} />
            </label>

            <label style={estiloEtiqueta}>
              Referencia del Pago:
              <input type="text" inputMode="numeric" value={referenciaBancamiga} onChange={(e) => setReferenciaBancamiga(e.target.value.replace(/\D/g, ""))} required placeholder="Solo números"
                style={{ ...estiloCampo, fontFamily: "monospace" }} />
              {sufijoReferenciaActivo && (
                <span style={{ fontSize: "12px", color: "#a6adc8" }}>
                  Se buscará por: <strong style={{ fontFamily: "monospace", color: "#a6e3a1" }}>{sufijoReferenciaActivo}</strong>
                  {" "}— compara estos dígitos con los del comprobante del cliente.
                </span>
              )}
            </label>

            <p style={{ margin: 0, fontSize: "12px", color: "#6c7086", lineHeight: 1.5 }}>
              🏦 El banco y el teléfono del pagador los toma el sistema del historial de
              Bancamiga. No hace falta preguntarle nada al cliente.
            </p>

            <div style={{ border: "1px dashed #45475a", borderRadius: "8px", padding: "12px", marginTop: "6px" }}>
              <p style={{ margin: "0 0 10px 0", fontSize: "12px", color: "#a6adc8" }}>
                Opcional — solo hace falta si la búsqueda automática no encuentra el pago (el
                banco a veces tarda en reflejarlo). Si tienes el teléfono completo del
                pagador, complétalo aquí para intentar una consulta directa.
              </p>
              <div style={{ display: "flex", gap: "12px" }}>
                <label style={{ ...estiloEtiqueta, flex: 1 }}>
                  Teléfono de origen
                  <input type="text" value={telefonoOrigenBancamiga} onChange={(e) => setTelefonoOrigenBancamiga(e.target.value)}
                    placeholder="0412-0998630" style={estiloCampo} />
                </label>
                <label style={{ ...estiloEtiqueta, flex: 1 }}>
                  Banco emisor
                  <select value={bancoOrigenBancamiga} onChange={(e) => setBancoOrigenBancamiga(e.target.value)} style={estiloCampo}>
                    <option value="">— Selecciona —</option>
                    {BANCOS.map((b) => <option key={b.codigo} value={b.nombre}>{b.nombre}</option>)}
                  </select>
                </label>
              </div>
            </div>
          </>
        )}

        {/* Botón Principal de Validación: exige comprobante escaneado, número de venta
            y los datos que el proveedor seleccionado necesita */}
        <button type="submit" disabled={botonDeshabilitado}
          style={{
            width: "100%", padding: "16px", marginTop: "10px", borderRadius: "8px", border: "none",
            background: botonDeshabilitado ? "#585b70" : "#a6e3a1",
            color: "#11111b", fontWeight: "bold", fontSize: "16px", cursor: botonDeshabilitado ? "not-allowed" : "pointer", boxSizing: "border-box"
          }}
        >
          {textoBotonValidar}
        </button>
      </form>

      {/* 🏦 CONFIRMACIÓN DE PAGO POR MONTO
          Aparece cuando la referencia del comprobante no está en el extracto/historial pero
          sí hay pagos por ese monto exacto — el caso de los pagos BDV a BDV (u otro banco a
          banco), que numeran la operación con una referencia interna propia. Elige una
          persona y no el sistema porque el monto se repite entre pagos distintos del mismo
          día en uno de cada nueve casos, en cualquiera de los tres proveedores. */}
      {candidatos.length > 0 && (
        <div style={{ marginTop: "20px", padding: "15px", borderRadius: "8px", background: "#313244", border: "2px solid #f9e2af" }}>
          <p style={{ margin: "0 0 12px 0", fontSize: "14px", color: "#f9e2af", fontWeight: "bold" }}>
            ¿Cuál de estos es el pago del cliente?
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            {candidatos.map((c) => (
              <button
                key={c.referenciaBanco}
                type="button"
                disabled={cargando}
                onClick={() => handleSubmit(null, c.referenciaBanco)}
                style={{
                  textAlign: "left", padding: "12px", borderRadius: "6px", border: "1px solid #45475a",
                  background: "#1e1e2e", color: "#fff", cursor: cargando ? "not-allowed" : "pointer", fontSize: "14px",
                }}
              >
                <div style={{ fontWeight: "bold", color: "#a6e3a1" }}>
                  Bs. {c.monto?.toFixed(2)}
                  {c.hora && <span style={{ color: "#a6adc8", fontWeight: "normal" }}> · {c.hora.slice(0, 2)}:{c.hora.slice(2)}</span>}
                </div>
                <div style={{ fontSize: "13px", color: "#a6adc8", marginTop: "3px" }}>
                  {c.pagador || "Pagador no identificado"}
                  {c.identificacion && ` · ${c.identificacion}`}
                </div>
                <div style={{ fontSize: "11px", color: "#6c7086", fontFamily: "monospace", marginTop: "2px" }}>
                  ref. banco {c.referenciaBanco}
                </div>
                {/* Solo se anota el parecido cuando es alto. Ponerlo en todos convertiría el
                    dato en ruido, y en un candidato lejano insinuaría un vínculo que no existe. */}
                {c.correcciones <= CORRECCIONES_MAX_PARECIDO && (
                  <div style={{ fontSize: "12px", color: "#a6e3a1", marginTop: "5px" }}>
                    ✔️ Casi igual a la referencia escaneada
                    {c.correcciones > 0 && ` (${c.correcciones} dígito${c.correcciones > 1 ? "s" : ""} de diferencia; probable error de lectura)`}
                    . Compárala con el comprobante del cliente.
                  </div>
                )}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => { setCandidatos([]); setMensajeAlerta(null); }}
            style={{ marginTop: "12px", width: "100%", padding: "10px", borderRadius: "6px", border: "none", background: "#585b70", color: "#fff", cursor: "pointer", fontSize: "13px" }}
          >
            Ninguno — cancelar
          </button>
        </div>
      )}

      {mensajeAlerta && (
        <div style={{ marginTop: "20px", padding: "15px", borderRadius: "6px", fontWeight: "bold", textAlign: "center", 
          background: mensajeAlerta.tipo === "exito" ? "#a6e3a1" : mensajeAlerta.tipo === "conflicto" ? "#f9e2af" : "#f38ba8",
          color: "#11111b", fontSize: "14px"
        }}>
          {mensajeAlerta.texto}
        </div>
      )}
    </div>
  );
}