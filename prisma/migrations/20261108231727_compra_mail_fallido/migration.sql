-- La marca de «el mail con el QR no salió» en la compra.
--
-- Aditiva: una columna que admite NULL y sin default, así que las compras que ya
-- existen quedan sin marca, que es lo cierto (no hay registro de que su mail haya
-- fallado). No hace falta backfill.
--
-- ⚠️ ESCRITA A MANO, a propósito. `Compra` es la tabla de la plata y nunca fue
-- reescrita en producción: un ADD COLUMN no la reescribe, y `prisma migrate dev`
-- en SQLite puede generar un RedefineTables (CREATE new_X + INSERT..SELECT + DROP
-- TABLE X + RENAME). El campo está al final del modelo para que el orden físico de
-- las columnas coincida con el que Prisma espera.

-- AlterTable · Compra
ALTER TABLE "Compra" ADD COLUMN "mailFallidoAt" DATETIME;
