-- Generaliza saldos_historial a más de un banco: hasta ahora solo guardaba Sofitasa. BDV se
-- suma con la misma forma de fila (ver app/lib/proveedores/saldos-tipos.ts) — su saldo se
-- deriva del último movimiento del extracto, no de un endpoint de saldo dedicado como el de
-- Sofitasa, pero de cara a esta tabla es una fila más.
--
-- Aplicar con:  npm run db:migrate
-- Es idempotente: se puede correr varias veces sin efecto secundario.

-- El DEFAULT solo es para las filas que ya existían (todas eran de Sofitasa, la única
-- fuente hasta ahora); se retira después para que toda fila nueva tenga que decir de qué
-- banco es, igual que ya exige la columna 'proveedor' de 'transacciones'.
ALTER TABLE saldos_historial ADD COLUMN IF NOT EXISTS proveedor VARCHAR NOT NULL DEFAULT 'SOFITASA';
ALTER TABLE saldos_historial ALTER COLUMN proveedor DROP DEFAULT;

-- El índice anterior solo servía a Sofitasa (una empresa = una fila del historial); ahora
-- "empresa" por sí sola puede repetirse entre bancos, así que el filtro típico del panel
-- ("el historial de este banco y esta empresa") necesita las dos columnas.
DROP INDEX IF EXISTS saldos_historial_empresa_fecha_idx;
CREATE INDEX IF NOT EXISTS saldos_historial_proveedor_empresa_fecha_idx
  ON saldos_historial (proveedor, empresa, capturado_en DESC);
