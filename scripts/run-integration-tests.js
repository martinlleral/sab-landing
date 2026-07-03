#!/usr/bin/env node
/**
 * Runner de los tests de integración.
 *
 * Auto-descubre todos los `tests/integration/*.test.js` y los corre uno por uno
 * (secuencial a propósito: comparten la misma dev.db de SQLite, así que correrlos
 * en paralelo haría que se pisen los fixtures). Cada test es un script Node
 * autónomo que sale con código 0 = PASS / ≠0 = FAIL; el runner junta los códigos
 * y termina en 1 si alguno falló, para servir de gate en CI o pre-push.
 *
 * Uso:
 *   npm test                 → corre los tests puros (contra dev.db, sin server)
 *   npm test -- compras      → corre solo los que matchean "compras" en el nombre
 *   npm test -- --all        → incluye también los @requires-server
 *
 * Los tests marcados con `@requires-server` en su header pegan contra un server
 * HTTP vivo (localhost:3000). El runner los SALTEA por default para que el gate
 * quede verde offline, y los incluye si hay server disponible: cuando está
 * seteado TEST_BASE_URL o cuando se pasa --all.
 *
 * Cualquier `*.test.js` nuevo que se agregue a tests/integration/ entra solo.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const INTEGRATION_DIR = path.join(__dirname, '..', 'tests', 'integration');
const args = process.argv.slice(2);
const incluirServer = args.includes('--all') || !!process.env.TEST_BASE_URL;
const filtro = (args.find((a) => !a.startsWith('--')) || '').toLowerCase();

const requiereServer = (rutaAbs) =>
  fs.readFileSync(rutaAbs, 'utf8').includes('@requires-server');

const todos = fs
  .readdirSync(INTEGRATION_DIR)
  .filter((f) => f.endsWith('.test.js'))
  .filter((f) => !filtro || f.toLowerCase().includes(filtro))
  .sort();

const salteados = [];
const archivos = todos.filter((f) => {
  if (incluirServer) return true;
  if (requiereServer(path.join(INTEGRATION_DIR, f))) {
    salteados.push(f);
    return false;
  }
  return true;
});

if (archivos.length === 0) {
  console.error(filtro
    ? `No hay tests de integración que matcheen "${filtro}".`
    : 'No se encontraron tests de integración.');
  process.exit(1);
}

console.log('═'.repeat(72));
console.log(`Runner de integración — ${archivos.length} suite(s)${filtro ? ` (filtro: "${filtro}")` : ''}`);
if (salteados.length) {
  console.log(`⏭  ${salteados.length} salteada(s) por @requires-server (usá --all para incluirlas): ${salteados.join(', ')}`);
}
console.log('═'.repeat(72));

const resultados = [];
const t0 = Date.now();

for (const archivo of archivos) {
  const ruta = path.join(INTEGRATION_DIR, archivo);
  const inicio = Date.now();
  console.log(`\n▶ ${archivo}`);
  console.log('─'.repeat(72));

  const res = spawnSync('node', [ruta], { stdio: 'inherit' });
  const ms = Date.now() - inicio;

  // spawnSync devuelve status=null si el proceso murió por señal (ej. crash).
  const ok = res.status === 0;
  resultados.push({ archivo, ok, ms, status: res.status, signal: res.signal });
}

const totalMs = Date.now() - t0;
const fallidos = resultados.filter((r) => !r.ok);

console.log('\n' + '═'.repeat(72));
console.log('RESUMEN');
console.log('═'.repeat(72));
for (const r of resultados) {
  const icono = r.ok ? '✅' : '❌';
  const detalle = r.ok
    ? ''
    : r.signal ? ` (señal ${r.signal})` : ` (exit ${r.status})`;
  console.log(`${icono} ${r.archivo}  ${(r.ms / 1000).toFixed(1)}s${detalle}`);
}
console.log('─'.repeat(72));
console.log(
  `${fallidos.length === 0 ? '✅' : '❌'} ${resultados.length - fallidos.length}/${resultados.length} suites OK` +
  `  ·  ${(totalMs / 1000).toFixed(1)}s`,
);

process.exit(fallidos.length === 0 ? 0 : 1);
