/**
 * Tests de integración — la entrada incluida en la afiliación.
 *
 * Una compra de UNA entrada, con cupón de afiliados y total en $0, sale como
 * invitación: sin Mercado Pago, aprobada, con su QR y su mail. Cualquier otra
 * compra sigue por el camino de siempre.
 *
 * Cubre:
 *  - A. La invitación: qué crea, qué devuelve (nunca el QR) y qué mail manda.
 *  - B. Los gemelos que NO salen como invitación: cupón común al 100 %, cupón con
 *       sólo «una entrada», afiliados con descuento parcial, aporte y menú.
 *  - C. Un uso por mail en cada show, con sus bordes y la carrera.
 *  - D. La emisión que falla: la compra no vuelve a pending y el barrido la completa.
 *  - E. La salida a mano: reenviar y devolver, con cupo, cupón y QR.
 *  - F. El mail y el panel.
 *
 * Uso local (con dev.db):
 *   node tests/integration/entrada-incluida.test.js
 */

const fs = require('fs');
const path = require('path');
const prisma = require('../../src/utils/prisma');
const compras = require('../../src/controllers/compras.controller');
const cupones = require('../../src/controllers/cupones.controller');
const eventos = require('../../src/controllers/eventos.controller');
const entradasCtrl = require('../../src/controllers/entradas.controller');
const mpService = require('../../src/services/mercadopago.service');
const brevoService = require('../../src/services/brevo.service');
const qrService = require('../../src/services/qr.service');
const pagos = require('../../src/services/pagos.service');

const QR_DIR = path.join(__dirname, '../../public/assets/img/uploads/qr');
const TEST_PREFIX = 'entrada-incluida-test-';
const PRECIO_MENU = 6000;

let mpCalls = [];
let mailsConfirmacion = [];
let mailsInvitacion = [];
const original = {
  crearPreferencia: mpService.crearPreferencia,
  enviarConfirmacion: brevoService.enviarConfirmacion,
  enviarInvitacion: brevoService.enviarInvitacion,
  generarQR: qrService.generarQR,
};
mpService.crearPreferencia = async (args) => {
  mpCalls.push(args);
  return { id: `mock-pref-${Date.now()}-${Math.random()}`, init_point: 'https://mock.invalid/pay' };
};
brevoService.enviarConfirmacion = async (args) => { mailsConfirmacion.push(args); return { mock: true }; };
brevoService.enviarInvitacion = async (args) => { mailsInvitacion.push(args); return { mock: true }; };

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

let contador = 0;
const mailUnico = () => `ana.ejemplo+${Date.now()}${contador++}@example.invalid`;
const codigoUnico = (base) => `${base}${Date.now().toString(36).toUpperCase()}${contador++}`;

async function setupEvento(sufijo, {
  precio = 10000, porcentajeAporte = 0, capacidad = null, menuHabilitado = false,
} = {}) {
  return prisma.evento.create({
    data: {
      nombre: `${TEST_PREFIX}${sufijo}-${Date.now()}-${contador++}`,
      descripcion: 'test',
      fecha: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      hora: '21:00',
      estaPublicado: true,
      menuHabilitado,
      tandas: {
        create: [{
          nombre: 'Única', precio, orden: 1, activa: true, porcentajeAporte, capacidad,
        }],
      },
    },
    include: { tandas: true },
  });
}

async function crearCupon(eventoId, overrides = {}) {
  return prisma.cuponDescuento.create({
    data: {
      eventoId,
      codigo: overrides.codigo || codigoUnico('T'),
      tipo: overrides.tipo || 'porcentaje',
      valor: overrides.valor ?? 100,
      topeUsos: overrides.topeUsos ?? null,
      paraAfiliados: overrides.paraAfiliados ?? true,
      unaEntradaPorCompra: overrides.unaEntradaPorCompra ?? true,
    },
  });
}

const comprar = (eventoId, cupon, overrides = {}) => call(compras.crearPreferencia, {
  body: {
    eventoId,
    email: mailUnico(),
    nombre: 'Ana',
    apellido: 'Ejemplo',
    telefono: '0',
    cantidad: 1,
    ...(cupon ? { cuponCodigo: cupon.codigo } : {}),
    ...overrides,
  },
});

const tandaDe = (ev) => prisma.tanda.findUnique({ where: { id: ev.tandas[0].id } });
const cuponDe = (c) => prisma.cuponDescuento.findUnique({ where: { id: c.id } });
const envejecer = (compraId, campo, minutos) => prisma.$executeRawUnsafe(
  `UPDATE Compra SET ${campo} = ? WHERE id = ?`,
  Date.now() - minutos * 60 * 1000,
  compraId,
);

async function cleanup() {
  const evs = await prisma.evento.findMany({
    where: { nombre: { startsWith: TEST_PREFIX } },
    select: { id: true },
  });
  const eventoIds = evs.map((e) => e.id);
  if (eventoIds.length === 0) return;

  const cuponIds = (await prisma.cuponDescuento.findMany({
    where: { eventoId: { in: eventoIds } }, select: { id: true },
  })).map((c) => c.id);
  const compraIds = (await prisma.compra.findMany({
    where: { eventoId: { in: eventoIds } }, select: { id: true },
  })).map((c) => c.id);
  const entradas = await prisma.entrada.findMany({
    where: { compraId: { in: compraIds } }, select: { codigoQR: true },
  });
  for (const e of entradas) {
    fs.rmSync(path.join(QR_DIR, `${e.codigoQR}.png`), { force: true });
  }

  await prisma.cuponUso.deleteMany({ where: { cuponId: { in: cuponIds } } });
  await prisma.cuponDescuento.deleteMany({ where: { id: { in: cuponIds } } });
  await prisma.entrada.deleteMany({ where: { compraId: { in: compraIds } } });
  await prisma.compra.deleteMany({ where: { id: { in: compraIds } } });
  await prisma.tanda.deleteMany({ where: { eventoId: { in: eventoIds } } });
  await prisma.evento.deleteMany({ where: { id: { in: eventoIds } } });
}

async function main() {
  const checks = [];
  const check = (name, pass, detail = '') => checks.push({ name, pass: !!pass, detail });
  let homeOriginal = null;
  let homeCreadoId = null;

  try {
    await cleanup();

    // ============================================
    // A — La invitación
    // ============================================

    const evA = await setupEvento('invitacion');
    const cupA = await crearCupon(evA.id);

    mpCalls = []; mailsConfirmacion = []; mailsInvitacion = [];
    const rA = await comprar(evA.id, cupA);
    const compraA = rA.body?.compra_id
      ? await prisma.compra.findUnique({ where: { id: rA.body.compra_id }, include: { entradas: true } })
      : null;
    const usoA = compraA ? await prisma.cuponUso.findFirst({ where: { compraId: compraA.id } }) : null;
    const tA = await tandaDe(evA);
    const cA = await cuponDe(cupA);

    check(
      '🎯 A1) cupón de afiliados al 100 %: 200, invitacion, sin init_point y sin MP',
      rA.statusCode === 200 && rA.body?.invitacion === true && !rA.body?.init_point && mpCalls.length === 0,
      `status=${rA.statusCode} body=${JSON.stringify(rA.body)} mpCalls=${mpCalls.length}`
    );
    check(
      '🎯 A2) la compra queda aprobada, en $0, con 1 entrada, cupo +1 y uso del cupón',
      compraA?.mpEstado === 'approved' && compraA?.totalPagado === 0 && compraA?.entradas.length === 1
        && tA.cantidadVendida === 1 && cA.usosActuales === 1 && usoA?.descuentoAplicado === 10000,
      `estado=${compraA?.mpEstado} total=${compraA?.totalPagado} entradas=${compraA?.entradas.length} `
        + `cupo=${tA.cantidadVendida} usos=${cA.usosActuales} desc=${usoA?.descuentoAplicado}`
    );
    check(
      '🔒 A3) la respuesta no trae el QR (el mail es el único camino)',
      compraA && !JSON.stringify(rA.body).includes(compraA.entradas[0]?.codigoQR)
        && !/codigoQR|qrImageUrl|entradas/.test(JSON.stringify(rA.body)),
      JSON.stringify(rA.body)
    );
    check(
      '🔒 A4) sin mpPreferenciaId: el endpoint público /check no la encuentra por ahí',
      compraA?.mpPreferenciaId === '',
      `mpPreferenciaId="${compraA?.mpPreferenciaId}"`
    );
    check(
      'A5) sale el mail de confirmación, una sola vez, al mail de la compra',
      mailsConfirmacion.length === 1 && mailsInvitacion.length === 0
        && mailsConfirmacion[0].email === compraA?.email,
      `confirmacion=${mailsConfirmacion.length} invitacion=${mailsInvitacion.length}`
    );

    const evA6 = await setupEvento('monto');
    const cupA6 = await crearCupon(evA6.id, { tipo: 'monto', valor: 50000 });
    mpCalls = [];
    const rA6 = await comprar(evA6.id, cupA6);
    check(
      'A6) un cupón de afiliados de monto que cubre el precio también sale como invitación',
      rA6.statusCode === 200 && rA6.body?.invitacion === true && mpCalls.length === 0,
      `status=${rA6.statusCode} body=${JSON.stringify(rA6.body)} mpCalls=${mpCalls.length}`
    );

    const evA7 = await setupEvento('destildado');
    const cupA7 = await crearCupon(evA7.id, { unaEntradaPorCompra: false });
    mpCalls = [];
    const rA7a = await comprar(evA7.id, cupA7, { cantidad: 2 });
    const comprasA7a = await prisma.compra.count({ where: { eventoId: evA7.id } });
    check(
      '🎯 A7) destildaron «una entrada»: con 2 entradas sigue siendo CUPON_UNA_ENTRADA, sin compra',
      rA7a.statusCode === 400 && rA7a.body?.code === 'CUPON_UNA_ENTRADA' && comprasA7a === 0 && mpCalls.length === 0,
      `status=${rA7a.statusCode} code=${rA7a.body?.code} compras=${comprasA7a} mpCalls=${mpCalls.length}`
    );
    const rA7b = await comprar(evA7.id, cupA7);
    check(
      'A7b) destildaron «una entrada»: con 1 entrada sale como invitación',
      rA7b.statusCode === 200 && rA7b.body?.invitacion === true && mpCalls.length === 0,
      `status=${rA7b.statusCode} body=${JSON.stringify(rA7b.body)}`
    );
    const rA7c = await call(cupones.validarPublico, {
      body: { eventoId: evA7.id, codigo: cupA7.codigo, cantidad: 1 },
    });
    check(
      'A7c) la validación pública avisa al checkout: es de una entrada y es de afiliados',
      rA7c.body?.cupon?.unaEntradaPorCompra === true && rA7c.body?.cupon?.paraAfiliados === true,
      JSON.stringify(rA7c.body?.cupon)
    );

    const evA8 = await setupEvento('sin-cupo', { capacidad: 1 });
    const cupA8 = await crearCupon(evA8.id);
    await comprar(evA8.id, cupA8);
    const rA8 = await comprar(evA8.id, cupA8);
    const usosA8 = (await cuponDe(cupA8)).usosActuales;
    check(
      'A8) sin lugar en la tanda: 400 y no consume el uso',
      rA8.statusCode === 400 && usosA8 === 1,
      `status=${rA8.statusCode} error=${rA8.body?.error} usos=${usosA8}`
    );

    const evA9 = await setupEvento('tope');
    const cupA9 = await crearCupon(evA9.id, { topeUsos: 1 });
    await comprar(evA9.id, cupA9);
    const rA9 = await comprar(evA9.id, cupA9);
    const comprasA9 = await prisma.compra.count({ where: { eventoId: evA9.id } });
    check(
      'A9) alcanzado el tope de usos («sujeta a disponibilidad»): 400 y sin segunda compra',
      rA9.statusCode === 400 && comprasA9 === 1,
      `status=${rA9.statusCode} code=${rA9.body?.code} compras=${comprasA9}`
    );

    const evA10 = await setupEvento('mail-roto');
    const cupA10 = await crearCupon(evA10.id);
    const rA10a = await comprar(evA10.id, cupA10, { email: 'sin-arroba' });
    const rA10b = await comprar(evA10.id, cupA10, { email: { $ne: 1 } });
    const usosA10 = (await cuponDe(cupA10)).usosActuales;
    check(
      '🔒 A10) mail inválido con cupón de afiliados: 400, sin compra y sin consumir el uso',
      rA10a.statusCode === 400 && rA10b.statusCode === 400 && usosA10 === 0
        && (await prisma.compra.count({ where: { eventoId: evA10.id } })) === 0,
      `texto→${rA10a.statusCode} objeto→${rA10b.statusCode} usos=${usosA10}`
    );

    // ============================================
    // B — Los gemelos que NO salen como invitación
    // ============================================

    const evB = await setupEvento('gemelos', { porcentajeAporte: 30 });
    const cupComun100 = await crearCupon(evB.id, { paraAfiliados: false, unaEntradaPorCompra: false });
    const cupSoloUna = await crearCupon(evB.id, { paraAfiliados: false, unaEntradaPorCompra: true });
    const cupAfi25 = await crearCupon(evB.id, { valor: 25 });
    const cupAfi100 = await crearCupon(evB.id);

    const pendienteYaMP = async (r) => {
      const c = r.body?.compra_id
        ? await prisma.compra.findUnique({ where: { id: r.body.compra_id }, include: { entradas: true } })
        : null;
      return { c, ok: r.statusCode === 200 && !!r.body?.init_point && !r.body?.invitacion
        && c?.mpEstado === 'pending' && c?.entradas.length === 0 };
    };

    mpCalls = []; mailsConfirmacion = [];
    const rB1 = await comprar(evB.id, cupComun100);
    const b1 = await pendienteYaMP(rB1);
    check(
      '🎯 B1) control gemelo: cupón COMÚN al 100 % sigue yendo a MP, pendiente y sin entrada',
      b1.ok && mpCalls.length === 1 && b1.c?.totalPagado === 0 && mailsConfirmacion.length === 0,
      `status=${rB1.statusCode} body=${JSON.stringify(rB1.body)} mp=${mpCalls.length} mails=${mailsConfirmacion.length}`
    );

    mpCalls = [];
    const rB2 = await comprar(evB.id, cupSoloUna);
    const b2 = await pendienteYaMP(rB2);
    check(
      'B2) cupón con sólo «una entrada» al 100 %, sin afiliados: va a MP',
      b2.ok && mpCalls.length === 1,
      `status=${rB2.statusCode} body=${JSON.stringify(rB2.body)}`
    );

    mpCalls = [];
    const rB3 = await comprar(evB.id, cupAfi25);
    const b3 = await pendienteYaMP(rB3);
    check(
      'B3) cupón de afiliados parcial: paga la diferencia por MP',
      b3.ok && mpCalls[0]?.precio === 7500 && b3.c?.totalPagado === 7500,
      `status=${rB3.statusCode} total=${b3.c?.totalPagado} mp=${mpCalls[0]?.precio}`
    );

    mpCalls = [];
    const rB4 = await comprar(evB.id, cupAfi100, { tipoEntrada: 'aporte' });
    const b4 = await pendienteYaMP(rB4);
    check(
      '🎯 B4) afiliados al 100 % con «A la Gorra»: paga sólo el aporte por MP',
      b4.ok && mpCalls[0]?.precio === 3000 && b4.c?.totalPagado === 3000,
      `status=${rB4.statusCode} total=${b4.c?.totalPagado} mp=${mpCalls[0]?.precio}`
    );

    // Menú: necesita un precio global. Se restaura en el finally.
    const home = await prisma.home.findFirst();
    if (home) {
      homeOriginal = { id: home.id, precioMenu: home.precioMenu };
      await prisma.home.update({ where: { id: home.id }, data: { precioMenu: PRECIO_MENU } });
    } else {
      homeCreadoId = (await prisma.home.create({ data: { precioMenu: PRECIO_MENU } })).id;
    }

    const evB5 = await setupEvento('menu', { menuHabilitado: true });
    const cupB5 = await crearCupon(evB5.id);
    mpCalls = []; mailsConfirmacion = [];
    const rB5 = await comprar(evB5.id, cupB5, { cantidadMenus: 1 });
    const b5 = await pendienteYaMP(rB5);
    const bodyB5 = mpCalls[0] ? mpService.construirBodyPreferencia(mpCalls[0]) : { items: [] };
    const sumaB5 = bodyB5.items.reduce((a, i) => a + i.unit_price * i.quantity, 0);
    check(
      '🎯 B5) afiliados al 100 % con menú: va a MP, pendiente, total = el menú',
      b5.ok && b5.c?.totalPagado === PRECIO_MENU && mailsConfirmacion.length === 0,
      `status=${rB5.statusCode} total=${b5.c?.totalPagado} body=${JSON.stringify(rB5.body)}`
    );
    check(
      '🔒 B6) lo que le llega a MP: una sola línea, la del menú, y suma el total (lo cruza el webhook)',
      bodyB5.items.length === 1 && bodyB5.items[0].unit_price === PRECIO_MENU && sumaB5 === b5.c?.totalPagado,
      `items=${JSON.stringify(bodyB5.items.map((i) => [i.unit_price, i.quantity]))} suma=${sumaB5}`
    );
    if (b5.c) await pagos.procesarPagoAprobado(b5.c.id, 'mock-pago-menu');
    const entradasB7 = b5.c ? await prisma.entrada.count({ where: { compraId: b5.c.id } }) : 0;
    check(
      'B7) pagado el menú, sale el QR por el camino normal',
      entradasB7 === 1 && (await tandaDe(evB5)).cantidadVendida === 1 && mailsConfirmacion.length === 1,
      `entradas=${entradasB7} mails=${mailsConfirmacion.length}`
    );

    const bodyComun = mpService.construirBodyPreferencia({
      titulo: 'x', precio: 0, cantidad: 1, email: 'a@example.invalid', preferenciaId: '1',
    });
    check(
      'B8) control: sin menú, una compra en $0 le manda a MP la línea en $0, como hoy',
      bodyComun.items.length === 1 && bodyComun.items[0].unit_price === 0,
      `items=${JSON.stringify(bodyComun.items.map((i) => i.unit_price))}`
    );
    const bodyPago = mpService.construirBodyPreferencia({
      titulo: 'x', precio: 7500, cantidad: 2, email: 'a@example.invalid', preferenciaId: '1',
      itemsExtra: [{ title: 'menu', unit_price: PRECIO_MENU, quantity: 1 }],
    });
    check(
      'B9) control: con precio y menú siguen viajando las dos líneas',
      bodyPago.items.length === 2,
      `items=${JSON.stringify(bodyPago.items.map((i) => i.unit_price))}`
    );

    // ============================================
    // C — Un uso por mail en cada show
    // ============================================

    const evC = await setupEvento('mail');
    const cupC = await crearCupon(evC.id);
    const mailC = mailUnico();
    await comprar(evC.id, cupC, { email: mailC });

    mailsConfirmacion = []; mpCalls = [];
    const rC1 = await comprar(evC.id, cupC, { email: mailC });
    const comprasC1 = await prisma.compra.count({ where: { eventoId: evC.id } });
    const usosC1 = (await cuponDe(cupC)).usosActuales;
    check(
      '🎯 C1) mismo mail, mismo show: 400 CUPON_MAIL_YA_USADO, sin compra, sin uso y sin mail',
      rC1.statusCode === 400 && rC1.body?.code === 'CUPON_MAIL_YA_USADO' && /ya tiene su entrada/.test(rC1.body?.error || '')
        && comprasC1 === 1 && usosC1 === 1 && mailsConfirmacion.length === 0 && mpCalls.length === 0,
      `status=${rC1.statusCode} code=${rC1.body?.code} compras=${comprasC1} usos=${usosC1} mails=${mailsConfirmacion.length}`
    );

    const rC2 = await comprar(evC.id, cupC, { email: `  ${mailC.toUpperCase()}  ` });
    check(
      '🎯 C2) con mayúsculas y espacios es el mismo mail',
      rC2.statusCode === 400 && rC2.body?.code === 'CUPON_MAIL_YA_USADO',
      `status=${rC2.statusCode} code=${rC2.body?.code}`
    );

    const cupC3 = await crearCupon(evC.id);
    const rC3 = await comprar(evC.id, cupC3, { email: mailC });
    check(
      'C3) otro cupón de afiliados del mismo show: también cuenta',
      rC3.statusCode === 400 && rC3.body?.code === 'CUPON_MAIL_YA_USADO',
      `status=${rC3.statusCode} code=${rC3.body?.code}`
    );

    const evC4 = await setupEvento('mail-otro-show');
    const cupC4 = await crearCupon(evC4.id);
    const rC4 = await comprar(evC4.id, cupC4, { email: mailC });
    check(
      '🎯 C4) el mismo mail en OTRO show: pasa',
      rC4.statusCode === 200 && rC4.body?.invitacion === true,
      `status=${rC4.statusCode} body=${JSON.stringify(rC4.body)}`
    );

    const rC5 = await comprar(evC.id, cupC);
    check(
      'C5) otro mail en el mismo show: pasa',
      rC5.statusCode === 200 && rC5.body?.invitacion === true,
      `status=${rC5.statusCode} body=${JSON.stringify(rC5.body)}`
    );

    const cupC6 = await crearCupon(evC.id, { valor: 25, paraAfiliados: false, unaEntradaPorCompra: false });
    const rC6a = await comprar(evC.id, cupC6, { email: mailC });
    const rC6b = await comprar(evC.id, null, { email: mailC });
    check(
      'C6) control: con cupón común o sin cupón, ese mail compra igual',
      rC6a.statusCode === 200 && !!rC6a.body?.init_point && rC6b.statusCode === 200 && !!rC6b.body?.init_point,
      `comun=${rC6a.statusCode} sin=${rC6b.statusCode}`
    );

    // Un pendiente de otro camino NO cuenta si no usó un cupón de afiliados: el
    // punto C6 dejó dos pendientes recientes con este mail y el mail sigue trabado
    // sólo por la invitación. C7 prueba el otro lado: la devolución lo libera.
    const compraC7 = await prisma.compra.findFirst({
      where: { eventoId: evC.id, email: mailC, mpEstado: 'approved' },
    });
    if (compraC7) await pagos.revertirCompraAprobada(compraC7.id, { revertidaPor: 'test' });
    const rC7 = await comprar(evC.id, cupC, { email: mailC });
    check(
      '🎯 C7) devuelta la entrada, ese mail puede volver a usar el cupón (y un pendiente común no lo traba)',
      rC7.statusCode === 200 && rC7.body?.invitacion === true,
      `status=${rC7.statusCode} code=${rC7.body?.code} error=${rC7.body?.error}`
    );

    const evC8 = await setupEvento('mail-pendiente');
    const cupC8 = await crearCupon(evC8.id, { valor: 25 });
    const mailC8 = mailUnico();
    const rC8a = await comprar(evC8.id, cupC8, { email: mailC8 });
    const rC8b = await comprar(evC8.id, cupC8, { email: mailC8 });
    check(
      'C8) con descuento parcial: un pendiente de menos de 30 minutos traba',
      rC8a.statusCode === 200 && rC8b.statusCode === 400 && rC8b.body?.code === 'CUPON_MAIL_YA_USADO',
      `primera=${rC8a.statusCode} segunda=${rC8b.statusCode} code=${rC8b.body?.code}`
    );
    await envejecer(rC8a.body?.compra_id ?? -1, 'createdAt', 31);
    const rC9 = await comprar(evC8.id, cupC8, { email: mailC8 });
    check(
      '🎯 C9) un pendiente abandonado (más de 30 minutos, sin pago) no traba',
      rC9.statusCode === 200 && !!rC9.body?.init_point,
      `status=${rC9.statusCode} code=${rC9.body?.code} error=${rC9.body?.error}`
    );
    await prisma.compra.updateMany({ where: { id: rC9.body?.compra_id ?? -1 }, data: { mpPagoId: 'mock-en-curso' } });
    await envejecer(rC9.body?.compra_id ?? -1, 'createdAt', 120);
    const rC10 = await comprar(evC8.id, cupC8, { email: mailC8 });
    check(
      'C10) con un pago en curso en MP traba aunque sea viejo (Rapipago)',
      rC10.statusCode === 400 && rC10.body?.code === 'CUPON_MAIL_YA_USADO',
      `status=${rC10.statusCode} code=${rC10.body?.code}`
    );

    const evC11 = await setupEvento('mail-carrera');
    const cupC11 = await crearCupon(evC11.id);
    const mailC11 = mailUnico();
    const carrera = await Promise.all(
      [1, 2, 3].map(() => comprar(evC11.id, cupC11, { email: mailC11 }))
    );
    const aprobadasC11 = await prisma.compra.count({ where: { eventoId: evC11.id, mpEstado: 'approved' } });
    const usosC11 = (await cuponDe(cupC11)).usosActuales;
    check(
      '🔒 C11) tres pedidos simultáneos con el mismo mail: una sola compra y un solo uso',
      aprobadasC11 === 1 && usosC11 === 1 && carrera.filter((r) => r.body?.invitacion === true).length === 1,
      `aprobadas=${aprobadasC11} usos=${usosC11} respuestas=${carrera.map((r) => `${r.statusCode}:${r.body?.code || 'ok'}`).join(',')}`
    );

    // ============================================
    // D — La emisión que falla
    // ============================================

    const evD = await setupEvento('falla');
    const cupD = await crearCupon(evD.id);
    qrService.generarQR = async () => { throw new Error('disco simulado'); };
    mailsConfirmacion = [];
    const errorOriginal = console.error;
    console.error = () => {};
    const rD = await comprar(evD.id, cupD);
    console.error = errorOriginal;
    qrService.generarQR = original.generarQR;
    const compraD = rD.body?.compra_id
      ? await prisma.compra.findUnique({ where: { id: rD.body.compra_id }, include: { entradas: true } })
      : null;
    check(
      '🎯 D1) falla la emisión: la persona ve que sale, y la compra queda aprobada, sin entrada',
      rD.statusCode === 200 && rD.body?.invitacion === true
        && compraD?.mpEstado === 'approved' && compraD?.entradas.length === 0,
      `status=${rD.statusCode} estado=${compraD?.mpEstado} entradas=${compraD?.entradas.length}`
    );

    const antes = compraD ? await pagos.repararComprasSinEntradas({ limite: 50 }) : [];
    check(
      '🔒 D2) el barrido no se mete mientras la compra es reciente',
      !antes.some((r) => r.compraId === compraD?.id),
      `reparadas=${JSON.stringify(antes.map((r) => r.compraId))}`
    );

    if (compraD) await envejecer(compraD.id, 'updatedAt', 6);
    const despues = compraD ? await pagos.repararComprasSinEntradas({ limite: 50 }) : [];
    const entradasD = compraD ? await prisma.entrada.count({ where: { compraId: compraD.id } }) : 0;
    const tD = await tandaDe(evD);
    check(
      '🎯 D3) pasados los minutos, el barrido la completa: 1 entrada, cupo +1 y el mail',
      despues.some((r) => r.compraId === compraD?.id) && entradasD === 1 && tD.cantidadVendida === 1
        && mailsConfirmacion.some((m) => m.email === compraD?.email),
      `reparada=${despues.some((r) => r.compraId === compraD?.id)} entradas=${entradasD} cupo=${tD.cantidadVendida} mails=${mailsConfirmacion.length}`
    );

    if (compraD) await envejecer(compraD.id, 'updatedAt', 10);
    if (compraD) await pagos.repararComprasSinEntradas({ limite: 50 });
    check(
      'D4) una segunda vuelta del barrido no duplica',
      (compraD ? await prisma.entrada.count({ where: { compraId: compraD.id } }) : 0) === 1
        && (await tandaDe(evD)).cantidadVendida === 1,
      `cupo=${(await tandaDe(evD)).cantidadVendida}`
    );

    // ============================================
    // E — La salida a mano: reenviar y devolver
    // ============================================

    const evE = await setupEvento('salida');
    const cupE = await crearCupon(evE.id);
    const rE = await comprar(evE.id, cupE);
    const compraE = await prisma.compra.findUnique({
      where: { id: rE.body?.compra_id ?? -1 }, include: { entradas: true },
    }).catch(() => null);
    const admin = { session: { usuario: { email: 'admin@example.invalid', rol: 1 } } };

    mailsConfirmacion = [];
    const rE1 = await call(compras.adminReenviarMail, {
      ...admin, params: { id: String(compraE?.id) }, body: {},
    });
    check(
      '🎯 E1) el botón Reenviar funciona: es la salida si el mail no llegó',
      rE1.statusCode === 200 && rE1.body?.ok === true && mailsConfirmacion.length === 1,
      `status=${rE1.statusCode} error=${rE1.body?.error} mails=${mailsConfirmacion.length}`
    );

    const qrE = compraE?.entradas[0]?.codigoQR;
    const rE2 = await call(compras.adminDevolver, {
      ...admin, params: { id: String(compraE?.id) }, body: { motivo: 'prueba' },
    });
    const compraE2 = compraE ? await prisma.compra.findUnique({ where: { id: compraE.id } }) : null;
    const tE = await tandaDe(evE);
    const cE = await cuponDe(cupE);
    check(
      '🎯 E2) la devolución revierte estado, cupo y uso del cupón',
      rE2.statusCode === 200 && rE2.body?.libero_cupon === true && compraE2?.mpEstado === 'refunded'
        && tE.cantidadVendida === 0 && cE.usosActuales === 0,
      `status=${rE2.statusCode} estado=${compraE2?.mpEstado} cupo=${tE.cantidadVendida} usos=${cE.usosActuales}`
    );
    const rE3 = await call(entradasCtrl.validarPorQR, { body: { codigoQR: qrE } });
    check(
      '🔒 E3) devuelta, el QR ya no entra',
      rE3.statusCode === 400 && rE3.body?.codigo === 'NOT_PAID',
      `status=${rE3.statusCode} codigo=${rE3.body?.codigo}`
    );
    const rE4 = await call(compras.adminDevolver, {
      ...admin, params: { id: String(compraE?.id) }, body: {},
    });
    check(
      'E4) devolver dos veces no descuenta dos veces',
      rE4.statusCode === 400 && (await tandaDe(evE)).cantidadVendida === 0,
      `status=${rE4.statusCode} cupo=${(await tandaDe(evE)).cantidadVendida}`
    );

    // ============================================
    // F — El mail y el panel
    // ============================================

    const baseMail = {
      nombre: 'Ana',
      evento: { nombre: 'Show', fecha: new Date(), hora: '21:00' },
      entradas: [{ codigoQR: '00000000-0000-0000-0000-000000000000' }],
      direccionLinea: 'Una calle',
    };
    const htmlGratis = brevoService._buildHtmlForTest({
      ...baseMail, compra: { totalPagado: 0, cantidadEntradas: 1 },
    });
    const htmlPago = brevoService._buildHtmlForTest({
      ...baseMail, compra: { totalPagado: 10000, cantidadEntradas: 1 },
    });
    check(
      '🎯 F1) en $0 el mail no habla de compra',
      /Tu entrada está confirmada/.test(htmlGratis) && !/Tu compra fue confirmada/.test(htmlGratis)
        && !/Confirmación de compra/.test(htmlGratis),
      'html en $0'
    );
    check(
      'regresión F2) con plata el mail sigue igual',
      /Tu compra fue confirmada/.test(htmlPago) && /Confirmación de compra/.test(htmlPago),
      'html con total'
    );

    const htmlNombre = brevoService._buildHtmlForTest({
      ...baseMail, nombre: '<a href="https://example.invalid">Ana</a>', compra: { totalPagado: 0, cantidadEntradas: 1 },
    });
    check(
      '🔒 F2b) el nombre lo escribe quien compra y, sin pago de por medio, no puede meter HTML en el mail',
      !htmlNombre.includes('<a href="https://example.invalid">') && htmlNombre.includes('&lt;a href='),
      'html con nombre'
    );

    const evF = await setupEvento('panel');
    const cupF = await crearCupon(evF.id);
    const rF = await comprar(evF.id, cupF);
    await call(eventos.adminEnviarInvitacion, {
      params: { id: String(evF.id) },
      body: { email: mailUnico(), nombre: 'Invitada', apellido: 'Ejemplo' },
    });
    const rF3 = await call(eventos.adminListarInvitaciones, { params: { id: String(evF.id) } });
    const filaAfi = (rF3.body || []).find((c) => c.id === rF.body?.compra_id);
    const filaInv = (rF3.body || []).find((c) => c.id !== rF.body?.compra_id);
    check(
      '🎯 F3) el listado de invitaciones distingue la de afiliados de la del panel',
      rF3.body?.length === 2 && filaAfi?.esAfiliadx === true && filaInv?.esAfiliadx === false,
      `filas=${rF3.body?.length} afi=${filaAfi?.esAfiliadx} inv=${filaInv?.esAfiliadx}`
    );
    const rF4 = await call(eventos.adminEventoStats, { params: { id: String(evF.id) } });
    check(
      'F4) las estadísticas la cuentan en «Invitaciones» y no suma a lo recaudado',
      rF4.body?.compras?.invitaciones === 2 && rF4.body?.recaudado === 0,
      `invitaciones=${rF4.body?.compras?.invitaciones} recaudado=${rF4.body?.recaudado}`
    );

    // ============================================
    // REPORT
    // ============================================

    console.log('─'.repeat(72));
    console.log('La entrada incluida en la afiliación');
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
      if (homeOriginal) {
        await prisma.home.update({ where: { id: homeOriginal.id }, data: { precioMenu: homeOriginal.precioMenu } });
      }
      if (homeCreadoId) await prisma.home.delete({ where: { id: homeCreadoId } });
    } catch (cleanupErr) {
      console.error('WARN cleanup:', cleanupErr.message);
    }
    mpService.crearPreferencia = original.crearPreferencia;
    brevoService.enviarConfirmacion = original.enviarConfirmacion;
    brevoService.enviarInvitacion = original.enviarInvitacion;
    qrService.generarQR = original.generarQR;
    await prisma.$disconnect();
    process.exit(process.exitCode || 0);
  }
}

main();
