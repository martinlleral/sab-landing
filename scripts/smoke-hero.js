/**
 * Smoke test del HERO de la portada, en un navegador de verdad.
 *
 * POR QUÉ ESTO NO ES UN TEST DE INTEGRACIÓN: el bug del 27/8 no estaba en ningún
 * controller. La portada amaneció mostrando un esqueleto —el badge "PRÓXIMO
 * EVENTO", un guión suelto y "Invitado especial:" sin nadie— porque la rama "sin
 * evento" de `renderDestacado` limpiaba lo que el JS rellena y no apagaba lo que
 * en el HTML es TEXTO FIJO. Ningún assert sobre un JSON puede ver eso: hay que
 * mirar la pantalla.
 *
 * Los tres casos:
 *   A — sin ningún evento: nada de lo fijo queda prendido, y el hero dice algo.
 *   B — con evento: el camino feliz sigue entero.
 *   C — vacío y DESPUÉS con evento: lo que se apagó se vuelve a prender. Este
 *       sólo falla en el segundo render, así que probando a mano una vez no se ve.
 *
 * Usa `page.route` para dictar lo que responde la API: así los tres estados se
 * prueban sin tocar la base ni depender de qué eventos haya cargados hoy.
 *
 * Requiere: server local corriendo y Chrome instalado (`channel: 'chrome'`, el
 * patrón de QA del proyecto).
 *
 *   PORT=3111 npm start &
 *   node scripts/smoke-hero.js                 # usa http://localhost:3111
 *   BASE_URL=http://localhost:3000 node scripts/smoke-hero.js
 *
 * Exit codes: 0 = PASS, 1 = FAIL
 */

const { chromium } = require('playwright');
const path = require('path');

// Dónde dejar las capturas para MIRARLAS. Un check verde dice que el elemento no
// está; la captura dice cómo se ve la página, que no es lo mismo.
const OUT = process.env.SMOKE_OUT || require('os').tmpdir();

const BASE = process.env.BASE_URL || 'http://localhost:3111';

const EVENTO_FALSO = {
  id: 9999, nombre: 'Noche de prueba', descripcion: 'x',
  fecha: new Date(Date.now() + 7 * 86400000).toISOString(), hora: '21:00',
  invitado: 'Alguien Invitado', flyerUrl: null, esDestacado: true, estaPublicado: true,
  estaAgotado: false, esExterno: false, linkExterno: null,
  boxDiaOverride: '', boxFechaOverride: '', boxHoraOverride: '',
  boxLugarOverride: '', boxDireccionOverride: '', boxCiudadOverride: '',
  boxPrecioOverride: '', boxEtiquetaEntradaOverride: '',
  menuHabilitado: false, topeMenus: null, menusRestantes: null, menuCerrado: false,
  esFallback: false,
  tandas: [{ id: 1, eventoId: 9999, nombre: 'Tanda 1', precio: 20000, orden: 1, activa: true,
             capacidad: 100, cantidadVendida: 0, fechaLimite: null, porcentajeAporte: 10 }],
  tandaVigente: { id: 1, eventoId: 9999, nombre: 'Tanda 1', precio: 20000, orden: 1, activa: true,
                  capacidad: 100, cantidadVendida: 0, fechaLimite: null, porcentajeAporte: 10 },
};

// Esperar a que el hero HAYA RENDERIZADO, no a que la red se calme. `networkidle`
// depende de requests ajenas al hero (el cron de MP puede tener ocupado al server)
// y falla por motivos que no son el que se está probando. `renderDestacado` marca
// `hero-content` con la clase `loaded` en los DOS caminos — con evento y sin
// evento — así que esa clase es la señal exacta de "ya decidió qué mostrar".
async function irAlHero(page) {
  await bloquearTerceros(page);
  await page.goto(BASE, { waitUntil: 'commit' });
  await page.waitForSelector('#hero-content.loaded', { timeout: 20000 });
}

// La portada carga Bootstrap (JS y CSS) de jsdelivr y un iframe de Google Maps.
// Un `<script src>` de terceros lento retrasa `DOMContentLoaded`, y sin ese evento
// `loadDestacado()` NO CORRE: el smoke se cae por una CDN que no tiene nada que ver
// con lo que se está probando (pasó armando esto — 30 s de timeout con el server
// respondiendo el HTML en 18 ms). Cortamos todo lo que no sea local: el hero se
// renderiza con CSS propio y no necesita nada de afuera.
async function bloquearTerceros(page) {
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith(BASE) || url.startsWith('data:') || url.startsWith('blob:')) {
      return route.continue();
    }
    return route.abort();
  });
}

async function estadoHero(page) {
  return page.evaluate(() => {
    const vis = (sel) => {
      const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
      if (!el) return 'NO_EXISTE';
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      return el.getBoundingClientRect().height > 0;
    };
    const txt = (id) => (document.getElementById(id)?.textContent || '').trim();
    return {
      badge: vis('.hero-badge'),
      separador: vis('#hero-hora-sep'),
      invitadoWrap: vis('#hero-invitado-wrap'),
      vacio: vis('#hero-vacio'),
      btnComprar: vis('#btn-comprar'),
      nombre: txt('hero-nombre'),
      fecha: txt('hero-fecha'),
      // Lo que un humano leería en el hero, sin markup.
      visible: (document.getElementById('hero-content')?.innerText || '')
        .replace(/\s+/g, ' ').trim(),
    };
  });
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  const fallos = [];
  const check = (n, cond, detalle) => {
    if (cond) console.log(`  ✅ ${n}`);
    else { console.log(`  ❌ ${n}${detalle ? ' — ' + detalle : ''}`); fallos.push(n); }
  };

  // ── CASO A: no hay ningún evento (el 404 del backend) ──────────────────
  {
    const page = await browser.newPage();
    await bloquearTerceros(page);
    await page.route('**/api/eventos/destacado', (r) =>
      r.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"No hay evento destacado"}' }));
    await page.route('**/api/eventos/proximos', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.goto(BASE, { waitUntil: 'commit' });
    await page.waitForSelector('#hero-content.loaded', { timeout: 20000 });
    const s = await estadoHero(page);
    console.log('\nCASO A — sin ningún evento');
    console.log('  hero dice:', JSON.stringify(s.visible));
    check('A1 el guión suelto NO se ve', s.separador === false, `separador=${s.separador}`);
    check('A2 "Invitado especial:" NO se ve', s.invitadoWrap === false, `invitadoWrap=${s.invitadoWrap}`);
    check('A3 el badge "Próximo Evento" NO se ve', s.badge === false, `badge=${s.badge}`);
    check('A4 el botón de compra NO se ve', s.btnComprar === false, `btn=${s.btnComprar}`);
    check('A5 se muestra el mensaje de estado vacío', s.vacio === true, `vacio=${s.vacio}`);
    check('A6 el hero no queda mudo', s.visible.length > 0, `texto="${s.visible}"`);
    // A7 mira el TEXTO que leería una persona, no el display de cada elemento.
    // Es el check que reproduce la captura del 27/8 ("PRÓXIMO EVENTO — Invitado
    // especial:") y el único que seguiría sirviendo si mañana el markup cambia y
    // los ids de arriba dejan de existir.
    check('A7 🎯 el texto visible no tiene guión huérfano ni etiquetas sin dato',
      !s.visible.includes('—') && !/invitado especial/i.test(s.visible),
      `texto="${s.visible}"`);
    await page.screenshot({ path: path.join(OUT, 'hero-A-vacio.png') });
    await page.close();
  }

  // ── CASO B: hay evento (el camino normal, no se rompió) ────────────────
  {
    const page = await browser.newPage();
    await bloquearTerceros(page);
    await page.route('**/api/eventos/destacado', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(EVENTO_FALSO) }));
    await page.goto(BASE, { waitUntil: 'commit' });
    await page.waitForSelector('#hero-content.loaded', { timeout: 20000 });
    const s = await estadoHero(page);
    console.log('\nCASO B — con evento');
    console.log('  hero dice:', JSON.stringify(s.visible.slice(0, 90)));
    check('B1 el badge se ve', s.badge === true, `badge=${s.badge}`);
    check('B2 el guión separador se ve', s.separador === true, `separador=${s.separador}`);
    check('B3 el botón de compra se ve', s.btnComprar === true, `btn=${s.btnComprar}`);
    check('B4 el mensaje de vacío NO se ve', s.vacio === false, `vacio=${s.vacio}`);
    check('B5 el nombre del evento está', s.nombre.length > 0, `nombre="${s.nombre}"`);
    // El innerText de arriba se imprime recortado: este check mira el dato entero,
    // porque "Invitado especial:" sin nombre al lado sería el mismo bug que vinimos
    // a arreglar, sólo que en el camino feliz.
    const invitado = await page.evaluate(() => (document.getElementById('hero-invitado')?.textContent || '').trim());
    check('B6 el invitado se rellena (no queda la etiqueta sola)',
      invitado === 'Alguien Invitado', `invitado="${invitado}"`);
    console.log('  texto completo:', JSON.stringify(s.visible));
    await page.screenshot({ path: path.join(OUT, 'hero-B-evento.png') });
    await page.close();
  }

  // ── CASO C: 🎯 vacío y DESPUÉS con evento, en la misma página ──────────
  // El bug de "apagué y nunca lo volví a prender". Sólo aparece en el segundo
  // render, así que probando a mano una vez no se ve.
  {
    const page = await browser.newPage();
    await bloquearTerceros(page);
    await page.route('**/api/eventos/destacado', (r) =>
      r.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"x"}' }));
    await page.goto(BASE, { waitUntil: 'commit' });
    await page.waitForSelector('#hero-content.loaded', { timeout: 20000 });
    const antes = await estadoHero(page);
    await page.evaluate((ev) => window.renderDestacado(ev), EVENTO_FALSO);
    const s = await estadoHero(page);
    console.log('\nCASO C — render vacío y después con evento');
    check('C0 el primer render dejó el hero en estado vacío', antes.vacio === true, `vacio=${antes.vacio}`);
    check('C1 🎯 el badge volvió a prenderse', s.badge === true, `badge=${s.badge}`);
    check('C2 🎯 el separador volvió a prenderse', s.separador === true, `separador=${s.separador}`);
    check('C3 🎯 el botón de compra volvió', s.btnComprar === true, `btn=${s.btnComprar}`);
    check('C4 🎯 el mensaje de vacío se apagó', s.vacio === false, `vacio=${s.vacio}`);
    await page.close();
  }

  await browser.close();
  console.log('\ncapturas en: ' + OUT);
  console.log();
  console.log(`\n${fallos.length === 0 ? '✅ TODO OK' : '❌ ' + fallos.length + ' FALLA(S)'}`);
  process.exit(fallos.length === 0 ? 0 : 1);
})();
