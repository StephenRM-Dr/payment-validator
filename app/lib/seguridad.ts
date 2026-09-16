// Primitivas de seguridad compartidas entre el portero del cajero y el del administrador.

// Comparación en tiempo constante: siempre recorre la cadena completa, sin cortar
// en la primera diferencia. Una comparación normal (===) tarda un poco más cuanto
// más caracteres coinciden, y esa diferencia de tiempo permite adivinar el secreto
// carácter por carácter en vez de probar todas las combinaciones.
export function comparacionSegura(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diferencia = 0;
  for (let i = 0; i < a.length; i++) diferencia |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diferencia === 0;
}

// Identifica al cliente detrás del proxy de Vercel para poder limitar intentos por origen.
// x-forwarded-for puede traer varias IPs encadenadas; la primera es la del cliente real.
export function ipDeLaPeticion(request: Request): string {
  const cadena = request.headers.get("x-forwarded-for") || "";
  const primera = cadena.split(",")[0]?.trim();
  return primera || request.headers.get("x-real-ip") || "desconocida";
}
