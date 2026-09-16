// Reglas compartidas para los comprobantes fotográficos.
// El cliente comprime hasta este techo y el backend lo exige: el valor debe ser
// exactamente el mismo en ambos lados, por eso vive en un único sitio.

// La imagen llega comprimida desde el cliente (~300 KB típico); 2.5M de caracteres base64
// (~1.8 MB reales) es un techo holgado que corta payloads anómalos.
export const LONGITUD_MAX_IMAGEN = 2_500_000;

// Data-URI de imagen, de tamaño razonable: corta payloads malformados o abusivos.
export function esImagenValida(imagen: string): boolean {
  return imagen.startsWith("data:image/") && imagen.length <= LONGITUD_MAX_IMAGEN;
}
