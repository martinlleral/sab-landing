/**
 * Tests de integración — campo porcentajeAporte en CRUD de tandas.
 *
 * Sprint 3 ítem 2 paso A. Solo cubre el campo nuevo; el flujo end-to-end de
 * compra con tipoEntrada=aporte ya está cubierto por compras-cupones.test.js.
 *
 * Uso local (con dev.db):
 *   node tests/integration/tandas-aporte.test.js
 */

const prisma = require('../../src/utils/prisma');
const controller = require('../../src/controllers/tandas.controller');

const TEST_PREFIX = 'tandas-aporte-test-';

function mockRes() {
  return {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(p) { this.body = p; return this; },
  };
}
function mockReq({ params = {}, body = {}, query = {} } = {}) {
  return { params, body, query };
}
async function call(handler, req) {
  const res = mockRes();
  await handler(req, res);
  return res;
}

async function cleanup() {
  const eventos = await prisma.evento.findMany({
    where: { nombre: { startsWith: TEST_PREFIX } }, select: { id: true },
  });
  const ids = eventos.map((e) => e.id);
  if (ids.length === 0) return;
  await prisma.tanda.deleteMany({ where: { eventoId: { in: ids } } });
  await prisma.evento.deleteMany({ where: { id: { in: ids } } });
}

async function setupEvento(sufijo = '') {
  return prisma.evento.create({
    data: {
      nombre: `${TEST_PREFIX}${sufijo || Date.now()}`,
      descripcion: 'test', fecha: new Date(Date.now() + 30 * 86400000), hora: '21:00',
      estaPublicado: true,
    },
  });
}

async function main() {
  const checks = [];
  try {
    await cleanup();

    const ev = await setupEvento('crear');

    // ============================================
    // BLOQUE 1 — adminCrear acepta porcentajeAporte
    // ============================================

    // Sin porcentajeAporte → default 0 (retrocompat)
    const r1 = await call(controller.adminCrear, mockReq({
      body: { eventoId: ev.id, nombre: 'Sin aporte', precio: 5000, orden: 1 },
    }));
    checks.push({
      name: 'crear sin porcentajeAporte → 201 con porcentajeAporte=0 (retrocompat)',
      pass: r1.statusCode === 201 && r1.body?.porcentajeAporte === 0,
      detail: `status=${r1.statusCode} porcentajeAporte=${r1.body?.porcentajeAporte}`,
    });

    // Con porcentajeAporte=30 explícito
    const r2 = await call(controller.adminCrear, mockReq({
      body: { eventoId: ev.id, nombre: 'Con aporte', precio: 5000, orden: 2, porcentajeAporte: 30 },
    }));
    checks.push({
      name: '🎯 crear con porcentajeAporte=30 → 201 con valor guardado',
      pass: r2.statusCode === 201 && r2.body?.porcentajeAporte === 30,
      detail: `porcentajeAporte=${r2.body?.porcentajeAporte}`,
    });

    // ============================================
    // BLOQUE 2 — Validaciones de input (crear)
    // ============================================

    const baseInvalid = { eventoId: ev.id, nombre: 'X', precio: 5000, orden: 99 };

    const r3 = await call(controller.adminCrear, mockReq({ body: { ...baseInvalid, porcentajeAporte: -5 } }));
    checks.push({
      name: 'crear con porcentajeAporte=-5 → 400',
      pass: r3.statusCode === 400 && /entre 0 y 100/i.test(r3.body?.error),
      detail: `status=${r3.statusCode} error=${r3.body?.error}`,
    });

    const r4 = await call(controller.adminCrear, mockReq({ body: { ...baseInvalid, porcentajeAporte: 150 } }));
    checks.push({
      name: 'crear con porcentajeAporte=150 → 400 (tope superior)',
      pass: r4.statusCode === 400 && /entre 0 y 100/i.test(r4.body?.error),
      detail: `error=${r4.body?.error}`,
    });

    const r5 = await call(controller.adminCrear, mockReq({ body: { ...baseInvalid, porcentajeAporte: 'abc' } }));
    checks.push({
      name: 'crear con porcentajeAporte="abc" → 400',
      pass: r5.statusCode === 400 && /entre 0 y 100/i.test(r5.body?.error),
      detail: `error=${r5.body?.error}`,
    });

    // ============================================
    // BLOQUE 3 — adminActualizar acepta porcentajeAporte
    // ============================================

    // Cambiar de 0 a 50
    const tandaSinAporte = await prisma.tanda.findFirst({
      where: { eventoId: ev.id, nombre: 'Sin aporte' },
    });
    const r6 = await call(controller.adminActualizar, mockReq({
      params: { id: tandaSinAporte.id },
      body: { porcentajeAporte: 50 },
    }));
    checks.push({
      name: 'PATCH porcentajeAporte 0 → 50',
      pass: r6.statusCode === 200 && r6.body?.porcentajeAporte === 50,
      detail: `porcentajeAporte=${r6.body?.porcentajeAporte}`,
    });

    // Cambiar de 50 a 0 (desactivar aporte)
    const r7 = await call(controller.adminActualizar, mockReq({
      params: { id: tandaSinAporte.id },
      body: { porcentajeAporte: 0 },
    }));
    checks.push({
      name: 'PATCH porcentajeAporte 50 → 0 (desactivar aporte)',
      pass: r7.statusCode === 200 && r7.body?.porcentajeAporte === 0,
      detail: `porcentajeAporte=${r7.body?.porcentajeAporte}`,
    });

    // Validación en update
    const r8 = await call(controller.adminActualizar, mockReq({
      params: { id: tandaSinAporte.id },
      body: { porcentajeAporte: 200 },
    }));
    checks.push({
      name: 'PATCH porcentajeAporte=200 → 400',
      pass: r8.statusCode === 400 && /entre 0 y 100/i.test(r8.body?.error),
      detail: `error=${r8.body?.error}`,
    });

    // ============================================
    // BLOQUE 4 — adminListar devuelve porcentajeAporte
    // ============================================

    const r9 = await call(controller.adminListar, mockReq({ query: { eventoId: ev.id } }));
    const tandasConAporte = r9.body.filter((t) => typeof t.porcentajeAporte === 'number');
    checks.push({
      name: 'listar tandas → todas traen porcentajeAporte',
      pass: r9.statusCode === 200 && tandasConAporte.length === r9.body.length,
      detail: `total=${r9.body.length} conCampo=${tandasConAporte.length}`,
    });

    // ============================================
    // REPORT
    // ============================================

    console.log('─'.repeat(72));
    console.log('Tandas Aporte — Test del campo porcentajeAporte (paso A ítem 2)');
    console.log('─'.repeat(72));
    for (const c of checks) {
      console.log(`${c.pass ? '✅' : '❌'} ${c.name}`);
      console.log(`   ${c.detail}`);
    }
    console.log('─'.repeat(72));

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
    try { await cleanup(); } catch (e) { console.error('WARN cleanup:', e.message); }
    await prisma.$disconnect();
    process.exit(process.exitCode || 0);
  }
}

main();
