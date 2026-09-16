// Descarga de archivos desde el navegador (panel administrativo y formulario del cajero).

// Dispara la descarga de una URL (data-URI u objeto Blob) con el nombre indicado.
// El enlace temporal se añade al DOM porque Firefox y algunos navegadores móviles
// ignoran el click() sobre un <a> que no está insertado en el documento.
export function descargarArchivo(url: string, nombreArchivo: string): void {
  const enlace = document.createElement("a");
  enlace.href = url;
  enlace.download = nombreArchivo;
  document.body.appendChild(enlace);
  enlace.click();
  document.body.removeChild(enlace);
}

// Igual que descargarArchivo, pero para contenido generado en memoria:
// crea la URL del Blob y la libera al terminar para no filtrar memoria.
export function descargarBlob(blob: Blob, nombreArchivo: string): void {
  const url = URL.createObjectURL(blob);
  try {
    descargarArchivo(url, nombreArchivo);
  } finally {
    URL.revokeObjectURL(url);
  }
}
