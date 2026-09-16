// Venezuela no tiene horario de verano, así que el offset es una constante fija —a
// diferencia de zonas con DST, no hace falta ninguna librería de zonas horarias para
// calcular esto correctamente.
const OFFSET_VENEZUELA_HORAS = 4; // UTC-4

// Dado un Date cuyos componentes UTC (año/mes/día) representan el día calendario que se
// quiere reportar, devuelve el rango [inicio, fin) en instantes UTC reales que cubren ese
// día completo en hora Venezuela. Se usan los getters UTC del Date de entrada (no los
// locales) para que el resultado no dependa de la zona horaria del proceso que llama.
export function rangoDelDiaEnVenezuela(fecha: Date): { inicio: Date; fin: Date } {
  const inicio = new Date(
    Date.UTC(fecha.getUTCFullYear(), fecha.getUTCMonth(), fecha.getUTCDate(), OFFSET_VENEZUELA_HORAS)
  );
  const fin = new Date(inicio.getTime() + 24 * 60 * 60 * 1000);
  return { inicio, fin };
}

function aFechaLocal(instanteUtc: Date): Date {
  return new Date(instanteUtc.getTime() - OFFSET_VENEZUELA_HORAS * 60 * 60 * 1000);
}

function relleno(n: number): string {
  return String(n).padStart(2, "0");
}

export function fechaISOVenezuela(instanteUtc: Date): string {
  const local = aFechaLocal(instanteUtc);
  return `${local.getUTCFullYear()}-${relleno(local.getUTCMonth() + 1)}-${relleno(local.getUTCDate())}`;
}

export function formatearFechaHoraVenezuela(instanteUtc: Date): string {
  const local = aFechaLocal(instanteUtc);
  return `${fechaISOVenezuela(instanteUtc)} ${relleno(local.getUTCHours())}:${relleno(local.getUTCMinutes())}`;
}
