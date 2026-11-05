/**
 * Tests de integración — el cupón de afiliados (paraAfiliados + unaEntradaPorCompra).
 *
 * Sin la regla, un cupón descuenta TODAS las entradas de la compra: el precio
 * unitario con descuento × la cantidad. El cupón de afiliados es de una entrada
 * por persona, así que con `unaEntradaPorCompra` sólo se puede usar en compras de
 * UNA entrada. La regla vive en un solo lugar (`validarCupon`) y la usan los tres
 * caminos que validan un cupón: el cálculo del precio, la compra (antes y dentro
 * de la transacción) y la validación pública del checkout.
 *
 * Cubre:
 *  - La regla en la capa de precios: 2 entradas → CUPON_UNA_ENTRADA; 1 → aplica.
 *  - Fail-closed: sin decir la cantidad, el cupón de una entrada no se puede usar.
 *  - La compra: 2 entradas → 400 con el mensaje, sin Compra, sin uso, sin MP.
 *  - La validación pública: el mismo rechazo y el dato para el checkout.
 *  - El panel: el alta y la edición guardan los dos campos; sin ellos, false.
 *  - Regresión: un cupón común sigue descontando las 2 entradas.
 *  - ⏸ Pendiente (sesión 2): la compra al 100 % con cupón de afiliados sale como
 *    invitación, sin pasar por MP. Un pendiente que empieza a pasar FALLA, para
 *    que quien lo hizo pasar le saque la marca.
 *
 * Uso local (con dev.db):
 *   node tests/integration/cupones-afiliados.test.js
 */

const prisma = require('../../src/utils/prisma');
const compras = require('../../src/controllers/compras.controller');
const cupones = require('../../src/controllers/cupones.controller');
const mpService = require('../../src/services/mercadopago.service');
const brevoService = require('../../src/services/brevo.service');
const {
  TIPO_CUPON, calcularPrecioFinal, calcularTotalCompra,
} = require('../../src/services/precios.service');

const TEST_PREFIX = 'cupones-afiliados-test-';

// Mocks de MP y de Brevo (CommonJS: el controller ve la misma instancia). Brevo
// también, aunque hoy ninguna de estas compras manda mail: el pendiente de la
// sesión 2 sí lo va a mandar, y el .env local tiene una clave real.
let mpCalls = [];
const originalCrearPref = mpService.crearPreferencia;
mpService.crearPreferencia = async (args) => {
  mpCalls.push(args);
  return { id: `mock-pref-${Date.now()}-${Math.random()}`, init_point: 'https://mock.invalid/pay' };
};
const originalBrevo = {
  enviarConfirmacion: brevoService.enviarConfirmacion,
  enviarInvitacion: brevoService.enviarInvitacion,
};
brevoService.enviarConfirmacion = async () => ({ mock: true });
brevoService.enviarInvitacion = async () => ({ mock: true });

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

async function call(fn, req) {
  const res = mockRes();
  await fn(req, res);
  return res;
}

async function cleanup() {
  const eventos = await prisma.evento.findMany({
    where: { nombre: { startsWith: TEST_PREFIX } },
    select: { id: true },
  });
  const eventoIds = eventos.map((e) => e.id);
  if (eventoIds.length === 0) return;

  const cuponIds = (await prisma.cuponDescuento.findMany({
    where: { eventoId: { in: eventoIds } },
    select: { id: true },
  })).map((c) => c.id);
  const compraIds = (await prisma.compra.findMany({
    where: { eventoId: { in: eventoIds } },
    select: { id: true },
  })).map((c) => c.id);

  await prisma.cuponUso.deleteMany({ where: { cuponId: { in: cuponIds } } });
  await prisma.cuponDescuento.deleteMany({ where: { id: { in: cuponIds } } });
  await prisma.entrada.deleteMany({ where: { compraId: { in: compraIds } } });
  await prisma.compra.deleteMany({ where: { id: { in: compraIds } } });
  await prisma.tanda.deleteMany({ where: { eventoId: { in: eventoIds } } });
  await prisma.evento.deleteMany({ where: { id: { in: eventoIds } } });
}

async function setupEvento(sufijo, precio = 10000) {
  return prisma.evento.create({
    data: {
      nombre: `${TEST_PREFIX}${sufijo}-${Date.now()}`,
      descripcion: 'test',
      fecha: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      hora: '21:00',
      estaPublicado: true,
      tandas: { create: [{ nombre: 'Única', precio, orden: 1, activa: true }] },
    },
    include: { tandas: true },
  });
}

// El código es @unique en toda la base: sufijo aleatorio para no chocar con lo
// que haya dejado otra suite.
function codigoUnico(base) {
  return `${base}${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 1000)}`;
}

async function crearCupon(eventoId, overrides = {}) {
  return prisma.cuponDescuento.create({
    data: {
      eventoId,
      codigo: overrides.codigo || codigoUnico('T'),
      tipo: overrides.tipo || TIPO_CUPON.PORCENTAJE,
      valor: overrides.valor ?? 25,
      topeUsos: overrides.topeUsos ?? null,
      paraAfiliados: overrides.paraAfiliados ?? false,
      unaEntradaPorCompra: overrides.unaEntradaPorCompra ?? false,
    },
  });
}

const bodyCompra = (eventoId, overrides = {}) => ({
  eventoId,
  email: `ana.ejemplo+${Date.now()}${Math.floor(Math.random() * 1000)}@example.invalid`,
  nombre: 'Ana',
  apellido: 'Ejemplo',
  telefono: '0',
  cantidad: 1,
  ...overrides,
});

// Para los casos que tienen que andar: si tiran, el check falla con el code en
// el detalle en vez de abortar la suite (así una mutación muestra QUÉ se rompió).
async function sinTirar(promesa) {
  try {
    return await promesa;
  } catch (err) {
    return { error: err.code || err.message };
  }
}

async function capturar(fn) {
  try {
    await fn();
    return { code: null, message: null };
  } catch (err) {
    return { code: err.code || null, message: err.message };
  }
}

async function main() {
  const checks = [];
  const check = (name, pass, detail, extra = {}) => checks.push({ name, pass: !!pass, detail, ...extra });

  try {
    await cleanup();

    // ============================================
    // BLOQUE 1 — La regla en la capa de precios
    // ============================================

    const ev1 = await setupEvento('precios');
    const t1 = ev1.tandas[0];
    const cupAfi1 = await crearCupon(ev1.id, {
      codigo: codigoUnico('AFI'), paraAfiliados: true, unaEntradaPorCompra: true,
    });
    const cupComun1 = await crearCupon(ev1.id, { codigo: codigoUnico('COMUN') });

    const r1a = await capturar(() => calcularTotalCompra(t1, { cantidad: 2, cuponCodigo: cupAfi1.codigo }));
    check(
      '🎯 1a) cupón de una entrada con 2 entradas → CUPON_UNA_ENTRADA',
      r1a.code === 'CUPON_UNA_ENTRADA' && /una sola entrada/.test(r1a.message || ''),
      `code=${r1a.code} message=${r1a.message}`
    );

    const c1b = await sinTirar(calcularTotalCompra(t1, { cantidad: 1, cuponCodigo: cupAfi1.codigo }));
    check(
      '1b) cupón de una entrada con 1 entrada → aplica (25 % de $10k = $7.500)',
      c1b.totalPagado === 7500 && c1b.descuentoUnitario === 2500,
      `total=${c1b.totalPagado} desc=${c1b.descuentoUnitario} error=${c1b.error}`
    );

    const c1c = await sinTirar(calcularTotalCompra(t1, { cantidad: 2, cuponCodigo: cupComun1.codigo }));
    check(
      'regresión 1c) cupón común con 2 entradas → descuenta las 2 ($15.000)',
      c1c.totalPagado === 15000,
      `total=${c1c.totalPagado} error=${c1c.error}`
    );

    // Fail-closed: si quien llama no dice la cantidad, el cupón de una entrada no
    // pasa. Es lo que pone en rojo un camino nuevo que se olvide de mandarla.
    const r1d = await capturar(() => calcularPrecioFinal(t1, { cuponCodigo: cupAfi1.codigo }));
    check(
      '🔒 1d) sin la cantidad, el cupón de una entrada no se puede usar (fail-closed)',
      r1d.code === 'CUPON_UNA_ENTRADA',
      `code=${r1d.code}`
    );

    const c1e = await sinTirar(calcularPrecioFinal(t1, { cuponCodigo: cupComun1.codigo }));
    check(
      'regresión 1e) cupón común sin cantidad → sigue aplicando como siempre',
      c1e.precioUnitarioFinal === 7500,
      `precio=${c1e.precioUnitarioFinal} error=${c1e.error}`
    );

    // ============================================
    // BLOQUE 2 — La compra (crearPreferencia)
    // ============================================

    const ev2 = await setupEvento('compra');
    const cupAfi2 = await crearCupon(ev2.id, {
      codigo: codigoUnico('AFI'), paraAfiliados: true, unaEntradaPorCompra: true,
    });
    const cupComun2 = await crearCupon(ev2.id, { codigo: codigoUnico('COMUN') });

    mpCalls = [];
    const comprasAntes = await prisma.compra.count({ where: { eventoId: ev2.id } });
    const r2a = await call(compras.crearPreferencia, {
      body: bodyCompra(ev2.id, { cantidad: 2, cuponCodigo: cupAfi2.codigo.toLowerCase() }),
    });
    const comprasDespues = await prisma.compra.count({ where: { eventoId: ev2.id } });
    const cupTras2a = await prisma.cuponDescuento.findUnique({ where: { id: cupAfi2.id } });
    check(
      '🎯 2a) compra de 2 entradas con cupón de una entrada → 400 CUPON_UNA_ENTRADA con el mensaje',
      r2a.statusCode === 400 && r2a.body?.code === 'CUPON_UNA_ENTRADA' && /una sola entrada/.test(r2a.body?.error || ''),
      `status=${r2a.statusCode} code=${r2a.body?.code} error=${r2a.body?.error}`
    );
    check(
      '2b) el rechazo no deja nada: sin Compra, sin uso del cupón y sin ir a MP',
      comprasDespues === comprasAntes && cupTras2a.usosActuales === 0 && mpCalls.length === 0,
      `compras ${comprasAntes}→${comprasDespues} usos=${cupTras2a.usosActuales} mpCalls=${mpCalls.length}`
    );

    mpCalls = [];
    const r2c = await call(compras.crearPreferencia, {
      body: bodyCompra(ev2.id, { cantidad: 1, cuponCodigo: cupAfi2.codigo }),
    });
    const compra2c = r2c.body?.compra_id
      ? await prisma.compra.findUnique({ where: { id: r2c.body.compra_id } })
      : null;
    const uso2c = compra2c ? await prisma.cuponUso.findFirst({ where: { compraId: compra2c.id } }) : null;
    const cupTras2c = await prisma.cuponDescuento.findUnique({ where: { id: cupAfi2.id } });
    check(
      '🎯 2c) compra de 1 entrada con cupón de una entrada → 200, $7.500, uso registrado',
      r2c.statusCode === 200 && compra2c?.totalPagado === 7500
        && uso2c?.descuentoAplicado === 2500 && cupTras2c.usosActuales === 1,
      `status=${r2c.statusCode} error=${r2c.body?.error} total=${compra2c?.totalPagado} `
        + `desc=${uso2c?.descuentoAplicado} usos=${cupTras2c.usosActuales}`
    );

    mpCalls = [];
    const r2d = await call(compras.crearPreferencia, {
      body: bodyCompra(ev2.id, { cantidad: 2, cuponCodigo: cupComun2.codigo }),
    });
    const compra2d = r2d.body?.compra_id
      ? await prisma.compra.findUnique({ where: { id: r2d.body.compra_id } })
      : null;
    check(
      'regresión 2d) compra de 2 entradas con cupón común → 200, $15.000, MP precio $7.500 × 2',
      r2d.statusCode === 200 && compra2d?.totalPagado === 15000
        && mpCalls[0]?.precio === 7500 && mpCalls[0]?.cantidad === 2,
      `status=${r2d.statusCode} total=${compra2d?.totalPagado} mp=${JSON.stringify(mpCalls.map((c) => [c.precio, c.cantidad]))}`
    );

    // ============================================
    // BLOQUE 3 — La validación pública del checkout
    // ============================================

    const ev3 = await setupEvento('validar');
    const cupAfi3 = await crearCupon(ev3.id, {
      codigo: codigoUnico('AFI'), paraAfiliados: true, unaEntradaPorCompra: true,
    });
    const cupComun3 = await crearCupon(ev3.id, { codigo: codigoUnico('COMUN') });
    const validar = (body) => call(cupones.validarPublico, { body: { eventoId: ev3.id, ...body } });

    const r3a = await validar({ codigo: cupAfi3.codigo, cantidad: 2 });
    check(
      '🎯 3a) validar el cupón de una entrada con 2 entradas → 400 CUPON_UNA_ENTRADA con el mensaje',
      r3a.statusCode === 400 && r3a.body?.code === 'CUPON_UNA_ENTRADA' && /una sola entrada/.test(r3a.body?.error || ''),
      `status=${r3a.statusCode} code=${r3a.body?.code} error=${r3a.body?.error}`
    );

    const r3b = await validar({ codigo: cupAfi3.codigo, cantidad: 1 });
    check(
      '3b) con 1 entrada → ok, y avisa que es de una entrada (para el checkout)',
      r3b.statusCode === 200 && r3b.body?.ok === true && r3b.body?.precio?.total === 7500
        && r3b.body?.cupon?.unaEntradaPorCompra === true,
      `status=${r3b.statusCode} body=${JSON.stringify(r3b.body)}`
    );

    // Un checkout viejo (Cloudflare cachea /assets/* unas horas después del
    // deploy) no manda la cantidad. El preview la toma como 1 y la compra, que
    // siempre la manda, es la que frena.
    const r3c = await validar({ codigo: cupAfi3.codigo });
    check(
      '3c) sin cantidad (checkout viejo en caché) → el preview la toma como 1',
      r3c.statusCode === 200 && r3c.body?.ok === true,
      `status=${r3c.statusCode} body=${JSON.stringify(r3c.body)}`
    );

    const r3d = await validar({ codigo: cupComun3.codigo, cantidad: 2 });
    check(
      'regresión 3d) cupón común con 2 entradas → ok, y no se marca como de una entrada',
      r3d.statusCode === 200 && r3d.body?.ok === true && r3d.body?.cupon?.unaEntradaPorCompra === false,
      `status=${r3d.statusCode} body=${JSON.stringify(r3d.body)}`
    );

    const r3e1 = await validar({ codigo: cupComun3.codigo, cantidad: 'dos' });
    const r3e2 = await validar({ codigo: cupComun3.codigo, cantidad: 0 });
    check(
      '3e) cantidad que no es un entero positivo → 400',
      r3e1.statusCode === 400 && r3e2.statusCode === 400,
      `'dos'→${r3e1.statusCode} 0→${r3e2.statusCode}`
    );

    const cupTras3 = await prisma.cuponDescuento.findUnique({ where: { id: cupAfi3.id } });
    check(
      '🔒 3f) validar no consume usos del cupón',
      cupTras3.usosActuales === 0,
      `usos=${cupTras3.usosActuales}`
    );

    // ============================================
    // BLOQUE 4 — El panel: alta y edición
    // ============================================

    const ev4 = await setupEvento('panel');
    const admin = { session: { usuario: { email: 'admin@example.invalid', rol: 1 } } };

    const r4a = await call(cupones.adminCrear, {
      ...admin,
      body: {
        eventoId: ev4.id, codigo: codigoUnico('AFI'), tipo: 'porcentaje', valor: 100,
        paraAfiliados: true, unaEntradaPorCompra: true,
      },
    });
    const c4a = r4a.body?.cupon;
    check(
      '🎯 4a) el alta guarda «para afiliados» y «una entrada por compra»',
      r4a.statusCode === 201 && c4a?.paraAfiliados === true && c4a?.unaEntradaPorCompra === true,
      `status=${r4a.statusCode} error=${r4a.body?.error} cupon=${JSON.stringify(c4a && { p: c4a.paraAfiliados, u: c4a.unaEntradaPorCompra })}`
    );

    const r4b = await call(cupones.adminCrear, {
      ...admin,
      body: { eventoId: ev4.id, codigo: codigoUnico('COMUN'), tipo: 'porcentaje', valor: 10 },
    });
    const c4b = r4b.body?.cupon;
    check(
      'regresión 4b) el alta sin los campos → false/false (el cupón de siempre)',
      r4b.statusCode === 201 && c4b?.paraAfiliados === false && c4b?.unaEntradaPorCompra === false,
      `status=${r4b.statusCode} cupon=${JSON.stringify(c4b && { p: c4b.paraAfiliados, u: c4b.unaEntradaPorCompra })}`
    );

    const r4c = await call(cupones.adminCrear, {
      ...admin,
      body: {
        eventoId: ev4.id, codigo: codigoUnico('STR'), tipo: 'porcentaje', valor: 10,
        paraAfiliados: 'true', unaEntradaPorCompra: 'false',
      },
    });
    const c4c = r4c.body?.cupon;
    check(
      '4c) el alta entiende "true"/"false" como texto',
      r4c.statusCode === 201 && c4c?.paraAfiliados === true && c4c?.unaEntradaPorCompra === false,
      `status=${r4c.statusCode} cupon=${JSON.stringify(c4c && { p: c4c.paraAfiliados, u: c4c.unaEntradaPorCompra })}`
    );

    const r4d = await call(cupones.adminActualizar, {
      ...admin,
      params: { id: String(c4b.id) },
      body: { paraAfiliados: true, unaEntradaPorCompra: true },
    });
    const c4d = await prisma.cuponDescuento.findUnique({ where: { id: c4b.id } });
    check(
      '🎯 4d) la edición cambia los dos campos (y no responde «nada para actualizar»)',
      r4d.statusCode === 200 && c4d.paraAfiliados === true && c4d.unaEntradaPorCompra === true,
      `status=${r4d.statusCode} error=${r4d.body?.error} p=${c4d.paraAfiliados} u=${c4d.unaEntradaPorCompra}`
    );

    const r4e = await call(cupones.adminActualizar, {
      ...admin,
      params: { id: String(c4b.id) },
      body: { unaEntradaPorCompra: false },
    });
    const c4e = await prisma.cuponDescuento.findUnique({ where: { id: c4b.id } });
    check(
      '4e) la edición de un solo campo no toca el otro',
      r4e.statusCode === 200 && c4e.paraAfiliados === true && c4e.unaEntradaPorCompra === false,
      `status=${r4e.statusCode} p=${c4e.paraAfiliados} u=${c4e.unaEntradaPorCompra}`
    );

    // ============================================
    // BLOQUE 5 — ⏸ PENDIENTE (sesión 2): la entrada incluida
    // ============================================
    // Hoy una compra en $0 se manda igual a MP y sin pago aprobado no sale el QR.
    // La sesión 2 hace que, con cupón de afiliados, salga como una invitación: sin
    // MP, aprobada en $0, con su entrada y descontando cupo de la tanda.

    const ev5 = await setupEvento('incluida');
    const cupAfi5 = await crearCupon(ev5.id, {
      codigo: codigoUnico('AFI'), valor: 100, paraAfiliados: true, unaEntradaPorCompra: true,
    });
    const vendidaAntes = (await prisma.tanda.findUnique({ where: { id: ev5.tandas[0].id } })).cantidadVendida;

    mpCalls = [];
    const r5 = await call(compras.crearPreferencia, {
      body: bodyCompra(ev5.id, { cantidad: 1, cuponCodigo: cupAfi5.codigo }),
    });
    const compra5 = r5.body?.compra_id
      ? await prisma.compra.findUnique({ where: { id: r5.body.compra_id } })
      : await prisma.compra.findFirst({ where: { eventoId: ev5.id } });
    const entradas5 = compra5 ? await prisma.entrada.count({ where: { compraId: compra5.id } }) : 0;
    const vendidaDespues = (await prisma.tanda.findUnique({ where: { id: ev5.tandas[0].id } })).cantidadVendida;
    check(
      '5a) compra al 100 % con cupón de afiliados → sin MP, aprobada en $0, 1 entrada, cupo +1',
      mpCalls.length === 0 && compra5?.mpEstado === 'approved' && compra5?.totalPagado === 0
        && entradas5 === 1 && vendidaDespues === vendidaAntes + 1,
      `mpCalls=${mpCalls.length} estado=${compra5?.mpEstado} total=${compra5?.totalPagado} `
        + `entradas=${entradas5} cupo ${vendidaAntes}→${vendidaDespues}`,
      { pendiente: 'sesión 2' }
    );

    // ============================================
    // REPORT
    // ============================================

    console.log('─'.repeat(72));
    console.log('Cupón de afiliados — una entrada por compra');
    console.log('─'.repeat(72));
    for (const c of checks) {
      if (c.pendiente) {
        // Un pendiente que pasa es un error: alguien lo hizo andar y no le sacó la marca.
        console.log(c.pass
          ? `❌ ${c.name}\n   PASA y sigue marcado como pendiente (${c.pendiente}): sacale la marca`
          : `⏸  ${c.name}\n   pendiente (${c.pendiente}) — ${c.detail}`);
        continue;
      }
      console.log(`${c.pass ? '✅' : '❌'} ${c.name}`);
      console.log(`   ${c.detail}`);
    }
    console.log('─'.repeat(72));

    const failed = checks.filter((c) => (c.pendiente ? c.pass : !c.pass));
    const pendientes = checks.filter((c) => c.pendiente && !c.pass).length;
    const activos = checks.length - pendientes;
    if (failed.length > 0) {
      console.log(`\n❌ FAIL — ${failed.length}/${checks.length} checks fallaron`);
      process.exitCode = 1;
    } else {
      console.log(`\n✅ PASS — ${activos}/${activos} checks OK · ${pendientes} pendiente(s)`);
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
    brevoService.enviarConfirmacion = originalBrevo.enviarConfirmacion;
    brevoService.enviarInvitacion = originalBrevo.enviarInvitacion;
    await prisma.$disconnect();
    process.exit(process.exitCode || 0);
  }
}

main();
