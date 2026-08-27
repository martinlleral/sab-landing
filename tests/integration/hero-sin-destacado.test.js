/**
 * Tests de integración — El hero de la portada nunca queda mudo (fix del 27/8/2026).
 *
 * EL BUG QUE ESTOS TESTS EXISTEN PARA QUE NO VUELVA:
 * el 27/8 la portada amaneció mostrando un esqueleto — el badge "PRÓXIMO EVENTO",
 * un guión suelto y "Invitado especial:" sin nadie — con TRES eventos publicados y
 * vendiendo, uno de ellos a seis días. La causa: el evento marcado `esDestacado`
 * era el del 26/8, se venció a las 00:00, y `getDestacado` devolvía 404 porque
 * pedía `esDestacado: true` y nada más.
 *
 * Nadie lo detectó desde el backoffice porque desde ahí era invisible: había que
 * abrir el sitio en otra pestaña para enterarse.
 *
 * LO QUE SE PROTEGE ACÁ:
 *   1. La marca `esDestacado` sigue mandando cuando está vigente — es una elección
 *      editorial, no la pisa un fallback.
 *   2. Cuando NO hay ninguna elección vigente, la portada cae al evento publicado
 *      más próximo en vez de quedarse muda.
 *   3. El 404 sobrevive, pero ahora significa lo que dice: no hay NINGÚN evento
 *      publicado vigente.
 *   4. El backoffice puede decir qué está mostrando la portada — incluso cuando el
 *      destacado cae fuera de la página de la paginación que se está viendo.
 *
 * ⚠️ ESTE TEST DESPUBLICA TEMPORALMENTE los eventos vigentes que no son suyos, y
 * los restaura en el `finally`. Es la única forma de razonar sobre "el próximo
 * evento de toda la base" en una dev.db compartida. Si el proceso muere a mitad,
 * pueden quedar eventos de dev.db despublicados — se arregla volviéndolos a
 * publicar a mano, y NO se corre esto contra prod.db (ver el runbook de deploy).
 *
 * No mockea Prisma: usa dev.db real y limpia con prefijo `hero-destacado-test-`.
 *
 * Uso local:
 *   node tests/integration/hero-sin-destacado.test.js
 *
 * Exit codes: 0 = PASS, 1 = FAIL
 */

const prisma = require('../../src/utils/prisma');
const eventosController = require('../../src/controllers/eventos.controller');

const TEST_PREFIX = 'hero-destacado-test-';
const UN_DIA = 24 * 60 * 60 * 1000;

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

async function call(handler, { params = {}, query = {}, body = {} } = {}) {
  const res = mockRes();
  await handler({ params, query, body, session: {} }, res);
  return res;
}

async function cleanup() {
  const eventos = await prisma.evento.findMany({
    where: { nombre: { startsWith: TEST_PREFIX } },
    select: { id: true },
  });
  const ids = eventos.map((e) => e.id);
  if (ids.length === 0) return;
  await prisma.tanda.deleteMany({ where: { eventoId: { in: ids } } });
  await prisma.evento.deleteMany({ where: { id: { in: ids } } });
}

// Saca de circulación todo lo que no es del test, para que "el próximo evento de
// la base" sea una pregunta con respuesta conocida. Devuelve lo necesario para
// deshacerlo.
async function aislarBase() {
  const ajenos = await prisma.evento.findMany({
    where: {
      estaPublicado: true,
      nombre: { not: { startsWith: TEST_PREFIX } },
    },
    select: { id: true },
  });
  const ids = ajenos.map((e) => e.id);
  if (ids.length) {
    await prisma.evento.updateMany({ where: { id: { in: ids } }, data: { estaPublicado: false } });
  }
  return ids;
}

async function restaurarBase(ids) {
  if (!ids || !ids.length) return;
  await prisma.evento.updateMany({ where: { id: { in: ids } }, data: { estaPublicado: true } });
}

let contador = 0;
async function crearEvento({ dias, destacado = false, publicado = true }) {
  contador += 1;
  return prisma.evento.create({
    data: {
      nombre: `${TEST_PREFIX}${contador}`,
      descripcion: 'test',
      fecha: new Date(Date.now() + dias * UN_DIA),
      hora: '21:00',
      estaPublicado: publicado,
      esDestacado: destacado,
      tandas: { create: [{ nombre: 'General', precio: 1000, orden: 1, activa: true }] },
    },
  });
}

async function borrarTodosLosDeTest() {
  await cleanup();
}

async function main() {
  const checks = [];
  function check(name, cond, detail) {
    if (cond) checks.push({ name, ok: true });
    else checks.push({ name, ok: false, detail });
  }

  let ajenos = null;

  try {
    await cleanup();
    ajenos = await aislarBase();

    // ============================================
    // BLOQUE 1 — La elección editorial manda
    // ============================================
    // El fallback no puede convertirse en "el sistema elige por vos": si alguien
    // marcó un destacado vigente, ese gana aunque no sea el más próximo.
    {
      await crearEvento({ dias: 3 });                      // el más próximo
      const destacado = await crearEvento({ dias: 20, destacado: true });

      const r = await call(eventosController.getDestacado);
      check('1a) con un destacado vigente, gana ese aunque haya uno más próximo',
        r.statusCode === 200 && r.body?.id === destacado.id,
        `status=${r.statusCode} id=${r.body?.id} esperado=${destacado.id}`);

      check('1b) y se marca como elección, no como fallback',
        r.body?.esFallback === false, `esFallback=${r.body?.esFallback}`);

      await borrarTodosLosDeTest();
    }

    // ============================================
    // BLOQUE 2 — 🎯 El bug del 27/8, exacto
    // ============================================
    // Un destacado que YA PASÓ + eventos publicados por delante. Es la fotografía
    // de la portada rota: antes esto devolvía 404.
    {
      await crearEvento({ dias: -1, destacado: true });     // el de ayer, todavía marcado
      const proximo = await crearEvento({ dias: 6 });       // el que hay que mostrar
      await crearEvento({ dias: 16 });
      await crearEvento({ dias: 58 });

      const r = await call(eventosController.getDestacado);
      check('2a) 🎯 destacado vencido + agenda llena: NO devuelve 404',
        r.statusCode === 200, `status=${r.statusCode} body=${JSON.stringify(r.body)}`);

      check('2b) 🎯 muestra el evento publicado más próximo',
        r.body?.id === proximo.id, `id=${r.body?.id} esperado=${proximo.id}`);

      check('2c) 🎯 y avisa que nadie eligió: esFallback = true',
        r.body?.esFallback === true, `esFallback=${r.body?.esFallback}`);

      check('2d) el evento del fallback viene completo (tandas para el botón de compra)',
        Array.isArray(r.body?.tandas) && r.body.tandas.length > 0 && r.body?.tandaVigente !== undefined,
        `tandas=${r.body?.tandas?.length} tandaVigente=${JSON.stringify(r.body?.tandaVigente)?.slice(0, 40)}`);

      await borrarTodosLosDeTest();
    }

    // ============================================
    // BLOQUE 3 — El 404 sigue existiendo, y ahora dice la verdad
    // ============================================
    {
      await crearEvento({ dias: -5 });                      // pasado
      await crearEvento({ dias: 10, publicado: false });    // futuro pero despublicado

      const r = await call(eventosController.getDestacado);
      check('3a) sin NINGÚN evento publicado vigente: 404',
        r.statusCode === 404, `status=${r.statusCode} body=${JSON.stringify(r.body)}`);

      check('3b) 🎯 un evento despublicado NO se usa como fallback',
        r.body?.id === undefined, `devolvió id=${r.body?.id}`);

      await borrarTodosLosDeTest();
    }

    // ============================================
    // BLOQUE 4 — Determinismo con dos destacados marcados
    // ============================================
    // Nadie apaga el `esDestacado` viejo: al 27/8 había CINCO marcados. El día que
    // dos estén vigentes a la vez, el hero no puede depender del orden en que la
    // base devuelva las filas.
    {
      const cercano = await crearEvento({ dias: 4, destacado: true });
      await crearEvento({ dias: 30, destacado: true });

      const r = await call(eventosController.getDestacado);
      check('4a) 🎯 con dos destacados vigentes gana el más próximo, siempre el mismo',
        r.statusCode === 200 && r.body?.id === cercano.id,
        `id=${r.body?.id} esperado=${cercano.id}`);

      await borrarTodosLosDeTest();
    }

    // ============================================
    // BLOQUE 5 — El backoffice se entera solo
    // ============================================
    {
      // 5.1 — sin destacado: el aviso ámbar
      const proximo = await crearEvento({ dias: 5 });
      await crearEvento({ dias: 25 });

      const rSin = await call(eventosController.adminListar, { query: {} });
      const pSin = rSin.body?.portada;
      check('5a) 🎯 el backoffice sabe que nadie marcó destacado',
        pSin?.esFallback === true && pSin?.destacadoVigente === null,
        `portada=${JSON.stringify(pSin)}`);

      check('5b) y sabe cuál se está mostrando en su lugar',
        pSin?.mostrando?.id === proximo.id,
        `mostrando=${pSin?.mostrando?.id} esperado=${proximo.id}`);

      check('5c) el aviso no confunde "sin destacado" con "sin eventos"',
        pSin?.sinEventos === false, `sinEventos=${pSin?.sinEventos}`);

      // 5.2 — con destacado: el aviso verde
      const destacado = await crearEvento({ dias: 40, destacado: true });
      const rCon = await call(eventosController.adminListar, { query: {} });
      const pCon = rCon.body?.portada;
      check('5d) con un destacado vigente, el aviso lo confirma',
        pCon?.esFallback === false && pCon?.destacadoVigente?.id === destacado.id
          && pCon?.mostrando?.id === destacado.id,
        `portada=${JSON.stringify(pCon)}`);

      // 5.3 — EL CASO QUE JUSTIFICA LA QUERY APARTE: el destacado está en otra
      // página de la paginación. Un aviso que sólo funciona en la página 1 es un
      // aviso que no funciona — y con `fecha: desc`, el destacado más lejano en el
      // tiempo es justamente el que aparece primero... o último, según cuántos haya.
      const rPag = await call(eventosController.adminListar, { query: { page: '2', limit: '1' } });
      const pPag = rPag.body?.portada;
      const idsEnPagina = (rPag.body?.eventos || []).map((e) => e.id);
      check('5e) 🎯 el aviso acierta aunque el destacado NO esté en la página que se ve',
        pPag?.destacadoVigente?.id === destacado.id && !idsEnPagina.includes(destacado.id),
        `destacadoVigente=${pPag?.destacadoVigente?.id} idsEnPagina=${JSON.stringify(idsEnPagina)}`);

      await borrarTodosLosDeTest();

      // 5.4 — sin nada publicado
      const rVacio = await call(eventosController.adminListar, { query: {} });
      const pVacio = rVacio.body?.portada;
      check('5f) sin eventos vigentes, el backoffice lo dice con su propio estado',
        pVacio?.sinEventos === true && pVacio?.mostrando === null,
        `portada=${JSON.stringify(pVacio)}`);
    }

    // ============================================
    // RESULTADO
    // ============================================
    const failed = checks.filter((c) => !c.ok);
    const passed = checks.length - failed.length;
    console.log('');
    console.log('========================================');
    console.log(`Tests Hero sin destacado: ${passed}/${checks.length} OK`);
    console.log('========================================');
    if (failed.length) {
      console.log('');
      console.log('FALLAS:');
      for (const x of failed) {
        console.log(`  ✗ ${x.name}`);
        if (x.detail !== undefined) console.log('    detalle:', x.detail);
      }
      process.exitCode = 1;
    } else {
      console.log('Todos los checks verdes ✓');
    }
  } catch (err) {
    console.error('ERROR EN TESTS:', err);
    process.exitCode = 1;
  } finally {
    await cleanup();
    await restaurarBase(ajenos);
    await prisma.$disconnect();
  }
}

main();
