/**
 * Tests de integración — sistema de Tandas.
 *
 * Valida:
 *   1. getTandaVigente() — casos por stock, por fecha, mixto, ninguna vigente.
 *   2. POST /api/compras/preferencia usa el precio de la tanda vigente y
 *      guarda tandaId como snapshot en la compra.
 *   3. Compra en evento sin tanda vigente → 400.
 *   4. Transición automática: cuando se agota la capacidad de la tanda 1,
 *      la siguiente request obtiene la tanda 2 como vigente.
 *   5. El endpoint público /api/eventos/destacado devuelve tandaVigente.
 *
 * Uso:
 *   docker exec sab-app node tests/integration/tandas.test.js
 *
 * Exit codes: 0 = PASS, 1 = FAIL
 */

const prisma = require('../../src/utils/prisma');
const { getTandaVigente } = require('../../src/services/tandas.service');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TEST_EVENTO_NAME = 'Tandas Integration Test Event';
const TEST_EMAIL_PREFIX = 'tandas-test-';

async function cleanup() {
  const compras = await prisma.compra.findMany({
    where: { email: { contains: TEST_EMAIL_PREFIX } },
    select: { id: true, eventoId: true },
  });
  const compraIds = compras.map((c) => c.id);
  const eventoIds = [...new Set(compras.map((c) => c.eventoId))];

  await prisma.entrada.deleteMany({ where: { compraId: { in: compraIds } } });
  await prisma.compra.deleteMany({ where: { id: { in: compraIds } } });

  // Borrar tandas + eventos de test (por nombre para defensa en profundidad)
  const eventosTest = await prisma.evento.findMany({
    where: { nombre: TEST_EVENTO_NAME },
    select: { id: true },
  });
  const idsTest = eventosTest.map((e) => e.id);
  await prisma.tanda.deleteMany({ where: { eventoId: { in: idsTest } } });
  await prisma.evento.deleteMany({ where: { id: { in: idsTest } } });
}

async function crearEventoConTandas(tandasData) {
  const evento = await prisma.evento.create({
    data: {
      nombre: TEST_EVENTO_NAME,
      descripcion: 'Evento de test para tandas',
      fecha: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      hora: '21:00',
      precioEntrada: 0,
      cantidadDisponible: 0,
      cantidadVendida: 0,
      estaPublicado: true,
      tandas: { create: tandasData },
    },
    include: { tandas: true },
  });
  return evento;
}

async function postCompra(eventoId, emailSuffix) {
  const res = await fetch(`${BASE_URL}/api/compras/preferencia`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      eventoId,
      email: `${TEST_EMAIL_PREFIX}${emailSuffix}@test.invalid`,
      nombre: 'Tandas',
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
  const checks = [];

  try {
    await cleanup();

    // ============================================
    // 1. getTandaVigente — casos puros (sin HTTP)
    // ============================================

    const ahora = new Date('2026-04-25T15:00:00Z');
    const casoStock = [
      { id: 1, orden: 1, activa: true, capacidad: 10, cantidadVendida: 10, fechaLimite: null, precio: 100 },
      { id: 2, orden: 2, activa: true, capacidad: null, cantidadVendida: 0, fechaLimite: null, precio: 150 },
    ];
    const vigenteStock = getTandaVigente(casoStock, ahora);
    checks.push({
      name: 'getTandaVigente: tanda 1 agotada → tanda 2 vigente',
      pass: vigenteStock && vigenteStock.id === 2,
      detail: `vigente.id=${vigenteStock?.id}`,
    });

    const casoFecha = [
      { id: 1, orden: 1, activa: true, capacidad: null, cantidadVendida: 0, fechaLimite: new Date('2026-04-20T00:00:00Z'), precio: 100 },
      { id: 2, orden: 2, activa: true, capacidad: null, cantidadVendida: 0, fechaLimite: null, precio: 150 },
    ];
    const vigenteFecha = getTandaVigente(casoFecha, ahora);
    checks.push({
      name: 'getTandaVigente: tanda 1 vencida → tanda 2 vigente',
      pass: vigenteFecha && vigenteFecha.id === 2,
      detail: `vigente.id=${vigenteFecha?.id}`,
    });

    const casoTodasOff = [
      { id: 1, orden: 1, activa: true, capacidad: 5, cantidadVendida: 5, fechaLimite: null, precio: 100 },
      { id: 2, orden: 2, activa: true, capacidad: null, cantidadVendida: 0, fechaLimite: new Date('2020-01-01T00:00:00Z'), precio: 150 },
    ];
    const vigenteNula = getTandaVigente(casoTodasOff, ahora);
    checks.push({
      name: 'getTandaVigente: todas agotadas/vencidas → null',
      pass: vigenteNula === null,
      detail: `vigente=${vigenteNula}`,
    });

    const casoDesactivada = [
      { id: 1, orden: 1, activa: false, capacidad: null, cantidadVendida: 0, fechaLimite: null, precio: 100 },
      { id: 2, orden: 2, activa: true, capacidad: null, cantidadVendida: 0, fechaLimite: null, precio: 150 },
    ];
    const vigenteDesact = getTandaVigente(casoDesactivada, ahora);
    checks.push({
      name: 'getTandaVigente: tanda 1 desactivada → tanda 2 vigente',
      pass: vigenteDesact && vigenteDesact.id === 2,
      detail: `vigente.id=${vigenteDesact?.id}`,
    });

    // ============================================
    // 2. POST /api/compras/preferencia usa tanda vigente
    // ============================================

    const ev1 = await crearEventoConTandas([
      { nombre: 'Early bird', precio: 12000, orden: 1, activa: true, capacidad: 5, cantidadVendida: 0 },
      { nombre: 'Regular', precio: 15000, orden: 2, activa: true, capacidad: null, cantidadVendida: 0 },
    ]);
    const early = ev1.tandas.find((t) => t.orden === 1);
    const regular = ev1.tandas.find((t) => t.orden === 2);

    const r1 = await postCompra(ev1.id, `a-${ts}`);
    checks.push({
      name: 'POST /compras/preferencia: 200 con tanda vigente (early bird)',
      pass: r1.status === 200,
      detail: `status=${r1.status}`,
    });

    const compra1 = await prisma.compra.findFirst({
      where: { email: `${TEST_EMAIL_PREFIX}a-${ts}@test.invalid` },
      orderBy: { id: 'desc' },
    });
    checks.push({
      name: 'compra guarda tandaId de early bird',
      pass: compra1 && compra1.tandaId === early.id,
      detail: `tandaId=${compra1?.tandaId} (esperado ${early.id})`,
    });
    checks.push({
      name: 'compra guarda precioUnitario de early bird ($12.000)',
      pass: compra1 && compra1.precioUnitario === 12000,
      detail: `precioUnitario=${compra1?.precioUnitario}`,
    });

    // ============================================
    // 3. Compra con tanda 1 "saturada artificialmente" → pasa a regular
    // ============================================

    // Simulamos que la tanda 1 se agotó (vendidas = capacidad)
    await prisma.tanda.update({
      where: { id: early.id },
      data: { cantidadVendida: 5 },
    });

    const r2 = await postCompra(ev1.id, `b-${ts}`);
    const compra2 = await prisma.compra.findFirst({
      where: { email: `${TEST_EMAIL_PREFIX}b-${ts}@test.invalid` },
      orderBy: { id: 'desc' },
    });
    checks.push({
      name: 'tras agotar early, POST pasa a tanda regular ($15.000)',
      pass: r2.status === 200 && compra2 && compra2.tandaId === regular.id && compra2.precioUnitario === 15000,
      detail: `status=${r2.status} tandaId=${compra2?.tandaId} precio=${compra2?.precioUnitario}`,
    });

    // ============================================
    // 4. Evento sin tanda vigente → 400
    // ============================================

    const ev2 = await crearEventoConTandas([
      { nombre: 'Cerrada', precio: 5000, orden: 1, activa: false, capacidad: null, cantidadVendida: 0 },
    ]);

    const r3 = await postCompra(ev2.id, `c-${ts}`);
    checks.push({
      name: 'evento sin tanda vigente → 400 con mensaje claro',
      pass: r3.status === 400 && /no disponibles/i.test(r3.body?.error || ''),
      detail: `status=${r3.status} error=${r3.body?.error}`,
    });

    // ============================================
    // 5. GET /api/eventos/destacado incluye tandaVigente
    // ============================================

    const destRes = await fetch(`${BASE_URL}/api/eventos/destacado`);
    const destBody = destRes.ok ? await destRes.json() : null;
    checks.push({
      name: 'GET /eventos/destacado incluye tandas[] y tandaVigente',
      pass: destBody && Array.isArray(destBody.tandas) && destBody.tandaVigente !== undefined,
      detail: `tandas=${destBody?.tandas?.length} tandaVigente.id=${destBody?.tandaVigente?.id}`,
    });

    // ============================================
    // REPORT
    // ============================================

    console.log('─'.repeat(60));
    console.log('Tandas Integration Test');
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
