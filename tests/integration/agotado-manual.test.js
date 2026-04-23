/**
 * Test de integración: toggle manual "Entradas agotadas" (estaAgotado).
 *
 * Qué valida:
 *   1. Con estaAgotado=true, POST /api/compras/preferencia devuelve 400
 *      con mensaje "Entradas agotadas para este evento".
 *   2. Con estaAgotado=false y stock >0, la misma request crea la compra.
 *   3. El flag viaja en el response de GET /api/eventos/destacado y /proximos
 *      (el frontend lo necesita para renderizar la cinta AGOTADO).
 *
 * Uso:
 *   docker exec sab-app node tests/integration/agotado-manual.test.js
 *
 * Exit codes:
 *   0 = PASS, 1 = FAIL
 */

const prisma = require('../../src/utils/prisma');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TEST_EVENTO_NAME = 'Agotado Manual Test Event';
const TEST_EMAIL_PREFIX = 'agotado-test-';

async function cleanup() {
  const compras = await prisma.compra.findMany({
    where: { email: { contains: TEST_EMAIL_PREFIX } },
    select: { id: true, eventoId: true },
  });
  const compraIds = compras.map((c) => c.id);
  const eventoIds = [...new Set(compras.map((c) => c.eventoId))];

  await prisma.entrada.deleteMany({ where: { compraId: { in: compraIds } } });
  await prisma.compra.deleteMany({ where: { id: { in: compraIds } } });
  await prisma.evento.deleteMany({
    where: { nombre: TEST_EVENTO_NAME },
  });
}

async function postCompra(eventoId, emailSuffix) {
  const res = await fetch(`${BASE_URL}/api/compras/preferencia`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      eventoId,
      email: `${TEST_EMAIL_PREFIX}${emailSuffix}@test.invalid`,
      nombre: 'Agotado',
      apellido: 'Test',
      telefono: '0',
      cantidad: 1,
    }),
  });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}

async function main() {
  const ts = Date.now();
  let eventoAgotadoId = null;
  let eventoDisponibleId = null;

  try {
    await cleanup();

    // Evento 1: destacado + agotado manual
    const evAgotado = await prisma.evento.create({
      data: {
        nombre: TEST_EVENTO_NAME,
        descripcion: 'Evento con toggle estaAgotado=true',
        fecha: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        hora: '21:00',
        precioEntrada: 1000,
        cantidadDisponible: 10,
        cantidadVendida: 0,
        estaPublicado: true,
        esDestacado: true,
        estaAgotado: true,
      },
    });
    eventoAgotadoId = evAgotado.id;

    // Evento 2: publicado, stock libre, no agotado — control
    const evDisponible = await prisma.evento.create({
      data: {
        nombre: TEST_EVENTO_NAME,
        descripcion: 'Evento control sin agotar',
        fecha: new Date(Date.now() + 31 * 24 * 60 * 60 * 1000),
        hora: '21:00',
        precioEntrada: 1000,
        cantidadDisponible: 10,
        cantidadVendida: 0,
        estaPublicado: true,
        estaAgotado: false,
      },
    });
    eventoDisponibleId = evDisponible.id;

    const checks = [];

    // Check 1: compra rechazada en evento agotado manual
    const r1 = await postCompra(eventoAgotadoId, `a-${ts}`);
    checks.push({
      name: 'compra en evento estaAgotado=true devuelve 400',
      pass: r1.status === 400,
      detail: `status=${r1.status} body=${JSON.stringify(r1.body)}`,
    });
    checks.push({
      name: 'mensaje de error menciona "agotad"',
      pass: r1.body && typeof r1.body.error === 'string' && /agotad/i.test(r1.body.error),
      detail: `error=${r1.body?.error}`,
    });

    // Check 2: compra OK en evento control
    const r2 = await postCompra(eventoDisponibleId, `b-${ts}`);
    checks.push({
      name: 'compra en evento estaAgotado=false devuelve 200',
      pass: r2.status === 200,
      detail: `status=${r2.status}`,
    });

    // Check 3: el flag viaja en GET /api/eventos/destacado
    const destRes = await fetch(`${BASE_URL}/api/eventos/destacado`);
    const destBody = destRes.ok ? await destRes.json() : null;
    checks.push({
      name: 'GET /api/eventos/destacado incluye estaAgotado',
      pass: destBody && typeof destBody.estaAgotado === 'boolean',
      detail: `estaAgotado=${destBody?.estaAgotado}`,
    });

    // Check 4: el flag viaja en GET /api/eventos/proximos
    const proxRes = await fetch(`${BASE_URL}/api/eventos/proximos`);
    const proxBody = proxRes.ok ? await proxRes.json() : null;
    const allHaveFlag = Array.isArray(proxBody)
      && proxBody.length > 0
      && proxBody.every((e) => typeof e.estaAgotado === 'boolean');
    checks.push({
      name: 'GET /api/eventos/proximos devuelve eventos con estaAgotado',
      pass: allHaveFlag,
      detail: `items=${proxBody?.length ?? 0}, sample=${JSON.stringify(proxBody?.[0] && { id: proxBody[0].id, estaAgotado: proxBody[0].estaAgotado })}`,
    });

    console.log('─'.repeat(60));
    console.log('Agotado Manual Integration Test');
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
    try {
      await cleanup();
    } catch (cleanupErr) {
      console.error('WARN cleanup:', cleanupErr.message);
    }
    await prisma.$disconnect();
    process.exit(process.exitCode || 0);
  }
}

main();
