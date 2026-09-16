"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { descargarBlob } from "../lib/descargas";
import { estiloBotonPagina, estiloCelda, estiloEtiquetaAdmin, estiloInputAdmin, estiloOverlayModal } from "../lib/estilos";
import { SUCURSALES, PROVEEDORES } from "../lib/sucursales";
import { nombreDeBanco } from "../lib/bancos";
import { LONGITUD_MAX_BUSQUEDA, LONGITUD_MAX_COMANDA, LONGITUD_MAX_PIN } from "../lib/validacion";

// Tipado estricto de los datos que devuelve el backend de auditoría
interface Transaccion {
  id: number;
  id_orden: string | null;        // ID de orden numérico de Binance (insertado por el worker)
  comanda: string | null;         // Número de venta interno asignado por el cajero
  nota: string | null;            // Comentario administrativo libre (ej: "se devolvió el dinero")
  anulada: boolean;               // Anulada (ej: devolución): excluida de los totales de dinero
  monto: string;
  moneda: string;
  binance_id_completo: string | null; // Referencia P_... del pago (respaldo/registros antiguos)
  estado: string;
  ciudad: string | null;
  txid: string | null;            // Referencia alfanumérica P_... del pago (transactionId de Binance)
  pagador: string | null;         // Nombre del pagador según Binance
  fecha_pago: string | null;      // Fecha real del pago según Binance (UTC)
  created_at: string;             // Hora de inserción del registro (para auditar retraso de detección)
  tiene_comprobante: boolean;     // La foto en sí NO viaja aquí; se trae bajo demanda al pulsar "Ver"
  // Multiproveedor: 'BINANCE', 'BDV', 'SOFITASA' o 'BANCAMIGA'. Los tres campos
  // siguientes solo traen valor en los pagos móviles (los tres últimos proveedores).
  proveedor: string;
  referencia: string | null;      // Referencia del pago móvil, tal como la registra el banco
  banco_origen: string | null;    // Código BCV de 4 dígitos del banco emisor
}

interface Metricas {
  totalReclamadoUSDT: number;
  totalPendienteUSDT: number;
  totalDineroFlujoUSDT: number;
  totalAnuladoUSDT: number;
  // Bolívares de los tres proveedores de pago móvil (BDV/Sofitasa/Bancamiga). Van aparte y
  // nunca se suman con los USDT: mezclar ambas monedas en una sola cifra no representaría
  // ninguna cantidad real de dinero.
  totalReclamadoVES: number;
  totalPendienteVES: number;
  totalDineroFlujoVES: number;
  totalAnuladoVES: number;
  registrosPagoMovil: number;
  registrosAnulados: number;
}

const METRICAS_INICIALES: Metricas = {
  totalReclamadoUSDT: 0,
  totalPendienteUSDT: 0,
  totalDineroFlujoUSDT: 0,
  totalAnuladoUSDT: 0,
  totalReclamadoVES: 0,
  totalPendienteVES: 0,
  totalDineroFlujoVES: 0,
  totalAnuladoVES: 0,
  registrosPagoMovil: 0,
  registrosAnulados: 0,
};

// Presentación por proveedor (insignia "Vía", filtro y exportación CSV) en un solo lugar en
// vez de comparaciones sueltas contra "BDV": con cuatro proveedores, repetir
// 't.proveedor === "BDV" ? X : Y' en cada sitio deja a los tres nuevos (Sofitasa, Bancamiga,
// y cualquier otro que se agregue) mostrándose todos como "Binance" por el valor por
// defecto de esas comparaciones binarias.
const ESTILO_PROVEEDOR: Record<string, { icono: string; corta: string; csv: string; fondo: string; texto: string }> = {
  BDV: { icono: "🏦", corta: "BDV", csv: "Pago Movil BDV", fondo: "rgba(249, 226, 175, 0.15)", texto: "#f9e2af" },
  SOFITASA: { icono: "🏦", corta: "Sofitasa", csv: "Pago Movil Sofitasa", fondo: "rgba(137, 180, 250, 0.15)", texto: "#89b4fa" },
  BANCAMIGA: { icono: "🏦", corta: "Bancamiga", csv: "Pago Movil Bancamiga", fondo: "rgba(166, 227, 161, 0.15)", texto: "#a6e3a1" },
  BINANCE: { icono: "🪙", corta: "Binance", csv: "Binance Pay", fondo: "rgba(203, 166, 247, 0.15)", texto: "#cba6f7" },
};
function estiloDeProveedor(proveedor: string) {
  return ESTILO_PROVEEDOR[proveedor] ?? ESTILO_PROVEEDOR.BINANCE;
}

const CLAVE_SESION_PIN = "paymentvalidator_admin_pin";

// Cada cuánto se consulta el backend en busca de transacciones nuevas (refresco automático).
// Antes en 15s: en producción el panel puede quedar abierto horas en una pestaña de fondo,
// y cada tick es la consulta de métricas+listado completa (ver la nota de "3. MÉTRICAS..."
// en app/api/admin/auditoria/route.ts). Subido a 30s -a la mitad del tráfico- y, más abajo,
// el refresco se pausa del todo mientras la pestaña está oculta (ver el useEffect de
// visibilitychange): ese es el ahorro más grande, porque una pestaña de fondo no necesita
// datos al segundo.
const INTERVALO_REFRESCO_MS = 30000;

// Una nota con saltos de línea queda dentro de comillas y Excel la abre bien, pero
// cualquier otro sistema que procese el CSV partiendo por líneas vería filas rotas.
// Se aplanan los saltos (y de paso los espacios repetidos) a un solo espacio.
function aplanarNota(nota: string | null): string {
  return (nota || "").replace(/\s+/g, " ").trim();
}

// Neutraliza inyección de fórmulas en CSV (celdas que Excel interpretaría como =, +, -, @)
function sanitizarCeldaCSV(valor: unknown): string {
  const texto = String(valor ?? "").replace(/"/g, '""');
  return /^[=+\-@]/.test(texto) ? `'${texto}` : texto;
}

// Muestra una fecha guardada en UTC en hora local de Venezuela (UTC-4).
// La base de datos guarda timestamps sin zona horaria: se les añade la Z
// para que JavaScript los interprete como UTC y no como hora local del navegador.
function formatearFechaVenezuela(fechaUtc: string | null): string {
  if (!fechaUtc) return "—";
  const iso = /Z$|[+-]\d{2}:?\d{2}$/.test(fechaUtc) ? fechaUtc : `${fechaUtc}Z`;
  return new Date(iso).toLocaleString("es-VE", { timeZone: "America/Caracas" });
}

export default function PanelAdministrativo() {
  // Autenticación por PIN (validada contra el servidor, nunca en el navegador)
  const [pin, setPin] = useState("");
  const [autenticado, setAutenticado] = useState(false);
  const [errorPin, setErrorPin] = useState("");

  // Datos de Auditoría
  const [transacciones, setTransacciones] = useState<Transaccion[]>([]);
  const [metricas, setMetricas] = useState<Metricas>(METRICAS_INICIALES);
  const [totalRegistros, setTotalRegistros] = useState(0);

  // Filtros de UI
  const [fechaInicio, setFechaInicio] = useState("");
  const [fechaFin, setFechaFin] = useState("");
  const [sucursalFiltro, setSucursalFiltro] = useState("TODAS");
  const [estadoFiltro, setEstadoFiltro] = useState("TODOS");
  const [proveedorFiltro, setProveedorFiltro] = useState("TODOS");
  const [filtroComanda, setFiltroComanda] = useState("");
  const [filtroMonto, setFiltroMonto] = useState("");
  const [filtroReferencia, setFiltroReferencia] = useState("");

  // Snapshot de los filtros realmente aplicados (se actualiza solo al pulsar "Aplicar Filtros")
  const [filtrosAplicados, setFiltrosAplicados] = useState({
    fechaInicio: "", fechaFin: "", sucursal: "TODAS", estado: "TODOS", proveedor: "TODOS",
    comanda: "", monto: "", referencia: "",
  });

  const [imagenModal, setImagenModal] = useState<string | null>(null);
  const [cargandoImagenId, setCargandoImagenId] = useState<number | null>(null);

  // Avisos dentro de la interfaz: un alert() del navegador bloquea la pantalla y desentona
  // en un panel que se usa a diario.
  const [aviso, setAviso] = useState<{ texto: string; tipo: "error" | "exito" } | null>(null);

  // El refresco automático se detiene si el servidor deja de aceptar el PIN (C2)
  const [sesionCaducada, setSesionCaducada] = useState(false);

  // Cada edición local incrementa esta marca. Una respuesta del refresco automático que
  // se haya pedido ANTES de la edición y llegue DESPUÉS se descarta, para que no repinte
  // la fila con el valor viejo (C13).
  const generacionDatos = useRef(0);

  // Comprobantes ya descargados (id → URL de objeto) y control para cancelar la petición
  // anterior cuando el administrador salta de una fila a otra.
  const comprobantesEnCache = useRef(new Map<number, string>());
  const peticionImagen = useRef<AbortController | null>(null);

  // Edición inline del número de venta (comanda)
  const [editandoComandaId, setEditandoComandaId] = useState<number | null>(null);
  const [comandaEnEdicion, setComandaEnEdicion] = useState("");
  const [guardandoComanda, setGuardandoComanda] = useState(false);

  // Modal de nota/comentario administrativo
  const [notaModalId, setNotaModalId] = useState<number | null>(null);
  const [notaEnEdicion, setNotaEnEdicion] = useState("");
  const [guardandoNota, setGuardandoNota] = useState(false);

  // Paginación y Control
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [cargando, setCargando] = useState(false);
  const [exportando, setExportando] = useState(false);

  const obtenerPinSesion = () => sessionStorage.getItem(CLAVE_SESION_PIN) || "";

  // Toda llamada al backend administrativo viaja con el PIN en la cabecera
  const fetchAdmin = (url: string, pinActivo?: string, init?: RequestInit) =>
    fetch(url, {
      ...init,
      headers: { ...init?.headers, "X-Admin-Pin": pinActivo || obtenerPinSesion() },
    });

  // Fija los filtros escritos como "aplicados" y consulta con ellos desde la página 1
  const aplicarFiltros = () => {
    const snapshot = {
      fechaInicio, fechaFin,
      sucursal: sucursalFiltro,
      estado: estadoFiltro,
      proveedor: proveedorFiltro,
      comanda: filtroComanda.trim(),
      monto: filtroMonto.trim(),
      referencia: filtroReferencia.trim(),
    };
    setFiltrosAplicados(snapshot);
    cargarDatosAuditoria(1, undefined, false, snapshot);
  };

  // Muestra un aviso en la interfaz y lo retira solo a los 6 segundos
  const mostrarAviso = useCallback((texto: string, tipo: "error" | "exito" = "error") => {
    setAviso({ texto, tipo });
    setTimeout(() => setAviso(null), 6000);
  }, []);

  // Libera las URLs de objeto de los comprobantes al salir de la página
  useEffect(() => {
    const cache = comprobantesEnCache.current;
    return () => {
      for (const url of cache.values()) URL.revokeObjectURL(url);
      cache.clear();
    };
  }, []);

  // Evita que el refresco automático dispare una consulta si la anterior aún no responde
  // (con conexión lenta las peticiones se apilarían unas sobre otras)
  const solicitudEnVuelo = useRef(false);

  const cerrarSesion = useCallback(() => {
    sessionStorage.removeItem(CLAVE_SESION_PIN);
    setAutenticado(false);
    setPin("");
    setTransacciones([]);
    setMetricas(METRICAS_INICIALES);
    setTotalRegistros(0);
    setPage(1);
  }, []);

  // Arma la query con los filtros APLICADOS (los del último "Aplicar Filtros"), no con lo
  // que el usuario tenga escrito en los inputs: antes, cambiar el texto de búsqueda y pulsar
  // "Siguiente" paginaba sobre un filtro distinto al que se estaba viendo en pantalla.
  const construirFiltros = useCallback((usar = filtrosAplicados) => {
    const params = new URLSearchParams();
    if (usar.fechaInicio) params.set("fechaInicio", usar.fechaInicio);
    if (usar.fechaFin) params.set("fechaFin", usar.fechaFin);
    if (usar.sucursal !== "TODAS") params.set("sucursal", usar.sucursal);
    if (usar.estado !== "TODOS") params.set("estado", usar.estado);
    if (usar.proveedor !== "TODOS") params.set("proveedor", usar.proveedor);
    if (usar.comanda) params.set("comanda", usar.comanda);
    if (usar.monto) params.set("monto", usar.monto);
    if (usar.referencia) params.set("referencia", usar.referencia);
    return params;
  }, [filtrosAplicados]);

  // Cargar datos desde el Backend Único de Auditoría.
  // En modo silencioso (refresco automático) no se enciende el indicador de carga,
  // para que la tabla no parpadee mientras el usuario la está leyendo.
  const cargarDatosAuditoria = useCallback(async (numeroPagina = 1, pinActivo?: string, silencioso = false, filtrosUsar?: typeof filtrosAplicados) => {
    const pinEnvio = pinActivo || obtenerPinSesion();
    if (!pinEnvio) return false;

    solicitudEnVuelo.current = true;
    const generacionAlPedir = generacionDatos.current;
    if (!silencioso) setCargando(true);
    try {
      const queryParams = construirFiltros(filtrosUsar);
      queryParams.set("page", numeroPagina.toString());
      queryParams.set("limit", "20");

      const res = await fetchAdmin(`/api/admin/auditoria?${queryParams.toString()}`, pinEnvio);
      const data = await res.json();

      if (res.ok) {
        // Si mientras viajaba esta respuesta el usuario editó algo, se descartan los datos
        // viejos: pintarlos revertiría visualmente la edición hasta el siguiente ciclo.
        if (silencioso && generacionAlPedir !== generacionDatos.current) return true;
        setTransacciones(data.transacciones || []);
        setMetricas(data.metricas || METRICAS_INICIALES);
        setPage(data.paginacion?.page || 1);
        setTotalPages(data.paginacion?.totalPages || 1);
        setTotalRegistros(data.paginacion?.totalTransaccionesGlobales || 0);
        return true;
      }

      if (res.status === 403) {
        // En un refresco de fondo NO se cierra la sesión: hacerlo borraba la pantalla de golpe
        // y se perdía lo que el usuario estuviera escribiendo (una nota, una edición inline).
        // Se avisa y se deja que decida; el refresco automático se detiene solo (ver más abajo).
        if (silencioso) {
          setSesionCaducada(true);
          mostrarAviso("Tu sesión ya no es válida. Vuelve a ingresar el PIN para seguir actualizando.", "error");
        } else {
          cerrarSesion();
          setErrorPin("❌ PIN de administración incorrecto.");
        }
      } else if (silencioso) {
        mostrarAviso(data.error || "No se pudieron actualizar los registros.", "error");
      } else {
        setErrorPin(data.error || "Error al obtener registros de auditoría.");
      }
      return false;
    } catch (err) {
      console.error("Error de conexión:", err);
      return false;
    } finally {
      solicitudEnVuelo.current = false;
      if (!silencioso) setCargando(false);
    }
  }, [construirFiltros, cerrarSesion, mostrarAviso]);

  // 🔄 Refresco automático: consulta transacciones nuevas periódicamente conservando
  // la página y los filtros activos, sin que el usuario tenga que presionar F5.
  //
  // Se salta el tick mientras la pestaña está oculta (document.visibilityState !== "visible")
  // en vez de solo bajar la frecuencia: es común dejar el panel abierto en una pestaña de
  // fondo horas seguidas, y ese tiempo no necesita datos al segundo — nadie lo está mirando.
  // Al volver a la pestaña se dispara un refresco inmediato para no esperar hasta el
  // próximo tick del intervalo.
  useEffect(() => {
    if (!autenticado || sesionCaducada) return;

    const tick = () => {
      if (document.visibilityState === "visible" && !solicitudEnVuelo.current) {
        cargarDatosAuditoria(page, undefined, true);
      }
    };
    const temporizador = setInterval(tick, INTERVALO_REFRESCO_MS);

    const alVolverVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", alVolverVisible);

    return () => {
      clearInterval(temporizador);
      document.removeEventListener("visibilitychange", alVolverVisible);
    };
  }, [autenticado, sesionCaducada, page, cargarDatosAuditoria]);

  // Recuperar sesión guardada: el servidor decide si el PIN sigue siendo válido
  useEffect(() => {
    const pinGuardado = sessionStorage.getItem(CLAVE_SESION_PIN);
    if (!pinGuardado) return;
    cargarDatosAuditoria(1, pinGuardado).then((ok) => {
      if (ok) setAutenticado(true);
    });
    // Solo debe ejecutarse al montar la página
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Login por PIN: se envía al backend y este responde si es correcto (el PIN no vive en el código del cliente)
  const handleLoginPin = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorPin("");
    const ok = await cargarDatosAuditoria(1, pin);
    if (ok) {
      sessionStorage.setItem(CLAVE_SESION_PIN, pin);
      setAutenticado(true);
      setPin("");
    } else if (!errorPin) {
      setErrorPin("❌ PIN de administración incorrecto.");
    }
  };

  // Actualiza comanda y/o nota de una transacción vía PATCH; refleja el resultado
  // en la fila local sin esperar al próximo refresco automático.
  const actualizarTransaccion = async (id: number, cambios: { comanda?: string; nota?: string; anulada?: boolean }) => {
    // El try/catch importa: un fallo de red aquí subía como promesa rechazada y dejaba el
    // botón atascado en "Guardando..." sin ningún aviso. Ahora el llamador siempre recibe
    // un booleano y el administrador se entera de que el cambio no se guardó.
    try {
      const res = await fetchAdmin(`/api/admin/transacciones/${id}`, undefined, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cambios),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok || !data?.transaccion) {
        mostrarAviso(data?.error || "No se pudo guardar el cambio.", "error");
        return false;
      }

      generacionDatos.current += 1;
      setTransacciones((prev) => prev.map((t) => (t.id === id ? { ...t, ...data.transaccion } : t)));
      return true;
    } catch (err) {
      console.error("[Admin] Error de red al actualizar la transacción:", err);
      mostrarAviso("Error de red al guardar el cambio. Revisa la conexión e inténtalo de nuevo.", "error");
      return false;
    }
  };

  const iniciarEdicionComanda = (t: Transaccion) => {
    setEditandoComandaId(t.id);
    setComandaEnEdicion(t.comanda || "");
  };

  const guardarComanda = async (id: number) => {
    const valor = comandaEnEdicion.trim();
    if (!valor) {
      mostrarAviso("⚠️ El número de venta no puede quedar vacío.", "error");
      return;
    }
    setGuardandoComanda(true);
    const ok = await actualizarTransaccion(id, { comanda: valor });
    setGuardandoComanda(false);
    if (ok) setEditandoComandaId(null);
  };

  // Anular saca el monto de los totales (caso típico: devolución al cliente). El backend
  // exige una nota que justifique el motivo, así que si no la tiene se abre el modal de nota.
  const alternarAnulada = async (t: Transaccion) => {
    if (!t.anulada && !t.nota) {
      mostrarAviso("⚠️ Antes de anular, escribe en la nota el motivo (ej: devolución por cancelación del cliente).", "error");
      abrirNota(t);
      return;
    }
    const accion = t.anulada ? "reactivar" : "anular";
    const detalle = t.anulada
      ? "Volverá a contar en los totales de dinero."
      : "Su monto dejará de contar en los totales de dinero.";
    if (!confirm(`¿Seguro que deseas ${accion} la transacción #${t.id}?\n\n${detalle}`)) return;

    await actualizarTransaccion(t.id, { anulada: !t.anulada });
  };

  const abrirNota = (t: Transaccion) => {
    setNotaModalId(t.id);
    setNotaEnEdicion(t.nota || "");
  };

  const guardarNota = async () => {
    if (notaModalId === null) return;
    setGuardandoNota(true);
    const ok = await actualizarTransaccion(notaModalId, { nota: notaEnEdicion.trim() });
    setGuardandoNota(false);
    if (ok) setNotaModalId(null);
  };

  // Trae la foto del comprobante bajo demanda (no viaja en la lista paginada: ver
  // el comentario en la consulta del backend sobre el costo de transferencia que evita)
  const handleVerComprobante = async (id: number) => {
    // Ya descargado en esta sesión: se muestra al instante, sin volver a pedirlo
    const enCache = comprobantesEnCache.current.get(id);
    if (enCache) {
      setImagenModal(enCache);
      return;
    }

    // Dos clics rápidos en filas distintas competían entre sí y ganaba la respuesta que
    // llegara última, mostrando el comprobante equivocado. Se cancela la petición anterior.
    peticionImagen.current?.abort();
    const controlador = new AbortController();
    peticionImagen.current = controlador;

    setCargandoImagenId(id);
    try {
      const res = await fetchAdmin(`/api/admin/transacciones/${id}/imagen`, undefined, {
        signal: controlador.signal,
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        mostrarAviso(data.error || "No se pudo cargar el comprobante.", "error");
        return;
      }

      // La respuesta es la imagen binaria: se convierte en URL de objeto para el <img>
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      comprobantesEnCache.current.set(id, url);
      setImagenModal(url);
    } catch (error) {
      // Una petición cancelada por otro clic no es un fallo que deba avisarse
      if ((error as Error)?.name !== "AbortError") {
        mostrarAviso("Error de red al cargar el comprobante.", "error");
      }
    } finally {
      if (peticionImagen.current === controlador) {
        peticionImagen.current = null;
        setCargandoImagenId(null);
      }
    }
  };

  // Exportar a Excel (.CSV sanitizado, respetando todos los filtros activos)
  const handleExportarExcel = async () => {
    setExportando(true);
    try {
      // Exporta con los filtros aplicados, los mismos que se están viendo en la tabla
      const queryParams = construirFiltros();
      queryParams.set("exportar", "true");

      const res = await fetchAdmin(`/api/admin/auditoria?${queryParams.toString()}`);
      const data = await res.json();

      if (!res.ok) {
        mostrarAviso(data.error || "Error al exportar datos contables.", "error");
        return;
      }

      // 'Via de Pago' y 'Banco Emisor' se añaden al inicio y junto a la referencia porque
      // contabilidad necesita poder separar los ingresos en USDT de los ingresos en
      // bolívares: sin esas columnas, el CSV mezcla dos monedas en la misma columna Monto
      // sin ninguna forma de distinguirlas.
      const titulos = ["ID Transaccion", "Via de Pago", "Comanda_Venta", "Monto", "Moneda", "Referencia / ID Orden", "Banco Emisor", "Referencia TxID", "Pagador", "Sucursal / Ciudad", "Estado", "Fecha Pago (Venezuela)", "Nota", "Anulada"];
      const filas = (data.transacciones as Transaccion[]).map((t) =>
        // El monto va con coma decimal para que Excel en español lo reconozca como número
        [t.id, estiloDeProveedor(t.proveedor).csv, t.comanda || "Sin Comanda", String(t.monto).replace(".", ","), t.moneda, t.referencia || t.id_orden || t.binance_id_completo, t.proveedor !== "BINANCE" ? nombreDeBanco(t.banco_origen) : "", t.txid || "", t.pagador || "", t.ciudad || "No Reclamada", t.estado, formatearFechaVenezuela(t.fecha_pago || t.created_at), aplanarNota(t.nota), t.anulada ? "SI" : "NO"]
          .map((celda) => `"${sanitizarCeldaCSV(celda)}"`)
          .join(";")
      );

      // "sep=;" en la primera línea obliga a Excel a delimitar por punto y coma sin importar
      // la configuración regional de Windows (sin esto, algunos equipos abren todo en una columna).
      // El BOM UTF-8 inicial preserva los acentos, y CRLF es el salto de línea que Excel espera.
      const contenidoCsv = ["sep=;", titulos.map((tit) => `"${tit}"`).join(";"), ...filas].join("\r\n");
      const blob = new Blob(["﻿" + contenidoCsv], { type: "text/csv;charset=utf-8;" });
      descargarBlob(blob, `Reporte_Calendario_Payment Validator_${new Date().toISOString().split("T")[0]}.csv`);
    } catch {
      mostrarAviso("No se pudo descargar el archivo de auditoría.", "error");
    } finally {
      setExportando(false);
    }
  };

  // Vista de bloqueo por PIN si no está autenticado
  if (!autenticado) {
    return (
      <div style={{ display: "flex", justifyContent: "center", alignItems: "center", minHeight: "100vh", background: "#11111b", fontFamily: "sans-serif" }}>
        <form onSubmit={handleLoginPin} style={{ background: "#1e1e2e", padding: "30px", borderRadius: "12px", boxShadow: "0 4px 20px rgba(0,0,0,0.5)", width: "100%", maxWidth: "360px", textAlign: "center" }}>
          <h2 style={{ color: "#cba6f7", margin: "0 0 10px 0" }}>🔒 Área Restringida</h2>
          <p style={{ color: "#a6adc8", fontSize: "14px", marginBottom: "20px" }}>Introduce el PIN de 6 dígitos para acceder.</p>
          <input type="password" inputMode="numeric" maxLength={LONGITUD_MAX_PIN} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} placeholder="••••••" autoComplete="off" style={{ width: "100%", padding: "15px", borderRadius: "8px", background: "#313244", color: "#fff", border: "1px solid #45475a", fontSize: "24px", textAlign: "center", letterSpacing: "8px", marginBottom: "15px", boxSizing: "border-box" }} required />
          <button type="submit" disabled={cargando} style={{ width: "100%", padding: "12px", borderRadius: "8px", border: "none", background: "#cba6f7", color: "#11111b", fontWeight: "bold", fontSize: "16px", cursor: cargando ? "wait" : "pointer" }}>
            {cargando ? "Desbloqueando..." : "Ingresar al Panel"}
          </button>
          {errorPin && <p style={{ color: "#f38ba8", fontSize: "14px", fontWeight: "bold", marginTop: "15px", marginBottom: 0 }}>{errorPin}</p>}
        </form>
      </div>
    );
  }

  return (
    <div style={{ padding: "20px", background: "#11111b", minHeight: "100vh", color: "#cdd6f4", fontFamily: "sans-serif", boxSizing: "border-box" }}>

      {/* Cabecera */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "15px", marginBottom: "20px", borderBottom: "1px solid #45475a", paddingBottom: "15px" }}>
        <div>
          <h1 style={{ margin: 0, color: "#cba6f7", fontSize: "26px" }}>📊 Payment Validator - Auditoría Global</h1>
          <p style={{ margin: "5px 0 0 0", color: "#a6adc8", fontSize: "14px" }}>Filtros por rangos de fecha, sucursal, vía de pago, estado y búsqueda de referencias</p>
        </div>
        <div style={{ display: "flex", gap: "10px" }}>
          <button onClick={handleExportarExcel} disabled={exportando} style={{ padding: "10px 15px", background: "#a6e3a1", color: "#11111b", border: "none", borderRadius: "6px", fontWeight: "bold", cursor: exportando ? "not-allowed" : "pointer" }}>
            {exportando ? "📥 Exportando..." : "📥 Exportar para Excel"}
          </button>
          <button onClick={cerrarSesion} style={{ padding: "10px 15px", background: "#f38ba8", color: "#11111b", border: "none", borderRadius: "6px", fontWeight: "bold", cursor: "pointer" }}>🔒 Salir</button>
        </div>
      </div>

      {/* Avisos en la interfaz (reemplazan a los alert() del navegador) */}
      {aviso && (
        <div role="status" style={{ marginBottom: "15px", padding: "12px 16px", borderRadius: "8px", fontWeight: "bold", fontSize: "14px",
          background: aviso.tipo === "exito" ? "rgba(166,227,161,0.12)" : "rgba(243,139,168,0.12)",
          border: `1px solid ${aviso.tipo === "exito" ? "#a6e3a1" : "#f38ba8"}`,
          color: aviso.tipo === "exito" ? "#a6e3a1" : "#f38ba8" }}>
          {aviso.texto}
        </div>
      )}

      {/* La sesión dejó de ser válida durante el refresco automático: se avisa sin borrar
          la pantalla, para no perder lo que el usuario estuviera escribiendo */}
      {sesionCaducada && (
        <div style={{ marginBottom: "15px", padding: "12px 16px", borderRadius: "8px", background: "rgba(249,226,175,0.12)", border: "1px solid #f9e2af", color: "#f9e2af", display: "flex", flexWrap: "wrap", gap: "12px", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontWeight: "bold", fontSize: "14px" }}>⚠️ La actualización automática se detuvo: tu sesión ya no es válida. Los datos en pantalla pueden estar desactualizados.</span>
          <button onClick={cerrarSesion} style={{ padding: "8px 14px", background: "#f9e2af", color: "#11111b", border: "none", borderRadius: "6px", fontWeight: "bold", cursor: "pointer" }}>Reingresar el PIN</button>
        </div>
      )}

      {/* 📅 Barra de Filtros: fechas, sucursal, estado y buscador de referencias */}
      <form onSubmit={(e) => { e.preventDefault(); aplicarFiltros(); }} style={{ background: "#1e1e2e", padding: "15px", borderRadius: "8px", marginBottom: "20px", display: "flex", flexWrap: "wrap", gap: "15px", alignItems: "flex-end", border: "1px solid #45475a" }}>

        <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
          <label htmlFor="filtro-fecha-inicio" style={estiloEtiquetaAdmin}>Desde:</label>
          <input id="filtro-fecha-inicio" type="date" value={fechaInicio} onChange={(e) => setFechaInicio(e.target.value)} style={estiloInputAdmin} />
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
          <label htmlFor="filtro-fecha-fin" style={estiloEtiquetaAdmin}>Hasta:</label>
          <input id="filtro-fecha-fin" type="date" value={fechaFin} onChange={(e) => setFechaFin(e.target.value)} style={estiloInputAdmin} />
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
          <label htmlFor="filtro-sucursal" style={estiloEtiquetaAdmin}>Sucursal:</label>
          <select id="filtro-sucursal" value={sucursalFiltro} onChange={(e) => setSucursalFiltro(e.target.value)} style={estiloInputAdmin}>
            <option value="TODAS">📍 Todas las Sucursales</option>
            <option value="SIN_ASIGNAR">⏳ Crudas (Sin reclamar)</option>
            {SUCURSALES.map((s) => (
              <option key={s.valor} value={s.valor}>{s.etiqueta}</option>
            ))}
          </select>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
          <label htmlFor="filtro-proveedor" style={estiloEtiquetaAdmin}>Vía de pago:</label>
          <select id="filtro-proveedor" value={proveedorFiltro} onChange={(e) => setProveedorFiltro(e.target.value)} style={estiloInputAdmin}>
            <option value="TODOS">🌐 Todas las vías</option>
            {PROVEEDORES.map((p) => (
              <option key={p.valor} value={p.valor}>{estiloDeProveedor(p.valor).icono} {p.etiqueta}</option>
            ))}
          </select>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
          <label htmlFor="filtro-estado" style={estiloEtiquetaAdmin}>Estado:</label>
          <select id="filtro-estado" value={estadoFiltro} onChange={(e) => setEstadoFiltro(e.target.value)} style={estiloInputAdmin}>
            <option value="TODOS">🌐 Todos los estados</option>
            <option value="VERIFICADO">✅ Verificados</option>
            <option value="PENDIENTE">⏳ Pendientes</option>
          </select>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
          <label htmlFor="filtro-comanda" style={estiloEtiquetaAdmin}>Comanda:</label>
          <input
            id="filtro-comanda"
            type="search"
            value={filtroComanda}
            onChange={(e) => setFiltroComanda(e.target.value)}
            placeholder="🔎 N° de venta..."
            maxLength={LONGITUD_MAX_BUSQUEDA}
            style={{ ...estiloInputAdmin, fontWeight: "normal", boxSizing: "border-box" }}
          />
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
          <label htmlFor="filtro-monto" style={estiloEtiquetaAdmin}>Monto:</label>
          <input
            id="filtro-monto"
            type="search"
            value={filtroMonto}
            onChange={(e) => setFiltroMonto(e.target.value)}
            placeholder="🔎 Monto exacto..."
            maxLength={LONGITUD_MAX_BUSQUEDA}
            style={{ ...estiloInputAdmin, fontWeight: "normal", boxSizing: "border-box" }}
          />
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "5px", flexGrow: 1, minWidth: "220px" }}>
          <label htmlFor="filtro-referencia" style={estiloEtiquetaAdmin}>Referencia:</label>
          <input
            id="filtro-referencia"
            type="search"
            value={filtroReferencia}
            onChange={(e) => setFiltroReferencia(e.target.value)}
            placeholder="🔎 ID de orden, TXID o referencia Binance..."
            maxLength={LONGITUD_MAX_BUSQUEDA}
            style={{ ...estiloInputAdmin, fontWeight: "normal", width: "100%", boxSizing: "border-box" }}
          />
        </div>

        <button type="submit" disabled={cargando} style={{ padding: "9px 18px", borderRadius: "6px", border: "none", background: "#cba6f7", color: "#11111b", fontWeight: "bold", cursor: cargando ? "wait" : "pointer" }}>
          🔍 Aplicar Filtros
        </button>

        <span style={{ fontSize: "13px", color: "#6c7086", marginLeft: "auto", alignSelf: "center" }}>
          Registros en este rango: <strong>{totalRegistros}</strong>
        </span>
      </form>

      {/* 💰 Bloque de Métricas Financieras (auto-recalculadas según los filtros activos) */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "15px", marginBottom: "25px" }}>
        <div style={{ background: "#1e1e2e", padding: "20px", borderRadius: "10px", borderLeft: "5px solid #a6e3a1", boxShadow: "0 2px 8px rgba(0,0,0,0.2)" }}>
          <div style={{ fontSize: "13px", color: "#a6adc8", textTransform: "uppercase", fontWeight: "bold" }}>✅ Reclamados en Período</div>
          <div style={{ fontSize: "24px", fontWeight: "bold", color: "#a6e3a1", marginTop: "5px" }}>{metricas.totalReclamadoUSDT.toFixed(2)} <span style={{ fontSize: "14px" }}>USDT</span></div>
        </div>
        <div style={{ background: "#1e1e2e", padding: "20px", borderRadius: "10px", borderLeft: "5px solid #f9e2af", boxShadow: "0 2px 8px rgba(0,0,0,0.2)" }}>
          <div style={{ fontSize: "13px", color: "#a6adc8", textTransform: "uppercase", fontWeight: "bold" }}>⏳ Pendientes en Período</div>
          <div style={{ fontSize: "24px", fontWeight: "bold", color: "#f9e2af", marginTop: "5px" }}>{metricas.totalPendienteUSDT.toFixed(2)} <span style={{ fontSize: "14px" }}>USDT</span></div>
        </div>
        <div style={{ background: "#1e1e2e", padding: "20px", borderRadius: "10px", borderLeft: "5px solid #89b4fa", boxShadow: "0 2px 8px rgba(0,0,0,0.2)" }}>
          <div style={{ fontSize: "13px", color: "#a6adc8", textTransform: "uppercase", fontWeight: "bold" }}>📈 Total en Rango Seleccionado</div>
          <div style={{ fontSize: "24px", fontWeight: "bold", color: "#89b4fa", marginTop: "5px" }}>{metricas.totalDineroFlujoUSDT.toFixed(2)} <span style={{ fontSize: "14px" }}>USDT</span></div>
        </div>
        {/* El dinero anulado (devoluciones) no se suma a los totales de arriba, pero se
            muestra aparte: ocultarlo del todo dejaría un hueco sin explicación en la caja */}
        <div style={{ background: "#1e1e2e", padding: "20px", borderRadius: "10px", borderLeft: "5px solid #f38ba8", boxShadow: "0 2px 8px rgba(0,0,0,0.2)" }}>
          <div style={{ fontSize: "13px", color: "#a6adc8", textTransform: "uppercase", fontWeight: "bold" }}>🚫 Anulado (no cuenta)</div>
          <div style={{ fontSize: "24px", fontWeight: "bold", color: "#f38ba8", marginTop: "5px" }}>{metricas.totalAnuladoUSDT.toFixed(2)} <span style={{ fontSize: "14px" }}>USDT</span></div>
          <div style={{ fontSize: "12px", color: "#6c7086", marginTop: "4px" }}>{metricas.registrosAnulados} transacción(es)</div>
        </div>
      </div>

      {/* 💵 Métricas en bolívares (Pago Móvil BDV/Sofitasa/Bancamiga), en su propio bloque.
          No se suman con las de arriba a propósito: Bs. y USDT son monedas distintas y
          consolidarlas exigiría una tasa de cambio y una política contable que no existen.
          El bloque solo aparece si el rango filtrado contiene algún pago móvil, para no
          ocupar pantalla con ceros en las tiendas que solo cobran por Binance. */}
      {metricas.registrosPagoMovil > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "15px", marginBottom: "25px" }}>
          <div style={{ background: "#1e1e2e", padding: "20px", borderRadius: "10px", borderLeft: "5px solid #a6e3a1", boxShadow: "0 2px 8px rgba(0,0,0,0.2)" }}>
            <div style={{ fontSize: "13px", color: "#a6adc8", textTransform: "uppercase", fontWeight: "bold" }}>🏦 Pago Móvil Verificado</div>
            <div style={{ fontSize: "24px", fontWeight: "bold", color: "#a6e3a1", marginTop: "5px" }}>{metricas.totalReclamadoVES.toFixed(2)} <span style={{ fontSize: "14px" }}>Bs.</span></div>
            <div style={{ fontSize: "12px", color: "#6c7086", marginTop: "4px" }}>{metricas.registrosPagoMovil} pago(s) móvil(es) en el rango</div>
          </div>
          <div style={{ background: "#1e1e2e", padding: "20px", borderRadius: "10px", borderLeft: "5px solid #89b4fa", boxShadow: "0 2px 8px rgba(0,0,0,0.2)" }}>
            <div style={{ fontSize: "13px", color: "#a6adc8", textTransform: "uppercase", fontWeight: "bold" }}>📈 Total Bolívares en Rango</div>
            <div style={{ fontSize: "24px", fontWeight: "bold", color: "#89b4fa", marginTop: "5px" }}>{metricas.totalDineroFlujoVES.toFixed(2)} <span style={{ fontSize: "14px" }}>Bs.</span></div>
          </div>
          <div style={{ background: "#1e1e2e", padding: "20px", borderRadius: "10px", borderLeft: "5px solid #f38ba8", boxShadow: "0 2px 8px rgba(0,0,0,0.2)" }}>
            <div style={{ fontSize: "13px", color: "#a6adc8", textTransform: "uppercase", fontWeight: "bold" }}>🚫 Anulado en Bolívares</div>
            <div style={{ fontSize: "24px", fontWeight: "bold", color: "#f38ba8", marginTop: "5px" }}>{metricas.totalAnuladoVES.toFixed(2)} <span style={{ fontSize: "14px" }}>Bs.</span></div>
          </div>
        </div>
      )}

      {/* Tabla Principal */}
      <div style={{ overflowX: "auto", background: "#1e1e2e", borderRadius: "12px", border: "1px solid #45475a" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left", fontSize: "14px" }}>
          <thead>
            <tr style={{ background: "#313244", color: "#cba6f7", borderBottom: "2px solid #45475a" }}>
              <th style={estiloCelda}>ID</th>
              <th style={estiloCelda}>Comanda / Venta</th>
              <th style={estiloCelda}>Vía</th>
              <th style={estiloCelda}>Monto</th>
              <th style={estiloCelda}>Moneda</th>
              <th style={estiloCelda}>Referencia / ID de Orden</th>
              <th style={estiloCelda}>Sucursal</th>
              <th style={estiloCelda}>Estado</th>
              <th style={estiloCelda}>Fecha Registro</th>
              <th style={estiloCelda}>Comprobante</th>
              <th style={estiloCelda}>Nota</th>
            </tr>
          </thead>
          <tbody>
            {cargando ? (
              <tr><td colSpan={11} style={{ padding: "20px", textAlign: "center", color: "#6c7086" }}>Cargando historial de auditoría...</td></tr>
            ) : transacciones.length === 0 ? (
              <tr><td colSpan={11} style={{ padding: "20px", textAlign: "center", color: "#6c7086" }}>No se encontraron transacciones bajo estos filtros.</td></tr>
            ) : (
              transacciones.map((t) => (
                // Las anuladas se atenúan y se tachan: siguen visibles para auditoría,
                // pero se distinguen de un vistazo de las que sí cuentan como venta.
                <tr key={t.id} style={{ borderBottom: "1px solid #45475a", opacity: t.anulada ? 0.55 : 1, textDecoration: t.anulada ? "line-through" : "none" }}>
                  <td style={{ ...estiloCelda, fontWeight: "bold", color: "#6c7086" }}>{t.id}</td>
                  <td style={estiloCelda}>
                    {editandoComandaId === t.id ? (
                      <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                        <input
                          type="text"
                          value={comandaEnEdicion}
                          onChange={(e) => setComandaEnEdicion(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter") guardarComanda(t.id); if (e.key === "Escape") setEditandoComandaId(null); }}
                          autoFocus
                          disabled={guardandoComanda}
                          maxLength={LONGITUD_MAX_COMANDA}
                          style={{ width: "120px", padding: "4px 6px", borderRadius: "4px", border: "1px solid #89b4fa", background: "#313244", color: "#fff", fontSize: "13px" }}
                        />
                        <button onClick={() => guardarComanda(t.id)} disabled={guardandoComanda} title="Guardar" style={{ background: "transparent", border: "none", color: "#a6e3a1", cursor: "pointer", fontSize: "16px" }}>✔️</button>
                        <button onClick={() => setEditandoComandaId(null)} disabled={guardandoComanda} title="Cancelar" style={{ background: "transparent", border: "none", color: "#f38ba8", cursor: "pointer", fontSize: "16px" }}>✖️</button>
                      </div>
                    ) : (
                      <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                        <span style={{ color: t.comanda ? "#fff" : "#6c7086" }}>{t.comanda || "Sin Comanda"}</span>
                        <button onClick={() => iniciarEdicionComanda(t)} title="Editar número de venta" style={{ background: "transparent", border: "none", color: "#89b4fa", cursor: "pointer", fontSize: "13px" }}>✏️</button>
                      </div>
                    )}
                  </td>
                  <td style={estiloCelda}>
                    <span
                      title={t.proveedor !== "BINANCE" ? `Pago Móvil · ${nombreDeBanco(t.banco_origen)}` : "Binance Pay"}
                      style={{
                        padding: "3px 7px", borderRadius: "4px", fontSize: "12px", fontWeight: "bold",
                        background: estiloDeProveedor(t.proveedor).fondo,
                        color: estiloDeProveedor(t.proveedor).texto,
                      }}
                    >
                      {estiloDeProveedor(t.proveedor).icono} {estiloDeProveedor(t.proveedor).corta}
                    </span>
                  </td>
                  <td style={{ ...estiloCelda, fontWeight: "bold", color: "#a6e3a1" }}>{t.monto}</td>
                  <td style={estiloCelda}><span style={{ background: "#313244", padding: "3px 6px", borderRadius: "4px" }}>{t.moneda}</span></td>
                  {/* Cada vía identifica su pago con un dato distinto: Binance con el ID de
                      orden, el pago móvil con la referencia bancaria. La columna es la misma. */}
                  <td style={{ ...estiloCelda, fontFamily: "monospace", color: "#b4befe" }}>{t.referencia || t.id_orden || t.binance_id_completo || "N/A"}</td>
                  <td style={estiloCelda}>
                    {t.ciudad ? (
                      <span style={{ background: "rgba(137, 180, 250, 0.1)", color: "#89b4fa", padding: "4px 8px", borderRadius: "6px", fontWeight: "bold" }}>{t.ciudad}</span>
                    ) : (
                      <span style={{ color: "#f9e2af", fontStyle: "italic" }}>⏳ Pendiente</span>
                    )}
                  </td>
                  <td style={{ ...estiloCelda, textDecoration: "none" }}>
                    <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                      <span style={{ padding: "4px 8px", borderRadius: "6px", fontWeight: "bold", fontSize: "12px", background: t.anulada ? "#f38ba8" : (t.estado === "VERIFICADO" ? "#a6e3a1" : "#f9e2af"), color: "#11111b" }}>
                        {t.anulada ? "ANULADA" : t.estado}
                      </span>
                      <button onClick={() => alternarAnulada(t)} title={t.anulada ? "Reactivar: volverá a contar en los totales" : "Anular: dejará de contar en los totales (ej: devolución)"}
                        style={{ background: "transparent", border: "none", color: t.anulada ? "#a6e3a1" : "#f38ba8", cursor: "pointer", fontSize: "13px" }}>
                        {t.anulada ? "↩️" : "🚫"}
                      </button>
                    </div>
                  </td>
                  <td style={{ ...estiloCelda, fontSize: "12px", color: "#a6adc8" }}>{formatearFechaVenezuela(t.fecha_pago || t.created_at)}</td>
                  <td style={estiloCelda}>
                    {t.tiene_comprobante ? (
                      <button onClick={() => handleVerComprobante(t.id)} disabled={cargandoImagenId === t.id}
                        style={{ padding: "4px 8px", background: "transparent", border: "1px solid #89b4fa", color: "#89b4fa", borderRadius: "4px", cursor: cargandoImagenId === t.id ? "wait" : "pointer", fontWeight: "bold", fontSize: "12px" }}>
                        {cargandoImagenId === t.id ? "Cargando..." : "👁️ Ver"}
                      </button>
                    ) : (
                      <span style={{ color: "#6c7086", fontSize: "12px" }}>Sin Adjunto</span>
                    )}
                  </td>
                  <td style={estiloCelda}>
                    <button onClick={() => abrirNota(t)} title={t.nota || "Agregar nota"}
                      style={{ padding: "4px 8px", background: t.nota ? "rgba(249, 226, 175, 0.15)" : "transparent", border: `1px solid ${t.nota ? "#f9e2af" : "#585b70"}`, color: t.nota ? "#f9e2af" : "#a6adc8", borderRadius: "4px", cursor: "pointer", fontWeight: "bold", fontSize: "12px", maxWidth: "140px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {t.nota ? `📝 ${t.nota}` : "➕ Nota"}
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Paginación Controlada */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "20px", background: "#1e1e2e", padding: "15px", borderRadius: "8px", border: "1px solid #45475a", flexWrap: "wrap", gap: "10px" }}>
        <span style={{ fontSize: "14px", color: "#a6adc8" }}>
          Página <strong>{page}</strong> de <strong>{totalPages}</strong>
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <button disabled={page <= 1 || cargando} onClick={() => cargarDatosAuditoria(page - 1)} style={{ ...estiloBotonPagina, background: page <= 1 ? "#45475a" : "#cba6f7", cursor: page <= 1 ? "not-allowed" : "pointer" }}>◀ Anterior</button>
          <button disabled={page >= totalPages || cargando} onClick={() => cargarDatosAuditoria(page + 1)} style={{ ...estiloBotonPagina, background: page >= totalPages ? "#45475a" : "#cba6f7", cursor: page >= totalPages ? "not-allowed" : "pointer" }}>Siguiente ▶</button>
        </div>
      </div>

      {/* Modal de Inspección Visual de Comprobantes Cargados */}
      {imagenModal && (
        <div onClick={() => setImagenModal(null)} style={estiloOverlayModal}>
          <div style={{ position: "relative", maxWidth: "90%", maxHeight: "90%" }} onClick={(e) => e.stopPropagation()}>
            <img src={imagenModal} alt="Comprobante de Caja" style={{ maxWidth: "100%", maxHeight: "85vh", borderRadius: "8px", boxShadow: "0 4px 20px rgba(0,0,0,0.5)" }} />
            <button onClick={() => setImagenModal(null)} style={{ position: "absolute", top: "-40px", right: "0", background: "#f38ba8", color: "#11111b", border: "none", padding: "6px 12px", borderRadius: "4px", fontWeight: "bold", cursor: "pointer" }}>Cerrar Vista</button>
          </div>
        </div>
      )}

      {/* Modal de Nota / Comentario Administrativo */}
      {notaModalId !== null && (
        <div onClick={() => !guardandoNota && setNotaModalId(null)} style={estiloOverlayModal}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: "#1e1e2e", borderRadius: "10px", padding: "20px", width: "100%", maxWidth: "420px", border: "1px solid #45475a" }}>
            <h3 style={{ margin: "0 0 12px 0", color: "#f9e2af" }}>📝 Nota de la transacción #{notaModalId}</h3>
            <textarea
              value={notaEnEdicion}
              onChange={(e) => setNotaEnEdicion(e.target.value)}
              maxLength={500}
              rows={4}
              autoFocus
              disabled={guardandoNota}
              placeholder="Ej: Se devolvió el dinero, el cliente canceló la compra."
              style={{ width: "100%", padding: "10px", borderRadius: "6px", border: "1px solid #45475a", background: "#313244", color: "#fff", fontSize: "14px", boxSizing: "border-box", resize: "vertical", fontFamily: "inherit" }}
            />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px", marginTop: "14px" }}>
              <button onClick={() => setNotaModalId(null)} disabled={guardandoNota} style={{ padding: "8px 14px", background: "transparent", border: "1px solid #585b70", color: "#a6adc8", borderRadius: "6px", cursor: "pointer", fontWeight: "bold" }}>Cancelar</button>
              <button onClick={guardarNota} disabled={guardandoNota} style={{ padding: "8px 14px", background: "#a6e3a1", border: "none", color: "#11111b", borderRadius: "6px", cursor: guardandoNota ? "wait" : "pointer", fontWeight: "bold" }}>
                {guardandoNota ? "Guardando..." : "Guardar Nota"}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
