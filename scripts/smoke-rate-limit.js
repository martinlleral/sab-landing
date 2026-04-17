#!/usr/bin/env node
/**
 * Smoke test del rate limiting en /api/auth/login.
 *
 * Por qué existe:
 * El repo no tiene suite de tests (ni jest ni mocha). Este script es
 * "documentación ejecutable" del comportamiento esperado del rate limiter.
 * Si alguien refactorea server.js y borra los app.use(loginLimiter), este
 * script falla y lo hace evidente.
 *
 * Cómo usar:
 *   1. Levantar la app localmente (docker compose up -d o npm run dev).
 *   2. node scripts/smoke-rate-limit.js
 *   3. Sale con código 0 si PASA, 1 si FALLA.
 *
 * Qué valida:
 *   - Los primeros 10 intentos de login con credenciales falsas devuelven 401.
 *   - Los intentos 11 y 12 devuelven 429 (Too Many Requests).
 *   - La respuesta 429 incluye header RateLimit-Remaining: 0 (standard draft-7).
 *
 * Nota: requiere Node 20+ (fetch nativo).
 */

const TARGET = process.env.SMOKE_TARGET || 'http://localhost:3000';
const ENDPOINT = '/api/auth/login';
const TOTAL_REQUESTS = 12;
const EXPECTED_LIMIT = 10;

async function hit(i) {
  const res = await fetch(TARGET + ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `smoke${i}@test.invalid`, password: 'wrong' }),
  });
  return {
    i,
    status: res.status,
    remaining: res.headers.get('ratelimit-remaining'),
  };
}

function fmt(r) {
  return `  #${String(r.i).padStart(2)} → ${r.status} (RateLimit-Remaining: ${r.remaining ?? '—'})`;
}

(async () => {
  console.log(`\nSmoke test: rate limiter en ${TARGET}${ENDPOINT}`);
  console.log(`Esperado: primeros ${EXPECTED_LIMIT} requests en 401, siguientes en 429.\n`);

  const results = [];
  for (let i = 1; i <= TOTAL_REQUESTS; i++) {
    try {
      results.push(await hit(i));
    } catch (err) {
      console.error(`\n❌ FAIL: request #${i} lanzó error: ${err.message}`);
      console.error('   ¿La app está corriendo en ' + TARGET + '?\n');
      process.exit(1);
    }
  }

  results.forEach((r) => console.log(fmt(r)));

  const primeros = results.slice(0, EXPECTED_LIMIT);
  const sobrantes = results.slice(EXPECTED_LIMIT);

  const okPrimeros = primeros.every((r) => r.status === 401);
  const ok429 = sobrantes.every((r) => r.status === 429);
  const okHeader = sobrantes.every((r) => r.remaining === '0');

  console.log('');
  if (okPrimeros && ok429 && okHeader) {
    console.log('✅ PASS — rate limiter funcionando (10×401 + 2×429 con RateLimit-Remaining:0).\n');
    process.exit(0);
  }

  console.log('❌ FAIL');
  if (!okPrimeros) console.log(`   Esperaba ${EXPECTED_LIMIT} × 401, recibí: ${primeros.map((r) => r.status).join(', ')}`);
  if (!ok429) console.log(`   Esperaba ${TOTAL_REQUESTS - EXPECTED_LIMIT} × 429, recibí: ${sobrantes.map((r) => r.status).join(', ')}`);
  if (!okHeader) console.log(`   Esperaba RateLimit-Remaining:0 en los 429, recibí: ${sobrantes.map((r) => r.remaining).join(', ')}`);
  console.log('');
  process.exit(1);
})();
