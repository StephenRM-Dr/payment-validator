// Cliente HTTP hacia el puente `servidor-sofitasa/` — NO hacia el banco directo: Sofitasa
// solo es alcanzable desde dentro de la VPN corporativa, así que el puente (que corre en el
// Ubuntu de oficina, fuera de esta función serverless) es quien de verdad habla con el banco.
// Variables de entorno esperadas: SOFITASA_PUENTE_URL, SOFITASA_PUENTE_SECRETO.
//
// Mismo patrón de dos pasos que bdv.ts:
//
//   1. buscarPagoEnMovimientosSofitasa() — consulta /sofitasa/movimientos (estado de cuenta,
//      solo lectura, repetible) y cruza localmente por referencia y monto, igual que BDV
//      con su extracto.
//   2. confirmarPagoSofitasa() — llama a /sofitasa/verificar, que SÍ tiene efecto: el banco
//      marca la referencia como validada, y una segunda llamada devuelve "ya se validó" en
//      vez de repetir la respuesta. Por eso solo se invoca una vez que el paso 1 ya encontró
//      un match de confianza (o el cajero confirmó un candidato) — nunca a ciegas con los
//      datos que teclea el cajero, que es justo lo que costaría una referencia real por un
//      dato mal tecleado.

import { sufijoReferencia, digitosAComparar, limpiarReferencia, DIGITOS_REFERENCIA_MIN } from "./referencias.ts";
import type { EmpresaSofitasa } from "./empresas-sofitasa";
import { detalleDeErrorRed } from "./errores-red.ts";
import { agenteDnsConfiable } from "./dns-confiable.ts";
import { fetch as undiciFetch } from "undici";

const URL_PUENTE = process.env.SOFITASA_PUENTE_URL || "";
const SECRETO_PUENTE = process.env.SOFITASA_PUENTE_SECRETO || "";
const TIEMPO_MAXIMO_MS = 30_000;

export interface MovimientoSofitasa {
  DATETRX: string; // DD-MM-YYYY
  NUMCTRL: string;
  AMOUNT: number;
  CODTRX: string;
  BANKCODE: string;
  DEBTINST: string;
  CONCEPT: string;
  TYPETRX: string;
  BALANCDELT: string; // "Ingreso" | "Egreso"
  REFERENCEA: string;
  REFERENCEB: string;
}

export interface DatosPagadorSofitasa {
  telefonoPagador: string | null;
  bancoOrigen: string | null;
  cedulaPagador: string | null;
}

export type ResultadoBusquedaSofitasa =
  | { estado: "ENCONTRADO"; movimiento: MovimientoSofitasa; pagador: DatosPagadorSofitasa; movimientosRevisados: number }
  | { estado: "MONTO_DISTINTO"; mensaje: string; montoBanco: number; movimiento: MovimientoSofitasa }
  | { estado: "CANDIDATOS_POR_MONTO"; candidatos: { movimiento: MovimientoSofitasa; pagador: DatosPagadorSofitasa }[] }
  | { estado: "NO_ENCONTRADO"; mensaje: string; movimientosRevisados: number }
  | { estado: "SIN_RESPUESTA"; mensaje: string; detalle: string };

export type ResultadoConfirmacionSofitasa =
  | { estado: "VERIFICADO"; movimiento: Record<string, unknown> }
  | { estado: "YA_VERIFICADA"; mensaje: string; verificacionesPrevias: unknown[] }
  | { estado: "RECHAZADO"; mensaje: string; codigo: string; noExiste: boolean }
  | { estado: "SIN_RESPUESTA"; mensaje: string; detalle: string };

// Extrae teléfono/banco/cédula del campo CONCEPT del movimiento (formato `TELF.:...`,
// `BANCO:dddd`, `CED.:...`) — el mismo formato que ya usaba el prototipo de referencia de
// un compañero para conciliar manualmente, confirmado contra el spec OpenAPI del banco.
export function extraerDatosPagadorSofitasa(concept: string | null | undefined): DatosPagadorSofitasa {
  const texto = String(concept ?? "");
  return {
    telefonoPagador: /TELF\.:(\S+)/i.exec(texto)?.[1] ?? null,
    bancoOrigen: /BANCO:(\d{4})/i.exec(texto)?.[1] ?? null,
    cedulaPagador: /CED\.:(\S+)/i.exec(texto)?.[1] ?? null,
  };
}

type RespuestaPuente = { ok: true; estadoHttp: number; datos: unknown } | { ok: false; error: string; esTimeout: boolean };

// Un solo intento de ida y vuelta al puente. Separado de pedirAlPuente() para que el bucle
// de reintentos de abajo no mezcle "cómo se hace una petición" con "cuándo reintentarla".
async function intentarPedirAlPuente(
  ruta: string,
  metodo: "GET" | "POST",
  cuerpo: Record<string, unknown> | undefined
): Promise<RespuestaPuente> {
  try {
    // fetch del paquete 'undici', NO el global de Node: pasarle 'dispatcher: agenteDnsConfiable'
    // al fetch global reventó con "InvalidArgumentError: invalid onRequestStart method" — el
    // fetch interno de Node trae su propia copia empaquetada de undici, y un Agent creado con
    // la versión de npm no es 100% compatible con ella. Usando el fetch del mismo paquete que
    // creó el Agent, los dos hablan la misma versión y no chocan.
    const respuestaHttp = await undiciFetch(`${URL_PUENTE}${ruta}`, {
      method: metodo,
      headers: metodo === "GET"
        ? { "X-Puente-Secreto": SECRETO_PUENTE }
        : { "Content-Type": "application/json", "X-Puente-Secreto": SECRETO_PUENTE },
      body: metodo === "GET" ? undefined : JSON.stringify(cuerpo ?? {}),
      signal: AbortSignal.timeout(TIEMPO_MAXIMO_MS),
      dispatcher: agenteDnsConfiable,
    });
    const texto = await respuestaHttp.text();
    try {
      const datos = texto ? JSON.parse(texto) : {};
      return { ok: true, estadoHttp: respuestaHttp.status, datos };
    } catch {
      return { ok: false, error: "El puente Sofitasa devolvió una respuesta ilegible.", esTimeout: false };
    }
  } catch (error) {
    const esTimeout = error instanceof Error && error.name === "TimeoutError";
    console.error(`❌ [Sofitasa] No se pudo contactar con el puente en ${ruta}: ${detalleDeErrorRed(error)}`);
    return {
      ok: false,
      error: esTimeout ? "El puente Sofitasa tardó demasiado en responder." : "No se pudo conectar con el puente Sofitasa.",
      esTimeout,
    };
  }
}

// Transporte puro hacia el puente: no interpreta la respuesta, solo la entrega. Cada función
// de negocio decide qué significa cada estado HTTP — /sofitasa/verificar usa 404/409/422
// como resultados válidos, no como fallos de transporte.
//
// GET sin cuerpo (saldos) y POST con cuerpo (movimientos, verificar) comparten el mismo
// transporte: la única diferencia es si hay JSON que enviar, así que 'cuerpo' es opcional
// en vez de tener una segunda función casi idéntica.
//
// Hasta dos reintentos, y solo mientras el fallo NO sea timeout: confirmado contra
// producción, el hostname de Tailscale Funnel del puente a veces falla su resolución DNS de
// forma intermitente (ENOTFOUND) — un fallo rápido, no un cuelgue, así que varios reintentos
// rápidos son baratos. Un timeout es distinto: ya agotó sus 30s la primera vez, y
// reintentarlo encima le suma minutos de espera al cajero sin necesidad — ahí se corta de
// una vez.
const INTENTOS_MAXIMOS = 3;
const ESPERA_ENTRE_INTENTOS_MS = 300;

async function pedirAlPuente(
  ruta: string,
  opciones: { metodo?: "GET" | "POST"; cuerpo?: Record<string, unknown> } = {}
): Promise<{ ok: true; estadoHttp: number; datos: unknown } | { ok: false; error: string }> {
  if (!URL_PUENTE || !SECRETO_PUENTE) {
    return { ok: false, error: "La consulta a Sofitasa no está configurada (falta SOFITASA_PUENTE_URL o SOFITASA_PUENTE_SECRETO)." };
  }
  const metodo = opciones.metodo ?? "POST";

  let ultimoIntento: RespuestaPuente = await intentarPedirAlPuente(ruta, metodo, opciones.cuerpo);
  for (let intento = 2; intento <= INTENTOS_MAXIMOS; intento++) {
    // '=== false' y no '!ultimoIntento.ok': el proyecto compila con strict desactivado, y
    // ahí TypeScript solo estrecha la unión discriminada con una comparación explícita
    // (mismo motivo documentado en el resto del archivo).
    if (ultimoIntento.ok === true) return ultimoIntento;
    if (ultimoIntento.esTimeout) return ultimoIntento;

    console.warn(`⚠️ [Sofitasa] Reintentando ${ruta} (intento ${intento}/${INTENTOS_MAXIMOS})...`);
    await new Promise((resolver) => setTimeout(resolver, ESPERA_ENTRE_INTENTOS_MS));
    ultimoIntento = await intentarPedirAlPuente(ruta, metodo, opciones.cuerpo);
  }
  return ultimoIntento;
}

/**
 * Busca un pago concreto en el estado de cuenta del día (solo lectura, repetible), cruzando
 * por los últimos dígitos de la referencia y por el monto — misma lógica que
 * buscarPagoEnMovimientos() en bdv.ts.
 */
export async function buscarPagoEnMovimientosSofitasa(
  referencia: string,
  importe: number,
  fechaIso: string,
  empresa: EmpresaSofitasa
): Promise<ResultadoBusquedaSofitasa> {
  const largo = digitosAComparar(referencia);
  const sufijo = largo > 0 ? sufijoReferencia(limpiarReferencia(referencia), largo) : null;

  const resp = await pedirAlPuente("/sofitasa/movimientos", { cuerpo: { empresa, desde: fechaIso, hasta: fechaIso } });
  // '=== false' y no '!resp.ok': el proyecto compila con strict desactivado, y ahí
  // TypeScript solo estrecha la unión discriminada con una comparación explícita (mismo
  // motivo documentado en bdv.ts).
  if (resp.ok === false) {
    return { estado: "SIN_RESPUESTA", mensaje: "No se pudo consultar el estado de cuenta de Sofitasa. Inténtalo de nuevo en unos segundos.", detalle: resp.error };
  }

  const cuerpo = resp.datos as { ok?: boolean; mensaje?: string; movimientos?: MovimientoSofitasa[] };
  if (resp.estadoHttp !== 200 || cuerpo?.ok !== true) {
    return {
      estado: "SIN_RESPUESTA",
      mensaje: cuerpo?.mensaje || "El puente Sofitasa no pudo entregar el estado de cuenta.",
      detalle: `HTTP ${resp.estadoHttp}: ${JSON.stringify(cuerpo)}`,
    };
  }

  const movimientos = cuerpo.movimientos ?? [];
  // Solo "Ingreso" (crédito): un pago recibido nunca es un egreso de la cuenta del negocio.
  const creditos = movimientos.filter((m) => String(m.BALANCDELT ?? "").trim().toLowerCase() === "ingreso");

  let referenciaConOtroMonto: MovimientoSofitasa | null = null;

  if (sufijo) {
    for (const movimiento of creditos) {
      const coincide =
        sufijoReferencia(movimiento.REFERENCEA, largo) === sufijo ||
        sufijoReferencia(movimiento.REFERENCEB, largo) === sufijo ||
        sufijoReferencia(movimiento.NUMCTRL, largo) === sufijo;
      if (!coincide) continue;

      if (Math.round(movimiento.AMOUNT * 100) === Math.round(importe * 100)) {
        return {
          estado: "ENCONTRADO",
          movimiento,
          pagador: extraerDatosPagadorSofitasa(movimiento.CONCEPT),
          movimientosRevisados: movimientos.length,
        };
      }
      if (!referenciaConOtroMonto) referenciaConOtroMonto = movimiento;
    }
  }

  if (referenciaConOtroMonto) {
    return {
      estado: "MONTO_DISTINTO",
      mensaje: `❌ La referencia ${sufijo} sí existe, pero el banco la registró por Bs. ${referenciaConOtroMonto.AMOUNT.toFixed(2)} y no por Bs. ${importe.toFixed(2)}. Verifica el monto del comprobante.`,
      montoBanco: referenciaConOtroMonto.AMOUNT,
      movimiento: referenciaConOtroMonto,
    };
  }

  // Deduplicado por referencia, mismo motivo que bdv.ts: el banco a veces repite una fila.
  const porMonto = [
    ...new Map(
      creditos
        .filter((m) => Math.round(m.AMOUNT * 100) === Math.round(importe * 100))
        .map((m) => [m.REFERENCEA || m.NUMCTRL, m])
    ).values(),
  ];

  if (porMonto.length > 0) {
    return {
      estado: "CANDIDATOS_POR_MONTO",
      candidatos: porMonto.map((movimiento) => ({ movimiento, pagador: extraerDatosPagadorSofitasa(movimiento.CONCEPT) })),
    };
  }

  return {
    estado: "NO_ENCONTRADO",
    mensaje: sufijo
      ? `El banco no registra ningún pago recibido con la referencia ${sufijo} ni por Bs. ${importe.toFixed(2)} el ${fechaIso}. Verifica la referencia, el monto y la fecha del comprobante.`
      : `El banco no registra ningún pago por Bs. ${importe.toFixed(2)} el ${fechaIso}. La referencia "${referencia}" es demasiado corta para cruzarla directamente (hacen falta ${DIGITOS_REFERENCIA_MIN} dígitos significativos); verifica el monto y la fecha del comprobante.`,
    movimientosRevisados: movimientos.length,
  };
}

/**
 * Localiza un movimiento por la referencia EXACTA del estado de cuenta, que es la que el
 * cajero confirma tras elegir entre los candidatos. Se vuelve a consultar al banco a
 * propósito, igual que confirmarMovimientoDelExtracto() en bdv.ts: el cliente podría enviar
 * cualquier referencia en el segundo paso, así que el pago se comprueba de nuevo contra el
 * estado de cuenta en vez de fiarse de lo que llega en la petición.
 */
export async function confirmarMovimientoDelExtractoSofitasa(
  referenciaBanco: string,
  importe: number,
  fechaIso: string,
  empresa: EmpresaSofitasa
): Promise<
  | { estado: "ENCONTRADO"; movimiento: MovimientoSofitasa; pagador: DatosPagadorSofitasa }
  | { estado: "NO_ENCONTRADO"; mensaje: string }
  | { estado: "SIN_RESPUESTA"; mensaje: string; detalle: string }
> {
  const resp = await pedirAlPuente("/sofitasa/movimientos", { cuerpo: { empresa, desde: fechaIso, hasta: fechaIso } });
  // '=== false' y no '!resp.ok': el proyecto compila con strict desactivado, y ahí
  // TypeScript solo estrecha la unión discriminada con una comparación explícita (mismo
  // motivo documentado en bdv.ts).
  if (resp.ok === false) {
    return { estado: "SIN_RESPUESTA", mensaje: "No se pudo volver a consultar el estado de cuenta de Sofitasa.", detalle: resp.error };
  }
  const cuerpo = resp.datos as { ok?: boolean; mensaje?: string; movimientos?: MovimientoSofitasa[] };
  if (resp.estadoHttp !== 200 || cuerpo?.ok !== true) {
    return {
      estado: "SIN_RESPUESTA",
      mensaje: cuerpo?.mensaje || "El puente Sofitasa no pudo entregar el estado de cuenta.",
      detalle: `HTTP ${resp.estadoHttp}: ${JSON.stringify(cuerpo)}`,
    };
  }

  const movimiento = (cuerpo.movimientos ?? []).find(
    (m) =>
      String(m.BALANCDELT ?? "").trim().toLowerCase() === "ingreso" &&
      (m.REFERENCEA === referenciaBanco || m.NUMCTRL === referenciaBanco) &&
      Math.round(m.AMOUNT * 100) === Math.round(importe * 100)
  );

  if (!movimiento) {
    return { estado: "NO_ENCONTRADO", mensaje: "El pago que confirmaste ya no coincide con el estado de cuenta. Vuelve a escanear el comprobante." };
  }

  return { estado: "ENCONTRADO", movimiento, pagador: extraerDatosPagadorSofitasa(movimiento.CONCEPT) };
}

// El campo TELF. del CONCEPT trae el teléfono en formato INTERNACIONAL de 12 dígitos
// (58XXXXXXXXXX), pero /sofitasa/verificar espera el formato LOCAL de 11 (0XXXXXXXXXX) —
// confirmado contra un pago real: enviar el internacional hace que 'telefono.length === 11'
// falle más abajo, el tipo se infiera como transferencia en vez de pago móvil, y el banco
// rechace la verificación con un error genérico en vez de encontrar el registro.
function aTelefonoLocalSofitasa(telefono: string | null): string {
  const digitos = String(telefono ?? "").replace(/\D/g, "");
  if (digitos.length === 12 && digitos.startsWith("58")) return "0" + digitos.slice(2);
  return digitos;
}

/**
 * Confirma un pago ya identificado en el estado de cuenta llamando a /sofitasa/verificar.
 *
 * ⚠️ Esta llamada SÍ tiene efecto en el banco: marca la referencia como validada. Se llama
 * una sola vez, con los datos que ya resolvió buscarPagoEnMovimientosSofitasa() (o el
 * candidato que confirmó el cajero) — nunca especulativamente.
 */
export async function confirmarPagoSofitasa(
  movimiento: MovimientoSofitasa,
  pagador: DatosPagadorSofitasa,
  empresa: EmpresaSofitasa,
  fechaIso: string
): Promise<ResultadoConfirmacionSofitasa> {
  const referencia = limpiarReferencia(movimiento.REFERENCEA || movimiento.NUMCTRL);
  const telefono = pagador.telefonoPagador ? aTelefonoLocalSofitasa(pagador.telefonoPagador) : "0";
  const banco = pagador.bancoOrigen || movimiento.BANKCODE || "";
  // El manual admite "0" en teléfono solo para transferencias (tipo 1): si el CONCEPT no
  // traía un teléfono de 11 dígitos, se asume transferencia y no pago móvil.
  const tipo = telefono !== "0" && telefono.length === 11 ? 0 : 1;

  const resp = await pedirAlPuente("/sofitasa/verificar", {
    cuerpo: { empresa, referencia, telefono, banco, monto: movimiento.AMOUNT.toFixed(2), tipo, fecha: fechaIso },
  });

  // '=== false' y no '!resp.ok': el proyecto compila con strict desactivado, y ahí
  // TypeScript solo estrecha la unión discriminada con una comparación explícita (mismo
  // motivo documentado en bdv.ts).
  if (resp.ok === false) {
    return { estado: "SIN_RESPUESTA", mensaje: "No se pudo confirmar el pago con Sofitasa. Inténtalo de nuevo en unos segundos.", detalle: resp.error };
  }

  const cuerpo = resp.datos as {
    ok?: boolean;
    mensaje?: string;
    codigo?: string;
    yaVerificada?: boolean;
    verificacionesPrevias?: unknown[];
    movimiento?: Record<string, unknown>;
  };

  if (resp.estadoHttp === 200 && cuerpo?.ok === true) {
    return { estado: "VERIFICADO", movimiento: cuerpo.movimiento ?? {} };
  }

  // 0630: el banco dice que esta referencia ya se validó antes. Puede ser un intento de
  // duplicado, o un cobro nuestro que se perdió entre el verify exitoso y el registro en
  // nuestra base de datos — verificacionesPrevias trae el rastro del puente para decidir.
  if (resp.estadoHttp === 409 && cuerpo?.yaVerificada) {
    return {
      estado: "YA_VERIFICADA",
      mensaje: cuerpo.mensaje || "El banco dice que esta referencia ya fue verificada antes.",
      verificacionesPrevias: cuerpo.verificacionesPrevias ?? [],
    };
  }

  return {
    estado: "RECHAZADO",
    mensaje: cuerpo?.mensaje || "El banco rechazó la verificación del pago.",
    codigo: String(cuerpo?.codigo ?? resp.estadoHttp),
    noExiste: resp.estadoHttp === 404,
  };
}

// Una cuenta y su saldo, tal como los devuelve Balance Consult (puerto 8006) del banco.
export interface SaldoCuentaSofitasa {
  Cuenta: string;
  producto: string;
  moneda: string;
  saldo: number;
}

export type ResultadoSaldosSofitasa =
  | { estado: "OK"; cuentas: SaldoCuentaSofitasa[] }
  | { estado: "SIN_RESPUESTA"; mensaje: string; detalle: string };

/**
 * Saldos de las cuentas de una empresa (solo lectura, repetible) vía /sofitasa/saldos/{empresa}.
 */
export async function obtenerSaldosSofitasa(empresa: EmpresaSofitasa): Promise<ResultadoSaldosSofitasa> {
  const resp = await pedirAlPuente(`/sofitasa/saldos/${empresa}`, { metodo: "GET" });
  // '=== false' y no '!resp.ok': mismo motivo que en el resto del archivo (proyecto sin strict).
  if (resp.ok === false) {
    return { estado: "SIN_RESPUESTA", mensaje: "No se pudo consultar los saldos de Sofitasa. Inténtalo de nuevo en unos segundos.", detalle: resp.error };
  }

  const cuerpo = resp.datos as { ok?: boolean; mensaje?: string; cuentas?: SaldoCuentaSofitasa[] };
  if (resp.estadoHttp !== 200 || cuerpo?.ok !== true) {
    return {
      estado: "SIN_RESPUESTA",
      mensaje: cuerpo?.mensaje || "El puente Sofitasa no pudo entregar los saldos.",
      detalle: `HTTP ${resp.estadoHttp}: ${JSON.stringify(cuerpo)}`,
    };
  }

  return { estado: "OK", cuentas: cuerpo.cuentas ?? [] };
}
