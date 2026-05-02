/**
 * Tests de integración — POST /api/cupones/validar (paso E Sprint 3).
 *
 * Endpoint público que devuelve un preview del descuento sin reservar uso ni
 * crear Compra. Lo va a usar el modal del checkout (paso F).
 *
 * Cubre:
 *  - Preview correcto: base, descuento, excedente, total.
 *  - tipoEntrada=aporte refleja el excedente en el preview.
 *  - Mensajes user-friendly por código (vencido vs agotado vs inválido).
 *  - 🔒 Mensaje uniforme para "no existe" y "otro evento" (no revela existencia).
 *  - 🔒 Endpoint NO incrementa usosActuales (es solo preview).
 *  - Validaciones de evento (publicado, no agotado, con tanda vigente).
 *
 * Uso local (con dev.db):
 *   node tests/integration/cupones-validar.test.js
 */

const prisma = require('../../src/utils/prisma');
const { validarPublico } = require('../../src/controllers/cupones.controller');
const { TIPO_CUPON } = require('../../src/services/precios.service');

const TEST_PREFIX = 'cupones-validar-test-';

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}
function mockReq(body) { return { body }; }
async function call(req) {
  const res = mockRes();
  await validarPublico(req, res);
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

async function setupEvento({
  precio = 10000, porcentajeAporte = 0, sufijo = '',
  estaPublicado = true, estaAgotado = false, tandaActiva = true,
} = {}) {
  return prisma.evento.create({
    data: {
      nombre: `${TEST_PREFIX}${sufijo || Date.now()}`,
      descripcion: 'test', fecha: new Date(Date.now() + 30 * 86400000), hora: '21:00',
      estaPublicado, estaAgotado,
      tandas: { create: [{ nombre: 'U', precio, orden: 1, activa: tandaActiva, porcentajeAporte }] },
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

async function main() {
  const checks = [];
  try {
    await cleanup();

    // ============================================
    // BLOQUE 1 — Cupón válido (preview correcto)
    // ============================================

    const ev1 = await setupEvento({ precio: 10000, sufijo: 'ok' });
    await crearCupon(ev1.tandas[0].eventoId, { codigo: 'AMIGOS25', tipo: TIPO_CUPON.PORCENTAJE, valor: 25 });

    const r1 = await call(mockReq({ eventoId: ev1.id, codigo: 'AMIGOS25' }));
    checks.push({
      name: '🎯 cupón 25% válido → 200 con preview',
      pass:
        r1.statusCode === 200 && r1.body?.ok === true &&
        r1.body.cupon?.codigo === 'AMIGOS25' &&
        r1.body.cupon?.tipo === 'porcentaje' &&
        r1.body.cupon?.valor === 25 &&
        r1.body.precio?.base === 10000 &&
        r1.body.precio?.descuento === 2500 &&
        r1.body.precio?.excedente === 0 &&
        r1.body.precio?.total === 7500,
      detail: JSON.stringify(r1.body),
    });

    // case-insensitive
    const r1b = await call(mockReq({ eventoId: ev1.id, codigo: 'amigos25' }));
    checks.push({
      name: 'case-insensitive: "amigos25" devuelve mismo resultado',
      pass: r1b.statusCode === 200 && r1b.body?.cupon?.codigo === 'AMIGOS25',
      detail: `codigo=${r1b.body?.cupon?.codigo}`,
    });

    // ============================================
    // BLOQUE 2 — tipoEntrada=aporte refleja excedente
    // ============================================

    const ev2 = await setupEvento({ precio: 10000, porcentajeAporte: 30, sufijo: 'aporte' });
    await crearCupon(ev2.tandas[0].eventoId, { codigo: 'GORRA25', valor: 25 });

    const r2 = await call(mockReq({ eventoId: ev2.id, codigo: 'GORRA25', tipoEntrada: 'aporte' }));
    // A2: descuento sobre base ($10k * 25% = $2.5k). Aporte intacto: 30% de $10k = $3k.
    // Total = (10000 - 2500) + 3000 = 10500.
    checks.push({
      name: '🎯 A2 con aporte: preview muestra descuento $2.5k base + excedente $3k → total $10.5k',
      pass:
        r2.statusCode === 200 &&
        r2.body.precio?.base === 10000 &&
        r2.body.precio?.descuento === 2500 &&
        r2.body.precio?.excedente === 3000 &&
        r2.body.precio?.total === 10500,
      detail: JSON.stringify(r2.body.precio),
    });

    // ============================================
    // BLOQUE 3 — Cupón vencido (mensaje específico)
    // ============================================

    const ev3 = await setupEvento({ precio: 10000, sufijo: 'venc' });
    await crearCupon(ev3.tandas[0].eventoId, {
      codigo: 'VENCIDO',
      validoHasta: new Date(Date.now() - 86400000),
    });

    const r3 = await call(mockReq({ eventoId: ev3.id, codigo: 'VENCIDO' }));
    checks.push({
      name: 'cupón vencido → 400 con mensaje user-friendly + code=CUPON_VENCIDO',
      pass:
        r3.statusCode === 400 && r3.body?.ok === false &&
        r3.body.code === 'CUPON_VENCIDO' &&
        /vencido/i.test(r3.body.error),
      detail: `status=${r3.statusCode} code=${r3.body?.code} error="${r3.body?.error}"`,
    });

    // ============================================
    // BLOQUE 4 — Cupón agotado (mensaje específico)
    // ============================================

    const ev4 = await setupEvento({ precio: 10000, sufijo: 'tope' });
    await crearCupon(ev4.tandas[0].eventoId, { codigo: 'TOPE', topeUsos: 1, usosActuales: 1 });

    const r4 = await call(mockReq({ eventoId: ev4.id, codigo: 'TOPE' }));
    checks.push({
      name: 'cupón agotado → 400 con mensaje específico de tope',
      pass:
        r4.statusCode === 400 && r4.body?.code === 'CUPON_AGOTADO' &&
        /tope/i.test(r4.body.error),
      detail: `code=${r4.body?.code} error="${r4.body?.error}"`,
    });

    // ============================================
    // BLOQUE 5 — 🔒 Mensaje uniforme para "no existe" y "otro evento"
    // ============================================

    const ev5 = await setupEvento({ precio: 10000, sufijo: 'unif' });
    const ev5otro = await setupEvento({ precio: 10000, sufijo: 'unif-otro' });
    await crearCupon(ev5otro.tandas[0].eventoId, { codigo: 'OTROEVENTO' });

    const rNoExiste = await call(mockReq({ eventoId: ev5.id, codigo: 'NOEXISTE' }));
    const rOtroEvento = await call(mockReq({ eventoId: ev5.id, codigo: 'OTROEVENTO' }));

    checks.push({
      name: '🔒 cupón inexistente → "Cupón no válido"',
      pass:
        rNoExiste.statusCode === 400 &&
        rNoExiste.body?.error === 'Cupón no válido',
      detail: `error="${rNoExiste.body?.error}"`,
    });
    checks.push({
      name: '🔒 cupón de otro evento → MISMO mensaje "Cupón no válido" (no revela existencia)',
      pass:
        rOtroEvento.statusCode === 400 &&
        rOtroEvento.body?.error === 'Cupón no válido',
      detail: `error="${rOtroEvento.body?.error}"`,
    });
    checks.push({
      name: '🔒 mensajes idénticos garantizan que un atacante no puede deducir si un código existe',
      pass: rNoExiste.body?.error === rOtroEvento.body?.error,
      detail: `idénticos=${rNoExiste.body?.error === rOtroEvento.body?.error}`,
    });

    // ============================================
    // BLOQUE 6 — 🔒 Endpoint NO incrementa usosActuales
    // ============================================

    const ev6 = await setupEvento({ precio: 10000, sufijo: 'noinc' });
    const cup6 = await crearCupon(ev6.tandas[0].eventoId, { codigo: 'NOTOQUES', usosActuales: 0 });

    await call(mockReq({ eventoId: ev6.id, codigo: 'NOTOQUES' }));
    await call(mockReq({ eventoId: ev6.id, codigo: 'NOTOQUES' }));
    await call(mockReq({ eventoId: ev6.id, codigo: 'NOTOQUES' }));
    const cup6Tras = await prisma.cuponDescuento.findUnique({ where: { id: cup6.id } });

    checks.push({
      name: '🔒 3 validaciones consecutivas → usosActuales sigue en 0 (es solo preview)',
      pass: cup6Tras.usosActuales === 0,
      detail: `usosActuales=${cup6Tras.usosActuales}`,
    });

    // ============================================
    // BLOQUE 7 — Validaciones de input + evento
    // ============================================

    const r7a = await call(mockReq({ codigo: 'X' }));
    checks.push({ name: 'sin eventoId → 400', pass: r7a.statusCode === 400, detail: `status=${r7a.statusCode}` });

    const r7b = await call(mockReq({ eventoId: 1 }));
    checks.push({ name: 'sin codigo → 400', pass: r7b.statusCode === 400, detail: `status=${r7b.statusCode}` });

    const evNoPub = await setupEvento({ sufijo: 'nopub', estaPublicado: false });
    await crearCupon(evNoPub.tandas[0].eventoId, { codigo: 'XXX' });
    const rNoPub = await call(mockReq({ eventoId: evNoPub.id, codigo: 'XXX' }));
    checks.push({
      name: 'evento no publicado → 400 sin revelar tipo de error',
      pass: rNoPub.statusCode === 400 && /no disponible/i.test(rNoPub.body?.error),
      detail: `error="${rNoPub.body?.error}"`,
    });

    const evAgotado = await setupEvento({ sufijo: 'agot', estaAgotado: true });
    await crearCupon(evAgotado.tandas[0].eventoId, { codigo: 'YYY' });
    const rAgot = await call(mockReq({ eventoId: evAgotado.id, codigo: 'YYY' }));
    checks.push({
      name: 'evento agotado → 400',
      pass: rAgot.statusCode === 400 && /no disponible/i.test(rAgot.body?.error),
      detail: `error="${rAgot.body?.error}"`,
    });

    const evSinTanda = await setupEvento({ sufijo: 'sintanda', tandaActiva: false });
    await crearCupon(evSinTanda.tandas[0].eventoId, { codigo: 'ZZZ' });
    const rSinTanda = await call(mockReq({ eventoId: evSinTanda.id, codigo: 'ZZZ' }));
    checks.push({
      name: 'evento sin tanda vigente → 400',
      pass: rSinTanda.statusCode === 400 && /no disponibles/i.test(rSinTanda.body?.error),
      detail: `error="${rSinTanda.body?.error}"`,
    });

    // ============================================
    // BLOQUE 8 — Aporte sobre tanda sin habilitar
    // ============================================

    const r8 = await call(mockReq({ eventoId: ev1.id, codigo: 'AMIGOS25', tipoEntrada: 'aporte' }));
    checks.push({
      name: 'tipoEntrada=aporte sobre tanda sin porcentajeAporte → 400 con APORTE_NO_HABILITADO',
      pass: r8.statusCode === 400 && r8.body?.code === 'APORTE_NO_HABILITADO',
      detail: `code=${r8.body?.code} error="${r8.body?.error}"`,
    });

    // ============================================
    // REPORT
    // ============================================

    console.log('─'.repeat(72));
    console.log('Cupones Validar Público — Test del endpoint preview (paso E Sprint 3)');
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
