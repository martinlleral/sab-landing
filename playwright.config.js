// Playwright E2E configuration — Landing SAB
//
// Ejecutar:
//   npm run test:e2e              # headless contra SMOKE_TARGET (default: producción)
//   npm run test:e2e:ui           # modo UI interactivo
//   npm run test:e2e:report       # abrir el último HTML report
//
// Targets:
//   SMOKE_TARGET=https://sindicatoargentinodeboleros.com.ar (default en producción)
//   SMOKE_TARGET=http://localhost:3000  (dev local con `docker compose up`)
//
// Docs completos en: https://playwright.dev/docs/test-configuration

const { defineConfig, devices } = require('@playwright/test');

const BASE_URL = process.env.SMOKE_TARGET || 'https://sindicatoargentinodeboleros.com.ar';

module.exports = defineConfig({
  testDir: './tests/e2e/specs',
  timeout: 30_000,
  expect: { timeout: 5_000 },

  // Run tests en paralelo dentro del mismo archivo. Entre archivos también.
  fullyParallel: true,

  // En CI no permitir .only. Reintentar fallos 1 vez localmente, 2 en CI.
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 1,
  workers: process.env.CI ? 1 : undefined,

  // Reportes: HTML interactivo + list simple en stdout + JSON para integración
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
    ['json', { outputFile: 'playwright-report/results.json' }],
  ],

  use: {
    baseURL: BASE_URL,
    // Recopilar artefactos solo cuando algo falla (ahorra espacio)
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    // Ignorar errores de cert SSL — útil para tests contra ambiente dev con certs self-signed
    ignoreHTTPSErrors: true,
  },

  projects: [
    {
      name: 'chromium-desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'chromium-mobile',
      use: { ...devices['Pixel 7'] },
    },
    {
      // Tablet con chromium en vez de webkit — así evitamos descargar 300MB extra
      // de browser solo para 1 viewport. La cobertura efectiva de "tablet" son
      // las dimensiones + touch; el engine no es crítico.
      name: 'chromium-tablet',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 820, height: 1180 },
        hasTouch: true,
        isMobile: true,
      },
    },
  ],
});
