// Lista única de bancos venezolanos con su código BCV de 4 dígitos.
//
// El campo 'bancoOrigen' que exige la API del BDV es ese código, no el nombre: el
// comprobante muestra "Banesco" y la API espera "0134". Esta tabla es la traducción, y la
// usan tanto el selector del formulario del cajero como la normalización de lo que lee la
// IA del comprobante — igual que sucursales.ts es la fuente única de las sucursales.

// Código BCV del propio Banco de Venezuela. Vive aquí, y no repetido como literal en cada
// archivo que lo necesita, porque es contra QUÉ se compara el banco receptor de un
// comprobante BDV para detectar pagos enviados a la cuenta equivocada (ver bdv.ts).
export const CODIGO_BDV = "0102";
// Mismo motivo que CODIGO_BDV, para Sofitasa y Bancamiga: el comprobante escaneado se
// contrasta contra estos códigos para avisar si el pago se envió a un banco distinto.
export const CODIGO_SOFITASA = "0137";
export const CODIGO_BANCAMIGA = "0172";

export const BANCOS = [
  { codigo: CODIGO_BDV, nombre: "Banco de Venezuela" },
  { codigo: "0104", nombre: "Venezolano de Crédito" },
  { codigo: "0105", nombre: "Mercantil" },
  { codigo: "0108", nombre: "Provincial" },
  { codigo: "0114", nombre: "Bancaribe" },
  { codigo: "0115", nombre: "Exterior" },
  { codigo: "0128", nombre: "Banco Caroní" },
  { codigo: "0134", nombre: "Banesco" },
  { codigo: "0137", nombre: "Sofitasa" },
  { codigo: "0138", nombre: "Banco Plaza" },
  { codigo: "0146", nombre: "Bangente" },
  { codigo: "0151", nombre: "BFC Banco Fondo Común" },
  { codigo: "0156", nombre: "100% Banco" },
  { codigo: "0157", nombre: "DelSur" },
  { codigo: "0163", nombre: "Banco del Tesoro" },
  { codigo: "0166", nombre: "Banco Agrícola de Venezuela" },
  { codigo: "0168", nombre: "Bancrecer" },
  { codigo: "0169", nombre: "Mi Banco" },
  { codigo: "0171", nombre: "Banco Activo" },
  { codigo: "0172", nombre: "Bancamiga" },
  { codigo: "0174", nombre: "Banplus" },
  { codigo: "0175", nombre: "Banco Bicentenario" },
  { codigo: "0177", nombre: "Banco de la Fuerza Armada Nacional Bolivariana" },
  { codigo: "0191", nombre: "Banco Nacional de Crédito" },
] as const;

// Códigos válidos, para validar sin recorrer la lista en cada comprobación
export const CODIGOS_BANCO: string[] = BANCOS.map((b) => b.codigo);

export function esCodigoBancoValido(codigo: string): boolean {
  return CODIGOS_BANCO.includes(codigo);
}

// Nombre legible para el panel administrativo; si el código no está en la lista se
// devuelve el código tal cual en vez de "desconocido": es más útil para auditar.
export function nombreDeBanco(codigo: string | null | undefined): string {
  if (!codigo) return "—";
  return BANCOS.find((b) => b.codigo === codigo)?.nombre ?? codigo;
}

// Normaliza un nombre de banco para comparar: sin acentos, sin mayúsculas y sin las
// palabras genéricas ("banco", "universal", "c.a.") que cada comprobante escribe a su
// manera. NFD separa cada letra acentuada de su tilde, y el filtro final a [a-z0-9]
// descarta la tilde suelta: así "Banco Caroní" y "BANCO CARONI" acaban en la misma cadena.
function simplificarNombre(texto: string): string {
  return texto
    .normalize("NFD")
    .toLowerCase()
    .replace(/\b(banco|banca|universal|c\.?a\.?|s\.?a\.?|de|del|la|el)\b/g, "")
    .replace(/[^a-z0-9]/g, "");
}

// Por debajo de esta longitud una coincidencia por subcadena no significa nada.
// Motivo real: "Mi Banco" se simplifica a "mi", y con la comparación por subcadena
// CUALQUIER nombre que contuviera esas dos letras caía en él — "Bancamiga" se traducía a
// 0169 (Mi Banco) en vez de 0172. Nombres cortos como "mi" o "100" solo valen exactos.
const LONGITUD_MIN_SUBCADENA = 5;

// Convierte lo que la IA leyó del comprobante ("Banesco", "BANCO MERCANTIL", "0134") al
// código BCV. Devuelve null si no hay UNA coincidencia inequívoca, y ese null es la
// respuesta correcta y deseable: un código equivocado hace que el BDV responda 1010 y el
// cajero no entienda por qué, mientras que un campo vacío se ve y se corrige en un segundo.
export function normalizarCodigoBanco(valor: unknown): string | null {
  if (typeof valor !== "string") return null;
  const texto = valor.trim();
  if (!texto) return null;

  // Ya viene como código de 4 dígitos
  const soloDigitos = texto.replace(/\D/g, "");
  if (soloDigitos.length === 4 && esCodigoBancoValido(soloDigitos)) return soloDigitos;

  const buscado = simplificarNombre(texto);
  if (!buscado) return null;

  // 1. Coincidencia exacta: el caso normal y el único totalmente fiable
  const exacta = BANCOS.find((b) => simplificarNombre(b.nombre) === buscado);
  if (exacta) return exacta.codigo;

  // 2. Coincidencia parcial, solo para nombres suficientemente largos y solo si es única.
  //    Dos candidatos = ambigüedad, y ante la duda se prefiere el desplegable vacío.
  const parciales = BANCOS.filter((b) => {
    const nombre = simplificarNombre(b.nombre);
    if (nombre.length < LONGITUD_MIN_SUBCADENA || buscado.length < LONGITUD_MIN_SUBCADENA) return false;
    return nombre.includes(buscado) || buscado.includes(nombre);
  });

  return parciales.length === 1 ? parciales[0].codigo : null;
}
