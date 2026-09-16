// Notificaciones a un grupo de Telegram cuando un pago queda verificado.
// Telegram (a diferencia de WhatsApp Business API) sí permite que un bot publique
// en grupos de forma oficial y gratuita — por eso se eligió como canal en vez de WhatsApp.
// Requiere TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID (ver README, sección de configuración).
//
// Los pagos en bolívares van a su propio grupo (TELEGRAM_CHAT_ID_VES): quien cuadra la
// caja en Bs. no es quien cuadra la caja en cripto, y mezclar ambas monedas en un mismo
// hilo obligaba a leer cada aviso para saber si tocaba a tu turno.

// Grupo al que le corresponde un pago según su moneda. Se decide por moneda y no por
// proveedor a propósito: si mañana entra otro medio de pago en bolívares, su aviso ya cae
// en el grupo correcto sin tocar este archivo.
function grupoParaMoneda(moneda: string): { chatId: string | undefined; nombre: string } {
  if (moneda.toUpperCase() === "VES") {
    const chatVes = process.env.TELEGRAM_CHAT_ID_VES;
    // Sin grupo de bolívares configurado se usa el general en vez de callar el aviso:
    // perder la notificación de un pago ya cobrado es peor que enviarla al grupo de
    // siempre, y el log deja constancia de que falta la variable.
    if (!chatVes) {
      console.warn("⚠️ [Telegram] TELEGRAM_CHAT_ID_VES no está configurado; el pago en bolívares se avisa en el grupo general.");
      return { chatId: process.env.TELEGRAM_CHAT_ID, nombre: "general (respaldo)" };
    }
    return { chatId: chatVes, nombre: "bolívares" };
  }

  return { chatId: process.env.TELEGRAM_CHAT_ID, nombre: "general" };
}

interface DatosNotificacion {
  comanda: string;
  monto: number;
  moneda: string;
  ciudad: string;
  imagenBase64: string; // data:image/jpeg;base64,...
  // Líneas opcionales que dependen del proveedor: el grupo está acostumbrado a ver
  // montos en USDT, así que un pago móvil en bolívares necesita decir de dónde viene
  // y con qué referencia, o el aviso se lee como una cifra suelta sin contexto.
  proveedor?: string;
  referencia?: string;
}

// Convierte un data-URI a Blob para adjuntarlo como foto en el multipart/form-data de Telegram
function dataUriABlob(dataUri: string): Blob {
  const [cabecera, base64] = dataUri.split(",");
  const mime = /data:(.*?);base64/.exec(cabecera)?.[1] || "image/jpeg";
  const binario = Buffer.from(base64, "base64");
  return new Blob([binario], { type: mime });
}

// Resultado de la notificación: el llamador no puede fallar por esto, pero sí necesita
// saber si el aviso llegó para poder reflejarlo en su respuesta y en sus logs.
export type ResultadoNotificacion =
  | { enviada: true }
  | { enviada: false; motivo: "sin_configurar" | "rechazada" | "error"; detalle: string };

// Envía la foto del comprobante con los datos de la venta al grupo configurado.
// No lanza: un fallo de Telegram (bot no configurado, grupo caído, etc.) nunca debe
// interrumpir la validación del pago, que ya quedó registrada en la base de datos;
// pero el fallo sí se devuelve al llamador en vez de quedar solo en el log del servidor.
export async function notificarPagoVerificado(datos: DatosNotificacion): Promise<ResultadoNotificacion> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const grupo = grupoParaMoneda(datos.moneda);

  if (!token || !grupo.chatId) {
    console.warn("⚠️ [Telegram] TELEGRAM_BOT_TOKEN o el chat de destino no están configurados; se omite la notificación.");
    return { enviada: false, motivo: "sin_configurar", detalle: `TELEGRAM_BOT_TOKEN o el chat del grupo ${grupo.nombre} no están configurados.` };
  }

  try {
    const leyenda = [
      "✅ Pago verificado",
      datos.proveedor ? `🏦 Vía: ${datos.proveedor}` : null,
      `💰 Monto: ${datos.monto.toFixed(2)} ${datos.moneda}`,
      `🏬 Sucursal: ${datos.ciudad}`,
      `🧾 Comanda: ${datos.comanda}`,
      datos.referencia ? `🔖 Referencia: ${datos.referencia}` : null,
    ].filter(Boolean).join("\n");

    const formulario = new FormData();
    formulario.append("chat_id", grupo.chatId);
    formulario.append("caption", leyenda);
    formulario.append("photo", dataUriABlob(datos.imagenBase64), "comprobante.jpg");

    const respuesta = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
      method: "POST",
      body: formulario,
    });

    if (!respuesta.ok) {
      const detalle = await respuesta.text().catch(() => "");
      // El nombre del grupo va en el log: con dos destinos posibles, "sendPhoto falló"
      // a secas no dice si el bot no está en el grupo nuevo o si el problema es general.
      console.error(`❌ [Telegram] sendPhoto al grupo ${grupo.nombre} falló (${respuesta.status}): ${detalle}`);
      return { enviada: false, motivo: "rechazada", detalle: `sendPhoto al grupo ${grupo.nombre} respondió ${respuesta.status}` };
    }

    console.log(`📨 [Telegram] Aviso enviado al grupo ${grupo.nombre}.`);
    return { enviada: true };
  } catch (error) {
    console.error("❌ [Telegram] Error al notificar el pago verificado:", error);
    return { enviada: false, motivo: "error", detalle: error instanceof Error ? error.message : String(error) };
  }
}
