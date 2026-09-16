"use client";

import { useCallback, useEffect, useState } from "react";
import { COLORES, estiloBotonPagina, estiloEtiquetaAdmin, estiloInputAdmin } from "../../lib/estilos";
import { LONGITUD_MAX_PIN } from "../../lib/validacion";
import { procesarImagenComprobante } from "../../lib/cliente";
import { VALORES_SUCURSALES } from "../../lib/sucursales";
import { BANCOS } from "../../lib/bancos";

// Mismo PIN de sesión que el resto del panel admin (ver app/admin/saldos/page.tsx): si ya
// se inició sesión en cualquier otra pantalla del panel, esta la reconoce sin pedirla de nuevo.
const CLAVE_SESION_PIN = "paymentvalidator_admin_pin";

interface Candidato {
  referenciaBanco: string;
  hora: string | null;
  monto: number;
  identificacion: string | null;
  bancoOrigen: string | null;
  correcciones: number;
}

interface RespuestaSeguimiento {
  message?: string;
  via?: string;
  candidatos?: Candidato[];
  notificacionTelegram?: boolean;
  pago?: { referencia: string; monto: number };
}

const ESTILO_ETIQUETA = { ...estiloEtiquetaAdmin, display: "block", marginBottom: "6px" };
const ESTILO_CAMPO = { ...estiloInputAdmin, width: "100%", boxSizing: "border-box" as const, padding: "10px" };

export default function PanelSeguimientoBancamiga() {
  const [pin, setPin] = useState("");
  const [autenticado, setAutenticado] = useState(false);
  const [errorPin, setErrorPin] = useState("");
  const [verificandoPin, setVerificandoPin] = useState(false);

  const [comanda, setComanda] = useState("");
  const [ciudad, setCiudad] = useState(VALORES_SUCURSALES[0] || "");
  const [referencia, setReferencia] = useState("");
  const [importe, setImporte] = useState("");
  const [fechaPago, setFechaPago] = useState("");
  const [telefonoOrigen, setTelefonoOrigen] = useState("");
  const [bancoOrigen, setBancoOrigen] = useState("");
  const [imagenBase64, setImagenBase64] = useState<string | null>(null);
  const [nombreArchivo, setNombreArchivo] = useState("");

  const [enviando, setEnviando] = useState(false);
  const [resultado, setResultado] = useState<RespuestaSeguimiento | null>(null);
  const [error, setError] = useState("");
  const [referenciaBancoElegida, setReferenciaBancoElegida] = useState<string | null>(null);

  // Verifica el PIN contra el servidor (GET de solo lectura, sin efectos secundarios) antes
  // de mostrar el formulario grande — así un PIN equivocado se detecta de una vez, en vez de
  // descubrirse hasta el final con un 403 confuso al enviar todo el formulario ya lleno.
  const verificarPin = useCallback(async (pinActivo: string): Promise<boolean> => {
    try {
      const res = await fetch("/api/admin/bancamiga-seguimiento", { headers: { "X-Admin-Pin": pinActivo } });
      if (res.ok) return true;
      const data = await res.json().catch(() => ({}));
      setErrorPin(data.error || data.message || "❌ PIN de administración incorrecto.");
      return false;
    } catch {
      setErrorPin("Error de red al verificar el PIN.");
      return false;
    }
  }, []);

  // Recupera sesión guardada por otra pantalla del panel (ver app/admin/saldos/page.tsx):
  // el servidor decide si el PIN sigue siendo válido.
  useEffect(() => {
    const pinGuardado = sessionStorage.getItem(CLAVE_SESION_PIN);
    if (!pinGuardado) return;
    setVerificandoPin(true);
    verificarPin(pinGuardado).then((ok) => {
      setVerificandoPin(false);
      if (ok) setAutenticado(true);
      else sessionStorage.removeItem(CLAVE_SESION_PIN);
    });
    // Solo debe ejecutarse al montar la página
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleLoginPin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pin.trim()) return;
    setErrorPin("");
    setVerificandoPin(true);
    const ok = await verificarPin(pin);
    setVerificandoPin(false);
    if (ok) {
      sessionStorage.setItem(CLAVE_SESION_PIN, pin);
      setAutenticado(true);
      setPin("");
    }
  };

  const handleArchivo = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const archivo = e.target.files?.[0];
    if (!archivo) return;
    setError("");
    try {
      const base64 = await procesarImagenComprobante(archivo);
      setImagenBase64(base64);
      setNombreArchivo(archivo.name);
    } catch (err) {
      setImagenBase64(null);
      setNombreArchivo("");
      setError(err instanceof Error ? err.message : "No se pudo procesar la imagen.");
    }
  };

  const enviar = async (referenciaBancoConfirmada?: string) => {
    if (!imagenBase64) {
      setError("⚠️ Adjunta la foto del comprobante.");
      return;
    }
    setEnviando(true);
    setError("");
    setResultado(null);
    try {
      const res = await fetch("/api/admin/bancamiga-seguimiento", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Admin-Pin": sessionStorage.getItem(CLAVE_SESION_PIN) || pin },
        body: JSON.stringify({
          comanda,
          ciudad,
          referencia,
          importe,
          fecha_pago: fechaPago,
          telefono_origen: telefonoOrigen,
          banco_origen: bancoOrigen,
          imagen_comprobante: imagenBase64,
          referencia_banco: referenciaBancoConfirmada || "",
        }),
      });
      const data: RespuestaSeguimiento = await res.json().catch(() => ({}));
      if (res.status === 403) {
        sessionStorage.removeItem(CLAVE_SESION_PIN);
        setAutenticado(false);
        setErrorPin("❌ PIN de administración incorrecto o expirado.");
        return;
      }
      setResultado(data);
      if (!res.ok && !data.candidatos) {
        setError(data.message || `Error (código ${res.status})`);
      }
    } catch {
      setError("Error de red al conectar con el servidor.");
    } finally {
      setEnviando(false);
    }
  };

  if (!autenticado) {
    return (
      <div style={{ display: "flex", justifyContent: "center", alignItems: "center", minHeight: "100vh", background: COLORES.fondo, fontFamily: "sans-serif" }}>
        <form onSubmit={handleLoginPin} style={{ background: COLORES.panel, padding: "30px", borderRadius: "12px", width: "100%", maxWidth: "360px", textAlign: "center" }}>
          <h2 style={{ color: COLORES.acento, margin: "0 0 10px 0" }}>🔎 Seguimiento Bancamiga</h2>
          <p style={{ color: COLORES.textoSuave, fontSize: "14px", marginBottom: "20px" }}>Introduce el PIN de administración para acceder.</p>
          <input type="password" inputMode="numeric" maxLength={LONGITUD_MAX_PIN} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} placeholder="••••••" autoComplete="off" style={{ width: "100%", padding: "15px", borderRadius: "8px", background: COLORES.campo, color: "#fff", border: `1px solid ${COLORES.borde}`, fontSize: "24px", textAlign: "center", letterSpacing: "8px", marginBottom: "15px", boxSizing: "border-box" }} required />
          <button type="submit" disabled={verificandoPin} style={{ width: "100%", padding: "12px", borderRadius: "8px", border: "none", background: COLORES.acento, color: COLORES.fondo, fontWeight: "bold", fontSize: "16px", cursor: verificandoPin ? "wait" : "pointer" }}>
            {verificandoPin ? "Verificando..." : "Ingresar"}
          </button>
          {errorPin && <p style={{ color: COLORES.error, fontSize: "14px", fontWeight: "bold", marginTop: "15px", marginBottom: 0 }}>{errorPin}</p>}
        </form>
      </div>
    );
  }

  return (
    <div style={{ padding: "20px", background: COLORES.fondo, minHeight: "100vh", color: COLORES.texto, fontFamily: "sans-serif", boxSizing: "border-box" }}>
      <div style={{ maxWidth: "640px", margin: "0 auto" }}>
        <div style={{ marginBottom: "20px", borderBottom: `1px solid ${COLORES.borde}`, paddingBottom: "15px" }}>
          <h1 style={{ margin: 0, color: COLORES.acento, fontSize: "24px" }}>🔎 Seguimiento de Bancamiga</h1>
          <p style={{ margin: "5px 0 0 0", color: COLORES.textoSuave, fontSize: "13px" }}>
            Para pagos que el cajero no pudo cerrar en el momento (casi siempre porque el historial del banco todavía no los reflejaba).
            Prueba por historial, transferencia/depósito y, si aportas el teléfono de origen completo, también por consulta directa.
            Si encuentra el pago, lo registra aquí mismo — comanda y sucursal correctas son tu responsabilidad, igual que en caja.
          </p>
        </div>

        <form onSubmit={(e) => { e.preventDefault(); enviar(); }} style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
          <div>
            <label style={ESTILO_ETIQUETA}>Número de venta / comanda</label>
            <input style={ESTILO_CAMPO} value={comanda} onChange={(e) => setComanda(e.target.value)} required />
          </div>

          <div>
            <label style={ESTILO_ETIQUETA}>Sucursal</label>
            <select style={ESTILO_CAMPO} value={ciudad} onChange={(e) => setCiudad(e.target.value)}>
              {VALORES_SUCURSALES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>

          <div style={{ display: "flex", gap: "12px" }}>
            <div style={{ flex: 2 }}>
              <label style={ESTILO_ETIQUETA}>Referencia (solo dígitos)</label>
              <input style={ESTILO_CAMPO} value={referencia} onChange={(e) => setReferencia(e.target.value.replace(/\D/g, ""))} required />
            </div>
            <div style={{ flex: 1 }}>
              <label style={ESTILO_ETIQUETA}>Monto (Bs.)</label>
              <input style={ESTILO_CAMPO} value={importe} onChange={(e) => setImporte(e.target.value)} placeholder="Ej. 34.936,34" required />
            </div>
          </div>

          <div>
            <label style={ESTILO_ETIQUETA}>Fecha del pago</label>
            <input type="date" style={ESTILO_CAMPO} value={fechaPago} onChange={(e) => setFechaPago(e.target.value)} required />
          </div>

          <div style={{ border: `1px dashed ${COLORES.borde}`, borderRadius: "8px", padding: "12px" }}>
            <p style={{ margin: "0 0 10px 0", fontSize: "12px", color: COLORES.textoTenue }}>
              Opcional — solo hace falta si historial y transferencia no encuentran el pago. El comprobante lo muestra parcialmente
              oculto (ej. &quot;04**-***3119&quot;): pídele el número completo al cliente.
            </p>
            <div style={{ display: "flex", gap: "12px" }}>
              <div style={{ flex: 1 }}>
                <label style={ESTILO_ETIQUETA}>Teléfono de origen completo</label>
                <input style={ESTILO_CAMPO} value={telefonoOrigen} onChange={(e) => setTelefonoOrigen(e.target.value)} placeholder="0412-0998630" />
              </div>
              <div style={{ flex: 1 }}>
                <label style={ESTILO_ETIQUETA}>Banco emisor</label>
                <select style={ESTILO_CAMPO} value={bancoOrigen} onChange={(e) => setBancoOrigen(e.target.value)}>
                  <option value="">— Selecciona —</option>
                  {BANCOS.map((b) => <option key={b.codigo} value={b.nombre}>{b.nombre}</option>)}
                </select>
              </div>
            </div>
          </div>

          <div>
            <label style={ESTILO_ETIQUETA}>Foto del comprobante</label>
            <input type="file" accept="image/*" onChange={handleArchivo} style={{ color: COLORES.textoSuave }} />
            {nombreArchivo && <p style={{ fontSize: "12px", color: COLORES.exito, margin: "6px 0 0" }}>✅ {nombreArchivo} lista.</p>}
          </div>

          <button type="submit" disabled={enviando} style={{ ...estiloBotonPagina, background: COLORES.acento, padding: "14px", fontSize: "16px", cursor: enviando ? "wait" : "pointer" }}>
            {enviando ? "Consultando..." : "Buscar y registrar"}
          </button>
        </form>

        {error && (
          <div style={{ marginTop: "16px", padding: "12px 16px", borderRadius: "8px", background: "rgba(243,139,168,0.12)", border: `1px solid ${COLORES.error}`, color: COLORES.error, fontWeight: "bold", fontSize: "14px" }}>
            {error}
          </div>
        )}

        {resultado?.message && !error && (
          <div style={{ marginTop: "16px", padding: "12px 16px", borderRadius: "8px", background: resultado.pago ? "rgba(166,227,161,0.12)" : "rgba(249,226,175,0.12)", border: `1px solid ${resultado.pago ? COLORES.exito : COLORES.aviso}`, color: resultado.pago ? COLORES.exito : COLORES.aviso, fontWeight: "bold", fontSize: "14px" }}>
            {resultado.message}
            {resultado.via && <div style={{ marginTop: "6px", fontSize: "12px", color: COLORES.textoSuave, fontWeight: "normal" }}>Vía: {resultado.via}</div>}
          </div>
        )}

        {resultado?.candidatos && resultado.candidatos.length > 0 && (
          <div style={{ marginTop: "16px" }}>
            <p style={{ color: COLORES.textoSuave, fontSize: "13px" }}>Elige cuál es el pago del cliente:</p>
            {resultado.candidatos.map((c) => (
              <button
                key={c.referenciaBanco}
                onClick={() => { setReferenciaBancoElegida(c.referenciaBanco); enviar(c.referenciaBanco); }}
                disabled={enviando}
                style={{ display: "block", width: "100%", textAlign: "left", padding: "10px 14px", marginBottom: "8px", borderRadius: "8px", background: referenciaBancoElegida === c.referenciaBanco ? COLORES.acento : COLORES.panel, color: referenciaBancoElegida === c.referenciaBanco ? COLORES.fondo : COLORES.texto, border: `1px solid ${COLORES.borde}`, cursor: "pointer" }}
              >
                Ref. {c.referenciaBanco} · Bs. {c.monto.toFixed(2)} · {c.hora || "hora ?"} · {c.identificacion || "sin identificar"}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
