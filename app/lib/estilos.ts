import type { CSSProperties } from "react";

// Estilos compartidos por las pantallas (panel administrativo y formulario del cajero).
// Ambas usan la misma paleta y los mismos campos de formulario; tenerlos aquí evita
// repetir el mismo objeto inline en cada elemento y que las pantallas se desvíen entre sí.

export const COLORES = {
  fondo: "#11111b",
  panel: "#1e1e2e",
  campo: "#313244",
  borde: "#45475a",
  bordeSuave: "#585b70",
  texto: "#cdd6f4",
  textoSuave: "#a6adc8",
  textoTenue: "#6c7086",
  acento: "#cba6f7",
  exito: "#a6e3a1",
  aviso: "#f9e2af",
  error: "#f38ba8",
  info: "#89b4fa",
} as const;

// Campo de formulario del cajero (select e input): tipografía grande y táctil,
// pensada para usarse desde el teléfono en el mostrador.
export const estiloCampoCajero: CSSProperties = {
  width: "100%",
  padding: "12px",
  borderRadius: "6px",
  border: `1px solid ${COLORES.borde}`,
  background: COLORES.campo,
  color: "#fff",
  fontSize: "16px",
  boxSizing: "border-box",
};

// Etiqueta que envuelve cada campo del formulario del cajero
export const estiloEtiquetaCajero: CSSProperties = {
  fontSize: "14px",
  color: COLORES.textoSuave,
  display: "flex",
  flexDirection: "column",
  gap: "5px",
};

// Filtros del panel administrativo
export const estiloInputAdmin: CSSProperties = {
  padding: "8px",
  borderRadius: "6px",
  background: COLORES.campo,
  color: "#fff",
  border: `1px solid ${COLORES.borde}`,
  fontWeight: "bold",
  colorScheme: "dark",
};

export const estiloEtiquetaAdmin: CSSProperties = {
  fontSize: "12px",
  color: COLORES.textoSuave,
  fontWeight: "bold",
};

export const estiloCelda: CSSProperties = { padding: "12px" };

export const estiloBotonPagina: CSSProperties = {
  padding: "8px 12px",
  borderRadius: "6px",
  border: "none",
  fontWeight: "bold",
  color: COLORES.fondo,
};

// Fondo oscuro a pantalla completa de los modales (comprobante y nota)
export const estiloOverlayModal: CSSProperties = {
  position: "fixed",
  top: 0,
  left: 0,
  width: "100%",
  height: "100%",
  background: "rgba(0,0,0,0.85)",
  display: "flex",
  justifyContent: "center",
  alignItems: "center",
  zIndex: 1000,
  padding: "20px",
  boxSizing: "border-box",
};
