-- Afiliados · el contenido de la página de afiliadxs (la lista de videos).
--
-- Aditiva: una tabla nueva, vacía. La fila la crea el backoffice la primera vez
-- que se guarda la lista. No toca ninguna tabla existente.
--
-- Tabla propia y no una columna de `Home`: `GET /api/home` es público y devuelve
-- la fila entera, y la lista sólo la recibe la página privada.

-- CreateTable · ContenidoAfiliados
CREATE TABLE "ContenidoAfiliados" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "listaUrl" TEXT NOT NULL DEFAULT '',
    "updatedAt" DATETIME NOT NULL
);
