-- Esquema base de Payment Validator.
--
-- Este archivo documenta el estado de la base de datos tal como existía antes de que el
-- repositorio tuviera migraciones versionadas: hasta ahora el esquema solo vivía en Neon y
-- cada columna nueva se agregaba a mano. Si el despliegue llegaba antes que el ALTER TABLE
-- manual, el panel entero respondía 500 — por eso ahora el esquema viaja con el código.
--
-- Es idempotente: se puede aplicar sobre una base existente sin efecto alguno, o sobre una
-- base vacía para reconstruir el sistema desde cero.
--
-- Aplicar con:  psql "$DATABASE_URL" -f db/migrations/000_esquema_base.sql
-- Verificar con: npm run db:check

-- Estado de conciliación de un pago. PENDIENTE = detectado por el worker pero aún no
-- reclamado por ningún cajero; VERIFICADO = cruzado contra una venta en caja.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'estado_pago') THEN
    CREATE TYPE estado_pago AS ENUM ('PENDIENTE', 'VERIFICADO');
  END IF;
END
$$;

-- Tabla principal: un registro por pago detectado en Binance.
CREATE TABLE IF NOT EXISTS transacciones (
  id                        SERIAL PRIMARY KEY,
  -- Identificación del pago en Binance
  binance_id_completo       VARCHAR UNIQUE,  -- ID de orden numérico (~18 dígitos) o SPOT_<timestamp>
  id_orden                  VARCHAR,         -- ID de orden que ve el cliente en su comprobante
  txid                      VARCHAR,         -- Referencia alfanumérica P_... (transactionId)
  pagador                   VARCHAR,         -- Nombre del pagador según Binance
  binance_raw               JSONB,           -- Payload original completo, para auditoría
  -- Datos del cobro
  monto                     NUMERIC   NOT NULL,
  moneda                    VARCHAR   NOT NULL,
  estado                    estado_pago DEFAULT 'PENDIENTE',
  -- Datos que aporta el cajero al validar
  comanda                   VARCHAR,         -- Número de venta interno del negocio
  ciudad                    VARCHAR,         -- Sucursal que reclamó el pago (NULL = sin reclamar)
  imagen_comprobante_base64 TEXT,            -- Evidencia fotográfica obligatoria
  fecha_cajero              TIMESTAMP,
  fecha_validacion          TIMESTAMP,
  -- Fechas del pago
  fecha_pago                TIMESTAMP,       -- Fecha real del pago según Binance (UTC)
  created_at                TIMESTAMP DEFAULT NOW(),  -- Inserción: sirve para auditar el retraso de detección
  -- Gestión administrativa
  nota                      TEXT             -- Comentario libre del administrador
);

-- Freno de emergencia: permite suspender las validaciones sin desplegar código.
CREATE TABLE IF NOT EXISTS configuracion_sistema (
  id                  SERIAL PRIMARY KEY,
  sistema_activo      BOOLEAN   DEFAULT TRUE,
  mensaje_bloqueo     TEXT      DEFAULT 'El sistema se encuentra temporalmente suspendido por el administrador.',
  ultima_modificacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO configuracion_sistema (id, sistema_activo)
SELECT 1, TRUE
WHERE NOT EXISTS (SELECT 1 FROM configuracion_sistema);

-- Bitácora cruda de lo que reporta el worker de Binance.
CREATE TABLE IF NOT EXISTS transacciones_raw_binance (
  id            SERIAL PRIMARY KEY,
  binance_id    VARCHAR   NOT NULL UNIQUE,
  monto         NUMERIC   NOT NULL,
  moneda        VARCHAR   NOT NULL,
  fecha_ingreso TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- NOTA DE MANTENIMIENTO: en la base actual conviven dos índices únicos sobre
-- transacciones.binance_id_completo — el de la restricción UNIQUE de la columna
-- ('transacciones_binance_id_completo_key') y otro creado a mano después
-- ('transacciones_binance_id_unico'), que resultó redundante. Cualquiera de los dos
-- sostiene el ON CONFLICT del webhook. Se puede eliminar el segundo sin riesgo:
--   DROP INDEX IF EXISTS transacciones_binance_id_unico;
-- No se hace aquí para no alterar producción desde una migración de documentación.
