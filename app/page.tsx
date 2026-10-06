import type { Metadata, Viewport } from "next";
import VisorInicio from "./inicio";

// La raíz no tenía page.tsx (de ahí el 404): esta es la landing de entrada,
// con acceso directo a las dos vistas operativas. Metadata propia porque el
// title/description de layout.tsx son los genéricos del sistema interno.
export const metadata: Metadata = {
  title: "Payment Validator — Verificación de pagos multi-banco",
  description:
    "Payment Validator cruza cada comprobante contra el banco o el riel cripto antes de aceptar el pago: OCR de IA, verificación directa y auditoría completa.",
};

export const viewport: Viewport = { themeColor: "#11111b" };

export default function PaginaInicio() {
  return <VisorInicio />;
}
