/**
 * Tests de integración — CRUD admin de Cupones (controller directo).
 *
 * Llama al controller con req/res mock. No pasa por HTTP/middleware: la
 * cobertura HTTP+auth+integración con compras está cubierta por el test
 * de compras del Sprint 2 (extendido en el paso B del Sprint 3).
 *
 * Uso local (con dev.db):
 *   node tests/integration/cupones-admin.test.js
 *
 * Exit codes: 0 = PASS, 1 = FAIL
 */

const prisma = require('../../src/utils/prisma');
const controller = require('../../src/controllers/cupones.controller');
const { TIPO_CUPON } = require('../../src/services/precios.service');

const TEST_PREFIX = 'cupones-admin-test-';

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
  const eventoIds = eventos.map((e) => e.id);
  if (eventoIds.length === 0) return;

  const cupones = await prisma.cuponDescuento.findMany({
    where: { eventoId: { in: eventoIds } },
    select: { id: true },
  });
  const cuponIds = cupones.map((c) => c.id);

  await prisma.cuponUso.deleteMany({ where: { cuponId: { in: cuponIds } } });
  await prisma.cuponDescuento.deleteMany({ where: { id: { in: cuponIds } } });
  await prisma.tanda.deleteMany({ where: { eventoId: { in: eventoIds } } });
  await prisma.evento.deleteMany({ where: { id: { in: eventoIds } } });
}

async function setupEvento({ tandasPrecios = [10000], sufijo = '' } = {}) {
  return prisma.evento.create({
    data: {
      nombre: `${TEST_PREFIX}${sufijo || Date.now()}`,
      descripcion: 'test',
      fecha: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      hora: '21:00',
      estaPublicado: true,
      tandas: {
        create: tandasPrecios.map((precio, i) => ({
          nombre: `Tanda ${i + 1}`,
          precio,
          orden: i + 1,
          activa: true,
        })),
      },
    },
    include: { tandas: true },
  });
}

async function main() {
  const checks = [];
  try {
    await cleanup();

    // ============================================
    // BLOQUE 1 — adminCrear: happy path + warnings
    // ============================================

    const ev1 = await setupEvento({ tandasPrecios: [10000, 15000], sufijo: 'crear' });

    const r1 = await call(controller.adminCrear, mockReq({
      body: { eventoId: ev1.id, codigo: 'amigos25', tipo: TIPO_CUPON.PORCENTAJE, valor: 25 },
    }));
    checks.push({
      name: 'crear 25% con código en minúscula → 201, código normalizado a "AMIGOS25"',
      pass: r1.statusCode === 201 && r1.body?.cupon?.codigo === 'AMIGOS25' && r1.body?.warnings?.length === 0,
      detail: `status=${r1.statusCode} codigo=${r1.body?.cupon?.codigo} warnings=${r1.body?.warnings?.length}`,
    });

    // Cupón monto que cubre solo 1 de las 2 tandas → warning con esa sola
    const r2 = await call(controller.adminCrear, mockReq({
      body: { eventoId: ev1.id, codigo: 'BAJON', tipo: TIPO_CUPON.MONTO, valor: 12000 },
    }));
    checks.push({
      name: '🎯 C: cupón $12k sobre tandas $10k+$15k → warning de 1 tanda en $0',
      pass: r2.statusCode === 201 && r2.body?.warnings?.length === 1 && /Tanda 1/.test(r2.body.warnings[0]),
      detail: `warnings=${JSON.stringify(r2.body?.warnings)}`,
    });

    // Cupón monto que cubre ambas → warning con ambas
    const r3 = await call(controller.adminCrear, mockReq({
      body: { eventoId: ev1.id, codigo: 'GRATISTOTAL', tipo: TIPO_CUPON.MONTO, valor: 50000 },
    }));
    checks.push({
      name: '🎯 C: cupón $50k sobre tandas $10k+$15k → warning de ambas tandas',
      pass: r3.statusCode === 201 && r3.body?.warnings?.length === 1 && /Tanda 1/.test(r3.body.warnings[0]) && /Tanda 2/.test(r3.body.warnings[0]),
      detail: `warnings=${JSON.stringify(r3.body?.warnings)}`,
    });

    // ============================================
    // BLOQUE 2 — adminCrear: validaciones
    // ============================================

    const valBase = { eventoId: ev1.id, codigo: 'TESTVAL' };

    const r4 = await call(controller.adminCrear, mockReq({ body: { codigo: 'X', tipo: 'porcentaje', valor: 10 } }));
    checks.push({ name: 'crear sin eventoId → 400', pass: r4.statusCode === 400, detail: `status=${r4.statusCode}` });

    const r5 = await call(controller.adminCrear, mockReq({
      body: { ...valBase, codigo: 'AB', tipo: TIPO_CUPON.PORCENTAJE, valor: 10 },
    }));
    checks.push({ name: 'código de 2 caracteres → 400', pass: r5.statusCode === 400, detail: `status=${r5.statusCode}` });

    const r6 = await call(controller.adminCrear, mockReq({
      body: { ...valBase, tipo: 'truchada', valor: 10 },
    }));
    checks.push({ name: 'tipo inválido → 400', pass: r6.statusCode === 400 && /tipo/.test(r6.body?.error), detail: `error=${r6.body?.error}` });

    const r7 = await call(controller.adminCrear, mockReq({
      body: { ...valBase, tipo: TIPO_CUPON.PORCENTAJE, valor: 150 },
    }));
    checks.push({ name: 'porcentaje > 100 → 400', pass: r7.statusCode === 400, detail: `status=${r7.statusCode} error=${r7.body?.error}` });

    const r8 = await call(controller.adminCrear, mockReq({
      body: { ...valBase, tipo: TIPO_CUPON.PORCENTAJE, valor: 0 },
    }));
    checks.push({ name: 'valor=0 → 400', pass: r8.statusCode === 400, detail: `status=${r8.statusCode} error=${r8.body?.error}` });

    const r9 = await call(controller.adminCrear, mockReq({
      body: { ...valBase, codigo: 'TOPE0', tipo: TIPO_CUPON.PORCENTAJE, valor: 10, topeUsos: 0 },
    }));
    checks.push({ name: 'topeUsos=0 → 400 (debe ser positivo o null)', pass: r9.statusCode === 400, detail: `error=${r9.body?.error}` });

    // Duplicado
    const r10 = await call(controller.adminCrear, mockReq({
      body: { eventoId: ev1.id, codigo: 'AMIGOS25', tipo: TIPO_CUPON.PORCENTAJE, valor: 50 },
    }));
    checks.push({ name: 'código duplicado → 400 con error claro', pass: r10.statusCode === 400 && /Ya existe/i.test(r10.body?.error), detail: `error=${r10.body?.error}` });

    // ============================================
    // BLOQUE 3 — adminListar
    // ============================================

    const r11 = await call(controller.adminListar, mockReq({ query: { eventoId: ev1.id } }));
    checks.push({
      name: 'listar por eventoId → array con los 3 cupones del bloque 1',
      pass: Array.isArray(r11.body) && r11.body.length === 3,
      detail: `count=${r11.body?.length}`,
    });

    // ============================================
    // BLOQUE 4 — adminGetById
    // ============================================

    const cuponAmigos = await prisma.cuponDescuento.findUnique({ where: { codigo: 'AMIGOS25' } });
    const r12 = await call(controller.adminGetById, mockReq({ params: { id: cuponAmigos.id } }));
    checks.push({
      name: 'GET /:id incluye evento y array de usos (vacío si nadie usó)',
      pass: r12.statusCode === 200 && r12.body?.evento?.id === ev1.id && Array.isArray(r12.body.usos),
      detail: `evento.id=${r12.body?.evento?.id} usos=${r12.body?.usos?.length}`,
    });

    const r13 = await call(controller.adminGetById, mockReq({ params: { id: 999999 } }));
    checks.push({ name: 'GET /:id inexistente → 404', pass: r13.statusCode === 404, detail: `status=${r13.statusCode}` });

    // ============================================
    // BLOQUE 5 — adminActualizar (solo topeUsos/validoHasta/activo)
    // ============================================

    const r14 = await call(controller.adminActualizar, mockReq({
      params: { id: cuponAmigos.id },
      body: { topeUsos: 50, activo: false },
    }));
    checks.push({
      name: 'PATCH topeUsos+activo → 200 con valores actualizados',
      pass: r14.statusCode === 200 && r14.body?.topeUsos === 50 && r14.body?.activo === false,
      detail: `topeUsos=${r14.body?.topeUsos} activo=${r14.body?.activo}`,
    });

    // Reactivar para tests posteriores
    await prisma.cuponDescuento.update({ where: { id: cuponAmigos.id }, data: { activo: true } });

    // PATCH con campos NO editables → ignorados (no rompe pero no aplica)
    const r15 = await call(controller.adminActualizar, mockReq({
      params: { id: cuponAmigos.id },
      body: { codigo: 'CAMBIADO', tipo: TIPO_CUPON.MONTO, valor: 99999 },
    }));
    checks.push({
      name: 'PATCH con codigo/tipo/valor → 400 ("Nada para actualizar")',
      pass: r15.statusCode === 400 && /Nada para actualizar/i.test(r15.body?.error),
      detail: `status=${r15.statusCode} error=${r15.body?.error}`,
    });

    // PATCH con topeUsos < usosActuales → 400
    await prisma.cuponDescuento.update({ where: { id: cuponAmigos.id }, data: { usosActuales: 10 } });
    const r16 = await call(controller.adminActualizar, mockReq({
      params: { id: cuponAmigos.id },
      body: { topeUsos: 5 },
    }));
    checks.push({
      name: 'PATCH topeUsos por debajo de usos actuales → 400',
      pass: r16.statusCode === 400 && /No podés bajar/i.test(r16.body?.error),
      detail: `error=${r16.body?.error}`,
    });

    // ============================================
    // BLOQUE 6 — adminEliminar
    // ============================================

    // Cupón sin uso → DELETE OK
    const cuponBorrable = await prisma.cuponDescuento.create({
      data: { eventoId: ev1.id, codigo: 'BORRABLE', tipo: TIPO_CUPON.PORCENTAJE, valor: 5 },
    });
    const r17 = await call(controller.adminEliminar, mockReq({ params: { id: cuponBorrable.id } }));
    const verif = await prisma.cuponDescuento.findUnique({ where: { id: cuponBorrable.id } });
    checks.push({
      name: 'DELETE cupón sin usos → 200 + borrado real',
      pass: r17.statusCode === 200 && verif === null,
      detail: `status=${r17.statusCode} verif=${verif}`,
    });

    // Cupón con usosActuales > 0 → DELETE bloqueado
    const r18 = await call(controller.adminEliminar, mockReq({ params: { id: cuponAmigos.id } }));
    checks.push({
      name: 'DELETE cupón con usos > 0 → 400 (debe desactivar, no borrar)',
      pass: r18.statusCode === 400 && /Desactivalo/i.test(r18.body?.error),
      detail: `status=${r18.statusCode} error=${r18.body?.error}`,
    });

    // ============================================
    // REPORT
    // ============================================

    console.log('─'.repeat(72));
    console.log('Cupones Admin — Test del CRUD (controller directo)');
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
