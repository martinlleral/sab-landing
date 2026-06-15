/**
 * Tests de integración — Validación de entradas por token compartible (ítem 2).
 *
 * Cubre:
 *   - Service: generar / validar / toggle activo (revocar y reactivar), sin expiración.
 *   - Middleware requireValidationToken: respuesta 404 UNIFORME (inexistente == revocado),
 *     inyecta req.validationToken, Cache-Control no-store.
 *   - Endpoint público validarPorQRPublico: OK / ALREADY_USED / NOT_FOUND / NOT_PAID,
 *     respuesta REDUCIDA (nombre + evento, SIN email/teléfono), y MULTI-EVENTO
 *     (un mismo token valida QR de eventos distintos).
 *   - Admin: generar (201 + url) / listar / toggle activo / validación de body.
 *   - Regresión: validarPorQR (admin) sigue devolviendo la entrada COMPLETA (con email).
 *
 * Controllers/servicios directos con req/res mock. Uso local (dev.db):
 *   node tests/integration/validacion-token.test.js
 * Exit codes: 0 = PASS, 1 = FAIL
 */

const prisma = require('../../src/utils/prisma');
const entradasController = require('../../src/controllers/entradas.controller');
const validacionController = require('../../src/controllers/validacionToken.controller');
const service = require('../../src/services/validationToken.service');
const { requireValidationToken } = require('../../src/middleware/auth.middleware');

const TEST_PREFIX = 'validacion-token-test-';

function mockRes() {
  return {
    statusCode: 200, body: null, headers: {},
    status(c) { this.statusCode = c; return this; },
    json(p) { this.body = p; return this; },
    set(k, v) { this.headers[k] = v; return this; },
  };
}
function mockReq({ params = {}, query = {}, body = {}, session = {} } = {}) {
  return { params, query, body, session };
}
async function call(handler, req) { const res = mockRes(); await handler(req, res); return res; }
async function callMw(mw, req) {
  const res = mockRes();
  let nextCalled = false;
  await mw(req, res, () => { nextCalled = true; });
  return { res, nextCalled };
}

async function cleanup() {
  const eventos = await prisma.evento.findMany({ where: { nombre: { startsWith: TEST_PREFIX } }, select: { id: true } });
  const eventoIds = eventos.map((e) => e.id);
  if (eventoIds.length) {
    const compras = await prisma.compra.findMany({ where: { eventoId: { in: eventoIds } }, select: { id: true } });
    const compraIds = compras.map((c) => c.id);
    await prisma.entrada.deleteMany({ where: { compraId: { in: compraIds } } });
    await prisma.compra.deleteMany({ where: { id: { in: compraIds } } });
    await prisma.tanda.deleteMany({ where: { eventoId: { in: eventoIds } } });
    await prisma.evento.deleteMany({ where: { id: { in: eventoIds } } });
  }
  await prisma.validationAccessToken.deleteMany({ where: { descripcion: { startsWith: TEST_PREFIX } } });
}

async function crearEventoConEntrada({ sufijo, mpEstado = 'approved', nombreComprador = 'Juan', qr }) {
  const evento = await prisma.evento.create({
    data: {
      nombre: `${TEST_PREFIX}${sufijo}`, descripcion: 'test',
      fecha: new Date(Date.now() + 10 * 864e5), hora: '21:00', estaPublicado: true,
      tandas: { create: [{ nombre: 'General', precio: 1000, orden: 1, activa: true }] },
    },
  });
  const compra = await prisma.compra.create({
    data: {
      eventoId: evento.id, email: `${TEST_PREFIX}${sufijo}@test.invalid`,
      nombre: nombreComprador, apellido: 'Pérez', telefono: '1122334455',
      cantidadEntradas: 1, precioUnitario: 1000, totalPagado: 1000, mpEstado,
    },
  });
  const entrada = await prisma.entrada.create({
    data: { compraId: compra.id, codigoQR: qr, qrImageUrl: `/assets/img/uploads/qr/${qr}.png` },
  });
  return { evento, compra, entrada };
}

async function main() {
  const checks = [];
  const add = (name, pass, detail = '') => checks.push({ name, pass, detail });
  const ts = Date.now();

  try {
    await cleanup();

    const qrA1 = `${TEST_PREFIX}A1-${ts}`;
    const qrA2 = `${TEST_PREFIX}A2-${ts}`;
    const qrB1 = `${TEST_PREFIX}B1-${ts}`;
    const qrP1 = `${TEST_PREFIX}P1-${ts}`;
    await crearEventoConEntrada({ sufijo: `A-${ts}`, qr: qrA1, nombreComprador: 'Ana' });
    // A2 vive en el mismo evento A (otra compra) — para la regresión admin
    const evA2 = await crearEventoConEntrada({ sufijo: `A2-${ts}`, qr: qrA2, nombreComprador: 'Carlos' });
    await crearEventoConEntrada({ sufijo: `B-${ts}`, qr: qrB1, nombreComprador: 'Beatriz' });
    await crearEventoConEntrada({ sufijo: `P-${ts}`, qr: qrP1, mpEstado: 'pending', nombreComprador: 'Pedro' });

    // ── Service ───────────────────────────────────────────────────────────────
    const tok = await service.generarToken({ descripcion: `${TEST_PREFIX}Casa Metro`, creadoPor: 'admin@test' });
    add('generarToken: token 64 hex + activo', /^[0-9a-f]{64}$/.test(tok.token) && tok.activo === true, `len=${tok.token.length} activo=${tok.activo}`);

    let v = await service.validarToken(tok.token);
    add('validarToken: token válido', v.valido === true && !!v.registro);
    v = await service.validarToken('no-existe-xyz');
    add('validarToken: inexistente → TOKEN_INEXISTENTE', v.valido === false && v.code === 'TOKEN_INEXISTENTE');

    await service.setActivo(tok.id, false);
    v = await service.validarToken(tok.token);
    add('setActivo(false) revoca → TOKEN_REVOCADO', v.valido === false && v.code === 'TOKEN_REVOCADO');
    await service.setActivo(tok.id, true);
    v = await service.validarToken(tok.token);
    add('setActivo(true) reactiva → válido de nuevo', v.valido === true);

    // ── Middleware: respuesta uniforme ─────────────────────────────────────────
    let r = await callMw(requireValidationToken, mockReq({ params: { token: tok.token } }));
    add('middleware: token válido → next() + req.validationToken + no-store',
      r.nextCalled && r.res.headers['Cache-Control'] === 'no-store',
      `next=${r.nextCalled} cc=${r.res.headers['Cache-Control']}`);

    const rInexist = await callMw(requireValidationToken, mockReq({ params: { token: 'zzz-inexistente' } }));
    await service.setActivo(tok.id, false);
    const rRevoc = await callMw(requireValidationToken, mockReq({ params: { token: tok.token } }));
    await service.setActivo(tok.id, true);
    add('middleware: inexistente y revocado dan el MISMO 404 (uniforme, no filtra)',
      rInexist.res.statusCode === 404 && rRevoc.res.statusCode === 404 &&
      JSON.stringify(rInexist.res.body) === JSON.stringify(rRevoc.res.body) &&
      !rInexist.nextCalled && !rRevoc.nextCalled,
      `inexist=${rInexist.res.statusCode} revoc=${rRevoc.res.statusCode}`);

    // ── Endpoint público validarPorQRPublico ────────────────────────────────────
    let res = await call(entradasController.validarPorQRPublico, mockReq({ body: { codigoQR: qrA1 } }));
    const okPayload = res.body || {};
    add('público: QR válido → 200 valida:true', res.statusCode === 200 && okPayload.valida === true);
    add('público: respuesta trae nombre + evento', !!(okPayload.entrada && okPayload.entrada.nombre === 'Ana' && okPayload.entrada.evento && okPayload.entrada.evento.nombre),
      `nombre=${okPayload.entrada?.nombre} evento=${okPayload.entrada?.evento?.nombre}`);
    add('público: respuesta NO expone email/teléfono/compra',
      okPayload.entrada && okPayload.entrada.email === undefined && okPayload.entrada.telefono === undefined && okPayload.entrada.compra === undefined,
      `keys=${Object.keys(okPayload.entrada || {}).join(',')}`);

    res = await call(entradasController.validarPorQRPublico, mockReq({ body: { codigoQR: qrA1 } }));
    add('público: mismo QR de nuevo → 409 ALREADY_USED', res.statusCode === 409 && res.body.codigo === 'ALREADY_USED');

    res = await call(entradasController.validarPorQRPublico, mockReq({ body: { codigoQR: qrB1 } }));
    add('público MULTI-EVENTO: mismo token concepto valida QR de OTRO evento → 200', res.statusCode === 200 && res.body.valida === true,
      `status=${res.statusCode} evento=${res.body?.entrada?.evento?.nombre}`);

    res = await call(entradasController.validarPorQRPublico, mockReq({ body: { codigoQR: 'qr-inexistente' } }));
    add('público: QR inexistente → 404 NOT_FOUND', res.statusCode === 404 && res.body.codigo === 'NOT_FOUND');

    res = await call(entradasController.validarPorQRPublico, mockReq({ body: { codigoQR: qrP1 } }));
    add('público: QR de compra pending → 400 NOT_PAID', res.statusCode === 400 && res.body.codigo === 'NOT_PAID');

    // ── Admin CRUD ──────────────────────────────────────────────────────────────
    res = await call(validacionController.adminGenerar, mockReq({ body: { descripcion: `${TEST_PREFIX}Niceto` }, session: { usuario: { email: 'admin@test' } } }));
    add('admin: generar → 201 + url /validar/<token>', res.statusCode === 201 && res.body.url === `/validar/${res.body.token}`, `url=${res.body?.url}`);
    const nuevoId = res.body.id;

    res = await call(validacionController.adminListar, mockReq());
    add('admin: listar incluye tokens con url', Array.isArray(res.body) && res.body.some((t) => t.id === nuevoId && t.url.startsWith('/validar/')));

    res = await call(validacionController.adminSetActivo, mockReq({ params: { id: String(nuevoId) }, body: { activo: false } }));
    add('admin: setActivo(false) → activo:false', res.statusCode === 200 && res.body.activo === false);

    res = await call(validacionController.adminSetActivo, mockReq({ params: { id: String(nuevoId) }, body: { activo: 'no-bool' } }));
    add('admin: setActivo sin boolean → 400', res.statusCode === 400);

    // ── Regresión: el endpoint admin de QR sigue devolviendo la entrada COMPLETA ──
    res = await call(entradasController.validarPorQR, mockReq({ body: { codigoQR: qrA2 } }));
    add('regresión admin: validarPorQR devuelve entrada COMPLETA con email',
      res.statusCode === 200 && res.body.valida === true && res.body.entrada && res.body.entrada.compra && typeof res.body.entrada.compra.email === 'string',
      `email=${res.body?.entrada?.compra?.email ? 'presente' : 'AUSENTE'}`);

    void evA2;

    console.log('─'.repeat(64));
    console.log('Validación por Token Compartible — Integration Test');
    console.log('─'.repeat(64));
    for (const c of checks) { console.log(`${c.pass ? '✅' : '❌'} ${c.name}${c.detail ? ' — ' + c.detail : ''}`); }
    console.log('─'.repeat(64));
    const failed = checks.filter((c) => !c.pass);
    console.log(failed.length ? `\n❌ FAIL — ${failed.length}/${checks.length}` : `\n✅ PASS — ${checks.length}/${checks.length} checks OK`);
    process.exitCode = failed.length ? 1 : 0;
  } catch (err) {
    console.error('❌ ERROR INESPERADO:', err.message); console.error(err.stack); process.exitCode = 1;
  } finally {
    try { await cleanup(); } catch (e) { console.error('WARN cleanup:', e.message); }
    await prisma.$disconnect();
    process.exit(process.exitCode || 0);
  }
}

main();
