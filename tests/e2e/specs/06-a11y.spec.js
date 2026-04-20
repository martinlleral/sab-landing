// Auditoría de accesibilidad automatizada con axe-core sobre las páginas clave.
// axe-core detecta ~57% de issues WCAG según su propia doc — es un piso, no un techo.
// Hallazgos "serious" o "critical" son blockers; "moderate" o "minor" son warnings.

const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;

test.describe('Accesibilidad (axe-core WCAG 2.1 AA)', () => {

  test('Home pública — sin violaciones serious/critical', async ({ page }) => {
    await page.goto('/');
    // Esperar a que el JS hidrate contenido dinámico (home data, stats, waitlist count)
    await page.waitForTimeout(1500);

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    const serious = results.violations.filter(
      (v) => v.impact === 'serious' || v.impact === 'critical'
    );

    // Log legible para debug cuando falla
    if (serious.length > 0) {
      console.log('\n⚠ Violaciones serious/critical encontradas:');
      serious.forEach((v) => {
        console.log(`  - [${v.impact}] ${v.id}: ${v.description}`);
        console.log(`    Nodes: ${v.nodes.length} (primero: ${v.nodes[0].target})`);
        console.log(`    Help: ${v.helpUrl}`);
      });
    }

    expect(serious).toEqual([]);
  });

  test('Backoffice login — sin violaciones serious/critical', async ({ page }) => {
    await page.goto('/backoffice/login.html');
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa'])
      .analyze();

    const serious = results.violations.filter(
      (v) => v.impact === 'serious' || v.impact === 'critical'
    );

    if (serious.length > 0) {
      console.log('\n⚠ Violaciones serious/critical en login:');
      serious.forEach((v) => console.log(`  - [${v.impact}] ${v.id}: ${v.description}`));
    }
    expect(serious).toEqual([]);
  });

  test('Home — warnings moderate/minor reportados (no falla, solo log)', async ({ page }, testInfo) => {
    await page.goto('/');
    await page.waitForTimeout(1500);

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    const warnings = results.violations.filter(
      (v) => v.impact === 'moderate' || v.impact === 'minor'
    );

    // Attachar el JSON completo al reporte HTML para revisión manual
    await testInfo.attach('axe-warnings.json', {
      body: JSON.stringify(warnings, null, 2),
      contentType: 'application/json',
    });

    console.log(`ℹ axe-core: ${warnings.length} warnings moderate/minor (no bloquean)`);
    expect(true).toBe(true); // Este test nunca falla, solo documenta
  });

});
