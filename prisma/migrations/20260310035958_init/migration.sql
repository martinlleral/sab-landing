-- CreateTable
CREATE TABLE "Home" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "slider1Url" TEXT NOT NULL DEFAULT '',
    "slider2Url" TEXT NOT NULL DEFAULT '',
    "slider3Url" TEXT NOT NULL DEFAULT '',
    "textoEvento" TEXT NOT NULL DEFAULT '',
    "youtubeUrl" TEXT NOT NULL DEFAULT '',
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Evento" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "nombre" TEXT NOT NULL,
    "descripcion" TEXT NOT NULL,
    "fecha" DATETIME NOT NULL,
    "hora" TEXT NOT NULL,
    "invitado" TEXT NOT NULL DEFAULT '',
    "precioEntrada" INTEGER NOT NULL,
    "cantidadDisponible" INTEGER NOT NULL,
    "cantidadVendida" INTEGER NOT NULL DEFAULT 0,
    "flyerUrl" TEXT NOT NULL DEFAULT '',
    "esDestacado" BOOLEAN NOT NULL DEFAULT false,
    "estaPublicado" BOOLEAN NOT NULL DEFAULT false,
    "esExterno" BOOLEAN NOT NULL DEFAULT false,
    "linkExterno" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Compra" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "eventoId" INTEGER NOT NULL,
    "email" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "apellido" TEXT NOT NULL,
    "telefono" TEXT NOT NULL DEFAULT '',
    "cantidadEntradas" INTEGER NOT NULL,
    "precioUnitario" INTEGER NOT NULL,
    "totalPagado" INTEGER NOT NULL,
    "mpPreferenciaId" TEXT NOT NULL DEFAULT '',
    "mpPagoId" TEXT NOT NULL DEFAULT '',
    "mpEstado" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Compra_eventoId_fkey" FOREIGN KEY ("eventoId") REFERENCES "Evento" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Entrada" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "compraId" INTEGER NOT NULL,
    "codigoQR" TEXT NOT NULL,
    "qrImageUrl" TEXT NOT NULL,
    "validada" BOOLEAN NOT NULL DEFAULT false,
    "validadaAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Entrada_compraId_fkey" FOREIGN KEY ("compraId") REFERENCES "Compra" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Usuario" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "nombre" TEXT NOT NULL,
    "apellido" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "telefono" TEXT NOT NULL DEFAULT '',
    "password" TEXT NOT NULL,
    "rol" INTEGER NOT NULL DEFAULT 2,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "Entrada_codigoQR_key" ON "Entrada"("codigoQR");

-- CreateIndex
CREATE UNIQUE INDEX "Usuario_email_key" ON "Usuario"("email");
