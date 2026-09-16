-- Bancamiga: transferencias/depósitos vía POST /public/protected/consulta/trx, además del
-- Pago Móvil ya soportado (migraciones 003/006/007).
--
-- Aplicar con:  npm run db:migrate
-- Es idempotente: se puede correr varias veces sin efecto secundario.

ALTER TABLE transacciones ADD COLUMN IF NOT EXISTS motivo_bancamiga VARCHAR;

-- Antiduplicado de transferencias Bancamiga.
--
-- El índice de la migración 006 -- UNIQUE (telefono_destino, referencia) WHERE proveedor =
-- 'BANCAMIGA' AND referencia IS NOT NULL -- NO protege este caso: una fila de transferencia
-- no tiene telefono_destino (consulta/trx no devuelve ningún teléfono), así que queda NULL.
-- Postgres trata cada NULL como distinto de cualquier otro NULL dentro de un índice único
-- b-tree — dos filas de transferencia con la MISMA referencia y ambas con telefono_destino
-- NULL nunca chocan contra ese índice. Este segundo índice parcial es la unicidad real para
-- ese caso: 'referencia' sola, acotada a filas BANCAMIGA con telefono_destino IS NULL. No
-- compite con el de la 006 (ambos indexan la misma fila de transferencia sin conflicto entre
-- sí; solo este segundo la protege) — el INSERT de verificar-bancamiga/route.ts apunta su ON
-- CONFLICT al índice que corresponde según el sub-flujo (Pago Móvil vs. transferencia),
-- porque Postgres exige que ON CONFLICT (columnas) WHERE (predicado) empate exactamente con
-- un índice único existente.
CREATE UNIQUE INDEX IF NOT EXISTS transacciones_bancamiga_transferencia_referencia_unica
  ON transacciones (referencia)
  WHERE proveedor = 'BANCAMIGA' AND telefono_destino IS NULL AND referencia IS NOT NULL;
