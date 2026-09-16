-- Anulación de transacciones e historial de ediciones administrativas.
--
-- Contexto: una devolución al cliente dejaba la fila en VERIFICADO, así que el dinero
-- devuelto seguía sumando en las métricas y en el CSV como venta buena; la nota era solo
-- texto libre que ninguna métrica leía. Y las ediciones del panel (número de venta, nota)
-- sobrescribían el valor anterior sin dejar rastro, en un libro que se exporta a contabilidad.
--
-- Se usa una columna booleana en vez de un valor nuevo del enum 'estado_pago' a propósito:
-- conserva el estado original de la transacción (fue verificada de verdad, y después se
-- anuló), no rompe ninguna consulta existente y es reversible — de un enum de Postgres no
-- se puede quitar un valor una vez añadido.
--
-- Aplicar con:  psql "$DATABASE_URL" -f db/migrations/002_anulacion_e_historial.sql
-- Es idempotente: se puede correr varias veces sin efecto secundario.

ALTER TABLE transacciones
  ADD COLUMN IF NOT EXISTS anulada BOOLEAN NOT NULL DEFAULT FALSE;

-- Las métricas filtran por esta columna en cada consulta del panel
CREATE INDEX IF NOT EXISTS transacciones_anulada_idx
  ON transacciones (anulada);

-- Rastro de auditoría de cada edición hecha desde el panel administrativo.
-- 'ip' es la mejor atribución disponible hoy: todos los administradores comparten el
-- mismo PIN, así que identificar a la persona exacta requeriría usuarios individuales.
CREATE TABLE IF NOT EXISTS transacciones_historial (
  id              SERIAL PRIMARY KEY,
  transaccion_id  INTEGER   NOT NULL REFERENCES transacciones(id) ON DELETE CASCADE,
  campo           VARCHAR   NOT NULL,
  valor_anterior  TEXT,
  valor_nuevo     TEXT,
  ip              VARCHAR,
  cambiado_en     TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS transacciones_historial_transaccion_idx
  ON transacciones_historial (transaccion_id, cambiado_en DESC);
