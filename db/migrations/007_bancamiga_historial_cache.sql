-- Caché del historial diario de Bancamiga por sucursal.
--
-- Por qué existe: el banco recomienda no consultar /bancamiga/historial más de una vez
-- cada 10 minutos por teléfono destino (ver README de servidor-bancamiga/), y el puente ya
-- hace respetar ese cooldown devolviendo 429. Pero la búsqueda de un pago concreto
-- (buscarEnListaBancamiga en app/lib/proveedores/bancamiga.ts) necesita el historial del día
-- en CADA verificación que haga un cajero — en una sucursal con varias ventas seguidas, eso
-- choca con el cooldown en minutos. Esta tabla guarda la última lista obtenida por sucursal
-- y fecha; se refresca desde el puente como mucho cada 9 minutos (justo debajo del límite
-- del banco) y, si el puente devuelve el cooldown activo, se reusa la copia en caché aunque
-- esté un poco vieja en vez de fallar la verificación.
--
-- Aplicar con:  npm run db:migrate
-- Es idempotente: se puede correr varias veces sin efecto secundario.

CREATE TABLE IF NOT EXISTS bancamiga_historial_cache (
  sucursal        VARCHAR NOT NULL,
  fecha           VARCHAR NOT NULL, -- AAAA-MM-DD
  lista           JSONB NOT NULL,
  actualizado_en  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (sucursal, fecha)
);
