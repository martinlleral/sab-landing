-- RedefineTables
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
    "boxDiaOverride" TEXT NOT NULL DEFAULT '',
    "boxFechaOverride" TEXT NOT NULL DEFAULT '',
    "boxHoraOverride" TEXT NOT NULL DEFAULT '',
    "boxLugarOverride" TEXT NOT NULL DEFAULT '',
    "boxCiudadOverride" TEXT NOT NULL DEFAULT '',
    "boxPrecioOverride" TEXT NOT NULL DEFAULT '',
    "boxEtiquetaEntradaOverride" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Evento" ("createdAt", "descripcion", "esDestacado", "esExterno", "estaAgotado", "estaPublicado", "fecha", "flyerUrl", "hora", "id", "invitado", "linkExterno", "nombre", "updatedAt") SELECT "createdAt", "descripcion", "esDestacado", "esExterno", "estaAgotado", "estaPublicado", "fecha", "flyerUrl", "hora", "id", "invitado", "linkExterno", "nombre", "updatedAt" FROM "Evento";
DROP TABLE "Evento";
ALTER TABLE "new_Evento" RENAME TO "Evento";
CREATE TABLE "new_Home" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "slider1Url" TEXT NOT NULL DEFAULT '',
    "slider2Url" TEXT NOT NULL DEFAULT '',
    "slider3Url" TEXT NOT NULL DEFAULT '',
    "textoEvento" TEXT NOT NULL DEFAULT '',
    "youtubeUrl" TEXT NOT NULL DEFAULT '',
    "totalEdiciones" INTEGER NOT NULL DEFAULT 0,
    "totalShows" INTEGER NOT NULL DEFAULT 0,
    "totalPersonas" INTEGER NOT NULL DEFAULT 0,
    "boxLugar" TEXT NOT NULL DEFAULT 'Espacio Doble T',
    "boxCiudad" TEXT NOT NULL DEFAULT 'La Plata',
    "boxEtiquetaEntrada" TEXT NOT NULL DEFAULT 'Anticipada online',
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Home" ("id", "slider1Url", "slider2Url", "slider3Url", "textoEvento", "totalEdiciones", "totalPersonas", "totalShows", "updatedAt", "youtubeUrl") SELECT "id", "slider1Url", "slider2Url", "slider3Url", "textoEvento", "totalEdiciones", "totalPersonas", "totalShows", "updatedAt", "youtubeUrl" FROM "Home";
DROP TABLE "Home";
ALTER TABLE "new_Home" RENAME TO "Home";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
