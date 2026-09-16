-- Pagos Móviles del Banco de Venezuela (BDV) en el mismo libro contable que Binance.
--
-- Contexto: hasta ahora 'transacciones' asumía un único proveedor. Binance funciona en
-- modo *push* — un worker detecta el pago, el webhook inserta una fila PENDIENTE y el
-- cajero después la reclama. BDV no puede funcionar así: su API (manual MDU-006) expone
-- un solo endpoint, POST /getMovement, que responde por UN pago concreto. No hay listado
-- ni consulta por fecha, así que ningún worker puede descubrir pagos por su cuenta.
--
-- Por eso BDV es *pull*: el cajero escanea, el sistema le pregunta al banco por ese pago,
-- y si el banco responde code 1000 la fila nace ya en estado VERIFICADO. El banco ocupa
-- el lugar que en Binance ocupa el worker: es la fuente de verdad del dinero.
--
-- Se usa la misma tabla con una columna discriminadora, y no una tabla aparte, porque el
-- panel administrativo, las métricas, la exportación a CSV, la anulación y la tabla
-- transacciones_historial (que tiene FK a transacciones.id) ya apuntan aquí: separar las
-- tablas obligaría a reescribir todo eso sin ganar nada.
--
-- Aplicar con:  psql "$DATABASE_URL" -f db/migrations/003_proveedor_bdv.sql
-- Verificar con: npm run db:check
-- Es idempotente: se puede correr varias veces sin efecto secundario.

-- Columna discriminadora. El DEFAULT 'BINANCE' clasifica correctamente todas las filas
-- históricas sin necesidad de un UPDATE de backfill: hasta hoy todo pago era de Binance.
ALTER TABLE transacciones
  ADD COLUMN IF NOT EXISTS proveedor VARCHAR NOT NULL DEFAULT 'BINANCE';

-- Campos propios del Pago Móvil BDV. Nulables porque no aplican a Binance; son
-- exactamente los que el manual exige en el JSON de entrada de /getMovement.
ALTER TABLE transacciones ADD COLUMN IF NOT EXISTS referencia       VARCHAR;  -- referencia del pago (solo dígitos)
ALTER TABLE transacciones ADD COLUMN IF NOT EXISTS telefono_pagador VARCHAR;  -- línea del cliente que pagó
ALTER TABLE transacciones ADD COLUMN IF NOT EXISTS telefono_destino VARCHAR;  -- línea Pago Móvil del negocio
ALTER TABLE transacciones ADD COLUMN IF NOT EXISTS cedula_pagador   VARCHAR;  -- cédula/RIF del ordenante (V/E/J + dígitos)
ALTER TABLE transacciones ADD COLUMN IF NOT EXISTS banco_origen     VARCHAR;  -- código BCV de 4 dígitos del banco emisor
-- Respuesta íntegra del banco. Es la evidencia de auditoría del lado BDV, equivalente a
-- binance_raw: si mañana se discute un cobro, aquí está lo que el banco respondió y cuándo.
ALTER TABLE transacciones ADD COLUMN IF NOT EXISTS bdv_raw          JSONB;

-- El panel filtra por proveedor en cada consulta
CREATE INDEX IF NOT EXISTS transacciones_proveedor_idx ON transacciones (proveedor);

-- Anti-duplicado de BDV: el equivalente al índice único de binance_id_completo.
--
-- Es lo que impide que un mismo comprobante se cobre dos veces (el riesgo real: el cliente
-- enseña la misma captura en dos sucursales). No basta con comprobarlo con un SELECT previo
-- —dos cajeros simultáneos lo pasarían los dos—: el índice es lo que sostiene el
-- ON CONFLICT DO NOTHING del INSERT, que resuelve la carrera en la base de datos.
--
-- La clave es (banco_origen, referencia) y no la referencia sola: cada banco emisor numera
-- sus referencias por su cuenta, así que dos bancos distintos sí pueden repetir un número.
--
-- El índice es PARCIAL (WHERE proveedor = 'BDV') para no imponerle ninguna restricción a
-- las filas de Binance, donde ambas columnas quedan NULL.
CREATE UNIQUE INDEX IF NOT EXISTS transacciones_bdv_referencia_unica
  ON transacciones (banco_origen, referencia)
  WHERE proveedor = 'BDV';
