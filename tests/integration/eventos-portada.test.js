/**
 * Tests de integración — Portada: carrusel de eventos (controller directo).
 *
 * Cubre los cambios del Sprint 5 (ítem 1):
 *   1. getProximos ya NO corta en 3 → devuelve todos los publicados vigentes.
 *   2. getProximos respeta los filtros (excluye despublicados y fechas pasadas).
 *   3. updateHome acepta/valida el campo nuevo eventosVisiblesPortada
 *      (acepta >=1, rechaza 0 y no-numérico) y getHome lo expone.
 *
 * Llama a los controllers con req/res mock (no pasa por HTTP/middleware).
 *
 * Uso local (con dev.db):
 *   node tests/integration/eventos-portada.test.js
 *
 * Exit codes: 0 = PASS, 1 = FAIL
 */

const prisma = require('../../src/utils/prisma');
const eventosController = require('../../src/controllers/eventos.controller');
const homeController = require('../../src/controllers/home.controller');

const TEST_PREFIX = 'eventos-portada-test-';

function mockRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return res;
}

function mockReq({ params = {}, query = {}, body = {} } = {}) {
  return { params, query, body };
}

async function call(handler, req) {
  const res = mockRes();
  await handler(req, res);
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

async function crearEvento({ sufijo, dias, publicado = true }) {
  return prisma.evento.create({
    data: {
      nombre: `${TEST_PREFIX}${sufijo}`,
      descripcion: 'test',
      fecha: new Date(Date.now() + dias * 24 * 60 * 60 * 1000),
      hora: '21:00',
      estaPublicado: publicado,
      tandas: { create: [{ nombre: 'General', precio: 1000, orden: 1, activa: true }] },
    },
  });
}

async function main() {
  const checks = [];
  let homeOriginal = null;

  try {
    await cleanup();

    // ── getProximos: no corta en 3 ──────────────────────────────────────────
    const creados = [];
    for (let i = 1; i <= 5; i++) {
      creados.push(await crearEvento({ sufijo: `pub-${i}`, dias: 10 + i }));
    }
    const despublicado = await crearEvento({ sufijo: 'despub', dias: 12, publicado: false });
    const pasado = await crearEvento({ sufijo: 'pasado', dias: -10 });

    const r = await call(eventosController.getProximos, mockReq());
    const ids = Array.isArray(r.body) ? r.body.map((e) => e.id) : [];

    checks.push({
      name: 'getProximos devuelve los 5 publicados vigentes (no corta en 3)',
      pass: creados.every((e) => ids.includes(e.id)),
      detail: `presentes=${creados.filter((e) => ids.includes(e.id)).length}/5, total devuelto=${ids.length}`,
    });
    checks.push({
      name: 'getProximos excluye el evento despublicado',
      pass: !ids.includes(despublicado.id),
      detail: `despublicado.id=${despublicado.id} presente=${ids.includes(despublicado.id)}`,
    });
    checks.push({
      name: 'getProximos excluye el evento de fecha pasada',
      pass: !ids.includes(pasado.id),
      detail: `pasado.id=${pasado.id} presente=${ids.includes(pasado.id)}`,
    });

    // ── updateHome: eventosVisiblesPortada ──────────────────────────────────
    homeOriginal = await prisma.home.findFirst();
    if (!homeOriginal) throw new Error('No hay registro Home en dev.db para testear updateHome');

    let res = await call(homeController.updateHome, mockReq({ body: { eventosVisiblesPortada: 5 } }));
    checks.push({
      name: 'updateHome acepta eventosVisiblesPortada=5',
      pass: res.statusCode === 200 && res.body && res.body.eventosVisiblesPortada === 5,
      detail: `status=${res.statusCode} val=${res.body?.eventosVisiblesPortada}`,
    });

    res = await call(homeController.updateHome, mockReq({ body: { eventosVisiblesPortada: 0 } }));
    checks.push({
      name: 'updateHome rechaza 0 (queda en el valor previo, 5)',
      pass: res.body && res.body.eventosVisiblesPortada === 5,
      detail: `val=${res.body?.eventosVisiblesPortada}`,
    });

    res = await call(homeController.updateHome, mockReq({ body: { eventosVisiblesPortada: 'abc' } }));
    checks.push({
      name: 'updateHome rechaza no-numérico (queda en 5)',
      pass: res.body && res.body.eventosVisiblesPortada === 5,
      detail: `val=${res.body?.eventosVisiblesPortada}`,
    });

    res = await call(homeController.getHome, mockReq());
    checks.push({
      name: 'getHome expone eventosVisiblesPortada (numérico)',
      pass: res.body && typeof res.body.eventosVisiblesPortada === 'number',
      detail: `val=${res.body?.eventosVisiblesPortada}`,
    });

    console.log('─'.repeat(60));
    console.log('Portada / Carrusel de Eventos — Integration Test');
    console.log('─'.repeat(60));
    for (const c of checks) {
      console.log(`${c.pass ? '✅' : '❌'} ${c.name}`);
      console.log(`   ${c.detail}`);
    }
    console.log('─'.repeat(60));

    const failed = checks.filter((c) => !c.pass);
    if (failed.length > 0) {
      console.log(`\n❌ FAIL — ${failed.length}/${checks.length} checks fallaron`);
      process.exitCode = 1;
    } else {
      console.log(`\n✅ PASS — ${checks.length}/${checks.length} checks OK`);
      process.exitCode = 0;
    }
  } catch (err) {
    console.error('❌ ERROR INESPERADO:', err.message);
    console.error(err.stack);
    process.exitCode = 1;
  } finally {
    // Restaurar el valor original del Home para no dejar la dev.db con datos de test.
    if (homeOriginal) {
      try {
        await prisma.home.update({
          where: { id: homeOriginal.id },
          data: { eventosVisiblesPortada: homeOriginal.eventosVisiblesPortada },
        });
      } catch (e) { console.error('WARN restaurar Home:', e.message); }
    }
    try { await cleanup(); } catch (e) { console.error('WARN cleanup:', e.message); }
    await prisma.$disconnect();
    process.exit(process.exitCode || 0);
  }
}

main();
