// Flujo de compra — hasta el redirect a MercadoPago.
// NO simula el pago real (no tenemos entorno test de MP en CI).
// El success criteria es que el backend acepta la preferencia y devuelve init_point.

const { test, expect } = require('@playwright/test');
const S = require('../fixtures/selectors');

test.describe('Flujo de compra', () => {

  test('API: crearPreferencia con datos válidos devuelve init_point', async ({ request }) => {
    // Primero conseguimos un evento publicado
    const eventosRes = await request.get('/api/eventos/proximos');
    expect(eventosRes.status()).toBe(200);
    const eventos = await eventosRes.json();
    test.skip(!eventos.length, 'No hay eventos publicados para testear compra');

    const evento = eventos[0];
    const res = await request.post('/api/compras/preferencia', {
      data: {
        eventoId: evento.id,
        email: `playwright-smoke-${Date.now()}@test.invalid`,
        nombre: 'Playwright',
        apellido: 'Smoke',
        telefono: '',
        cantidad: 1,
      },
    });

    // Si MP token está bien configurado, debería devolver 200 con init_point
    // Si hubo un typo (ver TD-3 resuelto 20/4), devuelve 500
    expect(res.status(), 'Si da 500 revisar MP_ACCESS_TOKEN en .env').toBe(200);
    const json = await res.json();
    expect(json.init_point).toMatch(/^https:\/\/(www\.mercadopago|mpago)/);
    expect(json.preferencia_id).toBeTruthy();
    expect(json.compra_id).toBeGreaterThan(0);
  });

  test('API: rechazar campos faltantes con 400', async ({ request }) => {
    const res = await request.post('/api/compras/preferencia', {
      data: { cantidad: 1 }, // faltan eventoId, email, nombre, apellido
    });
    expect(res.status()).toBe(400);
  });

  test('API: evento inexistente devuelve 404', async ({ request }) => {
    const res = await request.post('/api/compras/preferencia', {
      data: {
        eventoId: 999999,
        email: 'test@test.invalid',
        nombre: 'Test',
        apellido: 'User',
        cantidad: 1,
      },
    });
    expect(res.status()).toBe(404);
  });

  test('UI: modal de compra se abre desde botón destacado (si hay evento destacado)', async ({ page }) => {
    await page.goto('/');
    // El botón "COMPRAR" del hero depende de que haya un evento destacado
    // Si no hay, el botón no existe — skip el test
    const btn = page.locator('[onclick*="abrirModal"], a:has-text("COMPRAR"), button:has-text("COMPRAR")').first();
    const count = await btn.count();
    test.skip(count === 0, 'No hay botón de compra visible (probablemente sin evento destacado)');

    await btn.click();
    // El modal puede ser Bootstrap Modal, lo detectamos con rol dialog o clase modal show
    const modal = page.locator('.modal.show, [role="dialog"][aria-modal="true"]').first();
    await expect(modal).toBeVisible({ timeout: 3000 });
  });

});
