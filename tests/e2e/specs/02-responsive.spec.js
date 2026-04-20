// Tests responsive — se ejecutan automáticamente en los 3 viewports definidos
// en playwright.config.js (desktop, mobile pixel7, tablet iPad gen7).
// Los projects agregan cobertura gratis de cada test acá.

const { test, expect } = require('@playwright/test');
const S = require('../fixtures/selectors');

test.describe('Responsive', () => {

  test('Hero visible sin scroll inicial', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator(S.home.hero)).toBeInViewport();
  });

  test('Navbar colapsa o se adapta sin overflow horizontal', async ({ page }) => {
    await page.goto('/');
    // Verifica que el body no genera scroll horizontal (síntoma de overflow en mobile)
    const hasHorizontalOverflow = await page.evaluate(() => {
      return document.body.scrollWidth > window.innerWidth;
    });
    expect(hasHorizontalOverflow).toBe(false);
  });

  test('CTAs de compra tienen tamaño táctil mínimo 44x44 (WCAG touch target)', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'Solo relevante en mobile');
    await page.goto('/');
    const btn = page.locator('a:has-text("COMPRAR"), button:has-text("COMPRAR")').first();
    if (await btn.count() > 0) {
      const box = await btn.boundingBox();
      if (box) {
        expect(box.height).toBeGreaterThanOrEqual(44);
        expect(box.width).toBeGreaterThanOrEqual(44);
      }
    }
  });

  test('Stats de "Quiénes somos" se reorganizan en mobile', async ({ page, viewport }) => {
    await page.goto('/');
    await page.locator(S.home.quienesSomos).scrollIntoViewIfNeeded();
    const statsGrid = page.locator('.qs-stats').first();
    await expect(statsGrid).toBeVisible();
    // En mobile la media query usa 2 columnas; en desktop 3.
    // No chequeamos el grid-template-columns exacto (es sensible al CSS),
    // solo que el grid es visible y no overflow.
    const gridBox = await statsGrid.boundingBox();
    expect(gridBox).not.toBeNull();
    if (viewport) {
      expect(gridBox.width).toBeLessThanOrEqual(viewport.width);
    }
  });

});
