/**
 * Tests de integración — calcularPrecioFinal + reservarCupon.
 *
 * Valida las reglas del Sprint 3 (decididas el 2/5/2026):
 *   A2 — descuento aplica solo sobre la base, NO sobre el excedente del aporte.
 *   B  — códigos de cupón case-insensitive.
 *   C  — cupón monto > base topea el descuento (entrada al precio mínimo de base = $0).
 *   D  — reservarCupon es atómico (incrementa + valida tope dentro de tx).
 *
 * Uso local (con dev.db):
 *   node tests/integration/precios.test.js
 *
 * Exit codes: 0 = PASS, 1 = FAIL
 */

const prisma = require('../../src/utils/prisma');
const {
  calcularPrecioFinal,
  reservarCupon,
  liberarCupon,
  normalizarCodigo,
  TIPO_ENTRADA,
  TIPO_CUPON,
} = require('../../src/services/precios.service');

const TEST_PREFIX = 'precios-test-';

async function cleanup() {
  // Borra cupones+usos+compras+tandas+eventos creados por este test.
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

async function setupEvento({ porcentajeAporte = 0, precioBase = 10000, sufijo = '' } = {}) {
  const evento = await prisma.evento.create({
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
            precio: precioBase,
            orden: 1,
            activa: true,
            porcentajeAporte,
          },
        ],
      },
    },
    include: { tandas: true },
  });
  return { evento, tanda: evento.tandas[0] };
}

async function crearCupon(eventoId, overrides = {}) {
  return prisma.cuponDescuento.create({
    data: {
      eventoId,
      codigo: overrides.codigo || `TEST${Date.now()}${Math.floor(Math.random() * 1000)}`,
      tipo: overrides.tipo || TIPO_CUPON.PORCENTAJE,
      valor: overrides.valor ?? 25,
      topeUsos: overrides.topeUsos ?? null,
      validoHasta: overrides.validoHasta ?? null,
      activo: overrides.activo ?? true,
    },
  });
}

async function expectThrow(fn, expectedCode) {
  try {
    await fn();
    return { pass: false, detail: `esperaba throw con code=${expectedCode}, no tiró nada` };
  } catch (err) {
    return {
      pass: err.code === expectedCode,
      detail: `code=${err.code} (esperado ${expectedCode}) msg="${err.message}"`,
    };
  }
}

async function main() {
  const checks = [];
  try {
    await cleanup();

    // ============================================
    // BLOQUE 1 — Casos sin cupón (no tocan DB)
    // ============================================

    const { tanda: tBase } = await setupEvento({ precioBase: 10000, sufijo: 'base' });

    const r1 = await calcularPrecioFinal(tBase, { tipoEntrada: TIPO_ENTRADA.BASE });
    checks.push({
      name: 'tipo=base sin cupón → precio = base',
      pass: r1.precioUnitarioFinal === 10000 && r1.excedenteUnitario === 0 && r1.descuentoUnitario === 0,
      detail: JSON.stringify(r1.breakdown),
    });

    // Tanda con aporte 30 %
    const { tanda: tAporte } = await setupEvento({ precioBase: 10000, porcentajeAporte: 30, sufijo: 'aporte' });

    const r2 = await calcularPrecioFinal(tAporte, { tipoEntrada: TIPO_ENTRADA.APORTE });
    checks.push({
      name: 'tipo=aporte 30% sobre $10k → precio = $13k (excedente $3k)',
      pass: r2.precioUnitarioFinal === 13000 && r2.excedenteUnitario === 3000,
      detail: JSON.stringify(r2.breakdown),
    });

    // Pedir aporte sobre tanda sin aporte habilitado
    const errAporte = await expectThrow(
      () => calcularPrecioFinal(tBase, { tipoEntrada: TIPO_ENTRADA.APORTE }),
      'APORTE_NO_HABILITADO'
    );
    checks.push({ name: 'tipo=aporte sobre tanda con porcentajeAporte=0 → throw', ...errAporte });

    // Tipo de entrada inválido
    const errTipo = await expectThrow(
      () => calcularPrecioFinal(tBase, { tipoEntrada: 'vip' }),
      'TIPO_ENTRADA_INVALIDO'
    );
    checks.push({ name: 'tipo=vip → throw TIPO_ENTRADA_INVALIDO', ...errTipo });

    // ============================================
    // BLOQUE 2 — Cupón porcentaje sin aporte
    // ============================================

    const cup25 = await crearCupon(tBase.eventoId, { codigo: 'AMIGOS25', tipo: TIPO_CUPON.PORCENTAJE, valor: 25 });
    const r3 = await calcularPrecioFinal(tBase, { cuponCodigo: 'AMIGOS25' });
    checks.push({
      name: 'cupón 25% sobre base $10k → descuento $2.5k → precio $7.5k',
      pass: r3.descuentoUnitario === 2500 && r3.precioUnitarioFinal === 7500,
      detail: JSON.stringify(r3.breakdown),
    });

    // ============================================
    // BLOQUE 3 — REGLA A2: cupón NO descuenta el excedente del aporte
    // ============================================

    const cup25Aporte = await crearCupon(tAporte.eventoId, { codigo: 'GORRA25', tipo: TIPO_CUPON.PORCENTAJE, valor: 25 });
    const r4 = await calcularPrecioFinal(tAporte, {
      tipoEntrada: TIPO_ENTRADA.APORTE,
      cuponCodigo: 'GORRA25',
    });
    // Base $10k - 25% = $7.5k. + Aporte $3k intacto. Total $10.5k.
    // Si fuera A1 (descuento sobre total $13k = -$3.25k → $9.75k). Verificamos A2.
    checks.push({
      name: '🎯 A2: cupón 25% + aporte 30% → desc=$2.5k base, aporte $3k intacto, precio=$10.5k',
      pass: r4.descuentoUnitario === 2500 && r4.excedenteUnitario === 3000 && r4.precioUnitarioFinal === 10500,
      detail: JSON.stringify(r4.breakdown),
    });

    // ============================================
    // BLOQUE 4 — REGLA C: cupón monto > base topea a $0
    // ============================================

    const cupOverkill = await crearCupon(tBase.eventoId, { codigo: 'GRATIS', tipo: TIPO_CUPON.MONTO, valor: 50000 });
    const r5 = await calcularPrecioFinal(tBase, { cuponCodigo: 'GRATIS' });
    checks.push({
      name: '🎯 C: cupón monto $50k sobre base $10k → descuento topea a $10k → precio $0',
      pass: r5.descuentoUnitario === 10000 && r5.precioUnitarioFinal === 0,
      detail: JSON.stringify(r5.breakdown),
    });

    // C bis — con aporte: aporte sigue intacto aún con cupón overkill
    const cupOverkillAporte = await crearCupon(tAporte.eventoId, { codigo: 'GRATISAPORTE', tipo: TIPO_CUPON.MONTO, valor: 50000 });
    const r6 = await calcularPrecioFinal(tAporte, {
      tipoEntrada: TIPO_ENTRADA.APORTE,
      cuponCodigo: 'GRATISAPORTE',
    });
    checks.push({
      name: 'C+A2: cupón overkill + aporte → base $0, aporte $3k intacto, precio $3k',
      pass: r6.descuentoUnitario === 10000 && r6.excedenteUnitario === 3000 && r6.precioUnitarioFinal === 3000,
      detail: JSON.stringify(r6.breakdown),
    });

    // ============================================
    // BLOQUE 5 — REGLA B: case-insensitive
    // ============================================

    const r7a = await calcularPrecioFinal(tBase, { cuponCodigo: 'amigos25' });
    const r7b = await calcularPrecioFinal(tBase, { cuponCodigo: 'Amigos25' });
    const r7c = await calcularPrecioFinal(tBase, { cuponCodigo: '  AMIGOS25  ' });
    checks.push({
      name: '🎯 B: "amigos25", "Amigos25", "  AMIGOS25  " → mismo cupón',
      pass:
        r7a.cupon?.id === cup25.id &&
        r7b.cupon?.id === cup25.id &&
        r7c.cupon?.id === cup25.id,
      detail: `ids=${r7a.cupon?.id}/${r7b.cupon?.id}/${r7c.cupon?.id}`,
    });

    checks.push({
      name: 'normalizarCodigo("  abc  ") = "ABC"',
      pass: normalizarCodigo('  abc  ') === 'ABC',
      detail: `got="${normalizarCodigo('  abc  ')}"`,
    });

    // ============================================
    // BLOQUE 6 — Validaciones de cupón
    // ============================================

    const errInexistente = await expectThrow(
      () => calcularPrecioFinal(tBase, { cuponCodigo: 'NOEXISTE' }),
      'CUPON_INVALIDO'
    );
    checks.push({ name: 'cupón inexistente → throw CUPON_INVALIDO', ...errInexistente });

    await crearCupon(tBase.eventoId, { codigo: 'INACTIVO', activo: false });
    const errInactivo = await expectThrow(
      () => calcularPrecioFinal(tBase, { cuponCodigo: 'INACTIVO' }),
      'CUPON_INVALIDO'
    );
    checks.push({ name: 'cupón inactivo → throw CUPON_INVALIDO', ...errInactivo });

    // Cupón de OTRO evento
    const { tanda: tOtro } = await setupEvento({ sufijo: 'otro' });
    const cupOtro = await crearCupon(tOtro.eventoId, { codigo: 'EVENTOOTRO' });
    const errEventoOtro = await expectThrow(
      () => calcularPrecioFinal(tBase, { cuponCodigo: 'EVENTOOTRO' }),
      'CUPON_OTRO_EVENTO'
    );
    checks.push({ name: 'cupón de otro evento → throw CUPON_OTRO_EVENTO', ...errEventoOtro });

    // Cupón vencido
    await crearCupon(tBase.eventoId, {
      codigo: 'VENCIDO',
      validoHasta: new Date(Date.now() - 24 * 60 * 60 * 1000),
    });
    const errVencido = await expectThrow(
      () => calcularPrecioFinal(tBase, { cuponCodigo: 'VENCIDO' }),
      'CUPON_VENCIDO'
    );
    checks.push({ name: 'cupón vencido (validoHasta < ahora) → throw CUPON_VENCIDO', ...errVencido });

    // Cupón en tope
    const cupTope = await crearCupon(tBase.eventoId, { codigo: 'TOPE', topeUsos: 2 });
    await prisma.cuponDescuento.update({
      where: { id: cupTope.id },
      data: { usosActuales: 2 },
    });
    const errTope = await expectThrow(
      () => calcularPrecioFinal(tBase, { cuponCodigo: 'TOPE' }),
      'CUPON_AGOTADO'
    );
    checks.push({ name: 'cupón con usosActuales >= topeUsos → throw CUPON_AGOTADO', ...errTope });

    // ============================================
    // BLOQUE 7 — REGLA D: reservarCupon es atómico (rollback en tope)
    // ============================================

    const cupCarrera = await crearCupon(tBase.eventoId, { codigo: 'CARRERA', topeUsos: 1, usosActuales: 0 });

    // Reserva 1 (debe pasar): después de increment queda usosActuales=1, dentro del tope.
    await prisma.$transaction(async (tx) => {
      await reservarCupon(tx, cupCarrera.id);
    });
    const cupTras1 = await prisma.cuponDescuento.findUnique({ where: { id: cupCarrera.id } });
    checks.push({
      name: 'reservarCupon: 1ra reserva pasa, usosActuales=1',
      pass: cupTras1.usosActuales === 1,
      detail: `usosActuales=${cupTras1.usosActuales}`,
    });

    // Reserva 2 (debe romper la transacción y dejar usosActuales=1).
    let segundaError = null;
    try {
      await prisma.$transaction(async (tx) => {
        await reservarCupon(tx, cupCarrera.id);
      });
    } catch (err) {
      segundaError = err;
    }
    const cupTras2 = await prisma.cuponDescuento.findUnique({ where: { id: cupCarrera.id } });
    checks.push({
      name: '🎯 D: 2da reserva sobre tope=1 → throw + rollback (usosActuales sigue en 1)',
      pass: segundaError?.code === 'CUPON_AGOTADO_RACE' && cupTras2.usosActuales === 1,
      detail: `err.code=${segundaError?.code} usosActuales=${cupTras2.usosActuales}`,
    });

    // ============================================
    // BLOQUE 8 — liberarCupon (D3 autocancel)
    // ============================================

    await liberarCupon(prisma, cupCarrera.id);
    const cupTrasLiberar = await prisma.cuponDescuento.findUnique({ where: { id: cupCarrera.id } });
    checks.push({
      name: 'liberarCupon: decrementa usosActuales (1 → 0)',
      pass: cupTrasLiberar.usosActuales === 0,
      detail: `usosActuales=${cupTrasLiberar.usosActuales}`,
    });

    // Idempotencia: liberar en 0 no produce negativo
    await liberarCupon(prisma, cupCarrera.id);
    const cupTrasLiberar2 = await prisma.cuponDescuento.findUnique({ where: { id: cupCarrera.id } });
    checks.push({
      name: 'liberarCupon idempotente: liberar en 0 no produce negativo',
      pass: cupTrasLiberar2.usosActuales === 0,
      detail: `usosActuales=${cupTrasLiberar2.usosActuales}`,
    });

    // ============================================
    // REPORT
    // ============================================

    console.log('─'.repeat(72));
    console.log('Precios Service — Test de calcularPrecioFinal + reservarCupon');
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
