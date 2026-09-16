import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { emitirTokenCajero, peticionDeCajeroValida, COOKIE_CAJERO, VIGENCIA_COOKIE_SEGUNDOS } from "./app/lib/token-cajero";

// Al abrir /cajero, el navegador recibe una cookie firmada que después acompaña
// automáticamente a las peticiones de escaneo y validación (las cookies del mismo
// origen viajan solas en fetch). El cajero no escribe ni ve nada: cero fricción.
//
// La cookie se renueva además en cada llamada a los endpoints del cajero, pero SOLO si
// la que llega ya era válida. Así una app abierta a diario nunca ve caducar su
// credencial, y a la vez tocar la API sin credencial no la entrega: para obtener la
// primera sigue haciendo falta cargar /cajero.
async function debeEmitirCookie(request: NextRequest): Promise<boolean> {
  if (request.nextUrl.pathname === "/cajero") return true;
  return peticionDeCajeroValida(request);
}

export async function middleware(request: NextRequest) {
  const respuesta = NextResponse.next();

  if (!(await debeEmitirCookie(request))) return respuesta;

  const token = await emitirTokenCajero();

  if (token) {
    respuesta.cookies.set(COOKIE_CAJERO, token, {
      httpOnly: true,          // inaccesible desde JavaScript: no se puede robar con XSS
      sameSite: "strict",      // no viaja desde otros sitios
      secure: process.env.NODE_ENV === "production", // en local hay http, en producción https
      path: "/",
      maxAge: VIGENCIA_COOKIE_SEGUNDOS,
    });
  }

  return respuesta;
}

export const config = {
  matcher: ["/cajero", "/api/transacciones/escanear", "/api/transacciones/validar"],
};
