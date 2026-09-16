// Cliente HTTP hacia el puente `servidor-bancamiga/` — no hacia el banco directo: aunque
// Bancamiga expone un host público, las credenciales (master token, DNI/clave) no pueden
// aparecer en el bundle de una función serverless, así que el puente (Ubuntu de oficina) es
// quien las custodia y habla con el banco. Variables de entorno esperadas:
// BANCAMIGA_PUENTE_URL, BANCAMIGA_PUENTE_SECRETO.
//
// Mismo patrón de dos pasos que sofitasa.ts y bdv.ts, aunque aquí ambos endpoints son de
// solo lectura y repetibles:
//
//   1. consultarHistorialBancamiga() + buscarEnListaBancamiga() — el historial del día de la
//      sucursal, y el cruce local por referencia y monto sobre esa lista. Existe porque
//      /bancamiga/verificar exige el teléfono del pagador como filtro de búsqueda
//      (Phone_orig), un dato que el cajero no tiene por qué conocer ni teclear — el
//      historial no lo exige, y de un movimiento ya encontrado sí se puede leer.
//
//      Separado en dos funciones (consultar vs. buscar) a propósito: el banco recomienda no
//      llamar a /bancamiga/historial más de una vez cada 10 minutos por sucursal, así que
//      quien orquesta la petición (ver app/lib/proveedores/bancamiga-cache.ts) puede
//      reutilizar una lista ya descargada para varias búsquedas sin volver a tocar el
//      puente en cada verificación.
//   2. confirmarPagoBancamiga() — llama a /bancamiga/verificar con el teléfono ya conocido,
//      como paso final de mayor confianza antes de escribir en nuestra base de datos.

import {
  sufijoReferencia,
  limpiarReferencia,
  digitosACompararConMinimo,
  digitosDeCruceConMinimo,
  DIGITOS_MIN_BANCAMIGA,
} from "./referencias.ts";

const URL_PUENTE = process.env.BANCAMIGA_PUENTE_URL || "";
const SECRETO_PUENTE = process.env.BANCAMIGA_PUENTE_SECRETO || "";
const TIEMPO_MAXIMO_MS = 30_000;

function largoDeCruceBancamiga(referencia: unknown): number {
  return digitosACompararConMinimo(referencia, DIGITOS_MIN_BANCAMIGA);
}

// Versión exportada para la ruta y para el formulario del cajero: los dígitos que realmente
// se van a comparar, o null si la referencia es demasiado corta incluso para el mínimo propio
// de Bancamiga. Delega en digitosDeCruceConMinimo() de referencias.ts (pura, sin red) para
// que el navegador pueda mostrar el mismo cálculo sin importar este módulo — ver la nota de
// cabecera de referencias.ts sobre por qué no debe arrastrarse el cliente HTTP al bundle.
export function digitosDeCruceBancamiga(referencia: unknown): string | null {
  return digitosDeCruceConMinimo(referencia, DIGITOS_MIN_BANCAMIGA);
}

export interface MovimientoBancamiga {
  ID: string;
  Dni: string;
  PhoneDest: string;
  PhoneOrig: string;
  Amount: number;
  BancoOrig: string;
  NroReferenciaCorto: string;
  NroReferencia: string;
  HoraMovimiento: string;
  FechaMovimiento: string;
  Descripcion: string;
  // No se filtra por este campo al buscar un pago (ver buscarEnListaBancamiga): la doc
  // oficial documenta "500" como abonado, pero nunca se vio ese valor en datos reales — solo
  // "600" y "700", sin confirmar cuál es cuál ni si esos códigos son estables. Referencia +
  // monto exactos ya son suficiente prueba de que el movimiento es el correcto.
  Status: string;
  Ref: number;
}

export interface DatosPagadorBancamiga {
  telefonoPagador: string | null;
  bancoOrigen: string | null;
}

// Sin caso "SIN_RESPUESTA": buscarEnListaBancamiga() es pura (no toca la red), esa
// posibilidad la maneja obtenerHistorialConCache() antes de llegar aquí.
export type ResultadoBusquedaBancamiga =
  | { estado: "ENCONTRADO"; movimiento: MovimientoBancamiga; pagador: DatosPagadorBancamiga; movimientosRevisados: number }
  | { estado: "MONTO_DISTINTO"; mensaje: string; montoBanco: number; movimiento: MovimientoBancamiga }
  | { estado: "CANDIDATOS_POR_MONTO"; candidatos: { movimiento: MovimientoBancamiga; pagador: DatosPagadorBancamiga }[] }
  | { estado: "NO_ENCONTRADO"; mensaje: string; movimientosRevisados: number };

export type ResultadoConfirmacionBancamiga =
  | { estado: "VERIFICADO"; movimiento: Record<string, unknown> }
  | { estado: "RECHAZADO"; mensaje: string; codigo: string; noExiste: boolean }
  | { estado: "SIN_RESPUESTA"; mensaje: string; detalle: string };

export type ResultadoHistorialBancamiga =
  | { ok: true; lista: MovimientoBancamiga[]; telefonoDestino: string }
  | { ok: false; mensaje: string; detalle: string };

export type MotivoTransferenciaBancamiga = "CE" | "CI" | "CD";

export interface MovimientoTransferenciaBancamiga {
  motivo: MotivoTransferenciaBancamiga;
  // Dígitos exactos enviados al banco en el intento que dio con el pago — consulta/trx NO
  // devuelve un número de referencia propio (a diferencia de MovimientoBancamiga.NroReferencia),
  // así que esto es lo único que identifica la fila para el índice de la migración 008.
  referenciaConsultada: string;
  nroDocumento: string | null; // "V15755944" — ya trae V/E/J/G/P, va directo a cedula_pagador
  nombre: string | null; // va directo a la columna genérica 'pagador'
  monto: number;
  detalle: string | null;
  fechaBanco: string | null; // crudo, sin parsear: el formato es inconsistente entre la doc y la respuesta real
}

export type ResultadoTransferenciaBancamiga =
  | { estado: "ENCONTRADO"; movimiento: MovimientoTransferenciaBancamiga }
  | { estado: "MONTO_DISTINTO"; mensaje: string; montoBanco: number; movimiento: MovimientoTransferenciaBancamiga }
  | { estado: "NO_ENCONTRADO"; mensaje: string; motivosIntentados: MotivoTransferenciaBancamiga[] }
  | { estado: "SIN_RESPUESTA"; mensaje: string; detalle: string };

function datosPagadorDe(movimiento: MovimientoBancamiga): DatosPagadorBancamiga {
  return { telefonoPagador: movimiento.PhoneOrig || null, bancoOrigen: movimiento.BancoOrig || null };
}

// Transporte puro: no interpreta la respuesta, cada función de negocio decide qué significa
// cada estado HTTP — /bancamiga/verificar usa 404/409/422 como resultados válidos.
async function pedirAlPuente(
  ruta: string,
  cuerpo: Record<string, unknown>
): Promise<{ ok: true; estadoHttp: number; datos: unknown } | { ok: false; error: string }> {
  if (!URL_PUENTE || !SECRETO_PUENTE) {
    return { ok: false, error: "La verificación de Bancamiga no está configurada (falta BANCAMIGA_PUENTE_URL o BANCAMIGA_PUENTE_SECRETO)." };
  }
  try {
    const respuestaHttp = await fetch(`${URL_PUENTE}${ruta}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Puente-Secreto": SECRETO_PUENTE },
      body: JSON.stringify(cuerpo),
      signal: AbortSignal.timeout(TIEMPO_MAXIMO_MS),
    });
    const texto = await respuestaHttp.text();
    let datos: unknown;
    try {
      datos = texto ? JSON.parse(texto) : {};
    } catch {
      return { ok: false, error: "El puente Bancamiga devolvió una respuesta ilegible." };
    }
    return { ok: true, estadoHttp: respuestaHttp.status, datos };
  } catch (error) {
    const esTimeout = error instanceof Error && error.name === "TimeoutError";
    return {
      ok: false,
      error: esTimeout ? "El puente Bancamiga tardó demasiado en responder." : "No se pudo conectar con el puente Bancamiga.",
    };
  }
}

/**
 * Consulta el historial CRUDO del día de una sucursal — sin buscar nada dentro. Sujeto al
 * cooldown de 10 minutos por sucursal que impone el banco (ver README de
 * servidor-bancamiga/); quien llame a esto directo en cada verificación lo va a agotar en
 * una sucursal con varias ventas seguidas. Por eso el flujo normal no llama aquí
 * directamente: pasa por obtenerHistorialConCache() en bancamiga-cache.ts, que reutiliza la
 * última lista descargada mientras siga vigente.
 */
export async function consultarHistorialBancamiga(sucursal: string, fechaIso: string): Promise<ResultadoHistorialBancamiga> {
  const resp = await pedirAlPuente("/bancamiga/historial", { sucursal, fecha: fechaIso });
  // '=== false' y no '!resp.ok': el proyecto compila con strict desactivado, y ahí
  // TypeScript solo estrecha la unión discriminada con una comparación explícita (mismo
  // motivo documentado en bdv.ts).
  if (resp.ok === false) {
    return { ok: false, mensaje: "No se pudo consultar el historial de Bancamiga. Inténtalo de nuevo en unos segundos.", detalle: resp.error };
  }

  const cuerpo = resp.datos as { ok?: boolean; mensaje?: string; lista?: MovimientoBancamiga[]; telefonoDestino?: string };
  if (resp.estadoHttp !== 200 || cuerpo?.ok !== true) {
    return {
      ok: false,
      mensaje: cuerpo?.mensaje || "El puente Bancamiga no pudo entregar el historial.",
      detalle: `HTTP ${resp.estadoHttp}: ${JSON.stringify(cuerpo)}`,
    };
  }

  // telefonoDestino identifica la CUENTA real del banco, no la sucursal: varias
  // sucursales pueden compartir el mismo teléfono (ver bancamiga-cache.ts), así que
  // quien orquesta la caché lo necesita para no tratar esas sucursales como cuentas
  // separadas.
  return { ok: true, lista: cuerpo.lista ?? [], telefonoDestino: cuerpo.telefonoDestino ?? "" };
}

/**
 * Busca un pago concreto DENTRO de una lista de historial ya obtenida (fresca o en caché),
 * cruzando por los últimos dígitos de la referencia y por el monto — misma lógica que
 * buscarPagoEnMovimientos() en bdv.ts. Pura: no toca la red, así que se puede llamar tantas
 * veces como haga falta sin preocuparse por el cooldown del banco.
 */
export function buscarEnListaBancamiga(lista: MovimientoBancamiga[], referencia: string, importe: number): ResultadoBusquedaBancamiga {
  const largo = largoDeCruceBancamiga(referencia);
  const sufijo = largo > 0 ? sufijoReferencia(limpiarReferencia(referencia), largo) : null;

  // Sin filtrar por Status: ver la nota en MovimientoBancamiga. Referencia + monto exactos
  // ya identifican el pago de forma confiable.
  let referenciaConOtroMonto: MovimientoBancamiga | null = null;

  if (sufijo) {
    for (const movimiento of lista) {
      const coincide =
        sufijoReferencia(movimiento.NroReferencia, largo) === sufijo ||
        sufijoReferencia(movimiento.NroReferenciaCorto, largo) === sufijo;
      if (!coincide) continue;

      if (Math.round(movimiento.Amount * 100) === Math.round(importe * 100)) {
        return {
          estado: "ENCONTRADO",
          movimiento,
          pagador: datosPagadorDe(movimiento),
          movimientosRevisados: lista.length,
        };
      }
      if (!referenciaConOtroMonto) referenciaConOtroMonto = movimiento;
    }
  }

  if (referenciaConOtroMonto) {
    return {
      estado: "MONTO_DISTINTO",
      mensaje: `❌ La referencia ${sufijo} sí existe, pero el banco la registró por Bs. ${referenciaConOtroMonto.Amount.toFixed(2)} y no por Bs. ${importe.toFixed(2)}. Verifica el monto del comprobante.`,
      montoBanco: referenciaConOtroMonto.Amount,
      movimiento: referenciaConOtroMonto,
    };
  }

  const porMonto = [
    ...new Map(
      lista
        .filter((m) => Math.round(m.Amount * 100) === Math.round(importe * 100))
        .map((m) => [m.NroReferencia || m.NroReferenciaCorto, m])
    ).values(),
  ];

  if (porMonto.length > 0) {
    return {
      estado: "CANDIDATOS_POR_MONTO",
      candidatos: porMonto.map((movimiento) => ({ movimiento, pagador: datosPagadorDe(movimiento) })),
    };
  }

  return {
    estado: "NO_ENCONTRADO",
    // La nota de "si es reciente..." solo va en la variante con sufijo: ahí sí se buscó de
    // verdad y no apareció (candidato real a demora del banco). La variante sin sufijo es un
    // problema de datos (referencia demasiado corta), no de tiempo — añadir la misma nota ahí
    // sugeriría al cajero que basta con esperar, cuando en realidad hace falta otra referencia.
    mensaje: sufijo
      ? `El banco no registra ningún pago abonado con la referencia ${sufijo} ni por Bs. ${importe.toFixed(2)}. Verifica la referencia, el monto y la fecha del comprobante. Si el pago es muy reciente, esto puede ser normal — el banco a veces tarda unos minutos en reflejarlo; vuelve a intentar más tarde.`
      : `El banco no registra ningún pago por Bs. ${importe.toFixed(2)}. La referencia "${referencia}" es demasiado corta para cruzarla directamente (hacen falta ${DIGITOS_MIN_BANCAMIGA} dígitos significativos); verifica el monto y la fecha del comprobante.`,
    movimientosRevisados: lista.length,
  };
}

/**
 * Localiza un movimiento por la referencia EXACTA del historial, que es la que el cajero
 * confirma tras elegir entre los candidatos — sobre una lista ya obtenida, igual criterio
 * de no fiarse ciegamente de lo que envía el cliente que confirmarMovimientoDelExtracto()
 * en bdv.ts, solo que aquí la lista viene de obtenerHistorialConCache() en vez de una nueva
 * llamada al puente.
 */
export function encontrarMovimientoPorReferenciaBancamiga(
  lista: MovimientoBancamiga[],
  referenciaBanco: string,
  importe: number
): { estado: "ENCONTRADO"; movimiento: MovimientoBancamiga; pagador: DatosPagadorBancamiga } | { estado: "NO_ENCONTRADO"; mensaje: string } {
  // Sin filtrar por Status: ver la nota en MovimientoBancamiga.
  const movimiento = lista.find(
    (m) =>
      (m.NroReferencia === referenciaBanco || m.NroReferenciaCorto === referenciaBanco) &&
      Math.round(m.Amount * 100) === Math.round(importe * 100)
  );

  if (!movimiento) {
    return { estado: "NO_ENCONTRADO", mensaje: "El pago que confirmaste ya no coincide con el historial. Vuelve a escanear el comprobante." };
  }

  return { estado: "ENCONTRADO", movimiento, pagador: datosPagadorDe(movimiento) };
}

// Transporte compartido de /bancamiga/verificar (pm/find/secure del banco, según la doc de
// amigapagos/Bancamiga_API_Documentation.md §3.3): tanto confirmarPagoBancamiga() —ya con un
// movimiento resuelto del historial— como consultarPagoMovilDirecto() —una consulta puntual,
// sin pasar por el historial— acaban llamando exactamente lo mismo, solo que el segundo no
// tiene un MovimientoBancamiga del que sacar los datos: los recibe ya sueltos.
async function pedirVerificarBancamiga(datos: {
  sucursal: string;
  telefonoOrigen: string;
  banco: string;
  monto: number;
  referencia: string;
  fecha: string;
}): Promise<ResultadoConfirmacionBancamiga> {
  const resp = await pedirAlPuente("/bancamiga/verificar", datos);

  // '=== false' y no '!resp.ok': el proyecto compila con strict desactivado, y ahí
  // TypeScript solo estrecha la unión discriminada con una comparación explícita (mismo
  // motivo documentado en bdv.ts).
  if (resp.ok === false) {
    return { estado: "SIN_RESPUESTA", mensaje: "No se pudo confirmar el pago con Bancamiga. Inténtalo de nuevo en unos segundos.", detalle: resp.error };
  }

  const cuerpo = resp.datos as { ok?: boolean; mensaje?: string; codigo?: string; movimiento?: Record<string, unknown> };

  if (resp.estadoHttp === 200 && cuerpo?.ok === true) {
    return { estado: "VERIFICADO", movimiento: cuerpo.movimiento ?? {} };
  }

  return {
    estado: "RECHAZADO",
    mensaje: cuerpo?.mensaje || "El banco no confirmó el pago en el paso final.",
    codigo: String(cuerpo?.codigo ?? resp.estadoHttp),
    noExiste: resp.estadoHttp === 404,
  };
}

/**
 * Confirma un pago ya identificado en el historial llamando a /bancamiga/verificar con el
 * teléfono del pagador ya conocido. De solo lectura del lado del banco (repetible), pero se
 * llama como paso final de más confianza y deja el registro oficial antes de escribir en
 * nuestra base de datos.
 */
export async function confirmarPagoBancamiga(
  movimiento: MovimientoBancamiga,
  sucursal: string,
  fechaIso: string
): Promise<ResultadoConfirmacionBancamiga> {
  return pedirVerificarBancamiga({
    sucursal,
    telefonoOrigen: movimiento.PhoneOrig,
    banco: movimiento.BancoOrig,
    monto: movimiento.Amount,
    referencia: movimiento.NroReferencia || movimiento.NroReferenciaCorto,
    fecha: fechaIso,
  });
}

// Acepta el teléfono tal como lo escribiría el cajero (con guion, con o sin el 0 inicial) y lo
// deja en el formato de 12 dígitos con 58 que exige la API (ver §5.1 de la doc): "0412-0998630"
// y "584120998630" deben normalizar al mismo valor. Devuelve null si no hay 10 dígitos
// venezolanos reconocibles (ver §5.1: código de operadora de 3 + número de 7).
export function telefonoAFormatoBancamiga(valor: unknown): string | null {
  let digitos = String(valor ?? "").replace(/\D/g, "");
  if (digitos.startsWith("58")) digitos = digitos.slice(2);
  else if (digitos.startsWith("0")) digitos = digitos.slice(1);
  return /^\d{10}$/.test(digitos) ? `58${digitos}` : null;
}

/**
 * Consulta puntual de un Pago Móvil DIRECTAMENTE contra Bancamiga (pm/find/secure), sin pasar
 * por el historial del día ni por su caché de 9 minutos — útil cuando el historial no trajo el
 * pago todavía (el extracto del día se completa con retraso, igual que en BDV) pero el cajero
 * sí tiene el teléfono de origen del comprobante (el que Bancamiga muestra parcialmente oculto,
 * ej. "04**-***3119": hace falta el número completo, que el cliente puede confirmar de su
 * propio teléfono o de la app del banco emisor).
 *
 * Es la MISMA llamada que confirmarPagoBancamiga() —/bancamiga/verificar—, pero sin exigir un
 * MovimientoBancamiga ya encontrado en el historial: aquí el teléfono, el banco y el monto los
 * aporta quien llama, no un movimiento previo. Sigue siendo de solo lectura y repetible del
 * lado del banco.
 */
export async function consultarPagoMovilDirecto(datos: {
  telefonoOrigen: string; // ya normalizado a 12 dígitos con 58 — usar telefonoAFormatoBancamiga()
  banco: string;
  monto: number;
  referencia: string;
  fecha: string;
  sucursal: string;
}): Promise<ResultadoConfirmacionBancamiga> {
  return pedirVerificarBancamiga(datos);
}

// ── Transferencias/depósitos (consulta/trx) — respaldo cuando Pago Móvil no encuentra nada ──
//
// Endpoint SEPARADO de Pago Móvil: una transferencia bancaria no llega a un teléfono de
// sucursal, llega a la cuenta única de la empresa. Se prueba por referencia+fecha+motivo
// (CE=transferencia externa, CI=interna, CD=depósito), sin lista de candidatos — el banco
// devuelve como máximo un resultado exacto por intento, así que este flujo es
// "buscar → insertar" directo, no "buscar → elegir candidato → confirmar" como Pago Móvil.
// Ver bancamiga-docs/API-Bancamiga-Consultar-Transferencias-Depositos.md (worktree
// feat/bancamiga-consulta-trx) para el detalle de cómo se confirmó esto contra el banco real.

const REFERENCIA_CE_DIGITOS = 8; // confirmado contra el banco real, 22/08/2026
// El mensaje de error real del banco para CI fue "El número de referencia debe tener de 9 a
// 12 dígitos" — se usa ese rango, no el "10 dígitos" de la tabla del PDF (que ese mismo error
// contradice). CD asume el mismo rango que CI, sin confirmar (nunca probado con un depósito
// real).
const REFERENCIA_CI_CD_MIN = 9;
const REFERENCIA_CI_CD_MAX = 12;

function hoyVenezuelaBancamiga(): string {
  // Duplicado deliberado de hoyVenezuela() en servidor-bancamiga/src/bancamiga.mjs: son dos
  // runtimes sin módulo compartido (Vercel vs. Node bajo systemd).
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Caracas" }).format(new Date());
}

interface IntentoTransferenciaBancamiga {
  motivo: MotivoTransferenciaBancamiga;
  referenciaConsultada: string;
}

/**
 * Pura, sin red: decide qué motivos vale la pena probar y con qué referencia exacta, según el
 * largo de la referencia y si la fecha del pago es hoy (CD solo aplica a operaciones del
 * mismo día, según la doc del banco).
 *
 * A propósito NO pasa por limpiarReferencia(): esa función quita los ceros de relleno de la
 * izquierda, pensada para el cruce por sufijo de Pago Móvil (ahí da igual cuántos ceros traiga
 * el prefijo, solo importan los dígitos finales). consulta/trx es distinto: el banco exige un
 * ancho EXACTO de dígitos (8 para CE, 9-12 para CI/CD) sobre la referencia larga tal cual la
 * emite el banco, que SÍ viene rellena a la izquierda (ver "NroReferencia": "000000575202" en
 * la doc). Quitar esos ceros antes de contar el largo hacía que una referencia realmente de 8
 * dígitos (ej. "00226837") se viera como de solo 6 "significativos" y se descartara el intento
 * por completo — bug real: una transferencia Bancamiga terminó sin poder verificarse porque
 * "motivos probados" quedó vacío. sufijoReferencia() ya calcula sus propios dígitos y no
 * trunca por delante, así que reutilizarla aquí sobre la referencia cruda es seguro.
 */
export function intentosTransferenciaBancamiga(referencia: string, fechaPago: string): IntentoTransferenciaBancamiga[] {
  const digitos = String(referencia ?? "").replace(/\D/g, "");
  const intentos: IntentoTransferenciaBancamiga[] = [];

  const referenciaCe = sufijoReferencia(digitos, REFERENCIA_CE_DIGITOS);
  if (referenciaCe) {
    intentos.push({ motivo: "CE", referenciaConsultada: referenciaCe });
  }

  const largoValidoCiCd = digitos.length >= REFERENCIA_CI_CD_MIN && digitos.length <= REFERENCIA_CI_CD_MAX;
  if (largoValidoCiCd) {
    intentos.push({ motivo: "CI", referenciaConsultada: digitos }); // completa, sin truncar: no hay regla de truncado confirmada
  }
  if (largoValidoCiCd && fechaPago === hoyVenezuelaBancamiga()) {
    intentos.push({ motivo: "CD", referenciaConsultada: digitos });
  }

  return intentos;
}

/**
 * Busca una transferencia/depósito probando CE → CI → CD en orden, cortando en el primer
 * intento cuyo monto coincida exactamente. consulta/trx no filtra por monto en la petición —
 * este cruce local es la única defensa contra un falso positivo por colisión de referencia
 * corta (8 dígitos para CE).
 */
export async function buscarTransferenciaBancamiga(
  referencia: string,
  importe: number,
  fechaPago: string
): Promise<ResultadoTransferenciaBancamiga> {
  const intentos = intentosTransferenciaBancamiga(referencia, fechaPago);
  let candidatoMontoDistinto: MovimientoTransferenciaBancamiga | null = null;
  const motivosIntentados: MotivoTransferenciaBancamiga[] = [];

  for (const intento of intentos) {
    motivosIntentados.push(intento.motivo);

    const resp = await pedirAlPuente("/bancamiga/consulta-trx", {
      referencia: intento.referenciaConsultada,
      fecha: fechaPago,
      motivo: intento.motivo,
    });

    if (resp.ok === false) {
      return {
        estado: "SIN_RESPUESTA",
        mensaje: "No se pudo consultar la transferencia con Bancamiga. Inténtalo de nuevo en unos segundos.",
        detalle: resp.error,
      };
    }

    if (resp.estadoHttp === 503) {
      // Config rota del lado del puente (falta BANCAMIGA_API_KEY) — no va a mejorar con el
      // siguiente motivo bajo la misma configuración rota.
      const cuerpoError = resp.datos as { mensaje?: string };
      return {
        estado: "SIN_RESPUESTA",
        mensaje: "La verificación de transferencias de Bancamiga no está disponible.",
        detalle: cuerpoError?.mensaje ?? "HTTP 503",
      };
    }

    if (resp.estadoHttp !== 200) continue; // 404 (no encontrado) o 422 (rechazo puntual de este motivo): sigue con el siguiente

    const cuerpo = resp.datos as { ok?: boolean; movimiento?: Record<string, unknown> };
    if (cuerpo?.ok !== true || !cuerpo.movimiento) continue;

    const movimiento: MovimientoTransferenciaBancamiga = {
      motivo: intento.motivo,
      referenciaConsultada: intento.referenciaConsultada,
      nroDocumento: (cuerpo.movimiento.nro_documento as string) ?? null,
      nombre: (cuerpo.movimiento.nombre as string) ?? null,
      monto: Number(cuerpo.movimiento.monto),
      detalle: (cuerpo.movimiento.detalle as string) ?? null,
      fechaBanco: (cuerpo.movimiento.fecha as string) ?? null,
    };

    if (Math.round(movimiento.monto * 100) === Math.round(importe * 100)) {
      return { estado: "ENCONTRADO", movimiento };
    }
    if (!candidatoMontoDistinto) candidatoMontoDistinto = movimiento;
  }

  if (candidatoMontoDistinto) {
    return {
      estado: "MONTO_DISTINTO",
      mensaje: `❌ Encontré una transferencia con esa referencia (motivo ${candidatoMontoDistinto.motivo}), pero el banco la registró por Bs. ${candidatoMontoDistinto.monto.toFixed(2)} y no por Bs. ${importe.toFixed(2)}. Verifica el monto del comprobante.`,
      montoBanco: candidatoMontoDistinto.monto,
      movimiento: candidatoMontoDistinto,
    };
  }

  return {
    estado: "NO_ENCONTRADO",
    mensaje: `El banco no registra ninguna transferencia con esa referencia por Bs. ${importe.toFixed(2)}.`,
    motivosIntentados,
  };
}
