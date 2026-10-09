"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { COLORES } from "./lib/estilos";

function limitar01(valor: number): number {
  return Math.min(1, Math.max(0, valor));
}

// Landing pública de entrada: a diferencia de un sistema de cara al público, acá SÍ
// queremos que cajero y admin lleguen directo a su vista — por eso los botones de
// acceso van en el hero y se repiten al cierre. El movimiento (parallax por capas,
// reveals al hacer scroll) se hace con CSS + IntersectionObserver + un único scroll
// listener con rAF, sin sumar ninguna librería de animación.
export default function VisorInicio() {
  const raizRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const raiz = raizRef.current;
    if (!raiz) return;

    const prefiereReducido = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const observerReveal = new IntersectionObserver(
      (entradas) => {
        for (const entrada of entradas) {
          if (entrada.isIntersecting) {
            entrada.target.classList.add("pv-visible");
            observerReveal.unobserve(entrada.target);
          }
        }
      },
      { threshold: 0.2 }
    );
    raiz.querySelectorAll("[data-reveal]").forEach((el) => observerReveal.observe(el));

    if (prefiereReducido) {
      return () => observerReveal.disconnect();
    }

    const escenas = Array.from(raiz.querySelectorAll<HTMLElement>(".pv-escena"));
    const escenasActivas = new Set<HTMLElement>();
    const observerEscena = new IntersectionObserver(
      (entradas) => {
        for (const entrada of entradas) {
          if (entrada.isIntersecting) escenasActivas.add(entrada.target as HTMLElement);
          else escenasActivas.delete(entrada.target as HTMLElement);
        }
      },
      { rootMargin: "50% 0px" }
    );
    escenas.forEach((escena) => observerEscena.observe(escena));

    let cuadroPendiente = false;

    function actualizar() {
      cuadroPendiente = false;
      const alturaVentana = window.innerHeight;

      for (const escena of escenasActivas) {
        const rect = escena.getBoundingClientRect();
        const progreso = limitar01((alturaVentana - rect.top) / (alturaVentana + rect.height));
        escena.style.setProperty("--p", String(progreso * 2 - 1));
      }
    }

    function alHacerScroll() {
      if (!cuadroPendiente) {
        cuadroPendiente = true;
        requestAnimationFrame(actualizar);
      }
    }

    actualizar();
    window.addEventListener("scroll", alHacerScroll, { passive: true });
    window.addEventListener("resize", alHacerScroll, { passive: true });

    return () => {
      observerReveal.disconnect();
      observerEscena.disconnect();
      window.removeEventListener("scroll", alHacerScroll);
      window.removeEventListener("resize", alHacerScroll);
    };
  }, []);

  return (
    <div
      ref={raizRef}
      style={{
        background: COLORES.fondo,
        color: COLORES.texto,
        overflowX: "hidden",
        fontFamily: "system-ui, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
      }}
    >
      <style>{ESTILOS}</style>

      <main>
        {/* 1. HERO */}
        <section
          className="pv-escena pv-escena-hero"
          aria-label="Presentación de Payment Validator"
          style={{ minHeight: "100vh", position: "relative", display: "flex", alignItems: "center", justifyContent: "center", padding: "24px" }}
        >
          <div className="pv-capa pv-profundidad-0" aria-hidden="true" style={{ position: "absolute", inset: 0, background: `radial-gradient(circle at 50% 28%, ${COLORES.panel}, ${COLORES.fondo} 72%)` }} />

          <div className="pv-capa pv-profundidad-1" aria-hidden="true" style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
            <div className="pv-brillo pv-pulso" style={{ position: "absolute", top: "8%", left: "12%", width: "320px", height: "320px", borderRadius: "50%", background: COLORES.acento, filter: "blur(90px)", opacity: 0.28 }} />
            <div className="pv-brillo pv-pulso" style={{ position: "absolute", bottom: "6%", right: "10%", width: "260px", height: "260px", borderRadius: "50%", background: COLORES.info, filter: "blur(80px)", opacity: 0.2, animationDelay: "-2.5s" }} />
          </div>

          <svg className="pv-capa pv-profundidad-2" aria-hidden="true" width="420" height="420" viewBox="0 0 420 420" style={{ position: "absolute", opacity: 0.35 }}>
            <circle cx="210" cy="210" r="190" fill="none" stroke={COLORES.borde} strokeWidth="1.5" strokeDasharray="4 10" />
            <circle cx="210" cy="210" r="150" fill="none" stroke={COLORES.bordeSuave} strokeWidth="1" strokeDasharray="2 8" />
          </svg>

          <div className="pv-capa pv-profundidad-3" style={{ position: "relative", marginBottom: "40px" }}>
            <div className="pv-flotar-orbita" style={{ position: "relative" }}>
              <div aria-hidden="true" style={{ position: "absolute", inset: "-30px", borderRadius: "50%", background: COLORES.acento, filter: "blur(55px)", opacity: 0.32 }} />
              <div
                aria-hidden="true"
                style={{
                  position: "relative",
                  width: "104px",
                  height: "104px",
                  borderRadius: "26px",
                  background: COLORES.panel,
                  border: `1px solid ${COLORES.borde}`,
                  boxShadow: "0 24px 60px rgba(0,0,0,0.55)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: COLORES.acento,
                }}
              >
                <IconoEscudoPago />
              </div>
            </div>
          </div>

          <div className="pv-capa pv-profundidad-4" style={{ position: "relative", textAlign: "center", maxWidth: "640px" }}>
            <h1 data-reveal style={{ fontSize: "clamp(32px, 5vw, 54px)", lineHeight: 1.15, margin: 0, color: COLORES.texto }}>
              Cada pago, verificado antes de aceptarlo.
            </h1>
            <p data-reveal style={{ fontSize: "18px", color: COLORES.textoSuave, marginTop: "18px", lineHeight: 1.6 }}>
              Payment Validator cruza cada comprobante contra el banco o el riel cripto en segundos — sin confiar a ciegas en una captura de pantalla.
            </p>

            <div data-reveal style={{ display: "flex", flexWrap: "wrap", gap: "14px", justifyContent: "center", marginTop: "36px" }}>
              <Link href="/cajero" style={estiloBotonCTA(COLORES.acento)}>
                Entrar como Cajero
              </Link>
              <Link href="/admin" style={estiloBotonCTA(COLORES.info)}>
                Entrar como Admin
              </Link>
            </div>
            <p data-reveal style={{ fontSize: "13px", color: COLORES.textoTenue, marginTop: "14px" }}>
              Demo pública con datos ficticios · PIN de Admin: <strong style={{ color: COLORES.textoSuave, letterSpacing: "2px" }}>246810</strong>
            </p>
          </div>

          <div className="pv-capa pv-profundidad-5" aria-hidden="true" style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
            <span className="pv-particula" style={{ top: "20%", left: "22%" }} />
            <span className="pv-particula" style={{ top: "70%", left: "78%", animationDelay: "-3s" }} />
            <span className="pv-particula" style={{ top: "35%", left: "85%", animationDelay: "-1.5s" }} />
            <span className="pv-particula" style={{ top: "80%", left: "15%", animationDelay: "-4.5s" }} />
          </div>
        </section>

        {/* 2. QUÉ RESUELVE */}
        <section className="pv-escena pv-seccion-resuelve" aria-label="Qué resuelve Payment Validator" style={{ position: "relative", padding: "90px 24px" }}>
          <div className="pv-capa pv-profundidad-0" aria-hidden="true" style={{ position: "absolute", inset: 0, background: `linear-gradient(180deg, ${COLORES.fondo}, ${COLORES.panel} 50%, ${COLORES.fondo})` }} />
          <div className="pv-capa pv-profundidad-1" aria-hidden="true" style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
            <div className="pv-brillo pv-pulso" style={{ position: "absolute", top: "20%", right: "20%", width: "280px", height: "280px", borderRadius: "50%", background: COLORES.acento, filter: "blur(100px)", opacity: 0.16 }} />
          </div>

          <div className="pv-capa pv-profundidad-4" style={{ position: "relative", maxWidth: "980px", margin: "0 auto" }}>
            <h2 data-reveal style={{ fontSize: "clamp(26px, 3.5vw, 38px)", textAlign: "center", color: COLORES.acento, margin: "0 0 56px" }}>
              Confiar en una captura de pantalla no es verificar un pago.
            </h2>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "20px" }}>
              {TARJETAS.map((tarjeta, i) => (
                <div
                  key={tarjeta.titulo}
                  data-reveal
                  style={{
                    background: COLORES.panel,
                    border: `1px solid ${COLORES.borde}`,
                    borderRadius: "16px",
                    padding: "28px",
                    transitionDelay: `${i * 90}ms`,
                  }}
                >
                  <div aria-hidden="true" style={{ color: tarjeta.color, marginBottom: "14px" }}>
                    {tarjeta.icono}
                  </div>
                  <h3 style={{ margin: "0 0 8px", fontSize: "19px", color: COLORES.texto }}>{tarjeta.titulo}</h3>
                  <p style={{ margin: 0, color: COLORES.textoSuave, fontSize: "15px", lineHeight: 1.5 }}>{tarjeta.texto}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* 3. CÓMO FUNCIONA */}
        <section className="pv-escena pv-seccion-funciona" aria-label="Cómo funciona" style={{ position: "relative", padding: "90px 24px" }}>
          <div className="pv-capa pv-profundidad-0" aria-hidden="true" style={{ position: "absolute", inset: 0, background: COLORES.fondo }} />
          <div className="pv-capa pv-profundidad-1" aria-hidden="true" style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
            <div className="pv-brillo pv-pulso" style={{ position: "absolute", top: "40%", left: "8%", width: "300px", height: "300px", borderRadius: "50%", background: COLORES.info, filter: "blur(110px)", opacity: 0.14 }} />
          </div>

          <div className="pv-capa pv-profundidad-4" style={{ position: "relative", maxWidth: "980px", margin: "0 auto" }}>
            <h2 data-reveal style={{ fontSize: "clamp(26px, 3.5vw, 38px)", textAlign: "center", color: COLORES.texto, margin: "0 0 64px" }}>
              Tres pasos, un solo flujo.
            </h2>

            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "center", gap: "0", flexWrap: "wrap" }}>
              {PASOS.map((paso, i) => (
                <div key={paso.titulo} style={{ display: "flex", alignItems: "center", flex: "1 1 220px", minWidth: "220px" }}>
                  <div data-reveal style={{ textAlign: "center", flex: 1, transitionDelay: `${i * 120}ms` }}>
                    <div
                      aria-hidden="true"
                      style={{
                        width: "56px",
                        height: "56px",
                        margin: "0 auto 16px",
                        borderRadius: "50%",
                        background: COLORES.campo,
                        border: `1px solid ${COLORES.borde}`,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        color: COLORES.acento,
                      }}
                    >
                      <IconoPaso numero={i + 1} />
                    </div>
                    <h3 style={{ margin: "0 0 6px", fontSize: "17px", color: COLORES.texto }}>{paso.titulo}</h3>
                    <p style={{ margin: 0, color: COLORES.textoSuave, fontSize: "14px" }}>{paso.texto}</p>
                  </div>
                  {i < PASOS.length - 1 && (
                    <div
                      data-reveal
                      className="pv-conector"
                      aria-hidden="true"
                      style={{ height: "1px", flex: "0 0 60px", background: COLORES.bordeSuave, marginTop: "28px", transitionDelay: `${i * 120 + 160}ms` }}
                    />
                  )}
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* 4. POR QUÉ CONFIAR */}
        <section className="pv-escena pv-seccion-confianza" aria-label="Por qué confiar en Payment Validator" style={{ position: "relative", padding: "90px 24px" }}>
          <div className="pv-capa pv-profundidad-0" aria-hidden="true" style={{ position: "absolute", inset: 0, background: `radial-gradient(circle at 50% 50%, ${COLORES.panel}, ${COLORES.fondo} 75%)` }} />
          <div className="pv-capa pv-profundidad-2" aria-hidden="true" style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
            <div className="pv-brillo pv-pulso" style={{ position: "absolute", top: "15%", left: "50%", transform: "translateX(-50%)", width: "420px", height: "420px", borderRadius: "50%", background: COLORES.acento, filter: "blur(130px)", opacity: 0.12 }} />
          </div>

          <div className="pv-capa pv-profundidad-4" style={{ position: "relative", maxWidth: "860px", margin: "0 auto", textAlign: "center" }}>
            <h2 data-reveal style={{ fontSize: "clamp(28px, 4vw, 44px)", margin: "0 0 56px", color: COLORES.texto }}>
              Verificación real, no solo una foto.
            </h2>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "24px" }}>
              {PILARES.map((pilar, i) => (
                <div key={pilar.titulo} data-reveal style={{ transitionDelay: `${i * 100}ms` }}>
                  <div aria-hidden="true" style={{ color: COLORES.exito, marginBottom: "10px" }}>{pilar.icono}</div>
                  <h3 style={{ margin: "0 0 6px", fontSize: "16px", color: COLORES.texto }}>{pilar.titulo}</h3>
                  <p style={{ margin: 0, color: COLORES.textoSuave, fontSize: "14px" }}>{pilar.texto}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* 5. CIERRE */}
        <section className="pv-escena pv-seccion-cierre" aria-label="Cierre" style={{ position: "relative", padding: "100px 24px 70px", display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" }}>
          <div className="pv-capa pv-profundidad-0" aria-hidden="true" style={{ position: "absolute", inset: 0, background: `linear-gradient(180deg, ${COLORES.fondo}, #0a0a12)` }} />
          <div className="pv-capa pv-profundidad-5" aria-hidden="true" style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
            <span className="pv-particula" style={{ top: "30%", left: "30%" }} />
            <span className="pv-particula" style={{ top: "60%", left: "68%", animationDelay: "-2s" }} />
          </div>

          <div className="pv-capa pv-profundidad-4" data-reveal style={{ position: "relative" }}>
            <h2 style={{ fontSize: "clamp(22px, 3vw, 30px)", margin: "0 0 10px", color: COLORES.texto }}>
              El respaldo de cada pago, verificado.
            </h2>
            <p style={{ margin: "0 0 32px", color: COLORES.textoTenue, fontSize: "13px" }}>Payment Validator · 2026</p>

            <div style={{ display: "flex", flexWrap: "wrap", gap: "14px", justifyContent: "center" }}>
              <Link href="/cajero" style={estiloBotonCTA(COLORES.acento)}>
                Entrar como Cajero
              </Link>
              <Link href="/admin" style={estiloBotonCTA(COLORES.info)}>
                Entrar como Admin
              </Link>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

// Botón de acceso grande del hero/cierre: mismo tratamiento para ambos destinos,
// solo cambia el color de acento para distinguir Cajero de Admin a simple vista.
function estiloBotonCTA(color: string): React.CSSProperties {
  return {
    display: "inline-block",
    padding: "16px 32px",
    borderRadius: "10px",
    background: color,
    color: COLORES.fondo,
    fontWeight: "bold",
    fontSize: "16px",
    textDecoration: "none",
    boxShadow: `0 8px 24px ${color}40`,
  };
}

function IconoEscudoPago() {
  return (
    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M12 2 4 6v6c0 5 3.5 8 8 10 4.5-2 8-5 8-10V6l-8-4z" strokeLinejoin="round" />
      <path d="M8.5 12.5l2.5 2.5 4.5-5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconoEscaneo() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M6 3H4a1 1 0 0 0-1 1v2M18 3h2a1 1 0 0 1 1 1v2M6 21H4a1 1 0 0 1-1-1v-2M18 21h2a1 1 0 0 0 1-1v-2" strokeLinecap="round" />
      <path d="M8 8h8v8H8z" strokeLinejoin="round" />
      <path d="M8 11h8" />
    </svg>
  );
}

function IconoVerificacion() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M3 10l9-7 9 7" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 10v9h14v-9" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M9.5 14.5l2 2 4-4.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconoMultiproveedor() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M12 3l8 4-8 4-8-4 8-4z" strokeLinejoin="round" />
      <path d="M4 12l8 4 8-4" strokeLinejoin="round" />
      <path d="M4 16l8 4 8-4" strokeLinejoin="round" />
    </svg>
  );
}

function IconoPaso({ numero }: { numero: number }) {
  return <span style={{ fontSize: "20px", fontWeight: "bold" }}>{numero}</span>;
}

function IconoVerificacionReal() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M12 2 4 6v6c0 5 3.5 8 8 10 4.5-2 8-5 8-10V6l-8-4z" strokeLinejoin="round" />
      <path d="M9 12l2 2 4-4.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconoKillSwitch() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M12 2v8" strokeLinecap="round" />
      <path d="M6.5 6.5a8 8 0 1 0 11 0" strokeLinecap="round" />
    </svg>
  );
}

function IconoTrazabilidad() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M9 11l3 3L22 4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const TARJETAS = [
  { titulo: "OCR del comprobante", texto: "La IA lee el monto, la moneda y la referencia directo de la foto que trae el cliente.", icono: <IconoEscaneo />, color: COLORES.info },
  { titulo: "Verificación directa", texto: "Esa referencia se cruza contra el banco o el riel cripto antes de aceptar el pago — nunca a ciegas.", icono: <IconoVerificacion />, color: COLORES.acento },
  { titulo: "Multiproveedor", texto: "Binance Pay, BDV, Sofitasa y Bancamiga, todos bajo el mismo flujo de validación.", icono: <IconoMultiproveedor />, color: COLORES.exito },
];

const PASOS = [
  { titulo: "El cliente paga", texto: "Por Binance Pay o pago móvil, en cualquiera de los bancos soportados." },
  { titulo: "El cajero escanea", texto: "La IA extrae monto, moneda y referencia del comprobante." },
  { titulo: "El sistema confirma", texto: "La referencia se busca en el banco o el riel cripto antes de aceptar." },
];

const PILARES = [
  { titulo: "Verificación real", texto: "Cada pago se contrasta contra el banco o el riel cripto antes de aceptarlo.", icono: <IconoVerificacionReal /> },
  { titulo: "Kill switch", texto: "Un solo flag detiene todos los endpoints de pago al instante durante un incidente.", icono: <IconoKillSwitch /> },
  { titulo: "Trazabilidad", texto: "Cada transacción queda auditada: quién, cuándo y con qué resultado.", icono: <IconoTrazabilidad /> },
];

const ESTILOS = `
  @keyframes pv-flotar-orbita {
    0%, 100% { transform: translate(0, 0) rotate(0deg); }
    50% { transform: translate(5px, -12px) rotate(1.5deg); }
  }
  @keyframes pv-pulso {
    0%, 100% { opacity: 0.6; }
    50% { opacity: 1; }
  }
  @keyframes pv-particula {
    0%, 100% { transform: translateY(0); opacity: 0.5; }
    50% { transform: translateY(-18px); opacity: 1; }
  }

  .pv-flotar-orbita { animation: pv-flotar-orbita 9s ease-in-out infinite; }
  .pv-pulso { animation: pv-pulso 6s ease-in-out infinite; }

  .pv-particula {
    position: absolute;
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: ${COLORES.acento};
    animation: pv-particula 8s ease-in-out infinite;
  }

  [data-reveal] {
    opacity: 0;
    transform: translateY(24px);
    filter: blur(6px);
    transition: opacity 650ms ease-out, transform 650ms ease-out, filter 650ms ease-out;
  }
  [data-reveal].pv-visible {
    opacity: 1;
    transform: translateY(0);
    filter: blur(0);
  }

  .pv-conector[data-reveal] {
    opacity: 1;
    filter: none;
    transform: scaleX(0);
    transform-origin: left;
    transition: transform 700ms ease-out;
  }
  .pv-conector[data-reveal].pv-visible {
    transform: scaleX(1);
  }

  .pv-escena { content-visibility: auto; }
  .pv-escena-hero { content-visibility: visible; }
  .pv-seccion-resuelve { contain-intrinsic-size: 1px 700px; }
  .pv-seccion-funciona { contain-intrinsic-size: 1px 600px; }
  .pv-seccion-confianza { contain-intrinsic-size: 1px 500px; }
  .pv-seccion-cierre { contain-intrinsic-size: 1px 450px; }

  .pv-profundidad-0 { transform: translateY(calc(var(--p, 0) * 10px)); }
  .pv-profundidad-1 { transform: translateY(calc(var(--p, 0) * 18px)); }
  .pv-profundidad-2 { transform: translateY(calc(var(--p, 0) * 32px)); }
  .pv-profundidad-3 { transform: translateY(calc(var(--p, 0) * 46px)); }
  .pv-profundidad-5 { transform: translateY(calc(var(--p, 0) * 60px)); }

  @media (prefers-reduced-motion: reduce) {
    [data-reveal] { opacity: 1 !important; transform: none !important; filter: none !important; transition: none !important; }
    .pv-conector[data-reveal] { transform: scaleX(1) !important; }
    .pv-flotar-orbita, .pv-pulso, .pv-particula { animation: none !important; }
    .pv-profundidad-0, .pv-profundidad-1, .pv-profundidad-2, .pv-profundidad-3, .pv-profundidad-5 { transform: none !important; }
  }

  @media (pointer: coarse) {
    .pv-profundidad-0, .pv-profundidad-1, .pv-profundidad-2, .pv-profundidad-5 { transform: none !important; }
  }
`;
