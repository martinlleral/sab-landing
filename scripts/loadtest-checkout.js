#!/usr/bin/env node
/**
 * Load test del endpoint /api/compras/preferencia.
 *
 * Simula N usuarios concurrentes creando preferencias MP durante D segundos.
 * Mide: P50, P95, P99 de latencia, error rate, throughput (RPS).
 *
 * Por qué existe este test:
 * SQLite + Prisma serializa writes. Con 50+ compras concurrentes puede haber
 * contención en el INSERT de la compra + sesiones (connect.sqlite3). Este
 * script valida que el tail latency no explota bajo carga.
 *
 * Uso:
 *   node scripts/loadtest-checkout.js
 *   LOAD_TARGET=http://localhost:3000 LOAD_VUS=10 LOAD_DURATION=15 node scripts/loadtest-checkout.js
 *
 * Variables:
 *   LOAD_TARGET       URL base (default: http://localhost:3000)
 *   LOAD_VUS          Usuarios virtuales concurrentes (default: 20)
 *   LOAD_DURATION     Duración en segundos (default: 30)
 *   LOAD_EVENTO_ID    ID del evento a comprar (default: el primero de /api/eventos/proximos)
 *   LOAD_DRY_RUN=1    Log requests sin enviar (para dev)
 *
 * ⚠ CONSIDERACIONES:
 * 1. Este script crea compras reales en la DB con mpEstado='pending'. No llegan
 *    al checkout de MP (solo crea la preferencia). Las 6 compras test=$1 que ya
 *    están en DB son ejemplo del tipo de registros que deja.
 * 2. Si corrés contra prod, Cloudflare Bot Fight puede bloquear antes de llegar
 *    al origen → vas a ver 429 CF en vez de timing real del backend.
 *    Para validación pura de backend, correr contra localhost o un droplet sin CF.
 * 3. Después del test, limpiar las compras test de la DB:
 *       DELETE FROM Compra WHERE email LIKE 'loadtest-%' AND mpEstado='pending';
 *
 * Output: JSON con métricas + resumen human-readable.
 */

const TARGET = process.env.LOAD_TARGET || 'http://localhost:3000';
const VUS = parseInt(process.env.LOAD_VUS) || 20;
const DURATION = parseInt(process.env.LOAD_DURATION) || 30;
const DRY_RUN = process.env.LOAD_DRY_RUN === '1';

async function getEventoId() {
  if (process.env.LOAD_EVENTO_ID) return parseInt(process.env.LOAD_EVENTO_ID);
  const res = await fetch(`${TARGET}/api/eventos/proximos`);
  if (!res.ok) throw new Error(`/api/eventos/proximos devolvió ${res.status}`);
  const eventos = await res.json();
  if (!Array.isArray(eventos) || eventos.length === 0) {
    throw new Error('No hay eventos próximos. Pasá LOAD_EVENTO_ID=N explícito.');
  }
  return eventos[0].id;
}

function payload(i) {
  return {
    eventoId: null,
    email: `loadtest-${Date.now()}-${i}@smoke.invalid`,
    nombre: 'LoadTest',
    apellido: `User${i}`,
    telefono: '221 555-0000',
    cantidad: 1,
  };
}

async function hit(eventoId, i) {
  const start = performance.now();
  const body = { ...payload(i), eventoId };
  if (DRY_RUN) {
    console.log('[dry]', JSON.stringify(body));
    return { ok: true, status: 200, ms: 0 };
  }
  try {
    const res = await fetch(`${TARGET}/api/compras/preferencia`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const ms = performance.now() - start;
    await res.text();
    return { ok: res.ok, status: res.status, ms };
  } catch (err) {
    const ms = performance.now() - start;
    return { ok: false, status: 0, ms, error: err.message };
  }
}

function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function vuLoop(eventoId, endAt, vuId, results) {
  let i = 0;
  while (performance.now() < endAt) {
    const r = await hit(eventoId, vuId * 1000 + i);
    results.push(r);
    i++;
  }
}

(async () => {
  console.log(`\nLoad test → ${TARGET}/api/compras/preferencia`);
  console.log(`VUs: ${VUS} · Duración: ${DURATION}s · Dry-run: ${DRY_RUN}\n`);

  const eventoId = await getEventoId();
  console.log(`Evento usado: #${eventoId}\n`);

  const results = [];
  const endAt = performance.now() + DURATION * 1000;
  const workers = Array.from({ length: VUS }, (_, v) => vuLoop(eventoId, endAt, v, results));
  await Promise.all(workers);

  const total = results.length;
  const ok = results.filter((r) => r.ok).length;
  const errs = results.filter((r) => !r.ok);
  const byStatus = {};
  for (const r of results) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  const latOk = results.filter((r) => r.ok).map((r) => r.ms);

  const p50 = percentile(latOk, 50);
  const p95 = percentile(latOk, 95);
  const p99 = percentile(latOk, 99);
  const max = Math.max(...latOk, 0);
  const rps = total / DURATION;

  console.log('─'.repeat(60));
  console.log('Resultados');
  console.log('─'.repeat(60));
  console.log(`Total requests:      ${total}`);
  console.log(`OK (2xx):            ${ok} (${(ok / total * 100).toFixed(1)}%)`);
  console.log(`Throughput:          ${rps.toFixed(1)} RPS`);
  console.log(`Status codes:        ${JSON.stringify(byStatus)}`);
  console.log();
  console.log('Latencia (requests OK):');
  console.log(`  P50:               ${p50.toFixed(0)} ms`);
  console.log(`  P95:               ${p95.toFixed(0)} ms`);
  console.log(`  P99:               ${p99.toFixed(0)} ms`);
  console.log(`  MAX:               ${max.toFixed(0)} ms`);
  console.log();

  // Heurísticas de PASS/FAIL
  const fails = [];
  if (ok / total < 0.95) fails.push(`error rate ${(100 - ok / total * 100).toFixed(1)}% > 5%`);
  if (p95 > 3000) fails.push(`P95 ${p95.toFixed(0)}ms > 3000ms (usuarios percibirán lentitud)`);
  if (p99 > 10000) fails.push(`P99 ${p99.toFixed(0)}ms > 10000ms (timeouts de browser)`);

  if (fails.length === 0) {
    console.log('✅ PASS — el endpoint aguanta la carga propuesta.\n');
    process.exit(0);
  }
  console.log('❌ FAIL:');
  fails.forEach((f) => console.log(`  - ${f}`));
  if (errs.length > 0) {
    console.log('\nPrimeros 3 errores:');
    errs.slice(0, 3).forEach((e) => console.log(`  - status=${e.status} ${e.error || ''}`));
  }
  console.log();
  process.exit(1);
})();
