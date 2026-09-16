// Conciliación de Pagos Móviles contra la API de Consulta de Movimientos del Banco de
// Venezuela (manual "API Consulta de Movimiento", producción).
//
// Por qué esta API y no getMovement, que fue la primera que se implementó:
//
//   • getMovement exige el teléfono del pagador, un dato que no se puede leer del
//     comprobante con fiabilidad (muestra también los del beneficiario) y que obligaba al
//     cajero a pedírselo al cliente en plena caja. El listado de movimientos trae los datos
//     del pagador dentro del campo 'observacion', así que nadie tiene que preguntarlos.
//   • getMovement NO es de solo lectura: una consulta exitosa marca el movimiento como
//     conciliado en el banco, y repetirla devuelve "El movimiento ya fue conciliado
//     anteriormente". Consultar el listado no altera nada del lado del banco.
//
// El listado es la fuente de verdad: son los movimientos reales de nuestra cuenta. Que un
// pago aparezca ahí como CRÉDITO significa que el dinero entró.

// Un solo día por consulta, y eso resuelve de raíz la restricción del manual: no se pueden
// mezclar días cerrados con el día en curso en un mismo rango. Preguntando por la fecha
// exacta del comprobante nunca se mezcla nada, y de paso se descargan ~100 movimientos en
// vez de los ~1.000 de un rango de diez días.
const URL_MOVIMIENTOS =
  process.env.BDV_MOVIMIENTOS_URL || "https://bdvconciliacion.banvenez.com/apis/bdv/consulta/movimientos";

// El banco a veces tarda. AbortSignal y no la opción 'timeout': el fetch nativo la ignora
// en silencio, y una petición colgada se comería el tiempo entero de la función serverless.
const TIEMPO_MAXIMO_MS = 30_000;

// Las reglas de comparación de referencias viven aparte porque el formulario del cajero
// también las usa, y es un componente cliente: importar este archivo desde el navegador
// arrastraría el cliente HTTP del banco al bundle. Se reexportan para que quien ya
// dependía de ellas a través de bdv.ts siga funcionando.
// La extensión .ts va explícita porque scripts/pruebas-bdv.mjs importa este archivo con
// node a secas, y el resolvedor ESM de Node —a diferencia del de Next— no completa
// extensiones. Sin ella, las pruebas contra el banco no arrancan.
import { digitosAComparar, sufijoReferencia, limpiarReferencia, DIGITOS_REFERENCIA_MIN } from "./referencias.ts";
export { digitosAComparar, sufijoReferencia, limpiarReferencia, digitosDeCruce } from "./referencias.ts";

// La cuenta a consultar es un parámetro, no una variable de entorno leída aquí dentro: el
// negocio tiene dos cuentas BDV y la que corresponde depende de la sucursal que cobra. Ver
// cuentas-bdv.ts, que es quien decide cuál toca.
import type { CredencialesBdv } from "./cuentas-bdv";
export type { CredencialesBdv } from "./cuentas-bdv";
import { CODIGO_BDV } from "../bancos.ts";
import { detalleDeErrorRed } from "./errores-red.ts";

export interface MovimientoBdv {
  referencia: string;
  descripcion: string | null;
  fecha: string;        // YYYY-MM-DD
  hora?: string | null; // HHMM
  mov: string;          // CREDITO | DEBITO
  saldo: string;
  importe: string;      // formato venezolano: "36.960,41"
  nroMov: string | null;
  observacion: string | null;
}

// Datos del pagador que el banco publica dentro de 'observacion'. Ninguno se le pide al
// cajero: todos vienen del banco, que es la fuente fiable.
export interface DatosPagador {
  bancoOrigen: string | null;      // código BCV de 4 dígitos
  telefonoPagador: string | null;  // solo en pagos de otros bancos
  cedulaPagador: string | null;    // solo en pagos BDV a BDV
  nombrePagador: string | null;
}

export type ResultadoBusqueda =
  // El pago está en la cuenta como crédito, con el monto exacto
  | { estado: "ENCONTRADO"; movimiento: MovimientoBdv; pagador: DatosPagador; movimientosRevisados: number }
  // La referencia existe pero el banco registró otro monto: casi siempre, el cajero tecleó mal
  | { estado: "MONTO_DISTINTO"; mensaje: string; montoBanco: string; movimiento: MovimientoBdv }
  // La referencia no aparece, pero sí hay créditos por el monto exacto. Pasa con los pagos
  // BDV a BDV: el extracto los numera con una referencia interna (prefijo 06772, en 186 de
  // 186 casos medidos) que no guarda relación con la del comprobante del cliente. El monto
  // por sí solo no basta para decidir —el 10,8% de los créditos comparte monto con otro del
  // mismo día—, así que los candidatos suben al cajero para que confirme cuál es.
  | { estado: "CANDIDATOS_POR_MONTO"; candidatos: { movimiento: MovimientoBdv; pagador: DatosPagador }[] }
  // Ese día no hay ningún crédito con esa referencia
  | { estado: "NO_ENCONTRADO"; mensaje: string; movimientosRevisados: number }
  // No se pudo hablar con el banco, o el banco devolvió un código de error
  | { estado: "SIN_RESPUESTA"; mensaje: string; detalle: string };

// La API espera DD/MM/AAAA; el resto del sistema trabaja en AAAA-MM-DD.
export function aFechaBdv(fechaIso: string): string {
  const [anio, mes, dia] = fechaIso.split("-");
  return `${dia}/${mes}/${anio}`;
}

// Normaliza un importe a número. El banco devuelve formato venezolano ("36.960,41": punto
// de millar, coma decimal) y el comprobante puede traer cualquiera de los dos estilos.
export function importeANumero(valor: unknown): number | null {
  if (valor === null || valor === undefined) return null;
  let texto = String(valor).replace(/\s|Bs\.?|\+/gi, "").trim();
  if (!texto) return null;

  if (texto.includes(",")) {
    // Coma presente: es el separador decimal, y los puntos son de millar
    texto = texto.replace(/\./g, "").replace(",", ".");
  } else {
    // Solo puntos: si hay más de uno, todos menos el último son de millar
    const partes = texto.split(".");
    if (partes.length > 2) texto = partes.slice(0, -1).join("") + "." + partes[partes.length - 1];
  }

  const numero = Number.parseFloat(texto);
  return Number.isFinite(numero) ? Math.abs(numero) : null;
}

// Extrae los datos del pagador de la observación del movimiento. El banco usa dos formatos,
// medidos sobre 421 créditos reales de la cuenta:
//   "PAGOMOVIL OTROS BANCOS 0134 04241168708"        → banco emisor + teléfono
//   "PAGOMOVIL BDV V029898428 MASSIEL HERRERA"       → cédula + nombre (el emisor es el BDV)
//   "PAGO RECIBIDO OTROS BANCOS 0191 J123456789"     → banco emisor + RIF
export function extraerDatosPagador(observacion: string | null | undefined): DatosPagador {
  const texto = String(observacion ?? "").trim();
  const vacio: DatosPagador = { bancoOrigen: null, telefonoPagador: null, cedulaPagador: null, nombrePagador: null };
  if (!texto) return vacio;

  // Otros bancos: código de 4 dígitos seguido del teléfono (11 dígitos) o de la cédula/RIF
  const otrosBancos = /OTROS BANCOS\s+(\d{4})\s+([A-Z]?\d{6,11})/i.exec(texto);
  if (otrosBancos) {
    const identificador = otrosBancos[2];
    const esTelefono = /^0\d{10}$/.test(identificador);
    return {
      bancoOrigen: otrosBancos[1],
      telefonoPagador: esTelefono ? identificador : null,
      cedulaPagador: esTelefono ? null : identificador.toUpperCase(),
      nombrePagador: null,
    };
  }

  // BDV a BDV: la cédula viene con ceros de relleno (V029898428 → V29898428) y detrás el
  // nombre, separado por los espacios de relleno del formato de ancho fijo del banco.
  // Sin '\s*' antes del grupo del nombre: como '.' también casa espacios, las dos partes
  // compiten por los mismos caracteres y el motor entra en retroceso exponencial. El
  // recorte se hace después con trim(), que es lineal.
  const mismoBanco = /PAGOMOVIL BDV\s+([VEJGP])(\d{6,10})(.*)$/i.exec(texto);
  if (mismoBanco) {
    return {
      bancoOrigen: CODIGO_BDV, // el pago salió del propio Banco de Venezuela
      telefonoPagador: null,
      cedulaPagador: `${mismoBanco[1].toUpperCase()}${mismoBanco[2].replace(/^0+/, "")}`,
      nombrePagador: mismoBanco[3].replace(/\s+/g, " ").trim() || null,
    };
  }

  return vacio;
}

type ResultadoDescarga = { ok: true; movimientos: MovimientoBdv[] } | { ok: false; mensaje: string; detalle: string; esTimeout: boolean };

// Un solo intento de ida y vuelta al banco. Separado de descargarMovimientosDelDia() para
// que el bucle de reintentos de abajo no mezcle "cómo se hace la petición" con "cuándo
// reintentarla" — mismo esquema que pedirAlPuente()/intentarPedirAlPuente() en sofitasa.ts.
async function intentarDescargarMovimientosDelDia(
  fechaIso: string,
  credenciales: CredencialesBdv
): Promise<ResultadoDescarga> {
  const { cuenta, apiKey, clave } = credenciales;
  const fecha = aFechaBdv(fechaIso);
  // fechaIni y fechaFin son el mismo día a propósito: ver la nota de URL_MOVIMIENTOS.
  const cuerpo = { cuenta, fechaIni: fecha, fechaFin: fecha, tipoMoneda: "VES", nroMovimiento: "" };

  try {
    // La cuenta va en el log —y en el resto de mensajes de esta función— porque con dos
    // cuentas activas "el banco no responde" a secas no dice cuál de las dos credenciales
    // falla, y ambas se configuran por separado.
    console.log(`🏦 [BDV/${clave}] Descargando los movimientos del ${fecha}...`);

    const respuestaHttp = await fetch(URL_MOVIMIENTOS, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
      body: JSON.stringify(cuerpo),
      signal: AbortSignal.timeout(TIEMPO_MAXIMO_MS),
    });

    const textoCrudo = await respuestaHttp.text();
    let respuesta: { code?: string | number; message?: string; data?: { movs?: MovimientoBdv[] } };
    try {
      respuesta = JSON.parse(textoCrudo);
    } catch {
      return {
        ok: false,
        mensaje: "El Banco de Venezuela devolvió una respuesta ilegible.",
        detalle: textoCrudo.slice(0, 300),
        esTimeout: false,
      };
    }

    // El banco devuelve el code como texto ("1000") en esta API y como número en getMovement
    if (String(respuesta?.code) !== "1000") {
      return {
        ok: false,
        mensaje: "El Banco de Venezuela no pudo entregar los movimientos del día. Inténtalo de nuevo en unos segundos.",
        detalle: `${clave}: code ${respuesta?.code}: ${respuesta?.message}`,
        esTimeout: false,
      };
    }

    const movimientos = respuesta.data?.movs ?? [];
    console.log(`🏦 [BDV/${clave}] ${movimientos.length} movimientos recibidos del ${fecha}.`);
    return { ok: true, movimientos };
  } catch (error) {
    const detalle = `${clave}: ${detalleDeErrorRed(error)}`;
    console.error(`❌ [BDV/${clave}] No se pudo contactar al banco: ${detalle}`);
    const esTimeout = error instanceof Error && error.name === "TimeoutError";
    return {
      ok: false,
      mensaje: esTimeout
        ? "El Banco de Venezuela tardó demasiado en responder. Inténtalo de nuevo en unos segundos."
        : "No se pudo conectar con el Banco de Venezuela. Inténtalo de nuevo en unos segundos.",
      detalle,
      esTimeout,
    };
  }
}

// Confirmado en producción (08/09/2026): ambas cuentas fallaron a la vez con
// ConnectTimeoutError contra las IPs YA resueltas del banco (200.11.243.178,
// 190.202.148.190) — no fue un problema de DNS ni del puente (BDV no usa uno, se llama
// directo), sino un corte breve para completar el TCP handshake. Mismo tipo de blip que ya
// se resolvía con reintentos en sofitasa.ts; un intento fallido rápido es barato de repetir.
// Un timeout SÍ agota los 30s completos primero: reintentarlo encima le suma minutos de
// espera al cajero sin necesidad, así que ahí se corta de una vez (misma regla que Sofitasa).
const INTENTOS_MAXIMOS_BDV = 3;
const ESPERA_ENTRE_INTENTOS_BDV_MS = 300;

/**
 * Descarga los movimientos de la cuenta para UN día concreto.
 * No lanza: los fallos vuelven como resultado para que el llamador decida el HTTP.
 */
export async function descargarMovimientosDelDia(
  fechaIso: string,
  credenciales: CredencialesBdv
): Promise<{ ok: true; movimientos: MovimientoBdv[] } | { ok: false; mensaje: string; detalle: string }> {
  let ultimoIntento = await intentarDescargarMovimientosDelDia(fechaIso, credenciales);
  for (let intento = 2; intento <= INTENTOS_MAXIMOS_BDV; intento++) {
    // '=== false' y no '!ultimoIntento.ok': el proyecto compila con strict desactivado, y
    // ahí TypeScript solo estrecha la unión discriminada con una comparación explícita
    // (mismo motivo documentado en el resto del archivo).
    if (ultimoIntento.ok === true) return ultimoIntento;
    if (ultimoIntento.esTimeout) return ultimoIntento;

    console.warn(`⚠️ [BDV] Reintentando ${credenciales.clave} (intento ${intento}/${INTENTOS_MAXIMOS_BDV})...`);
    await new Promise((resolver) => setTimeout(resolver, ESPERA_ENTRE_INTENTOS_BDV_MS));
    ultimoIntento = await intentarDescargarMovimientosDelDia(fechaIso, credenciales);
  }
  return ultimoIntento;
}

/**
 * Busca un pago concreto entre los movimientos del día y confirma que el dinero entró.
 *
 * @param referencia Referencia del comprobante (se compara por sus últimos 8 dígitos)
 * @param importe    Monto del comprobante; debe coincidir exactamente con el del banco
 * @param fechaIso   Fecha del pago en AAAA-MM-DD
 * @param credenciales Cuenta del negocio contra la que se concilia (depende de la sucursal)
 */
export async function buscarPagoEnMovimientos(
  referencia: string,
  importe: number,
  fechaIso: string,
  credenciales: CredencialesBdv
): Promise<ResultadoBusqueda> {
  // La longitud del cruce la fija la referencia del comprobante, no el extracto: es la
  // corta de las dos, y comparar más dígitos de los que el cliente enseña no casaría nunca.
  //
  // Si la referencia tiene MENOS de DIGITOS_REFERENCIA_MIN dígitos significativos, 'sufijo'
  // queda en null y el cruce por referencia se salta —comparar tan pocos dígitos arriesgaría
  // confundir dos pagos distintos, el mismo riesgo que ya obligó a fijar ese mínimo—, pero
  // NO se rechaza la búsqueda entera: cae directo al respaldo por monto de más abajo, igual
  // que cuando la referencia SÍ mide lo suficiente pero no coincide con ninguna del día. Es
  // el mismo candidato-con-confirmación-del-cajero, solo que sin haber intentado primero un
  // cruce que no era seguro hacer.
  //
  // Caso real: BBVA Provincial imprimió "000012100" (dígitos significativos: "12100", 5) —
  // más corto que cualquier referencia medida hasta ahora, pero perfectamente real: cuatro
  // lecturas de IA de dos proveedores distintos coincidieron dígito a dígito.
  const largo = digitosAComparar(referencia);
  const sufijo = largo > 0 ? sufijoReferencia(limpiarReferencia(referencia), largo) : null;

  // '=== false' y no '!descarga.ok': el proyecto compila con strict desactivado, y ahí
  // TypeScript solo estrecha la unión discriminada con una comparación explícita. Es la
  // misma forma que usan las validaciones de las rutas existentes.
  const descarga = await descargarMovimientosDelDia(fechaIso, credenciales);
  if (descarga.ok === false) {
    return { estado: "SIN_RESPUESTA", mensaje: descarga.mensaje, detalle: descarga.detalle };
  }

  // ⚠️ Solo CRÉDITO, y esto no es un detalle menor: el banco cobra una comisión por cada
  // pago móvil recibido y la registra como un DÉBITO que comparte los últimos 8 dígitos de
  // la referencia con el pago. Medido sobre datos reales, 392 de 421 créditos tienen un
  // débito gemelo. Sin este filtro, casi todo pago cruzaría contra su propia comisión y el
  // cajero recibiría un rechazo por monto que no tendría ningún sentido.
  const creditos = descarga.movimientos.filter((m) => String(m.mov ?? "").trim().toUpperCase() === "CREDITO");

  let referenciaConOtroMonto: { movimiento: MovimientoBdv; montoBanco: number } | null = null;

  // Sin 'sufijo' no hay nada seguro que comparar: se salta directo al respaldo por monto.
  if (sufijo) {
    for (const movimiento of creditos) {
      // La referencia del extracto se recorta a la MISMA longitud que la del comprobante:
      // es lo que descarta el prefijo interno con el que el banco la publica concatenada.
      if (sufijoReferencia(movimiento.referencia, largo) !== sufijo) continue;

      const montoBanco = importeANumero(movimiento.importe);
      // Se comparan céntimos enteros: dos flotantes que representan el mismo monto pueden
      // diferir en el último bit, y 36960.41 !== 36960.410000000004 rechazaría un pago bueno.
      if (montoBanco !== null && Math.round(montoBanco * 100) === Math.round(importe * 100)) {
        return {
          estado: "ENCONTRADO",
          movimiento,
          pagador: extraerDatosPagador(movimiento.observacion),
          movimientosRevisados: descarga.movimientos.length,
        };
      }

      // La referencia existe pero por otro monto. Se guarda y se sigue buscando, por si hay
      // más de un crédito con ese sufijo; solo se reporta si ninguno llega a coincidir.
      if (montoBanco !== null && !referenciaConOtroMonto) {
        referenciaConOtroMonto = { movimiento, montoBanco };
      }
    }
  }

  if (referenciaConOtroMonto) {
    const { montoBanco } = referenciaConOtroMonto;
    return {
      estado: "MONTO_DISTINTO",
      mensaje: `❌ La referencia ${sufijo} sí existe, pero el banco la registró por Bs. ${montoBanco.toFixed(2)} y no por Bs. ${importe.toFixed(2)}. Verifica el monto del comprobante.`,
      montoBanco: montoBanco.toFixed(2),
      movimiento: referenciaConOtroMonto.movimiento,
    };
  }

  // Sin coincidencia por referencia, se busca por monto exacto antes de rendirse. El banco
  // repite a veces la misma fila del extracto (visto en producción: dos filas idénticas con
  // nroMov 81131 y 81132), así que se deduplica por referencia para no ofrecerle al cajero
  // el mismo pago dos veces como si fueran dos.
  const porMonto = [
    ...new Map(
      creditos
        .filter((m) => {
          const montoBanco = importeANumero(m.importe);
          return montoBanco !== null && Math.round(montoBanco * 100) === Math.round(importe * 100);
        })
        .map((m) => [m.referencia, m])
    ).values(),
  ];

  if (porMonto.length > 0) {
    return {
      estado: "CANDIDATOS_POR_MONTO",
      candidatos: porMonto.map((movimiento) => ({ movimiento, pagador: extraerDatosPagador(movimiento.observacion) })),
    };
  }

  return {
    estado: "NO_ENCONTRADO",
    mensaje: sufijo
      ? `El banco no registra ningún pago recibido con la referencia ${sufijo} ni por Bs. ${importe.toFixed(2)} el ${fechaIso}. Verifica la referencia, el monto y la fecha del comprobante.`
      : `El banco no registra ningún pago por Bs. ${importe.toFixed(2)} el ${fechaIso}. La referencia "${referencia}" es demasiado corta para cruzarla directamente (hacen falta ${DIGITOS_REFERENCIA_MIN} dígitos significativos); verifica el monto y la fecha del comprobante.`,
    movimientosRevisados: descarga.movimientos.length,
  };
}

/**
 * Localiza un movimiento por la referencia EXACTA del extracto, que es la que el cajero
 * confirma tras elegir entre los candidatos. Se vuelve a consultar al banco a propósito:
 * el cliente podría enviar cualquier referencia en el segundo paso, así que el pago se
 * comprueba de nuevo contra el extracto en vez de fiarse de lo que llega en la petición.
 */
export async function confirmarMovimientoDelExtracto(
  referenciaBanco: string,
  importe: number,
  fechaIso: string,
  credenciales: CredencialesBdv
): Promise<ResultadoBusqueda> {
  const descarga = await descargarMovimientosDelDia(fechaIso, credenciales);
  if (descarga.ok === false) {
    return { estado: "SIN_RESPUESTA", mensaje: descarga.mensaje, detalle: descarga.detalle };
  }

  const movimiento = descarga.movimientos.find(
    (m) =>
      String(m.mov ?? "").trim().toUpperCase() === "CREDITO" &&
      m.referencia === referenciaBanco &&
      Math.round((importeANumero(m.importe) ?? -1) * 100) === Math.round(importe * 100)
  );

  if (!movimiento) {
    return {
      estado: "NO_ENCONTRADO",
      mensaje: "El pago que confirmaste ya no coincide con el extracto del banco. Vuelve a escanear el comprobante.",
      movimientosRevisados: descarga.movimientos.length,
    };
  }

  return {
    estado: "ENCONTRADO",
    movimiento,
    pagador: extraerDatosPagador(movimiento.observacion),
    movimientosRevisados: descarga.movimientos.length,
  };
}

// Elige el movimiento más reciente de un día por 'nroMov' (el correlativo que asigna el
// banco), NO por la posición en el arreglo: la API no documenta en qué orden entrega los
// movimientos, así que confiar en movs[0] sería una suposición sin respaldo.
export function movimientoMasReciente(movimientos: MovimientoBdv[]): MovimientoBdv | null {
  if (movimientos.length === 0) return null;
  return movimientos.reduce((masReciente, actual) => {
    const nroActual = Number.parseInt(actual.nroMov || "", 10);
    const nroMasReciente = Number.parseInt(masReciente.nroMov || "", 10);
    if (!Number.isFinite(nroActual)) return masReciente;
    if (!Number.isFinite(nroMasReciente)) return actual;
    return nroActual > nroMasReciente ? actual : masReciente;
  });
}

export interface SaldoBdv {
  saldo: number;
  fecha: string;        // AAAA-MM-DD del día consultado que sí tenía movimientos
  hora: string | null;
  nroMov: string | null;
}

export type ResultadoSaldoBdv =
  | { estado: "OK"; datos: SaldoBdv }
  | { estado: "SIN_RESPUESTA"; mensaje: string; detalle: string };

// Hasta cuántos días atrás se busca el último movimiento antes de rendirse. Una cuenta con
// más de 10 días sin ningún movimiento (ni una comisión) sería en sí misma una señal de
// alarma, no solo un problema de esta consulta.
const DIAS_MAXIMO_BUSQUEDA_SALDO = 10;

/**
 * Saldo actual de la cuenta, derivado del último movimiento registrado — BDV no tiene un
 * endpoint de saldo dedicado (a diferencia de Sofitasa/Balance Consult), así que se lee de
 * la columna 'saldo' del movimiento más reciente del extracto.
 *
 * Consulta UN día a la vez, empezando por hoy y retrocediendo si ese día todavía no tiene
 * movimientos: el manual de BDV prohíbe mezclar el día en curso con días cerrados en un
 * mismo rango (misma restricción que ya resuelve descargarMovimientosDelDia para la
 * conciliación de pagos), así que nunca se pide un rango de varios días de una vez.
 */
export async function ultimoSaldoBdv(credenciales: CredencialesBdv): Promise<ResultadoSaldoBdv> {
  for (let diasAtras = 0; diasAtras < DIAS_MAXIMO_BUSQUEDA_SALDO; diasAtras++) {
    const fechaIso = new Date(Date.now() - diasAtras * 86_400_000).toISOString().slice(0, 10);

    const descarga = await descargarMovimientosDelDia(fechaIso, credenciales);
    // '=== false' y no '!descarga.ok': mismo motivo que en el resto del archivo (proyecto
    // compilado sin strict).
    if (descarga.ok === false) {
      return { estado: "SIN_RESPUESTA", mensaje: descarga.mensaje, detalle: descarga.detalle };
    }

    const masReciente = movimientoMasReciente(descarga.movimientos);
    if (masReciente) {
      return {
        estado: "OK",
        datos: {
          saldo: importeANumero(masReciente.saldo) ?? 0,
          fecha: fechaIso,
          hora: masReciente.hora ?? null,
          nroMov: masReciente.nroMov,
        },
      };
    }
  }

  return {
    estado: "SIN_RESPUESTA",
    mensaje: `La cuenta no registra ningún movimiento en los últimos ${DIAS_MAXIMO_BUSQUEDA_SALDO} días.`,
    detalle: `clave=${credenciales.clave}`,
  };
}
