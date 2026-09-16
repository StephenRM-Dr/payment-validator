-- Bancamiga: la caché del historial pasa a guardarse por TELÉFONO DESTINO, no por
-- sucursal. Varias sucursales pueden compartir la misma cuenta Bancamiga (mismo
-- teléfono de Pago Móvil — confirmado en producción: San Cristóbal, Barinas, Caracas,
-- Valencia, Maracaibo y Concordia comparten una, Mérida tiene la suya propia), y el
-- cooldown de 10 minutos que impone el banco en /bancamiga/historial también es por
-- teléfono, no por sucursal (ver servidor-bancamiga/src/servidor.mjs).
--
-- Con la caché vieja (migración 007, clave por sucursal), cada sucursal guardaba su
-- propia fila aunque el teléfono fuera el mismo: la sucursal que pedía el historial
-- DESPUÉS de otra con el mismo teléfono chocaba con el cooldown del banco sin tener
-- una copia propia en caché a la que caer — fallaba la verificación del cajero en vez
-- de reusar el historial (idéntico, es la misma cuenta) que ya tenía la otra sucursal.
-- Esto explicaba por qué solo funcionaban de forma consistente las sucursales con
-- teléfono propio (Mérida) o la que primero pedía el historial del día.
--
-- bancamiga_sucursal_telefono guarda el último teléfono conocido por sucursal, para
-- poder resolver la clave de caché SIN llamar al banco (el puente ahora devuelve el
-- teléfono en /bancamiga/historial — ver bancamiga.ts). Es una resolución local, pura
-- información de mapeo: no cuenta contra el cooldown del banco.
--
-- Aplicar con:  npm run db:migrate
-- Recrea bancamiga_historial_cache: es una caché pura (datos derivables del banco, no
-- registros de negocio), así que perder su contenido en la migración es inofensivo —
-- se vuelve a poblar sola en la siguiente verificación. La migración es idempotente:
-- se puede correr varias veces sin efecto secundario.

DROP TABLE IF EXISTS bancamiga_historial_cache;

CREATE TABLE bancamiga_historial_cache (
  telefono_destino VARCHAR NOT NULL,
  fecha             VARCHAR NOT NULL, -- AAAA-MM-DD
  lista             JSONB NOT NULL,
  sucursal          VARCHAR NOT NULL, -- última sucursal que refrescó esta fila; solo para depuración, no participa en la clave
  actualizado_en    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (telefono_destino, fecha)
);

CREATE TABLE IF NOT EXISTS bancamiga_sucursal_telefono (
  sucursal          VARCHAR PRIMARY KEY,
  telefono_destino  VARCHAR NOT NULL,
  actualizado_en    TIMESTAMPTZ NOT NULL DEFAULT now()
);
