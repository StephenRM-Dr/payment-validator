"use client";

import { useCallback, useEffect, useState } from "react";
import { COLORES, estiloBotonPagina, estiloCelda, estiloEtiquetaAdmin } from "../../lib/estilos";
import { LONGITUD_MAX_PIN } from "../../lib/validacion";
import { descargarBlob } from "../../lib/descargas";

// Misma clave que app/admin/page.tsx a propósito: si el administrador ya inició sesión ahí,
// esta página también reconoce el PIN guardado sin pedirlo de nuevo — es el mismo backend
// (ADMIN_PIN), solo una vista distinta.
const CLAVE_SESION_PIN = "paymentvalidator_admin_pin";

const NOMBRE_EMPRESA: Record<string, string> = { acme: "Acme Corp", beta: "Beta Corp" };
const NOMBRE_PROVEEDOR: Record<string, string> = { SOFITASA: "Sofitasa", BDV: "Banco de Venezuela" };

interface FilaSaldo {
  proveedor: string;
  empresa: string;
  cuenta: string;
  producto: string | null;
  moneda: string;
  saldo: number;
}

interface ResultadoEmpresa {
  proveedor: string;
  empresa: string;
  ok: boolean;
  filas?: FilaSaldo[];
  mensaje?: string;
}

interface FilaHistorial extends FilaSaldo {
  capturado_en: string;
}

function formatearSaldo(saldo: number, moneda: string): string {
  return `${saldo.toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${moneda}`;
}

function formatearFechaVenezuela(fechaUtc: string): string {
  const iso = /Z$|[+-]\d{2}:?\d{2}$/.test(fechaUtc) ? fechaUtc : `${fechaUtc}Z`;
  return new Date(iso).toLocaleString("es-VE", { timeZone: "America/Caracas" });
}

export default function PanelSaldos() {
  const [pin, setPin] = useState("");
  const [autenticado, setAutenticado] = useState(false);
  const [errorPin, setErrorPin] = useState("");
  const [verificandoPin, setVerificandoPin] = useState(false);

  const [resultados, setResultados] = useState<ResultadoEmpresa[]>([]);
  const [cargandoSaldos, setCargandoSaldos] = useState(false);

  const [historial, setHistorial] = useState<FilaHistorial[]>([]);
  const [cargandoHistorial, setCargandoHistorial] = useState(false);

  const [aviso, setAviso] = useState("");
  const [exportando, setExportando] = useState(false);

  const obtenerPinSesion = () => sessionStorage.getItem(CLAVE_SESION_PIN) || "";

  const fetchAdmin = (url: string, pinActivo?: string) =>
    fetch(url, { headers: { "X-Admin-Pin": pinActivo || obtenerPinSesion() } });

  const consultarSaldos = useCallback(async (pinActivo?: string): Promise<boolean> => {
    setCargandoSaldos(true);
    try {
      const res = await fetchAdmin("/api/admin/saldos", pinActivo);
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setResultados(data.resultados || []);
        return true;
      }
      if (res.status === 403) {
        sessionStorage.removeItem(CLAVE_SESION_PIN);
        setAutenticado(false);
      }
      setErrorPin(data.error || "No se pudieron consultar los saldos.");
      return false;
    } catch {
      setAviso("Error de red al consultar los saldos.");
      return false;
    } finally {
      setCargandoSaldos(false);
    }
  }, []);

  const cargarHistorial = useCallback(async () => {
    setCargandoHistorial(true);
    try {
      const res = await fetchAdmin("/api/admin/saldos/historial");
      const data = await res.json().catch(() => ({}));
      if (res.ok) setHistorial(data.historial || []);
    } catch {
      setAviso("Error de red al consultar el historial.");
    } finally {
      setCargandoHistorial(false);
    }
  }, []);

  const handleExportarExcel = async () => {
    setExportando(true);
    try {
      const res = await fetchAdmin("/api/admin/saldos/exportar");
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setAviso(data.error || "No se pudo generar el Excel de saldos.");
        return;
      }
      const blob = await res.blob();
      const nombre = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") || "")?.[1] || "Saldos.xlsx";
      descargarBlob(blob, nombre);
    } catch {
      setAviso("Error de red al exportar los saldos.");
    } finally {
      setExportando(false);
    }
  };

  // Recupera sesión guardada por app/admin: el servidor decide si el PIN sigue siendo válido
  useEffect(() => {
    const pinGuardado = sessionStorage.getItem(CLAVE_SESION_PIN);
    if (!pinGuardado) return;
    setVerificandoPin(true);
    consultarSaldos(pinGuardado).then((ok) => {
      setVerificandoPin(false);
      if (ok) setAutenticado(true);
    });
    // Solo debe ejecutarse al montar la página
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (autenticado) cargarHistorial();
  }, [autenticado, cargarHistorial]);

  const handleLoginPin = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorPin("");
    const ok = await consultarSaldos(pin);
    if (ok) {
      sessionStorage.setItem(CLAVE_SESION_PIN, pin);
      setAutenticado(true);
      setPin("");
    } else if (!errorPin) {
      setErrorPin("❌ PIN de administración incorrecto.");
    }
  };

  const cerrarSesion = () => {
    sessionStorage.removeItem(CLAVE_SESION_PIN);
    setAutenticado(false);
    setResultados([]);
    setHistorial([]);
    setPin("");
  };

  if (!autenticado) {
    return (
      <div style={{ display: "flex", justifyContent: "center", alignItems: "center", minHeight: "100vh", background: COLORES.fondo, fontFamily: "sans-serif" }}>
        <form onSubmit={handleLoginPin} style={{ background: COLORES.panel, padding: "30px", borderRadius: "12px", boxShadow: "0 4px 20px rgba(0,0,0,0.5)", width: "100%", maxWidth: "360px", textAlign: "center" }}>
          <h2 style={{ color: COLORES.acento, margin: "0 0 10px 0" }}>🔒 Saldos Bancarios</h2>
          <p style={{ color: COLORES.textoSuave, fontSize: "14px", marginBottom: "20px" }}>Introduce el PIN de administración para acceder.</p>
          <input type="password" inputMode="numeric" maxLength={LONGITUD_MAX_PIN} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} placeholder="••••••" autoComplete="off" style={{ width: "100%", padding: "15px", borderRadius: "8px", background: COLORES.campo, color: "#fff", border: `1px solid ${COLORES.borde}`, fontSize: "24px", textAlign: "center", letterSpacing: "8px", marginBottom: "15px", boxSizing: "border-box" }} required />
          <button type="submit" disabled={verificandoPin || cargandoSaldos} style={{ width: "100%", padding: "12px", borderRadius: "8px", border: "none", background: COLORES.acento, color: COLORES.fondo, fontWeight: "bold", fontSize: "16px", cursor: cargandoSaldos ? "wait" : "pointer" }}>
            {verificandoPin ? "Verificando sesión..." : cargandoSaldos ? "Desbloqueando..." : "Ingresar"}
          </button>
          {errorPin && <p style={{ color: COLORES.error, fontSize: "14px", fontWeight: "bold", marginTop: "15px", marginBottom: 0 }}>{errorPin}</p>}
        </form>
      </div>
    );
  }

  return (
    <div style={{ padding: "20px", background: COLORES.fondo, minHeight: "100vh", color: COLORES.texto, fontFamily: "sans-serif", boxSizing: "border-box" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "15px", marginBottom: "20px", borderBottom: `1px solid ${COLORES.borde}`, paddingBottom: "15px" }}>
        <div>
          <h1 style={{ margin: 0, color: COLORES.acento, fontSize: "26px" }}>🏦 Saldos Bancarios</h1>
          <p style={{ margin: "5px 0 0 0", color: COLORES.textoSuave, fontSize: "14px" }}>Sofitasa y BDV, Acme Corp y Beta Corp — en vivo y el historial del corte diario (7:00pm hora Venezuela)</p>
        </div>
        <div style={{ display: "flex", gap: "10px" }}>
          <button onClick={() => consultarSaldos()} disabled={cargandoSaldos} style={{ ...estiloBotonPagina, background: COLORES.info, cursor: cargandoSaldos ? "wait" : "pointer" }}>
            {cargandoSaldos ? "🔄 Consultando..." : "🔄 Consultar ahora"}
          </button>
          <button onClick={handleExportarExcel} disabled={exportando} style={{ ...estiloBotonPagina, background: COLORES.exito, cursor: exportando ? "wait" : "pointer" }}>
            {exportando ? "📥 Exportando..." : "📥 Exportar a Excel"}
          </button>
          <button onClick={cerrarSesion} style={{ ...estiloBotonPagina, background: COLORES.error, cursor: "pointer" }}>🔒 Salir</button>
        </div>
      </div>

      {aviso && (
        <div role="status" style={{ marginBottom: "15px", padding: "12px 16px", borderRadius: "8px", fontWeight: "bold", fontSize: "14px", background: "rgba(243,139,168,0.12)", border: `1px solid ${COLORES.error}`, color: COLORES.error }}>
          {aviso}
        </div>
      )}

      <section style={{ marginBottom: "30px" }}>
        <h2 style={{ color: COLORES.texto, fontSize: "18px", marginBottom: "10px" }}>Saldo en vivo</h2>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "15px" }}>
          {resultados.map((r) => (
            <div key={`${r.proveedor}-${r.empresa}`} style={{ background: COLORES.panel, border: `1px solid ${COLORES.borde}`, borderRadius: "8px", padding: "15px", minWidth: "280px", flex: 1 }}>
              <h3 style={{ margin: "0 0 10px 0", color: COLORES.acento, fontSize: "16px" }}>
                {NOMBRE_PROVEEDOR[r.proveedor] || r.proveedor} · {NOMBRE_EMPRESA[r.empresa] || r.empresa}
              </h3>
              {r.ok ? (
                (r.filas || []).length === 0 ? (
                  <p style={{ color: COLORES.textoTenue, fontSize: "13px" }}>Sin cuentas informadas.</p>
                ) : (
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "14px" }}>
                    <tbody>
                      {(r.filas || []).map((f) => (
                        <tr key={`${f.proveedor}-${f.cuenta}`}>
                          <td style={{ ...estiloCelda, padding: "6px 0", color: COLORES.textoSuave }}>{f.cuenta}</td>
                          <td style={{ ...estiloCelda, padding: "6px 0", textAlign: "right", fontWeight: "bold" }}>{formatearSaldo(f.saldo, f.moneda)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )
              ) : (
                <p style={{ color: COLORES.error, fontSize: "13px" }}>⚠️ {r.mensaje || "No se pudo consultar."}</p>
              )}
            </div>
          ))}
          {resultados.length === 0 && !cargandoSaldos && (
            <p style={{ color: COLORES.textoTenue }}>Pulsa &quot;Consultar ahora&quot; para ver el saldo actual.</p>
          )}
        </div>
      </section>

      <section>
        <h2 style={{ color: COLORES.texto, fontSize: "18px", marginBottom: "10px" }}>Historial del corte diario</h2>
        {cargandoHistorial ? (
          <p style={{ color: COLORES.textoTenue }}>Cargando historial...</p>
        ) : historial.length === 0 ? (
          <p style={{ color: COLORES.textoTenue }}>Todavía no hay cortes diarios registrados.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", background: COLORES.panel, border: `1px solid ${COLORES.borde}`, borderRadius: "8px" }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${COLORES.borde}` }}>
                  <th style={{ ...estiloCelda, ...estiloEtiquetaAdmin, textAlign: "left" }}>Fecha (Venezuela)</th>
                  <th style={{ ...estiloCelda, ...estiloEtiquetaAdmin, textAlign: "left" }}>Banco</th>
                  <th style={{ ...estiloCelda, ...estiloEtiquetaAdmin, textAlign: "left" }}>Empresa</th>
                  <th style={{ ...estiloCelda, ...estiloEtiquetaAdmin, textAlign: "left" }}>Cuenta</th>
                  <th style={{ ...estiloCelda, ...estiloEtiquetaAdmin, textAlign: "right" }}>Saldo</th>
                </tr>
              </thead>
              <tbody>
                {historial.map((h, i) => (
                  <tr key={`${h.proveedor}-${h.empresa}-${h.cuenta}-${h.capturado_en}-${i}`} style={{ borderBottom: `1px solid ${COLORES.borde}` }}>
                    <td style={estiloCelda}>{formatearFechaVenezuela(h.capturado_en)}</td>
                    <td style={estiloCelda}>{NOMBRE_PROVEEDOR[h.proveedor] || h.proveedor}</td>
                    <td style={estiloCelda}>{NOMBRE_EMPRESA[h.empresa] || h.empresa}</td>
                    <td style={estiloCelda}>{h.cuenta}</td>
                    <td style={{ ...estiloCelda, textAlign: "right", fontWeight: "bold" }}>{formatearSaldo(h.saldo, h.moneda)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
