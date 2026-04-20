-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
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
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Home" ("id", "slider1Url", "slider2Url", "slider3Url", "textoEvento", "updatedAt", "youtubeUrl") SELECT "id", "slider1Url", "slider2Url", "slider3Url", "textoEvento", "updatedAt", "youtubeUrl" FROM "Home";
DROP TABLE "Home";
ALTER TABLE "new_Home" RENAME TO "Home";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
