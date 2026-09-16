-- Límite de intentos de acceso al panel administrativo (por IP).
--
-- El contador debe vivir en la base de datos y no en memoria: en Vercel cada petición
-- puede atenderla una instancia distinta del servidor, así que un contador en memoria
-- se reiniciaría continuamente y el bloqueo nunca llegaría a activarse.
--
-- Aplicar con:  psql "$DATABASE_URL" -f db/migrations/001_intentos_admin.sql
-- Es idempotente: se puede correr varias veces sin efecto secundario.

CREATE TABLE IF NOT EXISTS intentos_admin (
  ip               VARCHAR PRIMARY KEY,
  intentos         INTEGER   NOT NULL DEFAULT 0,
  bloqueado_hasta  TIMESTAMP,
  actualizado_en   TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Para purgar registros viejos sin recorrer toda la tabla
CREATE INDEX IF NOT EXISTS intentos_admin_actualizado_en_idx
  ON intentos_admin (actualizado_en);
