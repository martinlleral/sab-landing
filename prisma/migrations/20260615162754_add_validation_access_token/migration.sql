-- CreateTable
CREATE TABLE "ValidationAccessToken" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "token" TEXT NOT NULL,
    "descripcion" TEXT NOT NULL DEFAULT '',
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "creadoPor" TEXT NOT NULL DEFAULT '',
    "ultimoAcceso" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "ValidationAccessToken_token_key" ON "ValidationAccessToken"("token");
