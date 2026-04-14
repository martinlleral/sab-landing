#!/bin/sh
set -e

echo "▶ Ejecutando migraciones..."
npx prisma migrate deploy

echo "▶ Ejecutando seed (solo si es necesario)..."
node prisma/seed.js 2>/dev/null || echo "  Seed ya aplicado o sin cambios, continuando..."

echo "▶ Iniciando servidor..."
exec node src/server.js
