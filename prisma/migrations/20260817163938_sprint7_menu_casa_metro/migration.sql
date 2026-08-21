-- Sprint 7 · Menú de Casa Metro (ítems 43a/43b/43c) — migración ÚNICA con los 6 campos.
--
-- Aditiva y con defaults: los eventos y compras que ya existen quedan en 0/false,
-- o sea "no ofrece menú" / "no compró menú". No hace falta backfill.
--
-- ⚠️ ESCRITA A MANO, a propósito. `prisma migrate dev` generaba un RedefineTables
-- (CREATE new_X + INSERT..SELECT + DROP TABLE X + RENAME) para las tres tablas.
-- Sobre la base de producción, que tiene ventas vivas, eso significaba reescribir
-- `Compra` — la tabla de la plata, que nunca fue reescrita en prod (la migración
-- del 5/7 sumó los campos de devolución con ALTER TABLE). Seis ADD COLUMN hacen
-- exactamente lo mismo sin tocar los datos existentes.
-- Verificado con `prisma migrate dev` post-aplicación: no queda drift respecto de
-- schema.prisma. Los 6 campos están al final de sus modelos justamente para que el
-- orden físico de las columnas coincida con el que Prisma espera.

-- AlterTable · Home — precio global del menú + hora de corte de venta
ALTER TABLE "Home" ADD COLUMN "precioMenu" INTEGER NOT NULL DEFAULT 15000;
ALTER TABLE "Home" ADD COLUMN "menuCorteHora" TEXT NOT NULL DEFAULT '18:00';

-- AlterTable · Evento — toggle por evento + tope de menús (null = sin tope)
ALTER TABLE "Evento" ADD COLUMN "menuHabilitado" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Evento" ADD COLUMN "topeMenus" INTEGER;

-- AlterTable · Compra — cantidad propia + precio congelado al momento de comprar
ALTER TABLE "Compra" ADD COLUMN "cantidadMenus" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Compra" ADD COLUMN "menuUnitario" INTEGER NOT NULL DEFAULT 0;
