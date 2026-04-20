// Smoke del backoffice — login + acceso protegido.
// Requiere env vars SMOKE_ADMIN_EMAIL y SMOKE_ADMIN_PASS para correr.
// Si no están definidas, los tests se skipean (no fallan, son soft).

const { test, expect } = require('@playwright/test');

const ADMIN_EMAIL = process.env.SMOKE_ADMIN_EMAIL;
const ADMIN_PASS = process.env.SMOKE_ADMIN_PASS;
const HAS_CREDS = !!(ADMIN_EMAIL && ADMIN_PASS);

test.describe('Backoffice — autenticación y acceso', () => {

  test('Página de login responde 200 y tiene form con email + password', async ({ page }) => {
    const res = await page.goto('/backoffice/login.html');
    expect(res.status()).toBe(200);
    await expect(page.locator('input[type="email"]')).toBeVisible();
    await expect(page.locator('input[type="password"]')).toBeVisible();
    await expect(page.locator('button[type="submit"]')).toBeVisible();
  });

  test('Login con credenciales inválidas devuelve 401', async ({ request }) => {
    const res = await request.post('/api/auth/login', {
      data: { email: 'playwright-invalid@test.invalid', password: 'wrong-password' },
    });
    expect(res.status()).toBe(401);
  });

  test('Rutas admin redirigen o rechazan sin sesión', async ({ page, request }) => {
    // GET a HTML protegido. Esperar a que el navigation termine (load event)
    // para que un redirect server-side se complete antes de chequear la URL.
    await page.goto('/backoffice/dashboard.html', { waitUntil: 'load' });
    const url = page.url();
    expect(url, `URL final debería contener 'login', llegó: ${url}`).toContain('login');

    // API protegida sin sesión → 401
    const apiRes = await request.get('/api/admin/compras');
    expect(apiRes.status()).toBe(401);
  });

  // Cobertura defensiva del fix en auth.middleware.js (isApiRequest usando req.originalUrl).
  // Antes del fix, las rutas admin API devolvían 302→login.html en vez de 401 JSON porque
  // req.path dentro del subrouter era "/". Este test barre múltiples endpoints admin para
  // detectar regresiones o "bugs hermanos".
  test('Endpoints /api/admin/* sin sesión devuelven 401 JSON (no 302 HTML)', async ({ request }) => {
    const endpoints = [
      { method: 'GET', path: '/api/admin/compras' },
      { method: 'GET', path: '/api/admin/eventos' },
      { method: 'GET', path: '/api/admin/eventos/pasados' },
      { method: 'GET', path: '/api/admin/usuarios' },
    ];

    for (const ep of endpoints) {
      const res = await request.fetch(ep.path, { method: ep.method, maxRedirects: 0 });
      expect(res.status(), `${ep.method} ${ep.path} debería ser 401`).toBe(401);
      const ct = res.headers()['content-type'] || '';
      expect(ct, `${ep.method} ${ep.path} debería responder JSON`).toMatch(/json/i);
      const body = await res.json().catch(() => ({}));
      expect(body.error || body.message, `${ep.method} ${ep.path} debería tener campo error`).toBeTruthy();
    }
  });

  test('Respuestas de backoffice HTML tienen Cache-Control: no-store', async ({ request }) => {
    const res = await request.get('/backoffice/login.html');
    expect(res.status()).toBe(200);
    const cc = res.headers()['cache-control'] || '';
    expect(cc, `login.html Cache-Control debería ser no-store, llegó: ${cc}`).toContain('no-store');
  });

  test('Login con credenciales válidas + dashboard carga stats', async ({ page, context }) => {
    test.skip(!HAS_CREDS, 'Credenciales admin no provistas (SMOKE_ADMIN_EMAIL + SMOKE_ADMIN_PASS). Skipped.');

    // Login
    await page.goto('/backoffice/login.html');
    await page.fill('input[type="email"]', ADMIN_EMAIL);
    await page.fill('input[type="password"]', ADMIN_PASS);
    await page.click('button[type="submit"]');
    // Esperar redirect al dashboard
    await page.waitForURL(/dashboard|backoffice/, { timeout: 5000 });

    // Verificar que el dashboard tiene las 4 stat-cards con números
    await expect(page.locator('#stat-eventos')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#stat-compras')).toBeVisible();
    const eventosText = await page.locator('#stat-eventos').textContent();
    expect(eventosText).toMatch(/\d+/);
  });

});
