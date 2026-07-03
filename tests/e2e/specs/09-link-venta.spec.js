// Link de venta por evento (US-2): abrir /?evento=<id> lleva directo a la compra
// de ESA fecha (modal preseleccionado), sin pasar por elegir en la home.
// Usa page.route para inyectar eventos controlados → determinista y target-agnóstico
// (corre igual contra localhost en dev o contra prod tras el deploy).

const { test, expect } = require('@playwright/test');

const HOME = {
  id: 1, slider1Url: '', slider2Url: '', slider3Url: '', textoEvento: '', youtubeUrl: '',
  totalEdiciones: 0, totalShows: 0, totalPersonas: 0,
  boxLugar: 'Espacio Doble T', boxDireccion: 'Calle 23 entre 43 y 44', boxCiudad: 'La Plata',
  boxEtiquetaEntrada: 'Anticipada online', eventosVisiblesPortada: 3,
};

const ev = (id, nombre, over = {}) => ({
  id, nombre, descripcion: 'desc', fecha: new Date(Date.now() + 20 * 864e5).toISOString(),
  hora: '21:00', invitado: null, flyerUrl: null, estaAgotado: false, esExterno: false, linkExterno: null,
  esDestacado: false, estaPublicado: true,
  boxLugarOverride: '', boxDireccionOverride: '', boxCiudadOverride: '',
  boxDiaOverride: '', boxFechaOverride: '', boxHoraOverride: '', boxPrecioOverride: '', boxEtiquetaEntradaOverride: '',
  tandaVigente: { id: id * 10, precio: 8000, nombre: 'General', porcentajeAporte: 0 },
  tandas: [{ id: id * 10, precio: 8000, nombre: 'General', orden: 1 }],
  ...over,
});

const DESTACADO = ev(99, 'Show Destacado');
const QUILMES = ev(50, 'Homenaje en Quilmes');
const AGOTADO = ev(51, 'Show Agotado', { estaAgotado: true, tandaVigente: null });
const PROXIMOS = [DESTACADO, QUILMES, AGOTADO];

async function mockApis(page) {
  await page.route('**/api/home', (r) => r.fulfill({ json: HOME }));
  await page.route('**/api/eventos/destacado', (r) => r.fulfill({ json: DESTACADO }));
  await page.route('**/api/eventos/proximos', (r) => r.fulfill({ json: PROXIMOS }));
  // Cualquier otra /api que dispare la home: respuesta vacía inofensiva.
  await page.route('**/api/compras/**', (r) => r.fulfill({ json: {} }));
}

test.describe('US-2 · Link de venta por evento (?evento=)', () => {

  test('abre el modal de compra con la fecha correcta preseleccionada', async ({ page }) => {
    await mockApis(page);
    await page.goto('/?evento=50', { waitUntil: 'networkidle' });
    const modal = page.locator('#modalCompra.show');
    await expect(modal).toBeVisible({ timeout: 4000 });
    // El evento seleccionado es el del link (50), NO el destacado (99).
    await expect(page.locator('#modal-evento-select')).toHaveValue('50');
  });

  test('un id inexistente no abre el modal ni rompe la home', async ({ page }) => {
    const errores = [];
    page.on('pageerror', (e) => errores.push(e.message));
    await mockApis(page);
    await page.goto('/?evento=99999', { waitUntil: 'networkidle' });
    await page.waitForTimeout(700);
    await expect(page.locator('#modalCompra.show')).toHaveCount(0);
    expect(errores, 'no debe haber errores JS').toEqual([]);
  });

  test('un evento agotado abre el modal pero no permite pagar', async ({ page }) => {
    await mockApis(page);
    await page.goto('/?evento=51', { waitUntil: 'networkidle' });
    await expect(page.locator('#modalCompra.show')).toBeVisible({ timeout: 4000 });
    await expect(page.locator('#modal-evento-select')).toHaveValue('51');
    await expect(page.locator('#btn-pagar')).toBeDisabled();
  });

});
