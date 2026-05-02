-- CreateTable
CREATE TABLE "CuponDescuento" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "eventoId" INTEGER NOT NULL,
    "codigo" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "valor" INTEGER NOT NULL,
    "topeUsos" INTEGER,
    "usosActuales" INTEGER NOT NULL DEFAULT 0,
    "validoHasta" DATETIME,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CuponDescuento_eventoId_fkey" FOREIGN KEY ("eventoId") REFERENCES "Evento" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CuponUso" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "cuponId" INTEGER NOT NULL,
    "compraId" INTEGER NOT NULL,
    "descuentoAplicado" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CuponUso_cuponId_fkey" FOREIGN KEY ("cuponId") REFERENCES "CuponDescuento" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "CuponUso_compraId_fkey" FOREIGN KEY ("compraId") REFERENCES "Compra" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Compra" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "eventoId" INTEGER NOT NULL,
    "tandaId" INTEGER,
    "email" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "apellido" TEXT NOT NULL,
    "telefono" TEXT NOT NULL DEFAULT '',
    "cantidadEntradas" INTEGER NOT NULL,
    "precioUnitario" INTEGER NOT NULL,
    "totalPagado" INTEGER NOT NULL,
    "tipoEntrada" TEXT NOT NULL DEFAULT 'base',
    "excedenteUnitario" INTEGER NOT NULL DEFAULT 0,
    "mpPreferenciaId" TEXT NOT NULL DEFAULT '',
    "mpPagoId" TEXT NOT NULL DEFAULT '',
    "mpEstado" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Compra_eventoId_fkey" FOREIGN KEY ("eventoId") REFERENCES "Evento" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Compra_tandaId_fkey" FOREIGN KEY ("tandaId") REFERENCES "Tanda" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Compra" ("apellido", "cantidadEntradas", "createdAt", "email", "eventoId", "id", "mpEstado", "mpPagoId", "mpPreferenciaId", "nombre", "precioUnitario", "tandaId", "telefono", "totalPagado", "updatedAt") SELECT "apellido", "cantidadEntradas", "createdAt", "email", "eventoId", "id", "mpEstado", "mpPagoId", "mpPreferenciaId", "nombre", "precioUnitario", "tandaId", "telefono", "totalPagado", "updatedAt" FROM "Compra";
DROP TABLE "Compra";
ALTER TABLE "new_Compra" RENAME TO "Compra";
CREATE TABLE "new_Tanda" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "eventoId" INTEGER NOT NULL,
    "nombre" TEXT NOT NULL,
    "precio" INTEGER NOT NULL,
    "orden" INTEGER NOT NULL,
    "activa" BOOLEAN NOT NULL DEFAULT true,
    "capacidad" INTEGER,
    "cantidadVendida" INTEGER NOT NULL DEFAULT 0,
    "fechaLimite" DATETIME,
    "porcentajeAporte" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Tanda_eventoId_fkey" FOREIGN KEY ("eventoId") REFERENCES "Evento" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Tanda" ("activa", "cantidadVendida", "capacidad", "createdAt", "eventoId", "fechaLimite", "id", "nombre", "orden", "precio", "updatedAt") SELECT "activa", "cantidadVendida", "capacidad", "createdAt", "eventoId", "fechaLimite", "id", "nombre", "orden", "precio", "updatedAt" FROM "Tanda";
DROP TABLE "Tanda";
ALTER TABLE "new_Tanda" RENAME TO "Tanda";
CREATE UNIQUE INDEX "Tanda_eventoId_orden_key" ON "Tanda"("eventoId", "orden");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "CuponDescuento_codigo_key" ON "CuponDescuento"("codigo");

-- CreateIndex
CREATE UNIQUE INDEX "CuponUso_compraId_key" ON "CuponUso"("compraId");
