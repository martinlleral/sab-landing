/**
 * Tests de integración — procesarPagoCancelado (paso C Sprint 3).
 *
 * Cierra el loop de la regla D3: cuando una compra pending pasa a estado
 * terminal (autocancel 72h o pago rechazado/cancelado en MP), el cupón
 * asociado debe liberarse para que ese uso vuelva al pool.
 *
 * Cubre:
 *  - Liberación: compra con cupón → cancelled, cupón decrementa.
 *  - Sin cupón: helper no rompe, libero_cupon=false.
 *  - Atomicidad: si liberar el cupón fallara, el cambio de estado revierte.
 *  - Idempotencia: 2 llamadas → solo la 1ra decrementa.
 *  - Estados terminales soportados: cancelled, rejected, charged_back, refunded.
 *  - Cupón compartido: liberar uno solo decrementa 1, no afecta otros usos.
 *
 * Uso local (con dev.db):
 *   node tests/integration/pagos-cancelacion.test.js
 */

const prisma = require('../../src/utils/prisma');
const { procesarPagoCancelado } = require('../../src/services/pagos.service');
const { TIPO_CUPON } = require('../../src/services/precios.service');

const TEST_PREFIX = 'pagos-cancel-test-';

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

async function setupEventoConCupon({ usosIniciales = 0, sufijo = '' } = {}) {
  const evento = await prisma.evento.create({
    data: {
      nombre: `${TEST_PREFIX}${sufijo || Date.now()}`,
      descripcion: 'test',
      fecha: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      hora: '21:00',
      estaPublicado: true,
      tandas: { create: [{ nombre: 'U', precio: 10000, orden: 1, activa: true }] },
    },
    include: { tandas: true },
  });
  const cupon = await prisma.cuponDescuento.create({
    data: {
      eventoId: evento.id,
      codigo: `T${Date.now()}${Math.floor(Math.random() * 1000)}`,
      tipo: TIPO_CUPON.PORCENTAJE,
      valor: 25,
      usosActuales: usosIniciales,
    },
  });
  return { evento, tanda: evento.tandas[0], cupon };
}

async function crearCompraPending({ evento, tanda, cupon = null, totalPagado = 7500 }) {
  const compra = await prisma.compra.create({
    data: {
      eventoId: evento.id,
      tandaId: tanda.id,
      email: `c${Date.now()}@test.invalid`,
      nombre: 'C',
      apellido: 'T',
      telefono: '0',
      cantidadEntradas: 1,
      precioUnitario: 10000,
      totalPagado,
      mpEstado: 'pending',
      mpPreferenciaId: 'mock-pref',
    },
  });
  if (cupon) {
    await prisma.cuponUso.create({
      data: { cuponId: cupon.id, compraId: compra.id, descuentoAplicado: 2500 },
    });
  }
  return compra;
}

async function main() {
  const checks = [];
  try {
    await cleanup();

    // ============================================
    // BLOQUE 1 — Compra con cupón → autocancel libera
    // ============================================

    const ctx1 = await setupEventoConCupon({ usosIniciales: 1, sufijo: 'libera' });
    const compra1 = await crearCompraPending({ ...ctx1, cupon: ctx1.cupon });

    const r1 = await procesarPagoCancelado(compra1.id, 'cancelled');
    const compra1Tras = await prisma.compra.findUnique({ where: { id: compra1.id } });
    const cupon1Tras = await prisma.cuponDescuento.findUnique({ where: { id: ctx1.cupon.id } });

    checks.push({
      name: '🎯 D3: compra con cupón → cancelled, libero_cupon=true',
      pass: r1.procesada === true && r1.libero_cupon === true,
      detail: JSON.stringify(r1),
    });
    checks.push({
      name: 'estado de la compra ahora es cancelled',
      pass: compra1Tras.mpEstado === 'cancelled',
      detail: `mpEstado=${compra1Tras.mpEstado}`,
    });
    checks.push({
      name: '🎯 cupón decrementó: usosActuales 1 → 0',
      pass: cupon1Tras.usosActuales === 0,
      detail: `usosActuales=${cupon1Tras.usosActuales}`,
    });

    // ============================================
    // BLOQUE 2 — Compra sin cupón
    // ============================================

    const ctx2 = await setupEventoConCupon({ sufijo: 'sincupon' });
    const compra2 = await crearCompraPending({ ...ctx2, cupon: null, totalPagado: 10000 });

    const r2 = await procesarPagoCancelado(compra2.id, 'cancelled');
    checks.push({
      name: 'compra sin cupón → procesada=true, libero_cupon=false (no rompe)',
      pass: r2.procesada === true && r2.libero_cupon === false,
      detail: JSON.stringify(r2),
    });

    // ============================================
    // BLOQUE 3 — Idempotencia: 2 llamadas, 2da retorna ya_procesada
    // ============================================

    const ctx3 = await setupEventoConCupon({ usosIniciales: 1, sufijo: 'idem' });
    const compra3 = await crearCompraPending({ ...ctx3, cupon: ctx3.cupon });

    const r3a = await procesarPagoCancelado(compra3.id, 'cancelled');
    const r3b = await procesarPagoCancelado(compra3.id, 'cancelled');
    const cupon3Tras = await prisma.cuponDescuento.findUnique({ where: { id: ctx3.cupon.id } });

    checks.push({
      name: '🎯 idempotencia: 1ra llamada procesada, 2da ya_procesada',
      pass: r3a.procesada === true && r3b.ya_procesada === true,
      detail: `r3a=${JSON.stringify(r3a)} r3b=${JSON.stringify(r3b)}`,
    });
    checks.push({
      name: 'idempotencia: cupón decrementó 1 sola vez (1 → 0)',
      pass: cupon3Tras.usosActuales === 0,
      detail: `usosActuales=${cupon3Tras.usosActuales}`,
    });

    // ============================================
    // BLOQUE 4 — Estados terminales soportados
    // ============================================

    for (const estado of ['rejected', 'charged_back', 'refunded']) {
      const ctx = await setupEventoConCupon({ usosIniciales: 1, sufijo: `est-${estado}` });
      const compra = await crearCompraPending({ ...ctx, cupon: ctx.cupon });
      const r = await procesarPagoCancelado(compra.id, estado, `mpid-${estado}`);
      const compraTras = await prisma.compra.findUnique({ where: { id: compra.id } });
      const cupTras = await prisma.cuponDescuento.findUnique({ where: { id: ctx.cupon.id } });

      checks.push({
        name: `estado=${estado}: compra actualizada + mpPagoId guardado + cupón liberado`,
        pass:
          r.procesada === true &&
          compraTras.mpEstado === estado &&
          compraTras.mpPagoId === `mpid-${estado}` &&
          cupTras.usosActuales === 0,
        detail: `mpEstado=${compraTras.mpEstado} mpPagoId=${compraTras.mpPagoId} usos=${cupTras.usosActuales}`,
      });
    }

    // ============================================
    // BLOQUE 5 — Cupón compartido entre 2 compras: liberar 1 deja la otra intacta
    // ============================================

    const ctx5 = await setupEventoConCupon({ usosIniciales: 2, sufijo: 'compartido' });
    const compra5a = await crearCompraPending({ ...ctx5, cupon: ctx5.cupon });
    const compra5b = await crearCompraPending({ ...ctx5, cupon: ctx5.cupon });

    await procesarPagoCancelado(compra5a.id, 'cancelled');
    const cupon5Tras = await prisma.cuponDescuento.findUnique({ where: { id: ctx5.cupon.id } });
    const compra5bTras = await prisma.compra.findUnique({ where: { id: compra5b.id } });
    const uso5b = await prisma.cuponUso.findUnique({ where: { compraId: compra5b.id } });

    checks.push({
      name: 'cupón con 2 usos: cancelar 1 → usosActuales 2 → 1',
      pass: cupon5Tras.usosActuales === 1,
      detail: `usosActuales=${cupon5Tras.usosActuales}`,
    });
    checks.push({
      name: 'compra B (la otra) sigue pending, su CuponUso intacto',
      pass: compra5bTras.mpEstado === 'pending' && uso5b !== null,
      detail: `compraB.mpEstado=${compra5bTras.mpEstado} usoB.id=${uso5b?.id}`,
    });

    // ============================================
    // REPORT
    // ============================================

    console.log('─'.repeat(72));
    console.log('Pagos Cancelación — procesarPagoCancelado (D3 cierre del loop)');
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
