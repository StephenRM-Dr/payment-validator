-- Pagos Móviles de Sofitasa y Bancamiga en el mismo libro contable que Binance/BDV.
--
-- Mismo espíritu que 003_proveedor_bdv.sql y 005_cuenta_bdv.sql: se reutiliza la tabla
-- 'transacciones' con la columna discriminadora 'proveedor' (ya genérica, no cambia) y las
-- columnas que BDV ya dejó listas para cualquier pago móvil (referencia, telefono_pagador,
-- telefono_destino, banco_origen, cedula_pagador) — solo hacen falta las columnas propias de
-- cada banco para la evidencia de auditoría, y los índices de antiduplicado.
--
-- Aplicar con:  npm run db:migrate
-- Es idempotente: se puede correr varias veces sin efecto secundario.

-- Respuesta íntegra del puente en el paso de confirmación (equivalente a bdv_raw): si mañana
-- se discute un cobro, aquí está lo que el banco respondió y cuándo.
ALTER TABLE transacciones ADD COLUMN IF NOT EXISTS sofitasa_raw  JSONB;
ALTER TABLE transacciones ADD COLUMN IF NOT EXISTS bancamiga_raw JSONB;

-- A qué empresa de Sofitasa (Acme Corp / Beta Corp) pertenece el pago — análoga a
-- cuenta_bdv. Nulable porque solo aplica a filas SOFITASA.
ALTER TABLE transacciones ADD COLUMN IF NOT EXISTS empresa_sofitasa VARCHAR;

-- El panel filtra por proveedor y por empresa en sus consultas
CREATE INDEX IF NOT EXISTS transacciones_empresa_sofitasa_idx ON transacciones (empresa_sofitasa);

-- Antiduplicado de Sofitasa: la clave es (empresa_sofitasa, referencia) y no la referencia
-- sola, porque cada empresa tiene su propio ClienteCod ante el banco y ambas pueden recibir,
-- en teoría, una referencia con el mismo número sin ser el mismo pago.
CREATE UNIQUE INDEX IF NOT EXISTS transacciones_sofitasa_referencia_unica
  ON transacciones (empresa_sofitasa, referencia)
  WHERE proveedor = 'SOFITASA' AND referencia IS NOT NULL;

-- Antiduplicado de Bancamiga: reutiliza telefono_destino (ya existe desde la migración 003)
-- como la "cuenta" — Bancamiga opera con un solo login pero 7 teléfonos de sucursal, y la
-- referencia la numera el banco del pagador, así que dos sucursales sí podrían recibir la
-- misma referencia sin ser el mismo pago. Mismo razonamiento que cuenta_bdv para BDV.
CREATE UNIQUE INDEX IF NOT EXISTS transacciones_bancamiga_referencia_unica
  ON transacciones (telefono_destino, referencia)
  WHERE proveedor = 'BANCAMIGA' AND referencia IS NOT NULL;
