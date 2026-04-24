-- RedefineTables: drop precioEntrada, cantidadDisponible, cantidadVendida de Evento.
-- Source of truth de precio y cupo pasó a Tanda (ver 20260424161500_add_tandas_table).
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Evento" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "nombre" TEXT NOT NULL,
    "descripcion" TEXT NOT NULL,
    "fecha" DATETIME NOT NULL,
    "hora" TEXT NOT NULL,
    "invitado" TEXT NOT NULL DEFAULT '',
    "flyerUrl" TEXT NOT NULL DEFAULT '',
    "esDestacado" BOOLEAN NOT NULL DEFAULT false,
    "estaPublicado" BOOLEAN NOT NULL DEFAULT false,
    "estaAgotado" BOOLEAN NOT NULL DEFAULT false,
    "esExterno" BOOLEAN NOT NULL DEFAULT false,
    "linkExterno" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Evento" ("id", "nombre", "descripcion", "fecha", "hora", "invitado", "flyerUrl", "esDestacado", "estaPublicado", "estaAgotado", "esExterno", "linkExterno", "createdAt", "updatedAt") SELECT "id", "nombre", "descripcion", "fecha", "hora", "invitado", "flyerUrl", "esDestacado", "estaPublicado", "estaAgotado", "esExterno", "linkExterno", "createdAt", "updatedAt" FROM "Evento";
DROP TABLE "Evento";
ALTER TABLE "new_Evento" RENAME TO "Evento";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
