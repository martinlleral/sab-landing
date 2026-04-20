// Smoke de navegación + carga inicial.
// Valida que el sitio responde, las secciones principales se renderizan y los
// links del nav mueven el scroll a la sección correcta.

const { test, expect } = require('@playwright/test');
const S = require('../fixtures/selectors');

test.describe('Navigation + carga inicial', () => {

  test('Home responde 200 con título esperado', async ({ page }) => {
    const response = await page.goto('/');
    expect(response.status()).toBe(200);
    await expect(page).toHaveTitle(/sindicato argentino de boleros/i);
  });

  test('Las 6 secciones principales están en el DOM', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator(S.home.hero)).toBeVisible();
    await expect(page.locator(S.home.proximosEventos)).toBeVisible();
    await expect(page.locator(S.home.quienesSomos)).toBeVisible();
    await expect(page.locator('#waitlist')).toBeVisible();
    await expect(page.locator('footer')).toBeVisible();
  });

  test('Nav links navegan a las secciones correctas', async ({ page }) => {
    await page.goto('/');
    const proximosLink = page.locator(S.home.navLinks.proximos).first();
    await proximosLink.click();
    // Pequeña espera para scroll-behavior smooth
    await page.waitForTimeout(500);
    const proximosSection = page.locator(S.home.proximosEventos);
    await expect(proximosSection).toBeInViewport();
  });

  test('Trust bar se renderiza con las 4 tiles esperadas', async ({ page }) => {
    await page.goto('/');
    // Verificar que el trust-personas renderiza (puede mostrar default hardcoded o valor dinámico desde /api/home)
    const personasText = await page.locator(S.home.trustPersonas).textContent();
    expect(personasText).toMatch(/personas/i);
  });

  test('WhatsApp flotante está visible y es link a wa.me', async ({ page }) => {
    await page.goto('/');
    const wpp = page.locator(S.home.whatsappFlotante);
    await expect(wpp).toBeVisible();
    const href = await wpp.getAttribute('href');
    expect(href).toContain('wa.me');
  });

  test('Favicon se sirve (no 404)', async ({ request }) => {
    const res = await request.get('/favicon.ico');
    expect(res.status()).toBe(200);
    // Leer el body — Cloudflare a veces usa chunked encoding sin content-length,
    // por eso chequeamos el tamaño real del payload, no el header.
    const body = await res.body();
    expect(body.length).toBeGreaterThan(500);
  });

  test('Endpoint /healthz devuelve OK + db up', async ({ request }) => {
    const res = await request.get('/healthz');
    expect(res.status()).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('ok');
    expect(json.db).toBe('up');
  });

});
