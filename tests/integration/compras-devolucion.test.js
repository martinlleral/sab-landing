/**
 * Tests de integración — US-A: devolución de una compra aprobada.
 *
 * Cuando Euge hace un refund en Mercado Pago, el admin marca la compra como
 * devuelta desde el backoffice. La compra pasa a `refunded` y hay que:
 *   - decrementar el stock de la tanda (opuesto a aprobar, que lo incrementó),
 *   - liberar el cupón si lo usó,
 *   - dejar la trazabilidad (quién/cuándo/motivo),
 * todo atómico. Y gracias a que la validación de QR y las métricas ya filtran
 * por `approved`, la entrada deja de validar y la venta sale de los reportes
 * SIN código nuevo — eso lo verifican los tests 4 y 5.
 *
 * Núcleo real: tests 1, 2, 9 (reversión de stock atómica e idempotente).
 *
 * Uso local (con dev.db):
 *   node tests/integration/compras-devolucion.test.js
 *
 * Exit codes: 0 = PASS, 1 = FAIL
 */

const prisma = require('../../src/utils/prisma');
const { revertirCompraAprobada } = require('../../src/services/pagos.service');
const precios = require('../../src/services/precios.service');
const { TIPO_CUPON } = require('../../src/services/precios.service');
const comprasController = require('../../src/controllers/compras.controller');
const entradasController = require('../../src/controllers/entradas.controller');
const dashboardController = require('../../src/controllers/dashboard.controller');
const { requireAdmin } = require('../../src/middleware/auth.middleware');

const TEST_PREFIX = 'compras-devol-test-';

// ---------- helpers de HTTP mock (mismo estilo que compras-admin-listar) ----------
function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}
function mockReq({ params = {}, body = {}, query = {}, session = undefined, originalUrl = '' } = {}) {
  return { params, body, query, session, originalUrl };
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

  const cupones = await prisma.cuponDescuento.findMany({
    where: { eventoId: { in: eventoIds } }, select: { id: true },
  });
  const cuponIds = cupones.map((c) => c.id);
  const compras = await prisma.compra.findMany({
    where: { eventoId: { in: eventoIds } }, select: { id: true },
  });
  const compraIds = compras.map((c) => c.id);

  await prisma.cuponUso.deleteMany({ where: { cuponId: { in: cuponIds } } });
  await prisma.cuponDescuento.deleteMany({ where: { id: { in: cuponIds } } });
  await prisma.entrada.deleteMany({ where: { compraId: { in: compraIds } } });
  await prisma.compra.deleteMany({ where: { id: { in: compraIds } } });
  await prisma.tanda.deleteMany({ where: { eventoId: { in: eventoIds } } });
  await prisma.evento.deleteMany({ where: { id: { in: eventoIds } } });
}

/**
 * Crea un evento con tanda + una compra approved con entradas. La tanda arranca
 * con cantidadVendida = las entradas de esta compra (simula que aprobar ya la
 * contó), salvo override.
 */
async function setupCompraApproved({
  sufijo, cantidadEntradas = 2, cantidadVendidaInicial = null,
  conCupon = false, usosCupon = 1, validadas = 0, sinTanda = false,
}) {
  const vendidaInit = cantidadVendidaInicial == null ? cantidadEntradas : cantidadVendidaInicial;
  const evento = await prisma.evento.create({
    data: {
      nombre: `${TEST_PREFIX}${sufijo}`,
      descripcion: 'test',
      fecha: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      hora: '21:00',
      estaPublicado: true,
      tandas: { create: [{ nombre: 'U', precio: 10000, orden: 1, activa: true, cantidadVendida: vendidaInit }] },
    },
    include: { tandas: true },
  });

  let cupon = null;
  if (conCupon) {
    cupon = await prisma.cuponDescuento.create({
      data: {
        eventoId: evento.id,
        codigo: `T${Date.now()}${Math.floor(Math.random() * 100000)}`,
        tipo: TIPO_CUPON.PORCENTAJE, valor: 25, usosActuales: usosCupon,
      },
    });
  }

  const compra = await prisma.compra.create({
    data: {
      eventoId: evento.id,
      tandaId: sinTanda ? null : evento.tandas[0].id,
      email: `d${Date.now()}${Math.floor(Math.random() * 1000)}@test.invalid`,
      nombre: 'D', apellido: 'T', telefono: '0',
      cantidadEntradas, precioUnitario: 10000, totalPagado: 10000 * cantidadEntradas,
      mpEstado: 'approved', mpPreferenciaId: 'mock-pref',
    },
  });

  const entradasData = [];
  for (let i = 0; i < cantidadEntradas; i++) {
    entradasData.push({
      compraId: compra.id,
      codigoQR: `dqr-${compra.id}-${i}-${Date.now()}`,
      qrImageUrl: '',
      validada: i < validadas,
      validadaAt: i < validadas ? new Date() : null,
    });
  }
  await prisma.entrada.createMany({ data: entradasData });

  if (cupon) {
    await prisma.cuponUso.create({
      data: { cuponId: cupon.id, compraId: compra.id, descuentoAplicado: 2500 },
    });
  }

  return { evento, tanda: evento.tandas[0], compra, cupon };
}

async function main() {
  const checks = [];
  try {
    await cleanup();

    // 1) Feliz: approved → refunded, stock N − cant, trazabilidad registrada
    {
      const { tanda, compra } = await setupCompraApproved({ sufijo: '1feliz', cantidadEntradas: 2, cantidadVendidaInicial: 5 });
      const r = await revertirCompraAprobada(compra.id, { revertidaPor: 'admin@test.com', motivo: 'refund de Euge' });
      const cTras = await prisma.compra.findUnique({ where: { id: compra.id } });
      const tTras = await prisma.tanda.findUnique({ where: { id: tanda.id } });
      checks.push({
        name: '🎯 1) approved → refunded + stock 5 → 3 + trazabilidad',
        pass: r.ok === true && cTras.mpEstado === 'refunded' && tTras.cantidadVendida === 3 &&
          cTras.devueltaPor === 'admin@test.com' && cTras.devueltaMotivo === 'refund de Euge' && cTras.devueltaAt !== null &&
          r.stock_devuelto === 2,
        detail: `ok=${r.ok} estado=${cTras.mpEstado} vendida=${tTras.cantidadVendida} por=${cTras.devueltaPor} at=${!!cTras.devueltaAt}`,
      });
    }

    // 2) Idempotente: 2da llamada no vuelve a descontar stock
    {
      const { tanda, compra } = await setupCompraApproved({ sufijo: '2idem', cantidadEntradas: 2, cantidadVendidaInicial: 4 });
      const r1 = await revertirCompraAprobada(compra.id, { revertidaPor: 'a@t' });
      const r2 = await revertirCompraAprobada(compra.id, { revertidaPor: 'a@t' });
      const tTras = await prisma.tanda.findUnique({ where: { id: tanda.id } });
      const cTras = await prisma.compra.findUnique({ where: { id: compra.id } });
      checks.push({
        name: '🎯 2) idempotencia: 1ra ok, 2da NOT_APPROVED, stock baja UNA vez (4 → 2)',
        pass: r1.ok === true && r2.ok === false && r2.code === 'NOT_APPROVED' &&
          tTras.cantidadVendida === 2 && cTras.mpEstado === 'refunded',
        detail: `r1.ok=${r1.ok} r2.code=${r2.code} vendida=${tTras.cantidadVendida}`,
      });
    }

    // 3) Cupón liberado: usosActuales U − 1
    {
      const { compra, cupon } = await setupCompraApproved({ sufijo: '3cupon', conCupon: true, usosCupon: 3 });
      const r = await revertirCompraAprobada(compra.id, {});
      const cupTras = await prisma.cuponDescuento.findUnique({ where: { id: cupon.id } });
      checks.push({
        name: '3) cupón liberado: usosActuales 3 → 2, libero_cupon=true',
        pass: r.ok === true && r.libero_cupon === true && cupTras.usosActuales === 2,
        detail: `libero=${r.libero_cupon} usos=${cupTras.usosActuales}`,
      });
    }

    // 4) La entrada de una compra devuelta deja de validar (NOT_PAID) — sin código nuevo
    {
      const { compra } = await setupCompraApproved({ sufijo: '4qr', cantidadEntradas: 1 });
      const entrada = await prisma.entrada.findFirst({ where: { compraId: compra.id } });
      await revertirCompraAprobada(compra.id, {});
      const res = await call(entradasController.validarPorQR, mockReq({ body: { codigoQR: entrada.codigoQR } }));
      checks.push({
        name: '4) entrada de compra devuelta → validarPorQR responde NOT_PAID (400)',
        pass: res.statusCode === 400 && res.body?.codigo === 'NOT_PAID',
        detail: `status=${res.statusCode} codigo=${res.body?.codigo}`,
      });
    }

    // 5) La venta devuelta sale de recaudación / entradas vendidas del dashboard
    {
      const { evento, compra } = await setupCompraApproved({ sufijo: '5dash', cantidadEntradas: 2 });
      const resAntes = await call(dashboardController.resumen, mockReq({ query: { eventoId: evento.id } }));
      await revertirCompraAprobada(compra.id, {});
      const resDespues = await call(dashboardController.resumen, mockReq({ query: { eventoId: evento.id } }));
      checks.push({
        name: '5) dashboard: recaudación y vendidas EXCLUYEN la compra devuelta',
        pass: resAntes.body.recaudado.total === 20000 && resAntes.body.entradas.vendidas === 2 &&
          resDespues.body.recaudado.total === 0 && resDespues.body.entradas.vendidas === 0,
        detail: `antes=${resAntes.body.recaudado.total}/${resAntes.body.entradas.vendidas} después=${resDespues.body.recaudado.total}/${resDespues.body.entradas.vendidas}`,
      });
    }

    // 6) Compra pending → endpoint 400 NOT_APPROVED, stock intacto
    {
      const { evento, tanda } = await setupCompraApproved({ sufijo: '6pending', cantidadVendidaInicial: 2 });
      const pendiente = await prisma.compra.create({
        data: {
          eventoId: evento.id, tandaId: tanda.id, email: `p${Date.now()}@test.invalid`,
          nombre: 'P', apellido: 'T', telefono: '0', cantidadEntradas: 1,
          precioUnitario: 10000, totalPagado: 10000, mpEstado: 'pending', mpPreferenciaId: 'mock',
        },
      });
      const res = await call(
        comprasController.adminDevolver,
        mockReq({ params: { id: String(pendiente.id) }, session: { usuario: { email: 'a@t', rol: 1 } } }),
      );
      const tTras = await prisma.tanda.findUnique({ where: { id: tanda.id } });
      checks.push({
        name: '6) compra pending → adminDevolver 400 NOT_APPROVED, stock intacto',
        pass: res.statusCode === 400 && res.body?.code === 'NOT_APPROVED' && tTras.cantidadVendida === 2,
        detail: `status=${res.statusCode} code=${res.body?.code} vendida=${tTras.cantidadVendida}`,
      });
    }

    // 7) Compra legacy sin tanda (tandaId null) → no rompe, cambia estado, saltea decremento
    {
      const { compra } = await setupCompraApproved({ sufijo: '7legacy', sinTanda: true, cantidadEntradas: 1 });
      const r = await revertirCompraAprobada(compra.id, {});
      const cTras = await prisma.compra.findUnique({ where: { id: compra.id } });
      checks.push({
        name: '7) compra sin tanda (legacy) → refunded, stock_devuelto=0, no rompe',
        pass: r.ok === true && cTras.mpEstado === 'refunded' && r.stock_devuelto === 0,
        detail: `ok=${r.ok} estado=${cTras.mpEstado} stock_devuelto=${r.stock_devuelto}`,
      });
    }

    // 8) Sin sesión admin → requireAdmin rechaza (no llega al handler)
    {
      let nextLlamado = false;
      const res = await call(
        (req, r) => requireAdmin(req, r, () => { nextLlamado = true; }),
        mockReq({ originalUrl: '/api/admin/compras/1/devolver', session: {} }),
      );
      checks.push({
        name: '8) sin sesión → requireAdmin 401 y no invoca next()',
        pass: res.statusCode === 401 && nextLlamado === false,
        detail: `status=${res.statusCode} next=${nextLlamado}`,
      });
    }

    // 9) Falla liberarCupon dentro de la transacción → rollback total
    {
      const { tanda, compra, cupon } = await setupCompraApproved({ sufijo: '9rollback', conCupon: true, usosCupon: 2, cantidadEntradas: 2, cantidadVendidaInicial: 5 });
      const orig = precios.liberarCupon;
      precios.liberarCupon = () => { throw new Error('boom liberarCupon'); };
      let threw = false;
      try {
        await revertirCompraAprobada(compra.id, {});
      } catch (e) {
        threw = true;
      } finally {
        precios.liberarCupon = orig;
      }
      const cTras = await prisma.compra.findUnique({ where: { id: compra.id } });
      const tTras = await prisma.tanda.findUnique({ where: { id: tanda.id } });
      const cupTras = await prisma.cuponDescuento.findUnique({ where: { id: cupon.id } });
      checks.push({
        name: '🎯 9) falla liberarCupon → rollback: sigue approved, stock y cupón intactos',
        pass: threw === true && cTras.mpEstado === 'approved' && tTras.cantidadVendida === 5 && cupTras.usosActuales === 2,
        detail: `threw=${threw} estado=${cTras.mpEstado} vendida=${tTras.cantidadVendida} usos=${cupTras.usosActuales}`,
      });
    }

    // ============================================
    // REPORT
    // ============================================
    console.log('─'.repeat(72));
    console.log('US-A — Devolución de compra aprobada (revertirCompraAprobada)');
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
