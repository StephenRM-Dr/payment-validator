import { NextResponse } from "next/server";
import { obtenerSql, conReintentos, esErrorDeConexion, type SqlNeon } from "../../../../lib/db";
import { verificarAccesoAdmin } from "../../../../lib/auth-admin";
import { ipDeLaPeticion } from "../../../../lib/seguridad";
import { estaEnModoDemo, editarDemo } from "../../../../lib/datos-demo";

const LONGITUD_MAX_COMANDA = 60;
const LONGITUD_MAX_NOTA = 500;

// Convierte un valor del body a texto solo si es un primitivo legítimo;
// objetos o arrays enviados con malicia se tratan como vacío.
function comoTexto(valor: unknown): string {
  if (typeof valor === "string") return valor;
  if (typeof valor === "number" && Number.isFinite(valor)) return String(valor);
  return "";
}

interface CamposEdicion {
  tieneComanda: boolean;
  tieneNota: boolean;
  tieneAnulada: boolean;
  comanda?: string;
  nota?: string | null;
  anulada?: boolean;
}

type ResultadoCampos = { ok: true; campos: CamposEdicion } | { ok: false; error: string };

// Lee y valida qué se quiere cambiar. Los tres campos son opcionales, pero al menos uno
// debe venir: 'comanda' no puede quedar vacía (rompería la trazabilidad que se busca),
// mientras que 'nota' sí puede enviarse vacía a propósito para borrar una nota anterior.
function extraerCampos(body: Record<string, unknown>): ResultadoCampos {
  const tieneComanda = "comanda" in body;
  const tieneNota = "nota" in body;
  const tieneAnulada = "anulada" in body;

  if (!tieneComanda && !tieneNota && !tieneAnulada) {
    return { ok: false, error: "No se envió ningún campo para actualizar (comanda, nota o anulada)." };
  }

  const campos: CamposEdicion = { tieneComanda, tieneNota, tieneAnulada };

  // Se rechaza en vez de recortar: truncar en silencio hacía creer al administrador
  // que se había guardado el texto completo.
  if (tieneComanda) {
    campos.comanda = comoTexto(body.comanda).trim();
    if (!campos.comanda) {
      return { ok: false, error: "⚠️ El número de venta no puede quedar vacío." };
    }
    if (campos.comanda.length > LONGITUD_MAX_COMANDA) {
      return { ok: false, error: `⚠️ El número de venta no puede superar ${LONGITUD_MAX_COMANDA} caracteres.` };
    }
  }

  if (tieneNota) {
    const nota = comoTexto(body.nota).trim();
    if (nota.length > LONGITUD_MAX_NOTA) {
      return { ok: false, error: `⚠️ La nota no puede superar ${LONGITUD_MAX_NOTA} caracteres.` };
    }
    campos.nota = nota || null;
  }

  if (tieneAnulada) {
    campos.anulada = body.anulada === true;
  }

  return { ok: true, campos };
}

// 📜 Rastro de auditoría: una fila por campo modificado, con su valor anterior.
// Es un libro que se exporta a contabilidad; un cambio sin rastro es justo lo que un
// auditor cuestionaría. Nunca interrumpe la edición: si el historial falla, se registra
// en el log del servidor pero el cambio del administrador ya quedó guardado.
async function registrarHistorial(
  sql: SqlNeon,
  id: number,
  previa: Record<string, unknown>,
  actual: Record<string, unknown>,
  campos: CamposEdicion,
  ip: string
): Promise<void> {
  const cambios: { campo: string; anterior: string | null; nuevo: string | null }[] = [];

  if (campos.tieneComanda && previa.comanda !== actual.comanda) {
    cambios.push({ campo: "comanda", anterior: (previa.comanda as string) ?? null, nuevo: (actual.comanda as string) ?? null });
  }
  if (campos.tieneNota && previa.nota !== actual.nota) {
    cambios.push({ campo: "nota", anterior: (previa.nota as string) ?? null, nuevo: (actual.nota as string) ?? null });
  }
  if (campos.tieneAnulada && previa.anulada !== actual.anulada) {
    cambios.push({ campo: "anulada", anterior: String(Boolean(previa.anulada)), nuevo: String(Boolean(actual.anulada)) });
  }

  if (cambios.length === 0) return;

  try {
    for (const cambio of cambios) {
      await sql`
        INSERT INTO transacciones_historial (transaccion_id, campo, valor_anterior, valor_nuevo, ip)
        VALUES (${id}, ${cambio.campo}, ${cambio.anterior}, ${cambio.nuevo}, ${ip});
      `;
    }
    console.log(`📜 [Editar Transacción] ${cambios.length} cambio(s) registrados en el historial de la transacción ${id}.`);
  } catch (error_) {
    console.error("❌ [Editar Transacción] No se pudo registrar el historial:", error_);
  }
}

type EdicionPreparada =
  | { ok: true; id: number; campos: CamposEdicion }
  | { ok: false; response: NextResponse };

// Validación compartida por ambos caminos (demo y Postgres): ID de la URL, cuerpo JSON
// y qué campos se piden cambiar. Separado de PATCH para que el control de complejidad
// del linter no cuente estos tres chequeos tempranos junto con el resto del handler.
async function prepararEdicion(request: Request, params: Promise<{ id: string }>): Promise<EdicionPreparada> {
  const { id: idParam } = await params;
  const id = Number.parseInt(idParam, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return { ok: false, response: NextResponse.json({ error: "ID de transacción inválido." }, { status: 400 }) };
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return { ok: false, response: NextResponse.json({ error: "Cuerpo de petición inválido." }, { status: 400 }) };
  }

  const resultado = extraerCampos(body);
  if (resultado.ok === false) {
    return { ok: false, response: NextResponse.json({ error: resultado.error }, { status: 400 }) };
  }

  return { ok: true, id, campos: resultado.campos };
}

// Edición administrativa puntual de una transacción: número de venta, nota interna y
// anulación. No pasa por las reglas del cajero (duplicados, conciliación de fondos) porque
// es una corrección de trazabilidad sobre un registro que ya existe, no una nueva validación.
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    // 🔒 Mismo control de acceso que el resto del panel administrativo
    const acceso = await verificarAccesoAdmin(request);
    if (acceso.ok === false) {
      return NextResponse.json({ error: acceso.error }, { status: acceso.estado });
    }

    const preparado = await prepararEdicion(request, params);
    if (preparado.ok === false) return preparado.response;
    const { id, campos } = preparado;

    // 🧪 Sin DATABASE_URL: la edición se aplica sobre la grilla demo en memoria en vez
    // de Postgres — mismas reglas de negocio (nota obligatoria para anular, etc.).
    if (estaEnModoDemo()) {
      const resultadoDemo = editarDemo(id, campos);
      if (resultadoDemo.ok === false) {
        return NextResponse.json({ error: resultadoDemo.error }, { status: resultadoDemo.status });
      }
      return NextResponse.json({ transaccion: resultadoDemo.transaccion }, { status: 200 });
    }

    const sql = obtenerSql();

    // Estado previo: necesario para el historial (qué cambió exactamente) y para exigir
    // justificación al anular.
    const [previa] = await conReintentos(() => sql`
      SELECT id, comanda, nota, anulada, ciudad FROM transacciones WHERE id = ${id} LIMIT 1;
    `);

    if (!previa) {
      return NextResponse.json({ error: "No existe una transacción con ese ID." }, { status: 404 });
    }

    // Una fila sin reclamar (ciudad NULL) es dinero que ningún cajero ha vinculado todavía a
    // una venta: ponerle comanda desde aquí crearía un registro con número de venta pero sin
    // sucursal, que después el cajero puede reclamar y pisar. La nota y la anulación sí se
    // permiten, porque son anotaciones administrativas que no compiten con el flujo del cajero.
    if (campos.tieneComanda && !previa.ciudad) {
      return NextResponse.json(
        { error: "⚠️ Esta transacción aún no ha sido reclamada por ningún cajero: no se le puede asignar un número de venta desde aquí." },
        { status: 409 }
      );
    }

    // Anular saca el dinero de las métricas, así que debe quedar justificado por escrito:
    // se exige una nota, la que ya exista o la que venga en esta misma petición.
    if (campos.anulada === true && !(campos.tieneNota ? campos.nota : previa.nota)) {
      return NextResponse.json(
        { error: "⚠️ Para anular una transacción debes explicar el motivo en la nota (ej: devolución por cancelación del cliente)." },
        { status: 400 }
      );
    }

    // UPDATE parcial: solo toca las columnas presentes en la petición (se reusa el valor
    // actual de la columna cuando el campo no vino, para no pisarlo con NULL por accidente).
    const [actualizada] = await conReintentos(() => sql`
      UPDATE transacciones
      SET
        comanda = ${campos.tieneComanda ? campos.comanda : sql`comanda`},
        nota = ${campos.tieneNota ? campos.nota : sql`nota`},
        anulada = ${campos.tieneAnulada ? campos.anulada : sql`anulada`}
      WHERE id = ${id}
      RETURNING id, comanda, nota, anulada;
    `);

    await registrarHistorial(sql, id, previa, actualizada, campos, ipDeLaPeticion(request));

    return NextResponse.json({ transaccion: actualizada }, { status: 200 });

  } catch (error) {
    console.error("❌ [Editar Transacción] Error:", error);

    if (esErrorDeConexion(error)) {
      return NextResponse.json(
        { error: "⚠️ Fallo temporal de conexión con la base de datos. Inténtalo de nuevo." },
        { status: 503 }
      );
    }

    return NextResponse.json({ error: "Fallo interno al actualizar la transacción." }, { status: 500 });
  }
}
