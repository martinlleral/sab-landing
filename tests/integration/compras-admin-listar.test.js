/**
 * Tests de integración — adminListar (compras.controller).
 *
 * Cubre los 3 query params nuevos del Sprint 4:
 *   - q (búsqueda por nombre/apellido/email)
 *   - validacion (pendiente / validada / vacío)
 *   - orderBy (nombre default / fecha)
 *
 * Uso local (con dev.db):
 *   node tests/integration/compras-admin-listar.test.js
 *
 * Exit codes: 0 = PASS, 1 = FAIL
 */

const prisma = require('../../src/utils/prisma');
const controller = require('../../src/controllers/compras.controller');

const TEST_PREFIX = 'compras-listar-test-';

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

function mockReq({ query = {} } = {}) {
  return { query };
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
  const eventoIds = eventos.map((e) => e.id);
  if (!eventoIds.length) return;

  const compras = await prisma.compra.findMany({
    where: { eventoId: { in: eventoIds } },
    select: { id: true },
  });
  const compraIds = compras.map((c) => c.id);

  await prisma.entrada.deleteMany({ where: { compraId: { in: compraIds } } });
  await prisma.compra.deleteMany({ where: { id: { in: compraIds } } });
  await prisma.tanda.deleteMany({ where: { eventoId: { in: eventoIds } } });
  await prisma.evento.deleteMany({ where: { id: { in: eventoIds } } });
}

async function setupFixture() {
  const evento = await prisma.evento.create({
    data: {
      nombre: `${TEST_PREFIX}${Date.now()}`,
      descripcion: 'test',
      fecha: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      hora: '21:00',
      estaPublicado: true,
      tandas: {
        create: [{ nombre: 'Tanda 1', precio: 10000, orden: 1, activa: true }],
      },
    },
    include: { tandas: true },
  });

  const baseCompra = (overrides) => ({
    eventoId: evento.id,
    tandaId: evento.tandas[0].id,
    cantidadEntradas: 2,
    precioUnitario: 10000,
    totalPagado: 20000,
    mpEstado: 'approved',
    ...overrides,
  });

  // 3 compras approved con apellidos en orden inverso (Zorrilla, Martinez, Acosta)
  // para verificar que el sort A-Z reordena.
  const compraZ = await prisma.compra.create({
    data: baseCompra({ nombre: 'Zoe', apellido: 'Zorrilla', email: 'zoe@test.com' }),
  });
  const compraM = await prisma.compra.create({
    data: baseCompra({ nombre: 'Mariano', apellido: 'Martinez', email: 'mariano@test.com' }),
  });
  const compraA = await prisma.compra.create({
    data: baseCompra({ nombre: 'Ana', apellido: 'Acosta', email: 'ana@test.com' }),
  });

  // 1 compra rejected — debe excluirse del filtro validacion=pendiente/validada.
  const compraR = await prisma.compra.create({
    data: baseCompra({
      nombre: 'Roberto', apellido: 'Rechazado', email: 'rechazado@test.com',
      mpEstado: 'rejected',
    }),
  });

  // Entradas:
  //   compraZ: 2 entradas, ambas validadas → completamente validada
  //   compraM: 2 entradas, 1 validada y 1 sin validar → parcial = pendiente
  //   compraA: 2 entradas, ninguna validada → pendiente
  await prisma.entrada.createMany({
    data: [
      { compraId: compraZ.id, codigoQR: `qr-z-1-${Date.now()}`, qrImageUrl: '', validada: true,  validadaAt: new Date() },
      { compraId: compraZ.id, codigoQR: `qr-z-2-${Date.now()}`, qrImageUrl: '', validada: true,  validadaAt: new Date() },
      { compraId: compraM.id, codigoQR: `qr-m-1-${Date.now()}`, qrImageUrl: '', validada: true,  validadaAt: new Date() },
      { compraId: compraM.id, codigoQR: `qr-m-2-${Date.now()}`, qrImageUrl: '', validada: false },
      { compraId: compraA.id, codigoQR: `qr-a-1-${Date.now()}`, qrImageUrl: '', validada: false },
      { compraId: compraA.id, codigoQR: `qr-a-2-${Date.now()}`, qrImageUrl: '', validada: false },
    ],
  });

  return { evento, compraA, compraM, compraZ, compraR };
}

async function main() {
  await cleanup();

  const checks = [];

  try {
    const { evento, compraA, compraM, compraZ, compraR } = await setupFixture();

    // 1) Default (sin query): orderBy=nombre A-Z. Se incluyen las 4 compras del
    //    fixture ordenadas Acosta < Martinez < Rechazado < Zorrilla.
    const r1 = await call(controller.adminListar, mockReq({ query: { eventoId: evento.id } }));
    const apellidos = (r1.body?.compras || []).map((c) => c.apellido);
    checks.push({
      name: 'Default → orden alfabético por apellido (A-Z)',
      pass: JSON.stringify(apellidos) === JSON.stringify(['Acosta', 'Martinez', 'Rechazado', 'Zorrilla']),
      detail: `apellidos=${JSON.stringify(apellidos)}`,
    });

    // 2) orderBy=fecha → más recientes primero. compraR es la última creada
    //    del fixture → debe venir primera en desc.
    const r2 = await call(controller.adminListar, mockReq({ query: { eventoId: evento.id, orderBy: 'fecha' } }));
    const idsPorFecha = (r2.body?.compras || []).map((c) => c.id);
    checks.push({
      name: 'orderBy=fecha → más recientes primero',
      pass: idsPorFecha[0] === compraR.id,
      detail: `ids=${JSON.stringify(idsPorFecha)} esperaba_primero=${compraR.id}`,
    });

    // 3) q matchea por apellido (case-insensitive ASCII)
    const r3 = await call(controller.adminListar, mockReq({ query: { eventoId: evento.id, q: 'martinez' } }));
    const r3Apellidos = (r3.body?.compras || []).map((c) => c.apellido);
    checks.push({
      name: 'q="martinez" → matchea "Martinez" (case-insensitive)',
      pass: r3Apellidos.length === 1 && r3Apellidos[0] === 'Martinez',
      detail: `apellidos=${JSON.stringify(r3Apellidos)}`,
    });

    // 4) q matchea por nombre parcial
    const r4 = await call(controller.adminListar, mockReq({ query: { eventoId: evento.id, q: 'Ana' } }));
    const r4Nombres = (r4.body?.compras || []).map((c) => c.nombre);
    checks.push({
      name: 'q="Ana" → matchea por nombre parcial',
      pass: r4Nombres.includes('Ana'),
      detail: `nombres=${JSON.stringify(r4Nombres)}`,
    });

    // 5) q matchea por email
    const r5 = await call(controller.adminListar, mockReq({ query: { eventoId: evento.id, q: 'zoe@test' } }));
    const r5Emails = (r5.body?.compras || []).map((c) => c.email);
    checks.push({
      name: 'q="zoe@test" → matchea por email',
      pass: r5Emails.length === 1 && r5Emails[0] === 'zoe@test.com',
      detail: `emails=${JSON.stringify(r5Emails)}`,
    });

    // 6) validacion=pendiente → solo approved con al menos 1 entrada sin validar
    const r6 = await call(controller.adminListar, mockReq({ query: { eventoId: evento.id, validacion: 'pendiente' } }));
    const r6Apellidos = (r6.body?.compras || []).map((c) => c.apellido).sort();
    checks.push({
      name: 'validacion=pendiente → incluye Acosta (0/2) y Martinez (1/2), excluye Zorrilla (2/2) y Rechazado',
      pass: r6Apellidos.length === 2 && r6Apellidos[0] === 'Acosta' && r6Apellidos[1] === 'Martinez',
      detail: `apellidos=${JSON.stringify(r6Apellidos)}`,
    });

    // 7) validacion=validada → solo approved con todas las entradas validadas
    const r7 = await call(controller.adminListar, mockReq({ query: { eventoId: evento.id, validacion: 'validada' } }));
    const r7Apellidos = (r7.body?.compras || []).map((c) => c.apellido);
    checks.push({
      name: 'validacion=validada → solo Zorrilla (2/2 validadas)',
      pass: r7Apellidos.length === 1 && r7Apellidos[0] === 'Zorrilla',
      detail: `apellidos=${JSON.stringify(r7Apellidos)}`,
    });

    // 8) validacion fuerza mpEstado=approved (excluye rejected)
    const r8 = await call(controller.adminListar, mockReq({ query: { eventoId: evento.id, validacion: 'pendiente' } }));
    const r8Estados = new Set((r8.body?.compras || []).map((c) => c.mpEstado));
    checks.push({
      name: 'validacion=pendiente → todos approved (excluye rejected)',
      pass: r8Estados.size === 1 && r8Estados.has('approved'),
      detail: `estados=${JSON.stringify([...r8Estados])}`,
    });

    // 9) Response incluye `entradas` con id+validada para la pildora UI
    const r9 = await call(controller.adminListar, mockReq({ query: { eventoId: evento.id } }));
    const compraConEntradas = (r9.body?.compras || []).find((c) => c.id === compraM.id);
    const entradas = compraConEntradas?.entradas || [];
    const tieneCamposCorrectos = entradas.length === 2 &&
      entradas.every((e) => typeof e.id === 'number' && typeof e.validada === 'boolean');
    checks.push({
      name: 'Response include entradas {id, validada} para la pildora UI',
      pass: tieneCamposCorrectos,
      detail: `entradas=${JSON.stringify(entradas)}`,
    });

    // 10) q activo → page=1 y totalPages=1 (sin paginación)
    const r10 = await call(controller.adminListar, mockReq({ query: { eventoId: evento.id, q: 'a', page: 5 } }));
    checks.push({
      name: 'q activo → ignora paginación (page=1, totalPages=1)',
      pass: r10.body?.page === 1 && r10.body?.totalPages === 1,
      detail: `page=${r10.body?.page} totalPages=${r10.body?.totalPages}`,
    });

    // ============================================
    // REPORT
    // ============================================
    console.log('─'.repeat(72));
    console.log('Compras adminListar — Test de búsqueda + filtros + orden');
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
