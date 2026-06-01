/**
 * Tests de integración — Reporte de Ventas por Evento (#9).
 *
 * Cubre la cadena del link público de solo lectura:
 *  - Service reportToken: generar (token 64 hex + expiración), validar
 *    (válido / inexistente / revocado / vencido), revocar (soft-delete).
 *  - Middleware requireReportToken: inyecta el eventoId del token y responde
 *    UNIFORME (mismo 404) ante cualquier token inválido.
 *  - 🔒 Scoping: un token del evento A jamás expone datos del evento B.
 *  - Controller meta + admin (generar / listar / revocar).
 *
 * Uso local (con dev.db):
 *   node tests/integration/reporte-token.test.js
 */

const prisma = require('../../src/utils/prisma');
const reportTokenService = require('../../src/services/reportToken.service');
const { requireReportToken } = require('../../src/middleware/auth.middleware');
const dashboardController = require('../../src/controllers/dashboard.controller');
const reporteController = require('../../src/controllers/reporte.controller');

const TEST_PREFIX = 'reporte-token-test-';

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    set(k, v) { this.headers[k] = v; return this; },
  };
}

// Simula la cadena real del endpoint público: requireReportToken corre primero;
// si llama next(), corre el controller con el MISMO req (ya con eventoId inyectado).
async function callPublic(controllerFn, token, extraQuery = {}) {
  const req = { params: { token }, query: { ...extraQuery } };
  const res = mockRes();
  let nextCalled = false;
  await requireReportToken(req, res, () => { nextCalled = true; });
  if (nextCalled) await controllerFn(req, res);
  return { res, nextCalled, req };
}

async function callAdminGenerar(body, email = 'admin@test') {
  const req = { body, session: { usuario: { email } } };
  const res = mockRes();
  await reporteController.adminGenerar(req, res);
  return res;
}

async function setupEvento({ sufijo, precio = 10000 } = {}) {
  return prisma.evento.create({
    data: {
      nombre: `${TEST_PREFIX}${sufijo}`,
      descripcion: 'test',
      fecha: new Date(Date.now() + 30 * 86400000),
      hora: '21:00',
      estaPublicado: true,
      tandas: { create: [{ nombre: 'General', precio, orden: 1, activa: true }] },
    },
    include: { tandas: true },
  });
}

async function crearCompraApproved(evento, { cantidad = 1, total = 10000 } = {}) {
  return prisma.compra.create({
    data: {
      eventoId: evento.id,
      tandaId: evento.tandas[0].id,
      email: 'comprador@test', nombre: 'Test', apellido: 'User',
      cantidadEntradas: cantidad,
      precioUnitario: Math.round(total / cantidad),
      totalPagado: total,
      mpEstado: 'approved',
    },
  });
}

async function cleanup() {
  const eventos = await prisma.evento.findMany({
    where: { nombre: { startsWith: TEST_PREFIX } },
    select: { id: true },
  });
  const ids = eventos.map((e) => e.id);
  if (ids.length === 0) return;
  await prisma.reportAccessToken.deleteMany({ where: { eventoId: { in: ids } } });
  const compras = await prisma.compra.findMany({ where: { eventoId: { in: ids } }, select: { id: true } });
  const compraIds = compras.map((c) => c.id);
  await prisma.entrada.deleteMany({ where: { compraId: { in: compraIds } } });
  await prisma.cuponUso.deleteMany({ where: { compraId: { in: compraIds } } });
  await prisma.compra.deleteMany({ where: { eventoId: { in: ids } } });
  await prisma.tanda.deleteMany({ where: { eventoId: { in: ids } } });
  await prisma.evento.deleteMany({ where: { id: { in: ids } } });
}

async function main() {
  const checks = [];
  try {
    await cleanup();

    // Eventos con ventas distintas para probar scoping.
    const evA = await setupEvento({ sufijo: 'A', precio: 5000 });
    const evB = await setupEvento({ sufijo: 'B', precio: 8000 });
    await crearCompraApproved(evA, { cantidad: 2, total: 10000 });
    await crearCompraApproved(evB, { cantidad: 1, total: 8000 });

    // ============================================
    // BLOQUE 1 — Service: generarToken
    // ============================================
    const tokA = await reportTokenService.generarToken(evA.id, { expiraEnDias: 30, creadoPor: 'admin@test' });
    checks.push({
      name: '🎯 generarToken → token de 64 chars hex + expiración futura',
      pass: /^[0-9a-f]{64}$/.test(tokA.token) && tokA.expiraEn.getTime() > Date.now() && tokA.eventoId === evA.id,
      detail: `len=${tokA.token.length} expiraEn=${tokA.expiraEn.toISOString()} eventoId=${tokA.eventoId}`,
    });

    const tokDiasRaro = await reportTokenService.generarToken(evA.id, { expiraEnDias: 999 });
    const diasAprox = Math.round((tokDiasRaro.expiraEn.getTime() - Date.now()) / 86400000);
    checks.push({
      name: 'generarToken con días fuera de whitelist → cae al default (30)',
      pass: diasAprox === 30,
      detail: `diasAprox=${diasAprox}`,
    });

    let errEventoInexistente = null;
    try { await reportTokenService.generarToken(99999999, {}); } catch (e) { errEventoInexistente = e.code; }
    checks.push({
      name: 'generarToken sobre evento inexistente → throw EVENTO_NO_ENCONTRADO',
      pass: errEventoInexistente === 'EVENTO_NO_ENCONTRADO',
      detail: `code=${errEventoInexistente}`,
    });

    // ============================================
    // BLOQUE 2 — Service: validarToken
    // ============================================
    const vOk = await reportTokenService.validarToken(tokA.token);
    checks.push({
      name: '🎯 validarToken token válido → {valido:true, eventoId}',
      pass: vOk.valido === true && vOk.eventoId === evA.id,
      detail: `valido=${vOk.valido} eventoId=${vOk.eventoId}`,
    });

    const vNoExiste = await reportTokenService.validarToken('no-existe-' + Date.now());
    checks.push({
      name: 'validarToken inexistente → TOKEN_INEXISTENTE',
      pass: vNoExiste.valido === false && vNoExiste.code === 'TOKEN_INEXISTENTE',
      detail: `code=${vNoExiste.code}`,
    });

    const tokRevocado = await reportTokenService.generarToken(evA.id, {});
    await reportTokenService.revocar(tokRevocado.id);
    const vRevocado = await reportTokenService.validarToken(tokRevocado.token);
    checks.push({
      name: 'validarToken revocado → TOKEN_REVOCADO (soft-delete activo=false)',
      pass: vRevocado.valido === false && vRevocado.code === 'TOKEN_REVOCADO',
      detail: `code=${vRevocado.code}`,
    });

    const tokExpirado = await prisma.reportAccessToken.create({
      data: { eventoId: evA.id, token: 'tok-expirado-' + Date.now(), expiraEn: new Date(Date.now() - 86400000) },
    });
    const vExpirado = await reportTokenService.validarToken(tokExpirado.token);
    checks.push({
      name: 'validarToken vencido → TOKEN_EXPIRADO',
      pass: vExpirado.valido === false && vExpirado.code === 'TOKEN_EXPIRADO',
      detail: `code=${vExpirado.code}`,
    });

    // ============================================
    // BLOQUE 3 — 🔒 Middleware: respuesta UNIFORME ante token inválido
    // ============================================
    const rInexistente = await callPublic(reporteController.meta, 'no-existe-xyz');
    const rRevocado = await callPublic(reporteController.meta, tokRevocado.token);
    const rExpirado = await callPublic(reporteController.meta, tokExpirado.token);

    checks.push({
      name: '🔒 token inexistente → 404 sin llamar al controller',
      pass: rInexistente.nextCalled === false && rInexistente.res.statusCode === 404,
      detail: `next=${rInexistente.nextCalled} status=${rInexistente.res.statusCode}`,
    });
    checks.push({
      name: '🔒 inexistente / revocado / vencido → MISMO status y MISMO mensaje (no filtra estado del token)',
      pass:
        rInexistente.res.statusCode === 404 && rRevocado.res.statusCode === 404 && rExpirado.res.statusCode === 404 &&
        rInexistente.res.body.error === rRevocado.res.body.error &&
        rRevocado.res.body.error === rExpirado.res.body.error,
      detail: `msgs="${rInexistente.res.body.error}" | "${rRevocado.res.body.error}" | "${rExpirado.res.body.error}"`,
    });

    // ============================================
    // BLOQUE 4 — Middleware: token válido inyecta scope + no-store
    // ============================================
    const rMeta = await callPublic(reporteController.meta, tokA.token);
    checks.push({
      name: '🎯 token válido → next() + meta del evento correcto + Cache-Control no-store',
      pass:
        rMeta.nextCalled === true &&
        rMeta.res.statusCode === 200 &&
        rMeta.res.body.evento.nombre === evA.nombre &&
        rMeta.req.query.eventoId === String(evA.id) &&
        rMeta.req.params.id === String(evA.id) &&
        rMeta.res.headers['Cache-Control'] === 'no-store',
      detail: `nombre=${rMeta.res.body.evento.nombre} eventoId=${rMeta.req.query.eventoId} cc=${rMeta.res.headers['Cache-Control']}`,
    });

    // ============================================
    // BLOQUE 5 — 🔒 SCOPING: token de A no expone datos de B
    // ============================================
    const rResumenA = await callPublic(dashboardController.resumen, tokA.token);
    checks.push({
      name: '🔒 resumen con token de A → recaudado y entradas SOLO de A (no suma a B)',
      pass:
        rResumenA.res.body.recaudado.total === 10000 &&
        rResumenA.res.body.entradas.vendidas === 2 &&
        rResumenA.res.body.filtros.eventoId === evA.id,
      detail: `recaudado=${rResumenA.res.body.recaudado.total} vendidas=${rResumenA.res.body.entradas.vendidas} eventoId=${rResumenA.res.body.filtros.eventoId}`,
    });

    const tokB = await reportTokenService.generarToken(evB.id, {});
    const rResumenB = await callPublic(dashboardController.resumen, tokB.token);
    checks.push({
      name: '🔒 resumen con token de B → datos de B ($8000, 1 entrada), distinto de A',
      pass:
        rResumenB.res.body.recaudado.total === 8000 &&
        rResumenB.res.body.entradas.vendidas === 1 &&
        rResumenB.res.body.filtros.eventoId === evB.id,
      detail: `recaudado=${rResumenB.res.body.recaudado.total} vendidas=${rResumenB.res.body.entradas.vendidas} eventoId=${rResumenB.res.body.filtros.eventoId}`,
    });

    const rTandasA = await callPublic(dashboardController.distribucionTandas, tokA.token);
    checks.push({
      name: '🔒 distribucion-tandas con token de A → eventoId y tandas de A',
      pass:
        rTandasA.res.body.eventoId === evA.id &&
        rTandasA.res.body.evento.nombre === evA.nombre &&
        rTandasA.res.body.tandas.length === 1,
      detail: `eventoId=${rTandasA.res.body.eventoId} nombre=${rTandasA.res.body.evento.nombre} tandas=${rTandasA.res.body.tandas.length}`,
    });

    // ============================================
    // BLOQUE 6 — Controller admin: generar / listar
    // ============================================
    const rGen = await callAdminGenerar({ eventoId: evA.id, expiraEnDias: 7 });
    checks.push({
      name: '🎯 adminGenerar → 201 con token + url /reporte/<token>',
      pass:
        rGen.statusCode === 201 &&
        /^[0-9a-f]{64}$/.test(rGen.body.token) &&
        rGen.body.url === `/reporte/${rGen.body.token}`,
      detail: `status=${rGen.statusCode} url=${rGen.body?.url}`,
    });

    const rGenSinEvento = await callAdminGenerar({});
    checks.push({
      name: 'adminGenerar sin eventoId → 400',
      pass: rGenSinEvento.statusCode === 400,
      detail: `status=${rGenSinEvento.statusCode}`,
    });

    const rGenEventoMalo = await callAdminGenerar({ eventoId: 99999999 });
    checks.push({
      name: 'adminGenerar con evento inexistente → 404',
      pass: rGenEventoMalo.statusCode === 404,
      detail: `status=${rGenEventoMalo.statusCode}`,
    });

    const listaA = await reportTokenService.listarPorEvento(evA.id);
    checks.push({
      name: 'listarPorEvento(A) → incluye los tokens generados para A',
      pass: Array.isArray(listaA) && listaA.length >= 2 && listaA.every((t) => t.eventoId === evA.id),
      detail: `count=${listaA.length}`,
    });

    // ============================================
    // BLOQUE 7 — Revocación corta el acceso
    // ============================================
    const tokVivo = await reportTokenService.generarToken(evA.id, {});
    const antes = await callPublic(reporteController.meta, tokVivo.token);
    await reportTokenService.revocar(tokVivo.id);
    const despues = await callPublic(reporteController.meta, tokVivo.token);
    checks.push({
      name: '🔒 revocar un token vivo → deja de validar (200 antes, 404 después)',
      pass: antes.res.statusCode === 200 && despues.res.statusCode === 404 && despues.nextCalled === false,
      detail: `antes=${antes.res.statusCode} despues=${despues.res.statusCode}`,
    });

    // ============================================
    // REPORT
    // ============================================
    console.log('─'.repeat(72));
    console.log('Reporte de Ventas por Evento (#9) — Tests del token público');
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
