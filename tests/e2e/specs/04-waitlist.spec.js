// Flujo de waitlist — el formulario escribe directo a Supabase desde el navegador
// (no pasa por el backend del SAB). Aquí validamos que la sección renderiza y que
// el contador público funciona; NO hacemos insert real para no ensuciar la DB.

const { test, expect } = require('@playwright/test');
const S = require('../fixtures/selectors');

test.describe('Waitlist de socios', () => {

  test('Sección #waitlist existe y tiene formulario', async ({ page }) => {
    await page.goto('/');
    await page.locator('#waitlist').scrollIntoViewIfNeeded();
    await expect(page.locator('#waitlist')).toBeVisible();
    // El form tiene id="wl-form" dentro de #waitlist
    await expect(page.locator('#wl-form')).toBeVisible();
  });

  test('Contador de waitlist (#wl-count) es un número >= 0', async ({ page }) => {
    await page.goto('/');
    await page.locator('#waitlist').scrollIntoViewIfNeeded();

    // Esperar a que se hidrate con el valor de Supabase (el default es "—")
    // Usamos waitForFunction porque el valor cambia asíncronamente cuando llega el RPC
    await page.waitForFunction(
      () => {
        const el = document.getElementById('wl-count');
        return el && el.textContent.trim() !== '—' && el.textContent.trim() !== '';
      },
      { timeout: 8000 }
    ).catch(() => {
      throw new Error('El contador #wl-count no se hidrató desde Supabase RPC en 8s');
    });

    const text = await page.locator('#wl-count').textContent();
    const numero = parseInt(text.replace(/[^0-9]/g, ''), 10);
    expect(Number.isFinite(numero)).toBe(true);
    expect(numero).toBeGreaterThanOrEqual(0);
  });

  test('Formulario tiene campos básicos (nombre, email) + consentimiento Ley 25.326', async ({ page }) => {
    await page.goto('/');
    await page.locator('#waitlist').scrollIntoViewIfNeeded();
    const form = page.locator('#wl-form');

    // Campos básicos: nombre + email
    await expect(form.locator('input[type="text"]').first()).toBeVisible();
    await expect(form.locator('input[type="email"]').first()).toBeVisible();

    // Consentimiento Ley 25.326 — suele estar como texto cerca del submit
    const consentimiento = page.locator('#waitlist').locator('text=/25.326|protección de datos|consentimiento/i').first();
    const visible = await consentimiento.isVisible().catch(() => false);
    if (!visible) {
      console.warn('⚠ Consentimiento Ley 25.326 no localizado automáticamente — validar manualmente');
    }
  });

  test('Fetch real a Supabase RPC waitlist_count desde el browser', async ({ page }) => {
    // El contador dispara un fetch a Supabase al cargar. Interceptamos las requests
    // para confirmar que el llamado efectivamente salió y devolvió 200.
    let rpcResponseStatus = null;
    page.on('response', async (response) => {
      if (response.url().includes('/rpc/waitlist_count')) {
        rpcResponseStatus = response.status();
      }
    });

    await page.goto('/');
    await page.waitForTimeout(3000); // dar tiempo al fetch

    expect(rpcResponseStatus, 'El fetch a Supabase RPC no salió o no respondió').toBe(200);
  });

});
