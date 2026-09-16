// app/layout.tsx
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Payment Validator",
  description: "Sistema de Validación de Pagos",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="es">
      <body style={{ margin: 0, padding: 0, backgroundColor: "#11111b" }}>
        {children}
      </body>
    </html>
  );
}