-- CreateTable
CREATE TABLE "Tanda" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "eventoId" INTEGER NOT NULL,
    "nombre" TEXT NOT NULL,
    "precio" INTEGER NOT NULL,
    "orden" INTEGER NOT NULL,
    "activa" BOOLEAN NOT NULL DEFAULT true,
    "capacidad" INTEGER,
    "cantidadVendida" INTEGER NOT NULL DEFAULT 0,
    "fechaLimite" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Tanda_eventoId_fkey" FOREIGN KEY ("eventoId") REFERENCES "Evento" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Tanda_eventoId_orden_key" ON "Tanda"("eventoId", "orden");

-- AlterTable: add tandaId to Compra (nullable FK, ON DELETE SET NULL)
ALTER TABLE "Compra" ADD COLUMN "tandaId" INTEGER REFERENCES "Tanda" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
