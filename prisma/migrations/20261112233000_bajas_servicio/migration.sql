-- Afiliaciones · el Botón de baja de servicio (Disposición 954/2025).
--
-- Aditiva: una tabla nueva, vacía. No toca ninguna tabla existente.
--
-- Cada pedido de baja se guarda acá ANTES de mandar los avisos: un mail puede
-- fallar y un pedido de baja no se puede perder. El código es el comprobante
-- que la persona recibe en la pantalla en el momento.

-- CreateTable · BajaServicio
CREATE TABLE "BajaServicio" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "codigo" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "mensaje" TEXT NOT NULL DEFAULT '',
    "confirmacionEnviadaAt" DATETIME,
    "avisoEnviadoAt" DATETIME,
    "atendidaAt" DATETIME,
    "atendidaPor" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "BajaServicio_codigo_key" ON "BajaServicio"("codigo");

-- CreateIndex
CREATE INDEX "BajaServicio_createdAt_idx" ON "BajaServicio"("createdAt");
