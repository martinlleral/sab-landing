/**
 * Tests de integración — Corte horario de venta de menús (ítem 43c, Sprint 7 · S3).
 *
 * Casa Metro cierra la cuenta de cuánto cocinar a una hora del día del evento
 * (`Home.menuCorteHora`, default "18:00"). Pasada esa hora ya no se vende menú;
 * las entradas siguen a la venta.
 *
 * LO QUE ESTOS TESTS PROTEGEN, en orden de lo que cuesta si falla:
 *
 *   BLOQUE 1 — EL TIMEZONE, con hora fija. El proyecto ya tuvo un fix por esto
 *              (8-9/5/2026): mal calculado, el corte cae a las 15 o a las 21. Se
 *              prueba con `Date` construidas a mano, nunca con `new Date()`.
 *   BLOQUE 2 — la regla en la capa que usa el controller (`calcularTotalCompra`),
 *              no solo en el validador puro.
 *   BLOQUE 3 — 🔒 EL CAMINO DEL REQUEST. Es el candado de R1: un check unitario
 *              en verde no prueba que alguien llegue hasta la guarda. Acá se pega
 *              en `crearPreferencia` y se verifica el 400 **y que no haya quedado
 *              ninguna compra creada**.
 *   BLOQUE 4 — que el checkout reciba el estado ya resuelto por el servidor
 *              (`menuCerrado`), con el reloj del servidor y no el del navegador.
 *
 * ⚠️ LÍMITE DECLARADO. Por el camino del request el reloj es el real: no se
 * inyecta. Por eso el minuto exacto (17:59 vs 18:01) se prueba en el BLOQUE 1 con
 * hora fija, y el BLOQUE 3 mueve la FECHA DEL EVENTO —ayer vs mañana— que es
 * determinista a cualquier hora del día en que corran los tests. Un fixture
 * "hoy + hora relativa" fallaría solo cerca de medianoche, que es la peor forma
 * de fallar.
 *
 * ⚠️ `Home` es config global de una sola fila: los tests la pisan y la restauran
 * en el `finally`.
 *
 * No mockea Prisma: usa dev.db real y limpia con prefijo `menu-corte-test-`.
 *
 * Uso local:
 *   node tests/integration/menu-corte.test.js
 *
 * Exit codes: 0 = PASS, 1 = FAIL
 */

const prisma = require('../../src/utils/prisma');
const compras = require('../../src/controllers/compras.controller');
const eventosCtrl = require('../../src/controllers/eventos.controller');
const mpService = require('../../src/services/mercadopago.service');
const brevoService = require('../../src/services/brevo.service');
const {
  calcularCorteMenu, menuVentaCerrada, validarMenu, calcularTotalCompra,
} = require('../../src/services/precios.service');

const TEST_PREFIX = 'menu-corte-test-';
const PRECIO_ENTRADA = 10000;
const PRECIO_MENU = 15000;
const CORTE = '18:00';

// ---------- mocks de servicios externos ----------
const originalCrearPref = mpService.crearPreferencia;
mpService.crearPreferencia = async () => ({
  id: `mock-pref-${Date.now()}-${Math.random()}`,
  init_point: 'https://mock.invalid/pay',
});
const originalEnviarConfirmacion = brevoService.enviarConfirmacion;
brevoService.enviarConfirmacion = async () => ({ mocked: true });

// ---------- helpers ----------
const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail });
}

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

async function call(handler, req = {}) {
  const res = mockRes();
  await handler({ body: {}, params: {}, query: {}, ...req }, res);
  return res;
}

const comprar = (evento, { cantidad = 2, menus = 0 } = {}) => call(compras.crearPreferencia, {
  body: {
    eventoId: evento.id,
    email: `c${Date.now()}${Math.floor(Math.random() * 1000)}@test.invalid`,
    nombre: 'Test',
    apellido: 'Corte',
    telefono: '221',
    cantidad,
    ...(menus > 0 ? { cantidadMenus: menus } : {}),
  },
});

// Día calendario ART de hoy, desplazado N días, guardado como mediodía UTC — que
// es la convención del proyecto para `Evento.fecha` (ver `parsearFechaLocal`).
function fechaEventoRelativa(dias) {
  const ahoraART = new Date(Date.now() - 3 * 60 * 60 * 1000);
  return new Date(Date.UTC(
    ahoraART.getUTCFullYear(), ahoraART.getUTCMonth(), ahoraART.getUTCDate() + dias, 12, 0, 0
  ));
}

async function setupEvento({ dias = 30, menuHabilitado = true, sufijo = '' } = {}) {
  const evento = await prisma.evento.create({
    data: {
      nombre: `${TEST_PREFIX}${sufijo || Date.now()}`,
      descripcion: 'test',
      fecha: fechaEventoRelativa(dias),
      hora: '21:00',
      estaPublicado: true,
      menuHabilitado,
      tandas: {
        create: [{ nombre: 'Única', precio: PRECIO_ENTRADA, orden: 1, activa: true }],
      },
    },
    include: { tandas: true },
  });
  return { evento, tanda: evento.tandas[0] };
}

// ---------- Home (config global de 1 fila) ----------
let homeOriginal = null;
let homeCreadoId = null;

async function setHome(data) {
  const home = await prisma.home.findFirst();
  if (!home) {
    const creado = await prisma.home.create({ data });
    homeCreadoId = creado.id;
    return;
  }
  if (homeOriginal === null) {
    homeOriginal = { id: home.id, precioMenu: home.precioMenu, menuCorteHora: home.menuCorteHora };
  }
  await prisma.home.update({ where: { id: home.id }, data });
}

async function restaurarHome() {
  if (homeCreadoId !== null) {
    await prisma.home.delete({ where: { id: homeCreadoId } });
    homeCreadoId = null;
    return;
  }
  if (homeOriginal !== null) {
    await prisma.home.update({
      where: { id: homeOriginal.id },
      data: { precioMenu: homeOriginal.precioMenu, menuCorteHora: homeOriginal.menuCorteHora },
    });
    homeOriginal = null;
  }
}

async function cleanup() {
  const eventos = await prisma.evento.findMany({
    where: { nombre: { startsWith: TEST_PREFIX } },
    select: { id: true },
  });
  const eventoIds = eventos.map((e) => e.id);
  if (eventoIds.length === 0) return;
  const comprasTest = await prisma.compra.findMany({
    where: { eventoId: { in: eventoIds } }, select: { id: true },
  });
  const compraIds = comprasTest.map((c) => c.id);
  await prisma.entrada.deleteMany({ where: { compraId: { in: compraIds } } });
  await prisma.compra.deleteMany({ where: { id: { in: compraIds } } });
  await prisma.tanda.deleteMany({ where: { eventoId: { in: eventoIds } } });
  await prisma.evento.deleteMany({ where: { id: { in: eventoIds } } });
}

async function expectThrow(fn, expectedCode) {
  try {
    await fn();
    return { ok: false, detail: `esperaba throw con code=${expectedCode}, no tiró nada` };
  } catch (err) {
    return { ok: err.code === expectedCode, detail: `code=${err.code} msg="${err.message}"` };
  }
}

async function main() {
  try {
    await cleanup();
    await setHome({ precioMenu: PRECIO_MENU, menuCorteHora: CORTE });

    // ============================================================
    // BLOQUE 1 — Timezone, con HORA FIJA (nunca new Date())
    // ============================================================
    // Evento del 23/8/2026 guardado como mediodía UTC, que es como los guarda el
    // backoffice. El corte a las 18:00 ART de ese día es 21:00 UTC.
    const F23 = new Date('2026-08-23T12:00:00.000Z');

    check('1a) 🎯 el corte de las 18:00 ART del 23/8 es 2026-08-23T21:00:00Z (no 15:00 ni 21:00 ART)',
      calcularCorteMenu(F23, CORTE).toISOString() === '2026-08-23T21:00:00.000Z',
      calcularCorteMenu(F23, CORTE).toISOString());

    check('1b) 🎯 17:59 del día del evento: SE VENDE',
      menuVentaCerrada(F23, CORTE, new Date('2026-08-23T20:59:00.000Z')) === false);

    check('1c) 🎯 18:01 del día del evento: CERRADO',
      menuVentaCerrada(F23, CORTE, new Date('2026-08-23T21:01:00.000Z')) === true);

    check('1d) las 18:00 en punto ya es cierre (mismo criterio `>=` que estaDisponible)',
      menuVentaCerrada(F23, CORTE, new Date('2026-08-23T21:00:00.000Z')) === true);

    check('1e) la noche ANTERIOR al evento (23:00 ART del 22/8) se vende',
      menuVentaCerrada(F23, CORTE, new Date('2026-08-23T02:00:00.000Z')) === false);

    check('1f) el día DESPUÉS del evento está cerrado',
      menuVentaCerrada(F23, CORTE, new Date('2026-08-24T03:05:00.000Z')) === true);

    // Un corte tarde cruza de día en UTC: 22:00 ART del 23/8 = 01:00 UTC del 24/8.
    check('1g) un corte a las 22:00 cruza el día en UTC y a las 21:59 ART sigue abierto',
      calcularCorteMenu(F23, '22:00').toISOString() === '2026-08-24T01:00:00.000Z'
      && menuVentaCerrada(F23, '22:00', new Date('2026-08-24T00:59:00.000Z')) === false,
      calcularCorteMenu(F23, '22:00').toISOString());

    check('1h) 23:59 = vender hasta el final del día (la forma de "sin corte")',
      calcularCorteMenu(F23, '23:59').toISOString() === '2026-08-24T02:59:00.000Z',
      calcularCorteMenu(F23, '23:59').toISOString());

    // 🔒 REGRESIÓN TIMEZONE. La tentación al escribir esto es derivar el día
    // restándole 3 h a `fecha` (como hace `umbralVisibilidadART` con el RELOJ).
    // Aplicado al dato guardado, cualquier fecha entre las 00:00 y las 03:00 UTC
    // se iría al día anterior y el menú cerraría un día antes. Este check fija que
    // el día sale de los componentes UTC crudos.
    const F23medianoche = new Date('2026-08-23T00:00:00.000Z');
    check('🔒 1i) REGRESIÓN TIMEZONE: una fecha guardada a las 00:00 UTC da el MISMO corte que a las 12:00',
      calcularCorteMenu(F23medianoche, CORTE).toISOString() === calcularCorteMenu(F23, CORTE).toISOString(),
      `${calcularCorteMenu(F23medianoche, CORTE).toISOString()} vs ${calcularCorteMenu(F23, CORTE).toISOString()}`);

    // Fail-closed en el parseo: el valor malo explota en su guarda, no se convierte
    // en un default silencioso (es el hallazgo del `|| 0` de R1, aplicado a un String).
    for (const malo of ['25:00', '18:60', '8:00', '1800', 'dieciocho', '18:0']) {
      let code = null;
      try { calcularCorteMenu(F23, malo); } catch (e) { code = e.code; }
      check(`🔒 1j) "${malo}" NO se toma como hora válida → MENU_CORTE_INVALIDO`,
        code === 'MENU_CORTE_INVALIDO', `code=${code}`);
    }

    check('1k) sin hora configurada (null) no hay corte: no bloquea nada',
      menuVentaCerrada(F23, null, new Date('2030-01-01T00:00:00.000Z')) === false);

    // ============================================================
    // BLOQUE 2 — La regla, por la capa que usa el controller
    // ============================================================
    const { tanda: tPasado } = await setupEvento({ dias: -1, sufijo: '2ayer' });

    const r2a = await expectThrow(
      () => calcularTotalCompra(tPasado, {
        cantidad: 2, cantidadMenus: 2, menuHabilitado: true, precioMenu: PRECIO_MENU,
        fechaEvento: F23, menuCorteHora: CORTE, ahora: new Date('2026-08-23T21:30:00.000Z'),
      }),
      'MENU_CORTE_PASADO'
    );
    check('🔒 2a) calcularTotalCompra con el corte pasado → MENU_CORTE_PASADO', r2a.ok, r2a.detail);

    const sinMenuTardio = await calcularTotalCompra(tPasado, {
      cantidad: 2, cantidadMenus: 0, menuHabilitado: true, precioMenu: PRECIO_MENU,
      fechaEvento: F23, menuCorteHora: CORTE, ahora: new Date('2026-08-23T21:30:00.000Z'),
    });
    check('🎯 2b) el corte NO toca la venta de entradas: sin menús, la compra se calcula igual',
      sinMenuTardio.totalPagado === 2 * PRECIO_ENTRADA && sinMenuTardio.cantidadMenus === 0,
      `total=${sinMenuTardio.totalPagado}`);

    let errCorte = null;
    try {
      validarMenu({
        cantidad: 1, cantidadMenus: 1, menuHabilitado: true, precioMenu: PRECIO_MENU,
        fechaEvento: F23, menuCorteHora: CORTE, ahora: new Date('2026-08-23T21:30:00.000Z'),
      });
    } catch (e) { errCorte = e; }
    check('2c) el error viaja con la hora de corte (el checkout la usa en el mensaje)',
      errCorte?.code === 'MENU_CORTE_PASADO' && errCorte?.menuCorteHora === CORTE,
      `code=${errCorte?.code} hora=${errCorte?.menuCorteHora}`);

    // ============================================================
    // BLOQUE 3 — 🔒 EL CAMINO DEL REQUEST (candado de R1)
    // ============================================================
    // El reloj acá es el real: lo que se mueve es la fecha del evento.
    {
      const { evento: evAyer } = await setupEvento({ dias: -1, sufijo: '3ayer' });

      const resMenu = await comprar(evAyer, { cantidad: 2, menus: 2 });
      const creadas = await prisma.compra.count({ where: { eventoId: evAyer.id } });
      check('🔒 3a) 🎯 controller: menú después del corte → 400 MENU_CORTE_PASADO y NINGUNA compra creada',
        resMenu.statusCode === 400 && resMenu.body?.code === 'MENU_CORTE_PASADO' && creadas === 0,
        `status=${resMenu.statusCode} code=${resMenu.body?.code} compras=${creadas}`);

      check('3b) el 400 devuelve la hora de corte en el body (el front arma el mensaje con eso)',
        resMenu.body?.menuCorteHora === CORTE, `menuCorteHora=${resMenu.body?.menuCorteHora}`);

      const resEntradas = await comprar(evAyer, { cantidad: 2, menus: 0 });
      const compraSolaId = resEntradas.body?.compra_id;
      const compraSola = compraSolaId
        ? await prisma.compra.findUnique({ where: { id: compraSolaId } })
        : null;
      check('🎯 3c) la MISMA fecha vende entradas sin menú: el corte cierra el menú, no el evento',
        resEntradas.statusCode === 200 && compraSola?.cantidadMenus === 0
        && compraSola?.totalPagado === 2 * PRECIO_ENTRADA,
        `status=${resEntradas.statusCode} total=${compraSola?.totalPagado}`);

      const { evento: evManana } = await setupEvento({ dias: 1, sufijo: '3manana' });
      const resFuturo = await comprar(evManana, { cantidad: 2, menus: 2 });
      const compraFuturo = resFuturo.body?.compra_id
        ? await prisma.compra.findUnique({ where: { id: resFuturo.body.compra_id } })
        : null;
      check('3d) antes del corte la venta de menú sigue funcionando (no se rompió nada)',
        resFuturo.statusCode === 200 && compraFuturo?.cantidadMenus === 2
        && compraFuturo?.totalPagado === 2 * PRECIO_ENTRADA + 2 * PRECIO_MENU,
        `status=${resFuturo.statusCode} menus=${compraFuturo?.cantidadMenus} total=${compraFuturo?.totalPagado}`);

      // Config rota: solo se llega editando la base a mano (la whitelist del CMS
      // no deja persistir esto). Fail-closed y con 400 explícito, no un 500.
      await setHome({ menuCorteHora: '99:99' });
      const { evento: evRoto } = await setupEvento({ dias: 30, sufijo: '3roto' });
      const resRoto = await comprar(evRoto, { cantidad: 1, menus: 1 });
      const creadasRoto = await prisma.compra.count({ where: { eventoId: evRoto.id } });
      check('🔒 3e) 🎯 hora de corte inválida en la base → 400 MENU_CORTE_INVALIDO, ninguna compra, y NO un 500',
        resRoto.statusCode === 400 && resRoto.body?.code === 'MENU_CORTE_INVALIDO' && creadasRoto === 0,
        `status=${resRoto.statusCode} code=${resRoto.body?.code} compras=${creadasRoto}`);

      const resRotoEntradas = await comprar(evRoto, { cantidad: 1, menus: 0 });
      check('3f) con la config rota, las entradas se siguen vendiendo',
        resRotoEntradas.statusCode === 200, `status=${resRotoEntradas.statusCode}`);
      await setHome({ menuCorteHora: CORTE });
    }

    // ============================================================
    // BLOQUE 4 — El checkout recibe el estado resuelto por el servidor
    // ============================================================
    {
      const { evento: evFuturo } = await setupEvento({ dias: 2, sufijo: '4futuro' });
      const { evento: evPasado } = await setupEvento({ dias: -1, sufijo: '4pasado' });
      const { evento: evSinMenu } = await setupEvento({ dias: 2, menuHabilitado: false, sufijo: '4sinmenu' });

      const resProximos = await call(eventosCtrl.getProximos);
      const pubFuturo = (resProximos.body || []).find((e) => e.id === evFuturo.id);
      const pubSinMenu = (resProximos.body || []).find((e) => e.id === evSinMenu.id);
      check('4a) el evento futuro sale abierto para el checkout (menuCerrado=false)',
        pubFuturo?.menuCerrado === false, `menuCerrado=${pubFuturo?.menuCerrado}`);
      check('4b) un evento sin menú nunca se marca cerrado (no se anuncia lo que no vende)',
        pubSinMenu?.menuCerrado === false, `menuCerrado=${pubSinMenu?.menuCerrado}`);

      // La fecha pasada ya no aparece en la portada (la filtra el umbral ART), así
      // que el caso "cerrado" se verifica por el endpoint del backoffice, que usa
      // exactamente la misma función.
      const resAdmin = await call(eventosCtrl.adminGetById, { params: { id: String(evPasado.id) } });
      check('4c) 🎯 pasado el corte, el evento viaja con menuCerrado=true',
        resAdmin.body?.menuCerrado === true, `menuCerrado=${resAdmin.body?.menuCerrado}`);

      await setHome({ menuCorteHora: '99:99' });
      const resRoto = await call(eventosCtrl.adminGetById, { params: { id: String(evFuturo.id) } });
      check('🔒 4d) con la hora de corte rota, el evento sale CERRADO y el endpoint no se cae (200)',
        resRoto.statusCode === 200 && resRoto.body?.menuCerrado === true,
        `status=${resRoto.statusCode} menuCerrado=${resRoto.body?.menuCerrado}`);
      await setHome({ menuCorteHora: CORTE });
    }

    // ============================================
    // RESULTADO
    // ============================================
    const failed = checks.filter((c) => !c.ok);
    const passed = checks.length - failed.length;
    console.log('');
    console.log('========================================');
    console.log(`Tests Corte horario del menú: ${passed}/${checks.length} OK`);
    console.log('========================================');
    if (failed.length) {
      console.log('');
      console.log('FALLAS:');
      for (const x of failed) {
        console.log(`  ✗ ${x.name}`);
        if (x.detail !== undefined) console.log('    detalle:', x.detail);
      }
      process.exitCode = 1;
    } else {
      console.log('Todos los checks verdes ✓');
    }
  } catch (err) {
    console.error('ERROR EN TESTS:', err);
    process.exitCode = 1;
  } finally {
    mpService.crearPreferencia = originalCrearPref;
    brevoService.enviarConfirmacion = originalEnviarConfirmacion;
    await restaurarHome();
    await cleanup();
    await prisma.$disconnect();
  }
}

main();
