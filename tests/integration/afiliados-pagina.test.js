/**
 * Tests de integración — La página de afiliadxs (escalón 0): la dirección
 * privada, su rotación, la lista de videos y los cupones que lista sola.
 *
 * Cubre:
 *   A · La dirección: sin ninguna, rotar crea la primera; rotar de nuevo apaga la
 *       anterior en el acto (una sola activa); quién la creó.
 *   B · La puerta pública (requireAccesoAfiliados): 404 UNIFORME para la vieja,
 *       la inventada y la mal formada; no-store siempre; registra el último uso.
 *   C · La lista de videos: sólo links de YouTube con lista; se guarda normalizada;
 *       una inválida no pisa la guardada; vaciarla se puede. Y el candado: la
 *       lista NO sale por `GET /api/home`, que es público.
 *   D · Los cupones que se listan: sólo los de afiliadxs, activos, sin vencer, de
 *       shows publicados, propios y por venir; el agotado se lista marcado. Un
 *       cupón común del mismo show NO aparece.
 *   E · La respuesta pública: lista + cupones, sin datos de más.
 *   F · El HTML: noindex, no-store y no-referrer en la respuesta.
 *
 * Controllers/servicios directos con req/res mock. Uso local (dev.db):
 *   node tests/integration/afiliados-pagina.test.js
 * Exit codes: 0 = PASS, 1 = FAIL
 */

const prisma = require('../../src/utils/prisma');
const service = require('../../src/services/afiliados.service');
const controller = require('../../src/controllers/afiliados.controller');
const homeController = require('../../src/controllers/home.controller');
const { requireAccesoAfiliados } = require('../../src/middleware/auth.middleware');

const TEST_PREFIX = 'afiliados-pagina-test-';
const LISTA_ID = 'PLtestAfiliadxs_0123-abcdefXYZ';

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
function mockReq({ params = {}, query = {}, body = {}, session = {} } = {}) {
  return { params, query, body, session };
}
async function call(handler, req) { const res = mockRes(); await handler(req, res); return res; }
async function callMw(mw, req) {
  const res = mockRes();
  let nextCalled = false;
  await mw(req, res, () => { nextCalled = true; });
  return { res, nextCalled };
}

// Estado previo de las dos tablas globales: el test las usa y al final las deja
// como estaban (dev.db puede tener una dirección o una lista cargadas a mano).
let accesosPrevios = [];
let contenidoPrevio = [];

async function guardarEstado() {
  accesosPrevios = await prisma.accesoAfiliados.findMany();
  contenidoPrevio = await prisma.contenidoAfiliados.findMany();
}
async function restaurarEstado() {
  await prisma.accesoAfiliados.deleteMany({});
  for (const a of accesosPrevios) await prisma.accesoAfiliados.create({ data: a });
  await prisma.contenidoAfiliados.deleteMany({});
  for (const c of contenidoPrevio) await prisma.contenidoAfiliados.create({ data: c });
}

async function cleanupEventos() {
  const eventos = await prisma.evento.findMany({ where: { nombre: { startsWith: TEST_PREFIX } }, select: { id: true } });
  const ids = eventos.map((e) => e.id);
  if (!ids.length) return;
  await prisma.cuponDescuento.deleteMany({ where: { eventoId: { in: ids } } });
  await prisma.tanda.deleteMany({ where: { eventoId: { in: ids } } });
  await prisma.evento.deleteMany({ where: { id: { in: ids } } });
}

const DIA = 864e5;
async function crearEvento(sufijo, { dias = 10, estaPublicado = true, esExterno = false, estaAgotado = false } = {}) {
  return prisma.evento.create({
    data: {
      nombre: `${TEST_PREFIX}${sufijo}`, descripcion: 'test', invitado: `Invitadx ${sufijo}`,
      fecha: new Date(Date.now() + dias * DIA), hora: '21:00',
      estaPublicado, esExterno, estaAgotado,
      linkExterno: esExterno ? 'https://example.invalid' : null,
      tandas: { create: [{ nombre: 'General', precio: 1000, orden: 1, activa: true }] },
    },
  });
}
let nCupon = 0;
async function crearCupon(eventoId, extra = {}) {
  nCupon += 1;
  return prisma.cuponDescuento.create({
    data: {
      eventoId, codigo: `${TEST_PREFIX}C${nCupon}`.toUpperCase(), tipo: 'porcentaje', valor: 100,
      topeUsos: 10, paraAfiliados: true, unaEntradaPorCompra: true, ...extra,
    },
  });
}

async function main() {
  await cleanupEventos();
  await guardarEstado();
  await prisma.accesoAfiliados.deleteMany({});
  await prisma.contenidoAfiliados.deleteMany({});

  const sesion = { usuario: { email: 'coordinacion@test.invalid', rol: 1 } };

  // ── A · La dirección ──────────────────────────────────────────────────────
  console.log('\nA · La dirección');
  let r = await call(controller.adminGetAcceso, mockReq({ session: sesion }));
  check('A1', r.statusCode === 200 && r.body && r.body.vigente === null, 'sin ninguna creada, vigente = null');

  r = await call(controller.adminRotarAcceso, mockReq({ session: sesion }));
  const primera = r.body && r.body.vigente;
  check('A2', r.statusCode === 201 && primera && /^[0-9a-f]{64}$/.test(primera.token), 'rotar crea la primera: 64 hex');
  check('A2b', primera && primera.url === `/afiliados/${primera.token}`, 'trae su dirección /afiliados/<token>');
  check('A2c', primera && primera.creadoPor === 'coordinacion@test.invalid', 'guarda quién la creó');

  r = await call(controller.adminRotarAcceso, mockReq({ session: sesion }));
  const segunda = r.body && r.body.vigente;
  const activas = await prisma.accesoAfiliados.findMany({ where: { activo: true } });
  check('A3', segunda && primera && segunda.token !== primera.token, 'rotar de nuevo da otra');
  check('A3b', activas.length === 1 && activas[0].token === segunda.token, 'queda UNA sola activa: la nueva');
  const vieja = await prisma.accesoAfiliados.findUnique({ where: { token: primera.token } });
  check('A3c', vieja && vieja.activo === false, 'la anterior queda apagada, no borrada');

  r = await call(controller.adminGetAcceso, mockReq({ session: sesion }));
  check('A4', r.body && r.body.vigente && r.body.vigente.token === segunda.token, 'vigente = la última');

  // ── B · La puerta pública ─────────────────────────────────────────────────
  console.log('\nB · La puerta pública');
  const ok = await callMw(requireAccesoAfiliados, mockReq({ params: { token: segunda.token } }));
  check('B1', ok.nextCalled, 'la vigente pasa');
  check('B1b', ok.res.headers['Cache-Control'] === 'no-store', 'con no-store');
  await new Promise((res) => setTimeout(res, 50));
  const conUso = await prisma.accesoAfiliados.findUnique({ where: { token: segunda.token } });
  check('B1c', conUso && conUso.ultimoAcceso instanceof Date, 'registra el último uso');

  const casos = {
    vieja: primera.token,
    inventada: 'f'.repeat(64),
    corta: 'abc',
    mayusculas: segunda.token.toUpperCase(),
    vacia: '',
  };
  const respuestas = {};
  for (const [nombre, token] of Object.entries(casos)) {
    const x = await callMw(requireAccesoAfiliados, mockReq({ params: { token } }));
    respuestas[nombre] = x;
    check(`B2·${nombre}`, !x.nextCalled && x.res.statusCode === 404, `${nombre}: 404 y no pasa`);
  }
  const cuerpos = new Set(Object.values(respuestas).map((x) => JSON.stringify(x.res.body)));
  check('B3', cuerpos.size === 1, 'el 404 es idéntico en todos los casos (no dice cuál fue)');
  check('B3b', Object.values(respuestas).every((x) => x.res.headers['Cache-Control'] === 'no-store'), 'no-store también en el 404');

  // ── C · La lista de videos ────────────────────────────────────────────────
  console.log('\nC · La lista de videos');
  r = await call(controller.adminGetContenido, mockReq({ session: sesion }));
  check('C1', r.statusCode === 200 && r.body && r.body.listaUrl === '' && r.body.listaId === null, 'sin cargar: vacía');

  r = await call(controller.adminPutContenido, mockReq({ session: sesion, body: { listaUrl: `https://www.youtube.com/playlist?list=${LISTA_ID}` } }));
  check('C2', r.statusCode === 200 && r.body && r.body.listaId === LISTA_ID, 'guarda un link de lista');

  const validas = [
    `https://youtube.com/playlist?list=${LISTA_ID}&si=abc`,
    `https://m.youtube.com/playlist?list=${LISTA_ID}`,
    `https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=${LISTA_ID}&index=2`,
    `https://youtu.be/dQw4w9WgXcQ?list=${LISTA_ID}`,
    `  https://www.youtube.com/playlist?list=${LISTA_ID}  `,
  ];
  for (const [i, url] of validas.entries()) {
    const x = await call(controller.adminPutContenido, mockReq({ session: sesion, body: { listaUrl: url } }));
    check(`C3·${i + 1}`, x.statusCode === 200 && x.body.listaId === LISTA_ID
      && x.body.listaUrl === `https://www.youtube.com/playlist?list=${LISTA_ID}`, `variante válida ${i + 1}, guardada normalizada`);
  }

  const invalidas = {
    otroSitio: `https://vimeo.com/playlist?list=${LISTA_ID}`,
    imitacion: `https://youtube.com.example.invalid/playlist?list=${LISTA_ID}`,
    sinLista: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    javascript: 'javascript:alert(1)',
    listaRara: 'https://www.youtube.com/playlist?list=PL"><script>',
    noUrl: 'cualquier cosa',
    noString: 12345,
  };
  for (const [nombre, url] of Object.entries(invalidas)) {
    const x = await call(controller.adminPutContenido, mockReq({ session: sesion, body: { listaUrl: url } }));
    check(`C4·${nombre}`, x.statusCode === 400, `${nombre}: 400`);
  }
  const trasInvalidas = await service.obtenerContenido();
  check('C4b', trasInvalidas.listaId === LISTA_ID, 'una inválida no pisa la guardada');

  r = await call(controller.adminPutContenido, mockReq({ session: sesion, body: { listaUrl: '' } }));
  check('C5', r.statusCode === 200 && r.body.listaUrl === '' && r.body.listaId === null, 'vaciarla se puede');
  await call(controller.adminPutContenido, mockReq({ session: sesion, body: { listaUrl: `https://www.youtube.com/playlist?list=${LISTA_ID}` } }));
  check('C5b', (await prisma.contenidoAfiliados.count()) === 1, 'una sola fila de contenido');

  const home = await call(homeController.getHome, mockReq());
  check('C6', home.statusCode !== 200 || !JSON.stringify(home.body).includes(LISTA_ID), 'la lista NO sale por GET /api/home (público)');

  // ── D · Los cupones que se listan ─────────────────────────────────────────
  console.log('\nD · Los cupones que se listan');
  const eLejano = await crearEvento('lejano', { dias: 20 });
  const eCerca = await crearEvento('cerca', { dias: 5 });
  const ePasado = await crearEvento('pasado', { dias: -3 });
  const eOculto = await crearEvento('oculto', { estaPublicado: false });
  const eExterno = await crearEvento('externo', { esExterno: true });
  const eAgotado = await crearEvento('agotado', { dias: 8, estaAgotado: true });

  const cLejano = await crearCupon(eLejano.id);
  const cCerca = await crearCupon(eCerca.id, { tipo: 'porcentaje', valor: 50 });
  const cComun = await crearCupon(eCerca.id, { paraAfiliados: false, unaEntradaPorCompra: false });
  const cPasado = await crearCupon(ePasado.id);
  const cOculto = await crearCupon(eOculto.id);
  const cExterno = await crearCupon(eExterno.id);
  const cApagado = await crearCupon(eLejano.id, { activo: false });
  const cVencido = await crearCupon(eLejano.id, { validoHasta: new Date(Date.now() - DIA) });
  const cConVigencia = await crearCupon(eLejano.id, { validoHasta: new Date(Date.now() + DIA) });
  const cTope = await crearCupon(eCerca.id, { topeUsos: 2, usosActuales: 2 });
  const cShowAgotado = await crearCupon(eAgotado.id);

  const listados = (await service.cuponesListados()).filter((c) => c.evento.nombre.startsWith(TEST_PREFIX));
  const codigos = listados.map((c) => c.codigo);
  const esta = (c) => codigos.includes(c.codigo);

  check('D1', esta(cLejano) && esta(cCerca) && esta(cConVigencia), 'los de afiliadxs, activos, de shows por venir');
  check('D2', !esta(cComun), 'un cupón común del mismo show NO aparece');
  check('D3', !esta(cPasado), 'el de un show que ya pasó, no');
  check('D4', !esta(cOculto), 'el de un show sin publicar, no');
  check('D5', !esta(cExterno), 'el de un show con venta por fuera, no');
  check('D6', !esta(cApagado), 'el desactivado, no');
  check('D7', !esta(cVencido), 'el vencido, no');
  const tope = listados.find((c) => c.codigo === cTope.codigo);
  const showAgotado = listados.find((c) => c.codigo === cShowAgotado.codigo);
  const lejano = listados.find((c) => c.codigo === cLejano.codigo);
  check('D8', tope && tope.agotado === true, 'el que llegó al tope se lista como agotado');
  check('D8b', showAgotado && showAgotado.agotado === true, 'el de un show agotado, también');
  check('D8c', lejano && lejano.agotado === false, 'el que tiene lugar, no agotado');
  const orden = listados.map((c) => c.evento.id);
  const iCerca = orden.indexOf(eCerca.id);
  const iLejano = orden.indexOf(eLejano.id);
  check('D9', iCerca !== -1 && iLejano !== -1 && iCerca < iLejano, 'ordenados por fecha del show');
  const cerca = listados.find((c) => c.codigo === cCerca.codigo);
  check('D10', cerca && cerca.beneficio && cerca.beneficio.tipo === 'porcentaje' && cerca.beneficio.valor === 50, 'trae el beneficio para mostrarlo');

  // ── E · La respuesta pública ──────────────────────────────────────────────
  console.log('\nE · La respuesta pública');
  const req = mockReq({ params: { token: segunda.token } });
  const mw = await callMw(requireAccesoAfiliados, req);
  const pub = mockRes();
  pub.headers = { ...mw.res.headers };
  await controller.contenidoPublico(req, pub);
  check('E1', pub.statusCode === 200 && pub.body && pub.body.lista && pub.body.lista.id === LISTA_ID, 'trae el id de la lista');
  check('E1b', !JSON.stringify(pub.body).includes('youtube.com/playlist'), 'no manda el link de la lista, sólo el id');
  check('E1c', pub.headers['Cache-Control'] === 'no-store', 'no-store');
  const nuestros = (pub.body.cupones || []).filter((c) => c.evento.nombre.startsWith(TEST_PREFIX));
  check('E2', nuestros.length === listados.length, 'los mismos cupones que la lista');
  const campos = new Set(nuestros.flatMap((c) => Object.keys(c)));
  const camposEvento = new Set(nuestros.flatMap((c) => Object.keys(c.evento)));
  const prohibidos = ['usosActuales', 'topeUsos', 'id', 'eventoId', 'activo', 'validoHasta', 'paraAfiliados'];
  check('E3', prohibidos.every((p) => !campos.has(p)), 'sin usos, topes ni ids internos del cupón');
  check('E3b', [...camposEvento].every((k) => ['id', 'nombre', 'fecha', 'hora', 'invitado'].includes(k)), 'del show, sólo lo que se muestra');
  const token = segunda.token;
  check('E4', !JSON.stringify(pub.body).includes(token), 'la respuesta no repite la dirección');

  await prisma.contenidoAfiliados.deleteMany({});
  const sinLista = mockRes();
  await controller.contenidoPublico(req, sinLista);
  check('E5', sinLista.statusCode === 200 && sinLista.body.lista === null, 'sin lista cargada: lista = null, no se cae');

  // ── F · El HTML ───────────────────────────────────────────────────────────
  console.log('\nF · El HTML');
  const html = await call(controller.paginaHtml, mockReq({ params: { token: 'x' } }));
  check('F1', html.archivo && /public[\\/]afiliados[\\/]index\.html$/.test(html.archivo), 'sirve public/afiliados/index.html');
  check('F2', /noindex/.test(html.headers['X-Robots-Tag'] || ''), 'X-Robots-Tag noindex');
  check('F3', html.headers['Cache-Control'] === 'no-store', 'Cache-Control no-store');
  check('F4', html.headers['Referrer-Policy'] === 'no-referrer', 'Referrer-Policy no-referrer');
}

main()
  .catch((err) => { fail += 1; console.error('💥', err); })
  .finally(async () => {
    try { await cleanupEventos(); await restaurarEstado(); } catch (e) { fail += 1; console.error('💥 cleanup', e); }
    await prisma.$disconnect();
    console.log(`\n${pass} ok · ${fail} fallas`);
    process.exit(fail === 0 && pass > 0 ? 0 : 1);
  });
