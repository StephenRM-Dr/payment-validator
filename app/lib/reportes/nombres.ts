// Nombre de archivo del reporte — en su propio módulo, sin dependencias (ni de la base
// de datos ni de exceljs), para que scripts/sincronizar-reportes-drive.mjs pueda
// importarlo sin arrastrar @neondatabase/serverless (que generar.ts sí necesita, y que
// además vive en devDependencies: un `npm install --omit=dev` en el equipo local
// rompería el script si importara nombreDeArchivo desde generar.ts).
export function nombreDeArchivo(sucursal: string, fechaIso: string): string {
  return `Reporte_${sucursal.replace(/\s+/g, "_")}_${fechaIso}.xlsx`;
}
