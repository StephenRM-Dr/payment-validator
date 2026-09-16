-- Historial de saldos bancarios de Sofitasa (Acme Corp y Beta Corp).
--
-- Lo llena el corte diario (GET /api/cron/saldos, disparado por Vercel Cron al cierre de
-- operaciones) con una fila por cuenta y por empresa. La consulta en vivo del admin
-- (GET /api/admin/saldos) NO escribe aquí: solo lee el saldo actual del banco en el
-- momento de la petición, sin persistirlo.
--
-- Es un registro de monitoreo, no un libro contable: a diferencia de 'transacciones', no
-- lleva índice antiduplicado. Una fila repetida por un reintento de red no representa
-- dinero mal contado, solo una lectura de más el mismo día.
--
-- Aplicar con:  npm run db:migrate
-- Es idempotente: se puede correr varias veces sin efecto secundario.

CREATE TABLE IF NOT EXISTS saldos_historial (
  id            SERIAL PRIMARY KEY,
  empresa       VARCHAR NOT NULL,       -- 'acme' | 'beta'
  cuenta        VARCHAR NOT NULL,       -- número de cuenta, tal como lo devuelve el banco
  producto      VARCHAR,                -- código de producto del banco; puede venir vacío
  moneda        VARCHAR NOT NULL,       -- 'USD' | 'COP' | 'VES', según la cuenta
  saldo         NUMERIC NOT NULL,
  capturado_en  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- El panel siempre pide "el historial de esta empresa, más reciente primero"
CREATE INDEX IF NOT EXISTS saldos_historial_empresa_fecha_idx
  ON saldos_historial (empresa, capturado_en DESC);
