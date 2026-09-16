/**
 * 🏦 Prueba del conciliador de Pagos Móviles contra la API de Movimientos del BDV.
 *
 * Se apoya en datos REALES: descarga los movimientos de un día de la cuenta del negocio,
 * toma créditos verdaderos y comprueba que el buscador los encuentra por referencia +
 * monto, que rechaza un monto alterado, y que no confunde un pago con su comisión.
 *
 * Es de solo lectura: consultar el listado no altera nada del lado del banco (a diferencia
 * de getMovement, cuya consulta exitosa marca el movimiento como conciliado).
 *
 * Uso:  node scripts/pruebas-bdv.mjs [AAAA-MM-DD] [CUENTA_1|CUENTA_2]
 */

import { readFileSync, existsSync } from "node:fs";

// El provider lee su configuración de process.env, así que .env se carga a mano:
// este script corre con node suelto, sin el cargador de variables de Next.js.
for (const archivo of [".env", ".env.local"]) {
  const ruta = new URL(`../${archivo}`, import.meta.url);
  if (!existsSync(ruta)) continue;
  for (const linea of readFileSync(ruta, "utf8").split(/\r?\n/)) {
    const coincidencia = /^([A-Z0-9_]+)=(.*)$/.exec(linea.trim());
    // .env.local pisa a .env, igual que en Next.js
    if (coincidencia) process.env[coincidencia[1]] = coincidencia[2].trim().replace(/^["']|["']$/g, "");
  }
}

const { buscarPagoEnMovimientos, extraerDatosPagador, importeANumero, sufijoReferencia, digitosAComparar, aFechaBdv } =
  await import("../app/lib/proveedores/bdv.ts");
const { distanciaReferencias, CORRECCIONES_MAX_PARECIDO } = await import("../app/lib/proveedores/referencias.ts");

// El negocio tiene dos cuentas BDV. Por defecto se prueba la 1; 'node scripts/pruebas-bdv.mjs
// AAAA-MM-DD CUENTA_2' prueba la otra. Las credenciales se arman aquí en vez de importar
// cuentas-bdv.ts porque ese módulo resuelve la cuenta a partir de una SUCURSAL, y aquí no
// hay ninguna: se prueba el conciliador contra una cuenta concreta.
const clave = (process.argv[3] || "CUENTA_1").toUpperCase();
const credenciales = {
  clave,
  cuenta: ((clave === "CUENTA_2" ? process.env.BDV_CUENTA_2 : process.env.BDV_CUENTA_1) || "").trim(),
  apiKey: ((clave === "CUENTA_2" ? process.env.BDV_API_KEY_2 : process.env.BDV_API_KEY_1) || "").trim(),
  telefonoDestino: null,
};
const { cuenta, apiKey } = credenciales;
if (!cuenta || !apiKey) {
  console.error(`❌ Faltan BDV_CUENTA_${clave.slice(-1)} o BDV_API_KEY_${clave.slice(-1)} en el entorno.`);
  process.exit(1);
}

// Por defecto, ayer: el manual desaconseja barrer el día en curso y un día cerrado
// siempre tiene movimientos completos.
const fecha = process.argv[2] || new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

console.log(`🏦 Conciliación BDV por movimientos — día ${fecha}\n`);

// Se descarga el día una vez para elegir casos de prueba reales
const respuesta = await fetch(
  process.env.BDV_MOVIMIENTOS_URL || "https://bdvconciliacion.banvenez.com/apis/bdv/consulta/movimientos",
  {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
    body: JSON.stringify({ cuenta, fechaIni: aFechaBdv(fecha), fechaFin: aFechaBdv(fecha), tipoMoneda: "VES", nroMovimiento: "" }),
    signal: AbortSignal.timeout(30_000),
  }
).then((r) => r.json());

if (String(respuesta?.code) !== "1000") {
  console.error(`❌ El banco respondió code ${respuesta?.code}: ${respuesta?.message}`);
  process.exit(1);
}

const movimientos = respuesta.data?.movs ?? [];
const creditos = movimientos.filter((m) => String(m.mov).toUpperCase() === "CREDITO");
console.log(`Movimientos del día: ${movimientos.length} (${creditos.length} créditos)\n`);

if (creditos.length === 0) {
  console.error("❌ Ese día no tiene créditos; prueba con otra fecha.");
  process.exit(1);
}

let fallos = 0;
const comprobar = (etiqueta, condicion, detalle = "") => {
  console.log(`${condicion ? "✅" : "❌"} ${etiqueta}${detalle ? ` — ${detalle}` : ""}`);
  if (!condicion) fallos++;
};

// ── 1. Pagos reales: el buscador debe encontrarlos por referencia + monto ──────────────
console.log("── Pagos reales del día (deben encontrarse) ──");
for (const credito of creditos.slice(0, 3)) {
  const importe = importeANumero(credito.importe);
  const resultado = await buscarPagoEnMovimientos(credito.referencia, importe, fecha, credenciales);
  const pagador = resultado.estado === "ENCONTRADO" ? resultado.pagador : null;
  comprobar(
    `ref ...${sufijoReferencia(credito.referencia)} · Bs. ${importe.toFixed(2)}`,
    resultado.estado === "ENCONTRADO",
    resultado.estado === "ENCONTRADO"
      ? `pagador: banco ${pagador.bancoOrigen ?? "?"}, ${pagador.telefonoPagador ?? pagador.cedulaPagador ?? "sin identificar"}`
      : resultado.mensaje
  );
}

// ── 1b. La referencia del comprobante es más corta que la del extracto ────────────────
// El extracto publica la referencia concatenada (prefijo interno + la del comprobante), y
// el cliente enseña solo la cola. Se comprueba que el cruce funciona con 8 y con 6 dígitos.
console.log("\n── Referencia recortada, como la ve el cliente (8 y 6 dígitos) ──");
{
  const credito = creditos[0];
  const importe = importeANumero(credito.importe);
  const digitos = String(credito.referencia).replace(/\D/g, "");

  for (const largo of [8, 6]) {
    const comoLaVeElCliente = digitos.slice(-largo);
    const resultado = await buscarPagoEnMovimientos(comoLaVeElCliente, importe, fecha, credenciales);
    comprobar(
      `ref "${comoLaVeElCliente}" (${largo}d) contra extracto "${credito.referencia}"`,
      resultado.estado === "ENCONTRADO",
      `se comparan ${digitosAComparar(comoLaVeElCliente)} dígitos`
    );
  }

  // Con menos de 6 dígitos significativos no se cruza por referencia —arriesgaría
  // confundir dos pagos—, pero tampoco se rechaza la búsqueda entera: cae al respaldo por
  // monto, igual que una referencia de sobra que no coincidiera con ninguna del día. Caso
  // real que lo motivó: BBVA Provincial imprimió una referencia cuyos dígitos
  // significativos eran solo 5 ("000012100" → "12100"), y el sistema la rechazaba sin
  // haber llegado siquiera a mirar el extracto.
  const corta = digitos.slice(-4);
  const resultado = await buscarPagoEnMovimientos(corta, importe, fecha, credenciales);
  // Nunca "ENCONTRADO": sin dígitos suficientes para el cruce por referencia, el respaldo
  // por monto SIEMPRE pide confirmación del cajero, aunque haya un solo candidato.
  comprobar(
    `ref "${corta}" (4d, muy corta) cae al respaldo por monto en vez de rechazarse`,
    resultado.estado === "CANDIDATOS_POR_MONTO",
    `estado ${resultado.estado}`
  );
}

// ── 2. El cajero teclea un monto equivocado: debe rechazarse, no colarse ───────────────
console.log("\n── Monto alterado (debe rechazarse indicando el monto real) ──");
{
  const credito = creditos[0];
  const importeReal = importeANumero(credito.importe);
  const resultado = await buscarPagoEnMovimientos(credito.referencia, importeReal + 100, fecha, credenciales);
  comprobar(
    `ref ...${sufijoReferencia(credito.referencia)} con Bs. ${(importeReal + 100).toFixed(2)}`,
    resultado.estado === "MONTO_DISTINTO" && resultado.montoBanco === importeReal.toFixed(2),
    resultado.estado === "MONTO_DISTINTO" ? `el banco reporta Bs. ${resultado.montoBanco}` : `estado ${resultado.estado}`
  );
}

// ── 3. Referencia inexistente ─────────────────────────────────────────────────────────
console.log("\n── Referencia inventada (debe no encontrarse) ──");
{
  const resultado = await buscarPagoEnMovimientos("99999999", 1, fecha, credenciales);
  comprobar("ref 99999999", resultado.estado === "NO_ENCONTRADO", resultado.mensaje?.slice(0, 70));
}

// ── 4. La comisión del banco NO debe poder validarse como si fuera un pago ─────────────
// Es el riesgo real: cada pago móvil recibido genera un DÉBITO de comisión que comparte
// los últimos 8 dígitos de la referencia con el pago que lo originó.
console.log("\n── Comisión del banco (DÉBITO) presentada como pago ──");
{
  const debitos = movimientos.filter((m) => String(m.mov).toUpperCase() !== "CREDITO");
  const comision = debitos.find((d) => creditos.some((c) => sufijoReferencia(c.referencia) === sufijoReferencia(d.referencia)));
  if (!comision) {
    console.log("⚠️  Ese día no hay comisiones que compartan sufijo con un crédito; caso no evaluado.");
  } else {
    const montoComision = importeANumero(comision.importe);
    const resultado = await buscarPagoEnMovimientos(comision.referencia, montoComision, fecha, credenciales);
    comprobar(
      `débito "${String(comision.observacion).trim().slice(0, 30)}" por Bs. ${montoComision.toFixed(2)}`,
      resultado.estado !== "ENCONTRADO",
      `estado ${resultado.estado} (el crédito gemelo existe, pero por otro monto)`
    );
  }
}

// ── 5. Lectura de los datos del pagador desde la observación ──────────────────────────
console.log("\n── Datos del pagador extraídos de la observación ──");
{
  const casos = [
    ["PAGOMOVIL OTROS BANCOS 0134 04241168708", { bancoOrigen: "0134", telefonoPagador: "04241168708" }],
    ["PAGOMOVIL BDV V029898428 MASSIEL    HERRERA", { bancoOrigen: "0102", cedulaPagador: "V29898428" }],
    ["PAGO RECIBIDO OTROS BANCOS 0191 J123456789", { bancoOrigen: "0191", cedulaPagador: "J123456789" }],
  ];
  for (const [observacion, esperado] of casos) {
    const leido = extraerDatosPagador(observacion);
    const ok = Object.entries(esperado).every(([k, v]) => leido[k] === v);
    comprobar(`"${observacion.slice(0, 42)}"`, ok, JSON.stringify(leido));
  }
}

// ── 6. Parecido entre la referencia escaneada y la del extracto ───────────────────────
// Es lo que decide si al cajero se le señala un candidato como "casi igual". El caso real:
// el recibo decía 000993610016 y el escáner leyó 993610160 — perdió un cero y corrió los
// dígitos. Debe salir dentro del umbral, o el cajero descarta el pago correcto.
console.log("\n── Parecido de referencias (respaldo cuando el OCR falla un dígito) ──");
{
  const casos = [
    ["93610016", "93610160", true, "cero perdido, dígitos corridos (caso real 13/08)"],
    ["93610016", "93610017", true, "un dígito mal leído"],
    ["93610016", "93610016", true, "idénticas"],
    ["93610016", "48127734", false, "pago totalmente distinto"],
  ];
  for (const [banco, escaneada, esperadoParecido, nota] of casos) {
    const correcciones = distanciaReferencias(banco, escaneada);
    comprobar(
      `${escaneada} vs ${banco} — ${nota}`,
      (correcciones <= CORRECCIONES_MAX_PARECIDO) === esperadoParecido,
      `${correcciones} corrección(es); umbral ${CORRECCIONES_MAX_PARECIDO}`
    );
  }
}

console.log("");
if (fallos > 0) {
  console.error(`❌ ${fallos} comprobación(es) fallaron.`);
  process.exit(1);
}
console.log("✅ Todas las comprobaciones pasaron contra datos reales del banco.");
