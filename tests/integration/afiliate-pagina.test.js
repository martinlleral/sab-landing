/**
 * Tests de integración — La página pública para afiliarse (/afiliate) y la vuelta
 * desde Mercado Pago (/afiliate/gracias), escalón 0.
 *
 * Cubre:
 *   A · El reloj de la salida (src/config/afiliaciones.js): antes cerrado, en el
 *       instante y después abierto; la variable AFILIACIONES_SALIDA lo pisa; una
 *       variable mal escrita no lo rompe (vuelve al default).
 *   B · `GET /api/home` responde `afiliacionesAbiertas` calculado en el servidor,
 *       con su control: la misma base da false antes y true después.
 *   C · Los planes se guardan desde el panel (`PUT /api/admin/home`): nombre,
 *       monto y link de cada uno. El link sólo de Mercado Pago y por https; uno
 *       inválido devuelve 400 y no escribe NADA (tampoco los otros campos).
 *   D · Lo que ve la página (`planesAfiliacion`): sólo los planes con nombre y
 *       monto, en orden; un link que no pasa la validación sale como null aunque
 *       esté en la base (cargado a mano, por fuera del panel).
 *   E · El HTML: noindex antes de la salida y no después (la página); la vuelta,
 *       noindex siempre. Y los montos y links NO están en el HTML (con su control).
 *   F · La portada: la sección nueva viene oculta y la lista de espera visible,
 *       así que sin JS (o con /api/home caído) queda lo de hoy.
 *
 * Controllers directos con req/res mock. Uso local (dev.db):
 *   node tests/integration/afiliate-pagina.test.js
 * Exit codes: 0 = PASS, 1 = FAIL
 */

const fs = require('fs');
const path = require('path');
const prisma = require('../../src/utils/prisma');

const PUBLIC = path.join(__dirname, '../../public');
const SALIDA_ENV = 'AFILIACIONES_SALIDA';

let pass = 0;
let fail = 0;
function check(id, cond, msg) {
  if (cond) { pass += 1; console.log(`  ✅ ${id} ${msg}`); }
  else { fail += 1; console.log(`  ❌ ${id} ${msg}`); }
}

function mockRes() {
  return {
    statusCode: 200, body: null, headers: {}, archivo: null,
    status(c) { this.statusCode = c; return this; },
    json(p) { this.body = p; return this; },
    set(k, v) { this.headers[k] = v; return this; },
    sendFile(f) { this.archivo = f; return this; },
  };
}
async function call(handler, req = {}) { const res = mockRes(); await handler({ params: {}, query: {}, body: {}, ...req }, res); return res; }

// Los nombres de los nueve campos de Home, en un solo lugar del test.
const CAMPOS = [];
for (let i = 1; i <= 3; i += 1) CAMPOS.push(`afiliacionPlan${i}Nombre`, `afiliacionPlan${i}Monto`, `afiliacionPlan${i}Link`);

// Links de prueba: tienen la forma de los de MP, no son de ningún plan real.
const LINK_1 = 'https://www.mercadopago.com.ar/subscriptions/checkout?preapproval_plan_id=test-plan-uno';
const LINK_2 = 'https://mpago.la/testDos';

let homePrevio = null;
let envPrevio;

async function main() {
  console.log('\n═══ afiliate-pagina ═══');

  // Los módulos se cargan acá adentro: si no existen, el test falla con un
  // mensaje claro en vez de morir antes de imprimir nada (rojo legible).
  let reloj; let planes; let afiliate; let homeController;
  try {
    reloj = require('../../src/config/afiliaciones');
    planes = require('../../src/services/planes-afiliacion.service');
    afiliate = require('../../src/controllers/afiliate.controller');
    homeController = require('../../src/controllers/home.controller');
  } catch (e) {
    check('0', false, `faltan los módulos de /afiliate: ${e.message.split('\n')[0]}`);
    return;
  }

  envPrevio = process.env[SALIDA_ENV];
  homePrevio = await prisma.home.findFirst();
  if (!homePrevio) { check('0', false, 'dev.db no tiene fila en Home'); return; }

  // ── A · El reloj ───────────────────────────────────────────────────────────
  console.log('A · el reloj de la salida');
  delete process.env[SALIDA_ENV];
  const salida = reloj.salida();
  check('A1', salida.toISOString() === '2026-11-15T03:00:00.000Z', `la salida por defecto es el dom 15/11 00:00 de Argentina (${salida.toISOString()})`);
  check('A2', reloj.abiertas(new Date('2026-11-14T23:59:59-03:00')) === false, 'un segundo antes: cerrado');
  check('A3', reloj.abiertas(new Date('2026-11-15T00:00:00-03:00')) === true, 'en el instante: abierto');
  check('A4', reloj.abiertas(new Date('2026-11-16T10:00:00-03:00')) === true, 'después: abierto');
  process.env[SALIDA_ENV] = '2026-11-12T20:00:00-03:00';
  check('A5', reloj.abiertas(new Date('2026-11-12T20:30:00-03:00')) === true, 'la variable adelanta la salida (QA o decisión del congelamiento)');
  process.env[SALIDA_ENV] = '2026-11-20T00:00:00-03:00';
  check('A6', reloj.abiertas(new Date('2026-11-16T10:00:00-03:00')) === false, 'la variable también la pospone');
  process.env[SALIDA_ENV] = 'el domingo';
  check('A7', reloj.salida().toISOString() === '2026-11-15T03:00:00.000Z', 'una variable mal escrita vuelve al default, no deja la página siempre abierta ni siempre cerrada');
  delete process.env[SALIDA_ENV];

  // ── B · /api/home ──────────────────────────────────────────────────────────
  console.log('B · /api/home dice si están abiertas');
  process.env[SALIDA_ENV] = '2099-01-01T00:00:00-03:00';
  const bAntes = await call(homeController.getHome);
  check('B1', bAntes.statusCode === 200 && bAntes.body.afiliacionesAbiertas === false, 'antes de la salida: afiliacionesAbiertas = false');
  process.env[SALIDA_ENV] = '2000-01-01T00:00:00-03:00';
  const bDespues = await call(homeController.getHome);
  check('B2', bDespues.body.afiliacionesAbiertas === true, 'después de la salida: true (control: la misma base, otra hora)');
  check('B3', Array.isArray(bDespues.body.planesAfiliacion), 'trae planesAfiliacion como lista');
  delete process.env[SALIDA_ENV];

  // ── C · Guardar los planes desde el panel ──────────────────────────────────
  console.log('C · los planes se guardan desde el panel');
  const cOk = await call(homeController.updateHome, { body: {
    afiliacionPlan1Nombre: '  Plan test uno  ', afiliacionPlan1Monto: '1111', afiliacionPlan1Link: LINK_1,
    afiliacionPlan2Nombre: 'Plan test dos', afiliacionPlan2Monto: '2222', afiliacionPlan2Link: LINK_2,
    afiliacionPlan3Nombre: 'Plan test tres', afiliacionPlan3Monto: '3333', afiliacionPlan3Link: '',
  } });
  const guardado = await prisma.home.findFirst();
  check('C1', cOk.statusCode === 200, `guardar tres planes válidos da 200 (${cOk.statusCode} ${cOk.body && cOk.body.error || ''})`);
  check('C2', guardado.afiliacionPlan1Nombre === 'Plan test uno' && guardado.afiliacionPlan1Monto === 1111 && guardado.afiliacionPlan1Link === LINK_1, 'el plan 1 queda con su nombre recortado, su monto y su link');
  check('C3', guardado.afiliacionPlan2Link === LINK_2 && guardado.afiliacionPlan3Link === '' && guardado.afiliacionPlan3Monto === 3333, 'el link corto de MP vale y el vacío se guarda vacío');

  const invalidos = [
    ['C4', 'javascript:alert(1)', 'un javascript: (correría en el navegador de quien visita)'],
    ['C5', 'http://www.mercadopago.com.ar/subscriptions/checkout?x=1', 'MP pero por http'],
    ['C6', 'https://www.mercadopago.com.ar.otro.com/subscriptions', 'un dominio que sólo empieza como el de MP'],
    ['C7', 'https://otro.com/?r=https://www.mercadopago.com.ar', 'otro dominio que menciona a MP'],
    ['C8', 'https://usuario@www.mercadopago.com.ar/subscriptions', 'un link con usuario adentro'],
  ];
  for (const [id, link, que] of invalidos) {
    const r = await call(homeController.updateHome, { body: { afiliacionPlan1Link: link, afiliacionPlan1Nombre: 'No se tiene que guardar', textoEvento: 'tampoco esto' } });
    const tras = await prisma.home.findFirst();
    check(id, r.statusCode === 400 && tras.afiliacionPlan1Link === LINK_1 && tras.afiliacionPlan1Nombre === 'Plan test uno' && tras.textoEvento === homePrevio.textoEvento,
      `rechaza ${que} con 400 y no escribe nada`);
  }
  const cMonto = await call(homeController.updateHome, { body: { afiliacionPlan2Monto: 'mucho' } });
  const trasMonto = await prisma.home.findFirst();
  check('C9', cMonto.statusCode === 200 && trasMonto.afiliacionPlan2Monto === 2222, 'un monto que no es número no pisa el guardado (como precioMenu)');
  const largo = 'x'.repeat(80);
  await call(homeController.updateHome, { body: { afiliacionPlan3Nombre: largo } });
  check('C10', (await prisma.home.findFirst()).afiliacionPlan3Nombre.length === 60, 'el nombre se corta en 60, el tope de MP');
  await call(homeController.updateHome, { body: { afiliacionPlan3Nombre: 'Plan test tres' } });

  // ── D · Lo que ve la página ────────────────────────────────────────────────
  console.log('D · lo que recibe la página');
  let d = (await call(homeController.getHome)).body.planesAfiliacion;
  check('D1', d.length === 3 && d.map((p) => p.nombre).join('|') === 'Plan test uno|Plan test dos|Plan test tres', 'los tres planes, en orden');
  check('D2', d[0].monto === 1111 && d[0].link === LINK_1 && d[2].link === null, 'con su monto y su link; sin link, null');
  // Un link inválido metido directo en la base (por fuera del panel): la página
  // igual no lo recibe. Y un plan sin monto o sin nombre no aparece.
  await prisma.home.update({ where: { id: homePrevio.id }, data: { afiliacionPlan2Link: 'javascript:alert(2)', afiliacionPlan3Monto: 0 } });
  d = (await call(homeController.getHome)).body.planesAfiliacion;
  check('D3', d.length === 2 && d[1].nombre === 'Plan test dos' && d[1].link === null, 'el link inválido de la base sale como null y el plan sin monto no aparece');
  await prisma.home.update({ where: { id: homePrevio.id }, data: { afiliacionPlan1Nombre: '' } });
  d = (await call(homeController.getHome)).body.planesAfiliacion;
  check('D4', d.length === 1 && d[0].nombre === 'Plan test dos', 'el plan sin nombre tampoco aparece');
  check('D5', planes.linkPlanValido(LINK_1) && planes.linkPlanValido(LINK_2) && !planes.linkPlanValido('') && !planes.linkPlanValido(null), 'linkPlanValido: los dos de MP sí, vacío y null no');

  // ── E · El HTML ────────────────────────────────────────────────────────────
  console.log('E · el HTML');
  process.env[SALIDA_ENV] = '2099-01-01T00:00:00-03:00';
  let e = await call(afiliate.pagina);
  check('E1', /noindex/.test(e.headers['X-Robots-Tag'] || '') && /afiliate\.html$/.test(e.archivo || ''), 'antes de la salida, /afiliate va con noindex');
  process.env[SALIDA_ENV] = '2000-01-01T00:00:00-03:00';
  e = await call(afiliate.pagina);
  check('E2', !e.headers['X-Robots-Tag'] && /afiliate\.html$/.test(e.archivo || ''), 'después, /afiliate se puede indexar (control del E1)');
  const g = await call(afiliate.gracias);
  check('E3', /noindex/.test(g.headers['X-Robots-Tag'] || '') && /afiliate-gracias\.html$/.test(g.archivo || ''), '/afiliate/gracias va con noindex siempre');
  delete process.env[SALIDA_ENV];

  // Los montos y los links no viven en el HTML. El detector tiene su control:
  // tiene que encontrar un monto y un link en un texto que los tiene.
  const MONTO = /\$\s?\d{1,3}(\.\d{3})+/;
  const LINK_MP = /(mercadopago\.com\.ar\/subscriptions|mpago\.la\/)/;
  check('E4', MONTO.test('Cuota $1.234 por mes') && LINK_MP.test(LINK_1) && LINK_MP.test(LINK_2), 'control: el detector encuentra un monto y un link de MP');
  for (const f of ['afiliate.html', 'afiliate-gracias.html']) {
    const ruta = path.join(PUBLIC, f);
    const html = fs.existsSync(ruta) ? fs.readFileSync(ruta, 'utf8') : null;
    check(`E5·${f}`, html !== null && !MONTO.test(html) && !LINK_MP.test(html), `${f} existe y no tiene montos ni links de planes`);
  }
  const pag = fs.existsSync(path.join(PUBLIC, 'afiliate.html')) ? fs.readFileSync(path.join(PUBLIC, 'afiliate.html'), 'utf8') : '';
  check('E6', /\/api\/home/.test(pag) && /planesAfiliacion/.test(pag), 'la página lee los planes de /api/home');
  check('E7', !/innerHTML\s*=/.test(pag.replace(/<style[\s\S]*?<\/style>/g, '')), 'la página no pinta nada con innerHTML (lo del panel va con textContent)');

  // ── F · La portada ─────────────────────────────────────────────────────────
  console.log('F · la portada');
  const index = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  const seccion = index.match(/<section[^>]*id="afiliate"[^>]*>/);
  check('F1', !!seccion && /\shidden(\s|>|=)/.test(seccion[0]), 'la sección nueva está y viene oculta');
  const waitlist = index.match(/<section[^>]*id="waitlist"[^>]*>/);
  check('F2', !!waitlist && !/\shidden(\s|>|=)/.test(waitlist[0]), 'la lista de espera viene visible: sin JS, lo de hoy');
  check('F3', /id="nav-sumate"[^>]*href="#waitlist"[^>]*>Sumate</.test(index) || /href="#waitlist"[^>]*id="nav-sumate"[^>]*>Sumate</.test(index), 'el link del menú sigue diciendo «Sumate» en el HTML');
  const app = fs.readFileSync(path.join(PUBLIC, 'assets/js/app.js'), 'utf8');
  check('F4', /afiliacionesAbiertas/.test(app), 'app.js decide con afiliacionesAbiertas de /api/home (no con el reloj del celular)');
}

async function restaurar() {
  if (envPrevio === undefined) delete process.env[SALIDA_ENV]; else process.env[SALIDA_ENV] = envPrevio;
  if (!homePrevio) return;
  const data = {};
  for (const c of CAMPOS) if (c in homePrevio) data[c] = homePrevio[c];
  data.textoEvento = homePrevio.textoEvento;
  try { await prisma.home.update({ where: { id: homePrevio.id }, data }); } catch (_) { /* sin las columnas todavía */ }
}

main()
  .catch((e) => { fail += 1; console.error('  💥', e); })
  .finally(async () => {
    await restaurar();
    await prisma.$disconnect();
    console.log(`\n${fail === 0 ? '✅' : '❌'} afiliate-pagina: ${pass} OK · ${fail} FAIL`);
    process.exit(fail === 0 ? 0 : 1);
  });
