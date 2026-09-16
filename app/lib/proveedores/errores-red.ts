// undici/Node solo da 'fetch failed' (o 'TimeoutError') como mensaje para CUALQUIER fallo de
// red — no dice si fue DNS, un RST de TLS, conexión rechazada, etc. La causa real vive en
// 'error.cause' y por defecto nunca se ve en los logs: un bloqueo del túnel y una caída real
// del servidor remoto se ven exactamente igual. Compartido entre bdv.ts y sofitasa.ts, que
// tenían la misma lógica duplicada.
export function detalleDeErrorRed(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  if (!(error.cause instanceof Error)) return `${error.name}: ${error.message}`;

  const codigo = (error.cause as NodeJS.ErrnoException).code;
  const sufijoCodigo = codigo ? ` [${codigo}]` : "";
  return `${error.name}: ${error.message} (causa: ${error.cause.name}: ${error.cause.message}${sufijoCodigo})`;
}
