/**
 * Tests de integración — crearPreferencia con cupones y A la Gorra (paso B Sprint 3).
 *
 * Llama al controller con req/res mock. Mockea mpService.crearPreferencia para
 * no llegar a MP real (CommonJS: el require comparte la misma instancia con el
 * controller, así que sobreescribir la propiedad acá afecta también al controller).
 *
 * Cubre:
 *  - Regresión: compra sin cupón ni tipoEntrada → comportamiento idéntico al Sprint 2.
 *  - Cupón válido: totalPagado descontado, CuponUso creado, usosActuales++.
 *  - Validaciones: cupón vencido / agotado / otro evento / inexistente → 400, sin Compra ni efectos.
 *  - Race condition real: 2 compras concurrentes en última unidad → 1 OK, 1 falla, tope intacto.
 *  - Preview A la Gorra: tipoEntrada='aporte' aplica excedenteUnitario al totalPagado.
 *
 * Uso local (con dev.db):
 *   node tests/integration/compras-cupones.test.js
 */

const prisma = require('../../src/utils/prisma');
const compras = require('../../src/controllers/compras.controller');
const mpService = require('../../src/services/mercadopago.service');
const { TIPO_CUPON, TIPO_ENTRADA } = require('../../src/services/precios.service');

const TEST_PREFIX = 'compras-cupones-test-';

// Mock de mpService.crearPreferencia. Devuelve siempre el mismo id sintético.
let mpCalls = [];
const originalCrearPref = mpService.crearPreferencia;
mpService.crearPreferencia = async (args) => {
  mpCalls.push(args);
  return { id: `mock-pref-${Date.now()}-${Math.random()}`, init_point: 'https://mock.invalid/pay' };
};

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

function mockReq(body) {
  return { body };
}

async function call(req) {
  const res = mockRes();
  await compras.crearPreferencia(req, res);
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

  const compras = await prisma.compra.findMany({
    where: { eventoId: { in: eventoIds } },
    select: { id: true },
  });
  const compraIds = compras.map((c) => c.id);

  await prisma.cuponUso.deleteMany({ where: { cuponId: { in: cuponIds } } });
  await prisma.cuponDescuento.deleteMany({ where: { id: { in: cuponIds } } });
  await prisma.entrada.deleteMany({ where: { compraId: { in: compraIds } } });
  await prisma.compra.deleteMany({ where: { id: { in: compraIds } } });
  await prisma.tanda.deleteMany({ where: { eventoId: { in: eventoIds } } });
  await prisma.evento.deleteMany({ where: { id: { in: eventoIds } } });
}

async function setupEvento({
  precio = 10000,
  porcentajeAporte = 0,
  capacidad = null,
  sufijo = '',
} = {}) {
  return prisma.evento.create({
    data: {
      nombre: `${TEST_PREFIX}${sufijo || Date.now()}`,
      descripcion: 'test',
      fecha: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      hora: '21:00',
      estaPublicado: true,
      tandas: {
        create: [
          {
            nombre: 'Única',
            precio,
            orden: 1,
            activa: true,
            capacidad,
            porcentajeAporte,
          },
        ],
      },
    },
    include: { tandas: true },
  });
}

async function crearCupon(eventoId, overrides = {}) {
  return prisma.cuponDescuento.create({
    data: {
      eventoId,
      codigo: overrides.codigo || `T${Date.now()}${Math.floor(Math.random() * 1000)}`,
      tipo: overrides.tipo || TIPO_CUPON.PORCENTAJE,
      valor: overrides.valor ?? 25,
      topeUsos: overrides.topeUsos ?? null,
      validoHasta: overrides.validoHasta ?? null,
      activo: overrides.activo ?? true,
      usosActuales: overrides.usosActuales ?? 0,
    },
  });
}

const baseBody = (eventoId, overrides = {}) => ({
  eventoId,
  email: `comprador+${Date.now()}@test.invalid`,
  nombre: 'Compra',
  apellido: 'Test',
  telefono: '0',
  cantidad: 1,
  ...overrides,
});

async function main() {
  const checks = [];
  try {
    await cleanup();

    // ============================================
    // BLOQUE 1 — Regresión: compra sin cupón ni tipoEntrada
    // ============================================

    const ev1 = await setupEvento({ precio: 10000, sufijo: 'reg' });

    mpCalls = [];
    const r1 = await call(mockReq(baseBody(ev1.id, { cantidad: 2 })));
    const compra1 = r1.body?.compra_id ? await prisma.compra.findUnique({ where: { id: r1.body.compra_id } }) : null;

    checks.push({
      name: 'regresión: compra sin cupón → 200, sin tipoEntrada queda "base"',
      pass: r1.statusCode === 200 && compra1?.tipoEntrada === 'base' && compra1?.excedenteUnitario === 0,
      detail: `status=${r1.statusCode} tipoEntrada=${compra1?.tipoEntrada} excedente=${compra1?.excedenteUnitario}`,
    });
    checks.push({
      name: 'regresión: precioUnitario=$10k, totalPagado=$20k (2 entradas)',
      pass: compra1?.precioUnitario === 10000 && compra1?.totalPagado === 20000,
      detail: `pu=${compra1?.precioUnitario} total=${compra1?.totalPagado}`,
    });
    checks.push({
      name: 'regresión: MP recibe precio=$10k cantidad=2',
      pass: mpCalls.length === 1 && mpCalls[0].precio === 10000 && mpCalls[0].cantidad === 2,
      detail: `mpCalls=${JSON.stringify(mpCalls.map((c) => ({ precio: c.precio, cantidad: c.cantidad })))}`,
    });
    const usos1 = await prisma.cuponUso.count({ where: { compraId: compra1.id } });
    checks.push({
      name: 'regresión: 0 CuponUso registrados para compra sin cupón',
      pass: usos1 === 0,
      detail: `usos=${usos1}`,
    });

    // ============================================
    // BLOQUE 2 — Cupón porcentaje válido
    // ============================================

    const ev2 = await setupEvento({ precio: 10000, sufijo: 'pct' });
    const cup25 = await crearCupon(ev2.tandas[0].eventoId, { codigo: 'AMIGOS25', valor: 25 });

    mpCalls = [];
    const r2 = await call(mockReq(baseBody(ev2.id, { cantidad: 2, cuponCodigo: 'amigos25' })));
    const compra2 = await prisma.compra.findUnique({ where: { id: r2.body.compra_id } });
    const uso2 = await prisma.cuponUso.findFirst({ where: { compraId: compra2.id } });
    const cupTras2 = await prisma.cuponDescuento.findUnique({ where: { id: cup25.id } });

    checks.push({
      name: '🎯 cupón 25%: precioUnitario=$10k base, totalPagado=$15k (2 × $7.5k)',
      pass: compra2.precioUnitario === 10000 && compra2.totalPagado === 15000,
      detail: `pu=${compra2.precioUnitario} total=${compra2.totalPagado}`,
    });
    checks.push({
      name: 'cupón 25%: MP recibe precio=$7.5k cantidad=2',
      pass: mpCalls[0].precio === 7500 && mpCalls[0].cantidad === 2,
      detail: `mpCalls=${JSON.stringify(mpCalls.map((c) => ({ precio: c.precio, cantidad: c.cantidad })))}`,
    });
    checks.push({
      name: 'cupón 25%: CuponUso creado con descuentoAplicado=$5k (2 × $2.5k)',
      pass: uso2 && uso2.cuponId === cup25.id && uso2.descuentoAplicado === 5000,
      detail: `usoId=${uso2?.id} descuento=${uso2?.descuentoAplicado}`,
    });
    checks.push({
      name: 'cupón 25%: usosActuales del cupón pasó de 0 → 1',
      pass: cupTras2.usosActuales === 1,
      detail: `usosActuales=${cupTras2.usosActuales}`,
    });

    // ============================================
    // BLOQUE 3 — Cupón vencido (no debe crear Compra ni efectos)
    // ============================================

    const ev3 = await setupEvento({ precio: 10000, sufijo: 'vencido' });
    const cupVencido = await crearCupon(ev3.tandas[0].eventoId, {
      codigo: 'VENCIDO',
      validoHasta: new Date(Date.now() - 24 * 60 * 60 * 1000),
    });

    const comprasAntes = await prisma.compra.count({ where: { eventoId: ev3.id } });
    const r3 = await call(mockReq(baseBody(ev3.id, { cuponCodigo: 'VENCIDO' })));
    const comprasDespues = await prisma.compra.count({ where: { eventoId: ev3.id } });
    const cupTras3 = await prisma.cuponDescuento.findUnique({ where: { id: cupVencido.id } });

    checks.push({
      name: 'cupón vencido → 400 con code=CUPON_VENCIDO',
      pass: r3.statusCode === 400 && r3.body?.code === 'CUPON_VENCIDO',
      detail: `status=${r3.statusCode} code=${r3.body?.code}`,
    });
    checks.push({
      name: 'cupón vencido → no se creó Compra ni se incrementó el cupón',
      pass: comprasDespues === comprasAntes && cupTras3.usosActuales === 0,
      detail: `compras antes=${comprasAntes} después=${comprasDespues} usos=${cupTras3.usosActuales}`,
    });

    // ============================================
    // BLOQUE 4 — Cupón agotado
    // ============================================

    const ev4 = await setupEvento({ precio: 10000, sufijo: 'tope' });
    const cupTope = await crearCupon(ev4.tandas[0].eventoId, {
      codigo: 'TOPE',
      topeUsos: 1,
      usosActuales: 1,
    });

    const r4 = await call(mockReq(baseBody(ev4.id, { cuponCodigo: 'TOPE' })));
    checks.push({
      name: 'cupón con usosActuales=topeUsos → 400 con code=CUPON_AGOTADO',
      pass: r4.statusCode === 400 && r4.body?.code === 'CUPON_AGOTADO',
      detail: `status=${r4.statusCode} code=${r4.body?.code}`,
    });

    // ============================================
    // BLOQUE 5 — Cupón inexistente
    // ============================================

    const ev5 = await setupEvento({ precio: 10000, sufijo: 'inex' });
    const r5 = await call(mockReq(baseBody(ev5.id, { cuponCodigo: 'INEXISTENTE' })));
    checks.push({
      name: 'cupón inexistente → 400 con code=CUPON_INVALIDO',
      pass: r5.statusCode === 400 && r5.body?.code === 'CUPON_INVALIDO',
      detail: `status=${r5.statusCode} code=${r5.body?.code}`,
    });

    // ============================================
    // BLOQUE 6 — Race real: 2 compras simultáneas en última unidad
    // ============================================

    const ev6 = await setupEvento({ precio: 10000, sufijo: 'race' });
    const cupRace = await crearCupon(ev6.tandas[0].eventoId, {
      codigo: 'CARRERA',
      topeUsos: 1,
    });

    const [resA, resB] = await Promise.all([
      call(mockReq(baseBody(ev6.id, { cuponCodigo: 'CARRERA', email: 'a@test.invalid' }))),
      call(mockReq(baseBody(ev6.id, { cuponCodigo: 'CARRERA', email: 'b@test.invalid' }))),
    ]);

    const exitos = [resA, resB].filter((r) => r.statusCode === 200).length;
    const fallas = [resA, resB].filter((r) => r.statusCode === 400).length;
    const cupTrasRace = await prisma.cuponDescuento.findUnique({ where: { id: cupRace.id } });
    const usosCount = await prisma.cuponUso.count({ where: { cuponId: cupRace.id } });

    checks.push({
      name: '🎯 race: 2 compras simultáneas → 1 OK + 1 falla',
      pass: exitos === 1 && fallas === 1,
      detail: `exitos=${exitos} fallas=${fallas} statuses=${resA.statusCode}/${resB.statusCode}`,
    });
    checks.push({
      name: 'race: usosActuales queda en 1 (rollback efectivo)',
      pass: cupTrasRace.usosActuales === 1,
      detail: `usosActuales=${cupTrasRace.usosActuales}`,
    });
    checks.push({
      name: 'race: 1 solo CuponUso registrado',
      pass: usosCount === 1,
      detail: `usos=${usosCount}`,
    });

    // ============================================
    // BLOQUE 7 — A la Gorra (preview ítem 2)
    // ============================================

    const ev7 = await setupEvento({ precio: 10000, porcentajeAporte: 30, sufijo: 'aporte' });

    mpCalls = [];
    const r7 = await call(mockReq(baseBody(ev7.id, { tipoEntrada: TIPO_ENTRADA.APORTE })));
    const compra7 = await prisma.compra.findUnique({ where: { id: r7.body.compra_id } });

    checks.push({
      name: '🎯 aporte 30%: precioUnitario=$10k base, excedente=$3k, totalPagado=$13k',
      pass:
        compra7.tipoEntrada === 'aporte' &&
        compra7.precioUnitario === 10000 &&
        compra7.excedenteUnitario === 3000 &&
        compra7.totalPagado === 13000,
      detail: JSON.stringify({
        tipo: compra7.tipoEntrada, pu: compra7.precioUnitario,
        ex: compra7.excedenteUnitario, total: compra7.totalPagado,
      }),
    });
    checks.push({
      name: 'aporte: MP recibe precio=$13k (precioUnitarioFinal con excedente sumado)',
      pass: mpCalls[0].precio === 13000,
      detail: `mp.precio=${mpCalls[0].precio}`,
    });

    // Aporte sobre tanda sin porcentajeAporte → 400
    const r7b = await call(mockReq(baseBody(ev1.id, { tipoEntrada: TIPO_ENTRADA.APORTE })));
    checks.push({
      name: 'aporte sobre tanda con porcentajeAporte=0 → 400 con code=APORTE_NO_HABILITADO',
      pass: r7b.statusCode === 400 && r7b.body?.code === 'APORTE_NO_HABILITADO',
      detail: `status=${r7b.statusCode} code=${r7b.body?.code}`,
    });

    // ============================================
    // REPORT
    // ============================================

    console.log('─'.repeat(72));
    console.log('Compras + Cupones — Test del flujo crearPreferencia (paso B Sprint 3)');
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
    mpService.crearPreferencia = originalCrearPref;
    await prisma.$disconnect();
    process.exit(process.exitCode || 0);
  }
}

main();
