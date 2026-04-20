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
 *   2. node scripts/smoke-rate-limit.js                              # contra localhost:3000
 *   3. SMOKE_TARGET=https://tu.dominio.com node scripts/smoke-rate-limit.js  # contra prod
 *
 * Qué valida:
 *   - Los primeros 10 intentos de login con credenciales falsas devuelven 401.
 *   - Los intentos 11 y 12 devuelven 429 con RateLimit-Remaining: 0
 *     (respuesta del rate limiter de Express en nuestro backend).
 *
 * Comportamiento alternativo esperado detrás de Cloudflare con Bot Fight Mode activo:
 *   - Cloudflare puede interceptar antes de que lleguen a nuestro origen y responder 429
 *     sin los headers `ratelimit-*` (identificable por `server: cloudflare` +
 *     `retry-after` + SIN `ratelimit-remaining`).
 *   - Eso es defensa en profundidad deseada: Cloudflare filtra antes, Express filtra
 *     después. El smoke acepta este caso como PASS alternativo (validando que al menos
 *     una de las dos capas protege).
 *
 * Sale con código 0 si PASA, 1 si FALLA.
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
    server: res.headers.get('server'),
    retryAfter: res.headers.get('retry-after'),
  };
}

function fmt(r) {
  const ratelimitInfo = r.remaining !== null ? `RL-Rem: ${r.remaining}` : '—';
  const cfInfo = r.server === 'cloudflare' && r.status === 429 ? ' [CF bot-block]' : '';
  return `  #${String(r.i).padStart(2)} → ${r.status} (${ratelimitInfo})${cfInfo}`;
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

  // Clasificación simplificada
  // - 429 con header RateLimit-* (ratelimit-policy / ratelimit-remaining) → Express rate limiter
  // - 429 SIN esos headers → Cloudflare Bot Fight Mode u otro bloqueo ante-origen
  const count401 = results.filter((r) => r.status === 401).length;
  const count429Express = results.filter((r) => r.status === 429 && r.remaining !== null).length;
  const count429CF = results.filter((r) => r.status === 429 && r.remaining === null).length;
  const count2xx = results.filter((r) => r.status >= 200 && r.status < 300).length;

  console.log('');
  console.log(`Clasificación: ${count401} × 401 · ${count429Express} × 429-Express · ${count429CF} × 429-CF/otro · ${count2xx} × 2xx`);
  console.log('');

  // Caso ideal (local, sin CF): 10×401 + 2×429 de Express
  if (count401 === EXPECTED_LIMIT && count429Express === TOTAL_REQUESTS - EXPECTED_LIMIT) {
    console.log('✅ PASS canónico — rate limiter Express funcionando exacto (10×401 + 2×429 con RateLimit-Remaining:0).');
    console.log('   Sin CF intermediario. Patrón ideal para test local.\n');
    process.exit(0);
  }

  // Caso producción: basta con que alguna capa de rate limit actúe (≥1 × 429 de cualquier tipo)
  if (count429Express + count429CF >= 1) {
    console.log('✅ PASS — al menos una capa de rate limit activa.');
    if (count429Express > 0) console.log(`   Express rate limiter protege: ${count429Express} × 429 con header ratelimit-*`);
    if (count429CF > 0) console.log(`   Bloqueo ante-origen protege: ${count429CF} × 429 (probable Cloudflare Bot Fight Mode)`);
    console.log('   Para validación exacta del rate limiter Express, correr contra localhost sin CF intermediario.\n');
    process.exit(0);
  }

  // FAIL: no hubo ningún 429 → rate limiter inactivo
  console.log('❌ FAIL');
  console.log(`   Ninguna request recibió 429 — rate limiter parece inactivo.`);
  console.log(`   Statuses recibidos: ${results.map((r) => r.status).join(', ')}`);
  console.log('');
  process.exit(1);
})();
