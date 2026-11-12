-- Afiliaciones · los tres planes de suscripción que muestra /afiliate.
--
-- Aditiva y con defaults vacíos: la fila de Home que ya existe queda sin planes
-- (nombre '', monto 0, link ''), y /afiliate muestra entonces sólo el WhatsApp.
-- Los planes los carga la coordinación desde el panel después del deploy: el
-- repo no lleva montos ni links.
--
-- ⚠️ ESCRITA A MANO, como la del menú (20260817163938): nueve ADD COLUMN en vez
-- del RedefineTables que puede generar `migrate dev` en SQLite. Los campos están
-- al final del modelo para que el orden físico coincida con el de Prisma.

-- AlterTable · Home — plan 1
ALTER TABLE "Home" ADD COLUMN "afiliacionPlan1Nombre" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Home" ADD COLUMN "afiliacionPlan1Monto" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Home" ADD COLUMN "afiliacionPlan1Link" TEXT NOT NULL DEFAULT '';

-- AlterTable · Home — plan 2
ALTER TABLE "Home" ADD COLUMN "afiliacionPlan2Nombre" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Home" ADD COLUMN "afiliacionPlan2Monto" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Home" ADD COLUMN "afiliacionPlan2Link" TEXT NOT NULL DEFAULT '';

-- AlterTable · Home — plan 3
ALTER TABLE "Home" ADD COLUMN "afiliacionPlan3Nombre" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Home" ADD COLUMN "afiliacionPlan3Monto" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Home" ADD COLUMN "afiliacionPlan3Link" TEXT NOT NULL DEFAULT '';
