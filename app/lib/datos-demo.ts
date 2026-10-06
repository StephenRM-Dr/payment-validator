// Datos de ejemplo para el panel admin cuando no hay DATABASE_URL configurada (clon
// nuevo de este repo sanitizado, o despliegue de portfolio sin base de datos real).
// En vez de que /admin tire error de conexión apenas se entra, muestra una grilla fija
// con forma idéntica a la real (mismos filtros, misma edición en memoria) para que se
// pueda ver y probar la interfaz sin provisionar Postgres.
//
// `DATOS_DEMO` es `let` (no `const`) a propósito: editarDemo() la muta in-memory para
// que "guardar número de venta" / "anular" se sientan reales durante la sesión del
// servidor. Se pierde al reiniciar — es una demo, no una base de datos.

export function estaEnModoDemo(): boolean {
  return !process.env.DATABASE_URL;
}

export interface TransaccionDemo {
  id: number;
  id_orden: string | null;
  comanda: string | null;
  nota: string | null;
  anulada: boolean;
  monto: string;
  moneda: string;
  binance_id_completo: string | null;
  txid: string | null;
  pagador: string | null;
  estado: string;
  ciudad: string | null;
  proveedor: string;
  referencia: string | null;
  banco_origen: string | null;
  fecha_pago: string | null;
  created_at: string;
  tiene_comprobante: boolean;
}

function hace(horas: number): string {
  return new Date(Date.now() - horas * 3600_000).toISOString();
}

// Nombres y cédulas genéricos, sin relación con personas reales — mismo criterio que
// .env.example para las credenciales: valores de relleno, nunca datos de un negocio real.
const DATOS_FIJOS: Omit<TransaccionDemo, "tiene_comprobante">[] = [
  { id: 1, proveedor: "BINANCE", moneda: "USDT", monto: "125.50", estado: "VERIFICADO", anulada: false, ciudad: "Caracas", comanda: "4821", nota: null, id_orden: "20385712", binance_id_completo: "P_20385712AB91", txid: null, pagador: "María Pérez", referencia: null, banco_origen: null, fecha_pago: hace(2), created_at: hace(2) },
  { id: 2, proveedor: "BDV", moneda: "VES", monto: "890.00", estado: "VERIFICADO", anulada: false, ciudad: "Caracas", comanda: "4822", nota: null, id_orden: null, binance_id_completo: null, txid: null, pagador: "Carlos Rodríguez", referencia: "003841209", banco_origen: "0134", fecha_pago: hace(3), created_at: hace(3) },
  { id: 3, proveedor: "BINANCE", moneda: "USDT", monto: "40.00", estado: "PENDIENTE", anulada: false, ciudad: null, comanda: null, nota: null, id_orden: "20385801", binance_id_completo: "P_20385801CJ04", txid: null, pagador: null, referencia: null, banco_origen: null, fecha_pago: hace(1), created_at: hace(1) },
  { id: 4, proveedor: "SOFITASA", moneda: "VES", monto: "412.30", estado: "VERIFICADO", anulada: false, ciudad: "Merida", comanda: "4819", nota: null, id_orden: null, binance_id_completo: null, txid: null, pagador: "Ana González", referencia: "772104", banco_origen: "0105", fecha_pago: hace(5), created_at: hace(5) },
  { id: 5, proveedor: "BANCAMIGA", moneda: "VES", monto: "1250.00", estado: "VERIFICADO", anulada: false, ciudad: "Valencia", comanda: "4817", nota: null, id_orden: null, binance_id_completo: null, txid: null, pagador: "Luis Martínez", referencia: "551023887", banco_origen: "0108", fecha_pago: hace(6), created_at: hace(6) },
  { id: 6, proveedor: "BINANCE", moneda: "USDT", monto: "88.75", estado: "VERIFICADO", anulada: false, ciudad: "Maracaibo", comanda: "4815", nota: null, id_orden: "20385690", binance_id_completo: "P_20385690FQ22", txid: null, pagador: "Daniela Torres", referencia: null, banco_origen: null, fecha_pago: hace(8), created_at: hace(8) },
  { id: 7, proveedor: "BDV", moneda: "VES", monto: "150.00", estado: "VERIFICADO", anulada: true, ciudad: "Caracas", comanda: "4810", nota: "Devolución por cancelación del cliente.", id_orden: null, binance_id_completo: null, txid: null, pagador: "Pedro Ramírez", referencia: "003839951", banco_origen: "0172", fecha_pago: hace(12), created_at: hace(12) },
  { id: 8, proveedor: "BINANCE", moneda: "USDT", monto: "210.00", estado: "VERIFICADO", anulada: false, ciudad: "Barinas", comanda: "4808", nota: null, id_orden: "20385601", binance_id_completo: "P_20385601XM88", txid: null, pagador: "Valentina Silva", referencia: null, banco_origen: null, fecha_pago: hace(14), created_at: hace(14) },
  { id: 9, proveedor: "SOFITASA", moneda: "VES", monto: "67.00", estado: "VERIFICADO", anulada: false, ciudad: "San Cristobal", comanda: "4805", nota: null, id_orden: null, binance_id_completo: null, txid: null, pagador: "Jorge Fernández", referencia: "772098", banco_origen: "0134", fecha_pago: hace(16), created_at: hace(16) },
  { id: 10, proveedor: "BINANCE", moneda: "USDT", monto: "15.20", estado: "PENDIENTE", anulada: false, ciudad: null, comanda: null, nota: null, id_orden: "20385622", binance_id_completo: "P_20385622LK05", txid: null, pagador: null, referencia: null, banco_origen: null, fecha_pago: hace(10), created_at: hace(10) },
  { id: 11, proveedor: "BANCAMIGA", moneda: "VES", monto: "980.40", estado: "VERIFICADO", anulada: false, ciudad: "Concordia", comanda: "4803", nota: null, id_orden: null, binance_id_completo: null, txid: null, pagador: "Isabel Castro", referencia: "551019034", banco_origen: "0108", fecha_pago: hace(20), created_at: hace(20) },
  { id: 12, proveedor: "BINANCE", moneda: "USDT", monto: "56.00", estado: "VERIFICADO", anulada: false, ciudad: "Caracas", comanda: "4799", nota: "Cliente pidió factura aparte.", id_orden: "20385512", binance_id_completo: "P_20385512RT71", txid: null, pagador: "Andrés Blanco", referencia: null, banco_origen: null, fecha_pago: hace(24), created_at: hace(24) },
  { id: 13, proveedor: "BDV", moneda: "VES", monto: "320.00", estado: "VERIFICADO", anulada: false, ciudad: "Valencia", comanda: "4796", nota: null, id_orden: null, binance_id_completo: null, txid: null, pagador: "Camila Herrera", referencia: "003828817", banco_origen: "0105", fecha_pago: hace(30), created_at: hace(30) },
  { id: 14, proveedor: "BINANCE", moneda: "USDT", monto: "132.90", estado: "VERIFICADO", anulada: false, ciudad: "Merida", comanda: "4793", nota: null, id_orden: "20385488", binance_id_completo: "P_20385488WZ39", txid: null, pagador: "Gabriel Ortiz", referencia: null, banco_origen: null, fecha_pago: hace(36), created_at: hace(36) },
  { id: 15, proveedor: "SOFITASA", moneda: "VES", monto: "45.00", estado: "VERIFICADO", anulada: true, ciudad: "Maracaibo", comanda: "4790", nota: "Pago duplicado por el cliente; se reversó el segundo.", id_orden: null, binance_id_completo: null, txid: null, pagador: "Verónica Díaz", referencia: "771982", banco_origen: "0137", fecha_pago: hace(40), created_at: hace(40) },
  { id: 16, proveedor: "BANCAMIGA", moneda: "VES", monto: "1890.00", estado: "VERIFICADO", anulada: false, ciudad: "Barinas", comanda: "4788", nota: null, id_orden: null, binance_id_completo: null, txid: null, pagador: "Ricardo Gómez", referencia: "550998211", banco_origen: "0134", fecha_pago: hace(48), created_at: hace(48) },
  { id: 17, proveedor: "BINANCE", moneda: "USDT", monto: "72.30", estado: "VERIFICADO", anulada: false, ciudad: "San Cristobal", comanda: "4785", nota: null, id_orden: "20385390", binance_id_completo: "P_20385390QD14", txid: null, pagador: "Sofía Morales", referencia: null, banco_origen: null, fecha_pago: hace(52), created_at: hace(52) },
  { id: 18, proveedor: "BDV", moneda: "VES", monto: "500.00", estado: "VERIFICADO", anulada: false, ciudad: "Concordia", comanda: "4782", nota: null, id_orden: null, binance_id_completo: null, txid: null, pagador: "Diego Navarro", referencia: "003815543", banco_origen: "0108", fecha_pago: hace(60), created_at: hace(60) },
  { id: 19, proveedor: "BINANCE", moneda: "USDT", monto: "19.99", estado: "VERIFICADO", anulada: false, ciudad: "Caracas", comanda: "4779", nota: null, id_orden: "20385301", binance_id_completo: "P_20385301HN60", txid: null, pagador: "Natalia Suárez", referencia: null, banco_origen: null, fecha_pago: hace(68), created_at: hace(68) },
  { id: 20, proveedor: "SOFITASA", moneda: "VES", monto: "275.00", estado: "VERIFICADO", anulada: false, ciudad: "Valencia", comanda: "4776", nota: null, id_orden: null, binance_id_completo: null, txid: null, pagador: "Fernando Castillo", referencia: "771855", banco_origen: "0134", fecha_pago: hace(76), created_at: hace(76) },
  { id: 21, proveedor: "BANCAMIGA", moneda: "VES", monto: "640.00", estado: "VERIFICADO", anulada: false, ciudad: "Merida", comanda: "4773", nota: null, id_orden: null, binance_id_completo: null, txid: null, pagador: "Patricia Vargas", referencia: "550987120", banco_origen: "0105", fecha_pago: hace(84), created_at: hace(84) },
  { id: 22, proveedor: "BINANCE", moneda: "USDT", monto: "300.00", estado: "VERIFICADO", anulada: false, ciudad: "Maracaibo", comanda: "4770", nota: null, id_orden: "20385190", binance_id_completo: "P_20385190BX82", txid: null, pagador: "Hugo Ramos", referencia: null, banco_origen: null, fecha_pago: hace(96), created_at: hace(96) },
  { id: 23, proveedor: "BDV", moneda: "VES", monto: "95.50", estado: "VERIFICADO", anulada: false, ciudad: "Barinas", comanda: "4768", nota: null, id_orden: null, binance_id_completo: null, txid: null, pagador: "Lucía Mendoza", referencia: "003802290", banco_origen: "0172", fecha_pago: hace(110), created_at: hace(110) },
  { id: 24, proveedor: "BINANCE", moneda: "USDT", monto: "47.80", estado: "PENDIENTE", anulada: false, ciudad: null, comanda: null, nota: null, id_orden: "20385850", binance_id_completo: "P_20385850ZT17", txid: null, pagador: null, referencia: null, banco_origen: null, fecha_pago: hace(0.5), created_at: hace(0.5) },
];

// `tiene_comprobante` siempre false: no hay fotos reales que servir en modo demo, así
// que el botón "Ver comprobante" del panel queda oculto (ver admin/page.tsx) y no hace
// falta simular también /api/admin/transacciones/[id]/imagen.
export let DATOS_DEMO: TransaccionDemo[] = DATOS_FIJOS.map((t) => ({ ...t, tiene_comprobante: false }));

export interface FiltrosAuditoria {
  page: number;
  limit: number;
  offset: number;
  fechaInicio: string;
  fechaFin: string;
  sucursal: string;
  estado: string;
  proveedor: string;
  comanda: string;
  monto: string;
  referencia: string;
  exportarTodo: boolean;
}

// Mismas reglas que construirClausulaWhere() en app/api/admin/auditoria/route.ts, pero
// aplicadas en memoria en vez de en SQL.
function filtrarDemo(filtros: FiltrosAuditoria): TransaccionDemo[] {
  return DATOS_DEMO.filter((t) => {
    const base = t.fecha_pago ?? t.created_at;

    if (filtros.fechaInicio && new Date(base) < new Date(`${filtros.fechaInicio}T00:00:00.000Z`)) return false;
    if (filtros.fechaFin) {
      const limite = new Date(`${filtros.fechaFin}T00:00:00.000Z`);
      limite.setUTCDate(limite.getUTCDate() + 1);
      if (new Date(base) >= limite) return false;
    }

    if (filtros.sucursal === "SIN_ASIGNAR") {
      if (t.ciudad !== null) return false;
    } else if (filtros.sucursal && (t.ciudad || "").toUpperCase() !== filtros.sucursal) {
      return false;
    }

    if (filtros.estado && t.estado !== filtros.estado) return false;
    if (filtros.proveedor && t.proveedor !== filtros.proveedor) return false;

    if (filtros.comanda && !(t.comanda || "").toLowerCase().includes(filtros.comanda.toLowerCase())) return false;

    if (filtros.monto) {
      const montoBuscado = /^\d+([.,]\d+)?$/.test(filtros.monto) ? Number.parseFloat(filtros.monto.replace(",", ".")) : null;
      if (montoBuscado === null || Number.parseFloat(t.monto) !== montoBuscado) return false;
    }

    if (filtros.referencia) {
      const patron = filtros.referencia.toLowerCase();
      const coincide = [t.id_orden, t.binance_id_completo, t.txid, t.referencia].some((campo) => (campo || "").toLowerCase().includes(patron));
      if (!coincide) return false;
    }

    return true;
  }).sort((a, b) => new Date(b.fecha_pago ?? b.created_at).getTime() - new Date(a.fecha_pago ?? a.created_at).getTime());
}

function calcularMetricasDemo(filas: TransaccionDemo[]) {
  let totalReclamadoUSDT = 0, totalPendienteUSDT = 0, totalAnuladoUSDT = 0;
  let totalReclamadoVES = 0, totalPendienteVES = 0, totalAnuladoVES = 0;
  let registrosPagoMovil = 0, registrosAnulados = 0;

  for (const t of filas) {
    const monto = Number.parseFloat(t.monto) || 0;
    if (t.moneda === "VES") registrosPagoMovil++;

    if (t.anulada) {
      registrosAnulados++;
      if (t.moneda === "USDT") totalAnuladoUSDT += monto;
      if (t.moneda === "VES") totalAnuladoVES += monto;
      continue;
    }
    if (t.estado === "VERIFICADO") {
      if (t.moneda === "USDT") totalReclamadoUSDT += monto;
      if (t.moneda === "VES") totalReclamadoVES += monto;
    } else if (t.estado === "PENDIENTE") {
      if (t.moneda === "USDT") totalPendienteUSDT += monto;
      if (t.moneda === "VES") totalPendienteVES += monto;
    }
  }

  return {
    totalReclamadoUSDT, totalPendienteUSDT, totalAnuladoUSDT,
    totalDineroFlujoUSDT: totalReclamadoUSDT + totalPendienteUSDT,
    totalReclamadoVES, totalPendienteVES, totalAnuladoVES,
    totalDineroFlujoVES: totalReclamadoVES + totalPendienteVES,
    registrosPagoMovil, registrosAnulados,
  };
}

// Respuesta completa de GET /api/admin/auditoria en modo demo, con la misma forma que
// la ruta real (transacciones + metricas + paginacion) más `modoDemo: true` para que el
// panel pueda avisar que está mostrando datos de ejemplo.
export function obtenerAuditoriaDemo(filtros: FiltrosAuditoria) {
  const filtradas = filtrarDemo(filtros);
  const metricas = calcularMetricasDemo(filtradas);
  const totalPages = Math.max(1, Math.ceil(filtradas.length / filtros.limit));

  const transacciones = filtros.exportarTodo
    ? filtradas.map(({ tiene_comprobante: _tc, ...resto }) => resto)
    : filtradas.slice(filtros.offset, filtros.offset + filtros.limit);

  return {
    modoDemo: true,
    transacciones,
    metricas,
    paginacion: {
      page: filtros.page,
      limit: filtros.limit,
      totalPages,
      totalTransaccionesGlobales: filtradas.length,
    },
  };
}

export interface CamposEdicionDemo {
  tieneComanda: boolean;
  tieneNota: boolean;
  tieneAnulada: boolean;
  comanda?: string;
  nota?: string | null;
  anulada?: boolean;
}

export type ResultadoEdicionDemo =
  | { ok: true; transaccion: Pick<TransaccionDemo, "id" | "comanda" | "nota" | "anulada"> }
  | { ok: false; status: number; error: string };

// Mismas reglas de negocio que PATCH /api/admin/transacciones/[id]/route.ts, aplicadas
// sobre el array en memoria. La edición es real dentro de la sesión del servidor (se ve
// reflejada en el próximo fetch), pero se pierde al reiniciar — coherente con ser una demo.
export function editarDemo(id: number, campos: CamposEdicionDemo): ResultadoEdicionDemo {
  const fila = DATOS_DEMO.find((t) => t.id === id);
  if (!fila) return { ok: false, status: 404, error: "No existe una transacción con ese ID." };

  if (campos.tieneComanda && !fila.ciudad) {
    return {
      ok: false,
      status: 409,
      error: "⚠️ Esta transacción aún no ha sido reclamada por ningún cajero: no se le puede asignar un número de venta desde aquí.",
    };
  }

  if (campos.anulada === true) {
    const notaFinal = campos.tieneNota ? campos.nota : fila.nota;
    if (!notaFinal) {
      return {
        ok: false,
        status: 400,
        error: "⚠️ Para anular una transacción debes explicar el motivo en la nota (ej: devolución por cancelación del cliente).",
      };
    }
  }

  if (campos.tieneComanda) fila.comanda = campos.comanda ?? null;
  if (campos.tieneNota) fila.nota = campos.nota ?? null;
  if (campos.tieneAnulada) fila.anulada = campos.anulada ?? false;

  return { ok: true, transaccion: { id: fila.id, comanda: fila.comanda, nota: fila.nota, anulada: fila.anulada } };
}
