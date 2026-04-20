// Validación SEO — meta tags, OG, Twitter Card, Schema.org JSON-LD.
// Mucho de esto cambia raramente pero cuando se rompe suele ser silencioso y afecta
// directamente cuánta gente encuentra el sitio en Google/Bing.

const { test, expect } = require('@playwright/test');

test.describe('SEO — meta tags y structured data', () => {

  test('Meta description existe, no vacía, longitud razonable (50-200 chars)', async ({ page }) => {
    await page.goto('/');
    const desc = await page.locator('meta[name="description"]').getAttribute('content');
    expect(desc).toBeTruthy();
    expect(desc.length).toBeGreaterThan(50);
    expect(desc.length).toBeLessThan(200);
  });

  test('Open Graph tags completos (title, description, image, url, type)', async ({ page }) => {
    await page.goto('/');
    const required = ['og:title', 'og:description', 'og:image', 'og:url', 'og:type'];
    for (const prop of required) {
      const content = await page.locator(`meta[property="${prop}"]`).getAttribute('content');
      expect(content, `Falta ${prop}`).toBeTruthy();
    }
  });

  test('og:image apunta a un recurso que existe y es imagen', async ({ page, request }) => {
    await page.goto('/');
    const url = await page.locator('meta[property="og:image"]').getAttribute('content');
    const res = await request.get(url);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toMatch(/image\//);
  });

  test('Twitter Card configurado', async ({ page }) => {
    await page.goto('/');
    const card = await page.locator('meta[name="twitter:card"]').getAttribute('content');
    expect(card).toBe('summary_large_image');
  });

  test('canonical URL presente y apunta al dominio público', async ({ page }) => {
    await page.goto('/');
    const canonical = await page.locator('link[rel="canonical"]').getAttribute('href');
    expect(canonical).toMatch(/^https:\/\/sindicatoargentinodeboleros\.com\.ar/);
  });

  test('Schema.org MusicGroup presente en JSON-LD', async ({ page }) => {
    await page.goto('/');
    const scripts = await page.locator('script[type="application/ld+json"]').allTextContents();
    expect(scripts.length).toBeGreaterThan(0);

    let foundMusicGroup = false;
    for (const s of scripts) {
      try {
        const data = JSON.parse(s);
        if (data['@type'] === 'MusicGroup') {
          foundMusicGroup = true;
          expect(data.name).toBeTruthy();
          expect(data.foundingLocation || data.location).toBeTruthy();
        }
      } catch (e) {
        // ignore
      }
    }
    expect(foundMusicGroup, 'Schema MusicGroup no encontrado en ningún JSON-LD').toBe(true);
  });

  test('robots.txt accesible + sitemap.xml accesible', async ({ request }) => {
    const robots = await request.get('/robots.txt');
    expect(robots.status()).toBe(200);

    const sitemap = await request.get('/sitemap.xml');
    expect(sitemap.status()).toBe(200);
  });

  test('lang="es-AR" declarado en html', async ({ page }) => {
    await page.goto('/');
    const lang = await page.locator('html').getAttribute('lang');
    expect(lang).toBe('es-AR');
  });

});
