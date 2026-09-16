-- El negocio pasa a manejar DOS cuentas BDV, repartidas por sucursal, y cada fila deja
-- constancia de en cuál entró el dinero.
--
-- Por qué hace falta la columna y no basta con consultar la cuenta correcta:
--
--   1. Cuadre de caja. Cada cuenta se concilia por separado contra su extracto; sin este
--      dato, un ingreso registrado no se puede atribuir a una cuenta concreta y el panel
--      no puede cuadrar ninguna de las dos.
--   2. Antiduplicado. La referencia del extracto no la genera nuestra cuenta sino el banco
--      del pagador, así que dos cuentas distintas pueden recibir el mismo número. Con el
--      índice único global de la migración 004, un pago legítimo en Maracaibo se rechazaría
--      como "ya cobrado" por una referencia igual usada en Caracas. La unicidad tiene que
--      ser POR CUENTA.
--
-- Aplicar con:  npm run db:migrate
-- Es idempotente: se puede correr varias veces sin efecto secundario.

-- Nulable en la definición porque las filas de Binance no tienen cuenta BDV; el código
-- siempre la rellena en las filas BDV, y el índice de abajo cubre el caso de que no.
ALTER TABLE transacciones ADD COLUMN IF NOT EXISTS cuenta_bdv VARCHAR;

-- Filas BDV anteriores a esta migración: todas se cobraron contra la única cuenta que
-- existía entonces, que es la que hoy sirve a San Cristóbal, Mérida, Barinas y Caracas.
-- El reparto vivo está en app/lib/proveedores/cuentas-bdv.ts; aquí se repite solo para
-- clasificar el histórico, y por eso no vuelve a hacer falta mantenerlo sincronizado.
UPDATE transacciones
   SET cuenta_bdv = CASE
         WHEN ciudad IN ('Maracaibo', 'Valencia', 'Concordia') THEN 'CUENTA_2'
         ELSE 'CUENTA_1'
       END
 WHERE proveedor = 'BDV' AND cuenta_bdv IS NULL;

-- Antiduplicado por cuenta.
--
-- El COALESCE no es adorno: en Postgres dos NULL nunca colisionan en un índice único, así
-- que una fila BDV con cuenta_bdv sin rellenar habría quedado sin protección — exactamente
-- el agujero que la migración 004 vino a tapar en (banco_origen, referencia). Colapsando
-- los nulos a un valor centinela, esas filas siguen compitiendo entre sí por la referencia.
CREATE UNIQUE INDEX IF NOT EXISTS transacciones_bdv_cuenta_referencia_unica
  ON transacciones (COALESCE(cuenta_bdv, 'SIN_CUENTA'), referencia)
  WHERE proveedor = 'BDV' AND referencia IS NOT NULL;

-- Consultas del panel filtradas por cuenta (cuadre de caja de cada una)
CREATE INDEX IF NOT EXISTS transacciones_cuenta_bdv_idx ON transacciones (cuenta_bdv);

-- El índice global de la 004 se retira al final, y solo tras crear el nuevo, para que la
-- tabla no quede ni un instante sin protección contra duplicados.
DROP INDEX IF EXISTS transacciones_bdv_referencia_unica_v2;
