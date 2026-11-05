-- Afiliados · el cupón de afiliados y la dirección privada de su página — migración
-- ÚNICA, para que el deploy migre una sola vez.
--
-- Aditiva y con defaults: los cupones que ya existen quedan en false/false, o sea
-- exactamente como estaban (descuentan todas las entradas de la compra). No hace
-- falta backfill. La tabla nueva nace vacía: la primera dirección se genera desde
-- el backoffice.
--
-- ⚠️ ESCRITA A MANO, a propósito. `prisma migrate dev` generaba un RedefineTables
-- para `CuponDescuento` (CREATE new_X + INSERT..SELECT + DROP TABLE X + RENAME).
-- Dos ADD COLUMN hacen lo mismo sin reescribir la tabla, que tiene los usos de
-- cupones de compras reales. Los dos campos están al final del modelo para que el
-- orden físico de las columnas coincida con el que Prisma espera.
-- Verificado sin drift: `prisma migrate diff` de la base migrada contra
-- schema.prisma, y de la carpeta de migraciones contra schema.prisma, vacíos.

-- AlterTable · CuponDescuento — beneficio de afiliados + tope de una entrada por compra
ALTER TABLE "CuponDescuento" ADD COLUMN "paraAfiliados" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "CuponDescuento" ADD COLUMN "unaEntradaPorCompra" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable · AccesoAfiliados — la dirección privada, rotable desde el backoffice
CREATE TABLE "AccesoAfiliados" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "token" TEXT NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "creadoPor" TEXT NOT NULL DEFAULT '',
    "ultimoAcceso" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "AccesoAfiliados_token_key" ON "AccesoAfiliados"("token");
