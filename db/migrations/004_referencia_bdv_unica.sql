-- El antiduplicado de BDV pasa a apoyarse solo en la referencia.
--
-- Contexto: la migración 003 creó un índice único sobre (banco_origen, referencia) porque
-- entonces el cajero elegía el banco emisor a mano y la columna siempre traía valor. Al
-- conciliar contra la API de Consulta de Movimientos, el banco emisor deja de teclearse y
-- se deduce del campo 'observacion' del movimiento — y ahí puede venir un formato que no
-- reconozcamos, dejando banco_origen en NULL.
--
-- Eso rompe el antiduplicado en silencio: en Postgres dos NULL se consideran distintos, así
-- que un índice único sobre (banco_origen, referencia) NO impide insertar dos veces la misma
-- referencia si el banco no se pudo identificar. Sería exactamente el caso en el que más
-- falta hace la protección.
--
-- La referencia sola basta y sobra como clave: se guarda la que publica el banco en el
-- listado (13 dígitos), no la que teclea el cajero, y medida sobre 421 créditos reales de la
-- cuenta no hubo ni una sola colisión — ni siquiera comparando solo los últimos 6 dígitos.
--
-- Aplicar con:  psql "$DATABASE_URL" -f db/migrations/004_referencia_bdv_unica.sql
--          o:  npm run db:migrate
-- Es idempotente: se puede correr varias veces sin efecto secundario.

-- La referencia es obligatoria en toda fila BDV: sin ella no hay antiduplicado posible.
CREATE UNIQUE INDEX IF NOT EXISTS transacciones_bdv_referencia_unica_v2
  ON transacciones (referencia)
  WHERE proveedor = 'BDV' AND referencia IS NOT NULL;

-- Se elimina el índice de la 003 al final, y solo después de crear el nuevo, para que la
-- tabla nunca quede ni un instante sin protección contra duplicados.
DROP INDEX IF EXISTS transacciones_bdv_referencia_unica;
