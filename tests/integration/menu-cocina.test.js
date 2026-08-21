/**
 * Tests de integración — Lista de menús para la cocina (ítem 44, Sprint 7 · S4).
 *
 * Esta hoja ES el control de entrega: por decisión de producto del 16/8 no hay
 * segundo QR, en la puerta se tilda el papel. Y desde el hallazgo 📋 de R1 es
 * además lo único que hace verdadero al mail de confirmación, que ya le promete
 * al comprador "dá tu nombre y apellido — ya estás en la lista".
 *
 * LO QUE ESTOS TESTS PROTEGEN, en orden de lo que cuesta si falla:
 *
 *   BLOQUE 1 — 🔒 QUÉ CUENTA EL TOTAL. El número grande de la hoja tiene que ser
 *              la suma EXACTA de las filas que la hoja lista. Es el criterio de
 *              éxito de S4 y el candado contra el desvío 3 de S2: hay otro
 *              contador (`adminEventoStats.menus.cantidad`) que suena igual y
 *              mide PLATA (filtra `totalPagado > 0`). Usarlo acá haría cocinar
 *              de menos. Se prueba con un fixture sintético —una compra
 *              aprobada con menús y total 0— que hoy la app no puede producir
 *              pero que separa las dos definiciones.
 *   BLOQUE 2 — LOS NOMBRES. Sin apellido y nombre buscables la hoja no cierra la
 *              promesa del mail. Y sin email ni teléfono: va a la cocina, no a
 *              la administración, y el sistema guarda PII (Ley 25.326).
 *   BLOQUE 3 — EL ORDEN. Colación 'es' (ítem 40): SQLite compara bytes y manda
 *              "SANTORO" antes que "Abad". En una hoja que se busca a ojo bajo
 *              presión, eso la vuelve inusable.
 *   BLOQUE 4 — LOS PENDIENTES, con el criterio que cerró S3: ni ocultos ni
 *              sumados. Y las compras muertas (rechazada, cancelada, devuelta)
 *              fuera de las dos listas.
 *   BLOQUE 5 — EL INVARIANTE CON EL CUPO: aprobados + pendientes de la hoja ===
 *              lo que cuenta `contarMenusOcupados`, que es el número con el que
 *              el checkout corta la venta. Si divergen, la sede y el comprador
 *              están mirando dos realidades.
 *   BLOQUE 6 — LA HORA DE EMISIÓN y su lectura contra el corte de las 18:00.
 *
 * ⚠️ Igual que S3: el corte se prueba moviendo la FECHA DEL EVENTO (ayer vs
 * mañana), no la hora, porque por el camino del endpoint el reloj es el real y
 * no se inyecta. Un fixture "hoy + 5 minutos" fallaría solo cerca de medianoche.
 *
 * ⚠️ `Home` es config global de una sola fila: se pisa y se restaura en el
 * `finally`.
 *
 * No mockea Prisma: usa dev.db real y limpia con prefijo `menu-cocina-test-`.
 *
 * Uso local:
 *   node tests/integration/menu-cocina.test.js
 *
 * Exit codes: 0 = PASS, 1 = FAIL
 */

const prisma = require('../../src/utils/prisma');
const eventosCtrl = require('../../src/controllers/eventos.controller');
const { contarMenusOcupados } = require('../../src/services/precios.service');

const TEST_PREFIX = 'menu-cocina-test-';
const PRECIO_ENTRADA = 10000;
const PRECIO_MENU = 15000;
const CORTE = '18:00';
const DIA = 24 * 60 * 60 * 1000;

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

const hoja = (eventoId) => call(eventosCtrl.adminEventoMenus, { params: { id: String(eventoId) } });

// ---------- Home (config global) ----------
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
    homeOriginal = { id: home.id, menuCorteHora: home.menuCorteHora, precioMenu: home.precioMenu };
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
    const { id, ...datos } = homeOriginal;
    await prisma.home.update({ where: { id }, data: datos });
    homeOriginal = null;
  }
}

// ---------- fixtures ----------
async function cleanup() {
  const eventos = await prisma.evento.findMany({
    where: { nombre: { startsWith: TEST_PREFIX } },
    select: { id: true },
  });
  const eventoIds = eventos.map((e) => e.id);
  if (eventoIds.length === 0) return;

  const comprasTest = await prisma.compra.findMany({
    where: { eventoId: { in: eventoIds } },
    select: { id: true },
  });
  const compraIds = comprasTest.map((c) => c.id);

  await prisma.entrada.deleteMany({ where: { compraId: { in: compraIds } } });
  await prisma.compra.deleteMany({ where: { id: { in: compraIds } } });
  await prisma.tanda.deleteMany({ where: { eventoId: { in: eventoIds } } });
  await prisma.evento.deleteMany({ where: { id: { in: eventoIds } } });
}

let contadorEventos = 0;
async function setupEvento({ menuHabilitado = true, diasHastaEvento = 30 } = {}) {
  contadorEventos += 1;
  // Mediodía UTC, que es la convención con la que el proyecto guarda las fechas
  // de evento (y de la que depende el cálculo del corte).
  const base = new Date(Date.now() + diasHastaEvento * DIA);
  const fecha = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), 12, 0, 0));
  return prisma.evento.create({
    data: {
      nombre: `${TEST_PREFIX}${contadorEventos}`,
      descripcion: 'test',
      fecha,
      hora: '21:00',
      estaPublicado: true,
      menuHabilitado,
      tandas: { create: [{ nombre: 'Única', precio: PRECIO_ENTRADA, orden: 1, activa: true }] },
    },
  });
}

let contadorCompras = 0;
// Compra creada directo en la base: estos tests necesitan estados y apellidos
// puntuales (incluido uno que el checkout no puede producir), no el camino del
// checkout — ese ya lo cubren menu-checkout y menu-tope.
async function crearCompra(evento, {
  apellido, nombre = 'Ana', menus = 1, entradas = 2, estado = 'approved', total,
}) {
  contadorCompras += 1;
  const totalPagado = total === undefined
    ? entradas * PRECIO_ENTRADA + menus * PRECIO_MENU
    : total;
  return prisma.compra.create({
    data: {
      eventoId: evento.id,
      email: `cocina${contadorCompras}@test.invalid`,
      nombre,
      apellido,
      telefono: '2211234567',
      cantidadEntradas: entradas,
      precioUnitario: PRECIO_ENTRADA,
      totalPagado,
      cantidadMenus: menus,
      menuUnitario: menus > 0 ? PRECIO_MENU : 0,
      mpEstado: estado,
    },
  });
}

async function main() {
  try {
    await cleanup();
    await setHome({ precioMenu: PRECIO_MENU, menuCorteHora: CORTE });

    // ============================================
    // BLOQUE 1 — 🔒 QUÉ CUENTA EL TOTAL
    // ============================================
    {
      const ev = await setupEvento();
      await crearCompra(ev, { apellido: 'Ramírez', menus: 2, entradas: 3 });
      await crearCompra(ev, { apellido: 'Benítez', menus: 1, entradas: 1 });
      await crearCompra(ev, { apellido: 'Suárez', menus: 3, entradas: 4 });
      // Sin menú: no es de esta hoja.
      await crearCompra(ev, { apellido: 'Ledesma', menus: 0, entradas: 2 });

      const res = await hoja(ev.id);
      const b = res.body;

      check('1a) el endpoint responde 200 con la hoja',
        res.statusCode === 200 && Array.isArray(b?.aprobadas), `status=${res.statusCode}`);

      check('1b) el total son 6 menús (2+1+3), no 3 compras',
        b.totales.menusAprobados === 6, b.totales);

      check('1c) 🔒 el total es EXACTAMENTE la suma de las filas impresas',
        b.totales.menusAprobados === b.aprobadas.reduce((s, c) => s + c.cantidadMenus, 0),
        { total: b.totales.menusAprobados, filas: b.aprobadas.map((c) => c.cantidadMenus) });

      check('1d) la compra sin menús no aparece en la hoja',
        b.aprobadas.every((c) => c.apellido !== 'Ledesma') && b.aprobadas.length === 3,
        b.aprobadas.map((c) => c.apellido));

      check('1e) el conteo de compras acompaña al de menús',
        b.totales.comprasAprobadas === 3, b.totales);

      // 🔒 EL CANDADO DEL DESVÍO 3 DE S2 —────────────────────────────────────
      // Una compra aprobada, con menús, y totalPagado = 0. Hoy la app no la
      // puede producir (una invitación no lleva menús y el cupón no toca el
      // menú), pero es exactamente el estado donde las dos definiciones se
      // separan: el contador de PLATA filtra `totalPagado > 0` y no la ve; la
      // cocina tiene que cocinar ese plato igual. Si alguien "simplifica" este
      // endpoint derivándolo de `adminEventoStats.menus.cantidad`, este check
      // se pone en rojo.
      await crearCompra(ev, { apellido: 'Zalazar', menus: 2, entradas: 2, total: 0 });

      const res2 = await hoja(ev.id);
      const stats = await call(eventosCtrl.adminEventoStats, { params: { id: String(ev.id) } });

      check('1f) 🔒 la hoja cuenta el plato de una compra aprobada con total 0 (la cocina cocina cosas, no plata)',
        res2.body.totales.menusAprobados === 8,
        { hoja: res2.body.totales.menusAprobados, esperado: 8 });

      check('1g) 🔒 y el contador de PLATA no lo cuenta — son definiciones distintas, no el mismo número',
        stats.body.menus.cantidad === 6 && res2.body.totales.menusAprobados === 8,
        { plata: stats.body.menus.cantidad, platos: res2.body.totales.menusAprobados });

      check('1h) 🔒 con esa compra adentro, el total sigue siendo la suma de las filas',
        res2.body.totales.menusAprobados === res2.body.aprobadas.reduce((s, c) => s + c.cantidadMenus, 0),
        res2.body.aprobadas.map((c) => `${c.apellido}:${c.cantidadMenus}`));
    }

    // ============================================
    // BLOQUE 2 — LOS NOMBRES (y la PII que NO va)
    // ============================================
    {
      const ev = await setupEvento();
      await crearCompra(ev, { apellido: 'Pérez', nombre: 'Juan', menus: 2, entradas: 2 });

      const b = (await hoja(ev.id)).body;
      const fila = b.aprobadas[0];

      check('2a) la fila trae apellido y nombre (es lo que el mail promete)',
        fila.apellido === 'Pérez' && fila.nombre === 'Juan', fila);

      check('2b) la fila trae la cantidad de menús, para tildar de a uno',
        fila.cantidadMenus === 2, fila);

      check('2c) la fila NO trae email ni teléfono — la hoja va a la cocina, no a la administración',
        fila.email === undefined && fila.telefono === undefined, Object.keys(fila));

      check('2d) la hoja identifica el evento (nombre y fecha para el encabezado impreso)',
        b.evento?.nombre?.startsWith(TEST_PREFIX) && !!b.evento?.fecha, b.evento);

      check('2e) evento inexistente → 404, no una hoja vacía que parezca real',
        (await hoja(999999999)).statusCode === 404);

      const idMalo = await call(eventosCtrl.adminEventoMenus, { params: { id: 'abc' } });
      check('2f) id no numérico → 400',
        idMalo.statusCode === 400, `status=${idMalo.statusCode}`);
    }

    // ============================================
    // BLOQUE 3 — EL ORDEN (colación 'es', ítem 40)
    // ============================================
    {
      const ev = await setupEvento();
      // El orden binario de SQLite pondría SANTORO primero (S=83 < b=98) y
      // "diaz" al final de todo. El orden humano es otro.
      for (const ap of ['SANTORO', 'Abad', 'diaz', 'Ñandú', 'Díaz', 'Zurita']) {
        await crearCompra(ev, { apellido: ap, menus: 1, entradas: 1 });
      }

      const b = (await hoja(ev.id)).body;
      const orden = b.aprobadas.map((c) => c.apellido);

      check('3a) alfabético humano: Abad primero, SANTORO en su lugar, no al principio',
        orden[0] === 'Abad' && orden.indexOf('SANTORO') > 2, orden);

      check('3b) mayúsculas y acentos no parten el orden (diaz/Díaz juntos, después de Abad)',
        Math.abs(orden.indexOf('diaz') - orden.indexOf('Díaz')) === 1
        && orden.indexOf('diaz') > orden.indexOf('Abad'), orden);

      check('3c) la Ñ cae entre N y O, no al final',
        orden.indexOf('Ñandú') < orden.indexOf('SANTORO')
        && orden.indexOf('Ñandú') > orden.indexOf('Díaz'), orden);

      check('3d) Zurita último',
        orden[orden.length - 1] === 'Zurita', orden);

      // Estabilidad: dos homónimos no pueden intercambiarse entre dos
      // impresiones de la misma lista (el desempate es por id).
      const ev2 = await setupEvento();
      const c1 = await crearCompra(ev2, { apellido: 'Gómez', nombre: 'Ana', menus: 1 });
      const c2 = await crearCompra(ev2, { apellido: 'Gómez', nombre: 'Ana', menus: 1 });
      const a = (await hoja(ev2.id)).body.aprobadas.map((c) => c.id);
      const bb = (await hoja(ev2.id)).body.aprobadas.map((c) => c.id);
      check('3e) el orden es estable entre dos impresiones (desempate por id)',
        JSON.stringify(a) === JSON.stringify(bb) && a[0] === Math.min(c1.id, c2.id),
        { a, bb });
    }

    // ============================================
    // BLOQUE 4 — PENDIENTES Y COMPRAS MUERTAS
    // ============================================
    {
      const ev = await setupEvento();
      await crearCompra(ev, { apellido: 'Acosta', menus: 2, entradas: 2 });
      await crearCompra(ev, { apellido: 'Vera', nombre: 'Luis', menus: 3, entradas: 3, estado: 'pending' });
      await crearCompra(ev, { apellido: 'Nuñez', menus: 1, entradas: 1, estado: 'pending' });
      // Muertas: liberaron su cupo y no vienen a comer.
      await crearCompra(ev, { apellido: 'Rechazado', menus: 5, entradas: 5, estado: 'rejected' });
      await crearCompra(ev, { apellido: 'Cancelado', menus: 5, entradas: 5, estado: 'cancelled' });
      await crearCompra(ev, { apellido: 'Devuelto', menus: 5, entradas: 5, estado: 'refunded' });

      const b = (await hoja(ev.id)).body;

      check('4a) el total NO suma los pendientes (2, no 6)',
        b.totales.menusAprobados === 2, b.totales);

      check('4b) los pendientes NO se ocultan: van aparte, con nombre y cantidad',
        b.pendientes.length === 2
        && b.pendientes.some((c) => c.apellido === 'Vera' && c.cantidadMenus === 3),
        b.pendientes);

      check('4c) el resumen de pendientes trae compras Y platos (2 compras, 4 menús)',
        b.totales.comprasPendientes === 2 && b.totales.menusPendientes === 4, b.totales);

      check('4d) los pendientes están ordenados igual que los aprobados (Nuñez antes que Vera)',
        b.pendientes[0].apellido === 'Nuñez', b.pendientes.map((c) => c.apellido));

      const muertos = ['Rechazado', 'Cancelado', 'Devuelto'];
      const apareceMuerto = [...b.aprobadas, ...b.pendientes].some((c) => muertos.includes(c.apellido));
      check('4e) rechazadas, canceladas y devueltas no aparecen en ninguna de las dos listas',
        !apareceMuerto, [...b.aprobadas, ...b.pendientes].map((c) => c.apellido));

      // ============================================
      // BLOQUE 5 — EL INVARIANTE CON EL CUPO
      // ============================================
      const ocupados = await contarMenusOcupados(prisma, ev.id);
      check('5a) 🔒 aprobados + pendientes de la hoja === el cupo que corta la venta en el checkout',
        b.totales.menusAprobados + b.totales.menusPendientes === ocupados,
        { hoja: b.totales.menusAprobados + b.totales.menusPendientes, cupo: ocupados });
    }

    // ============================================
    // BLOQUE 6 — HORA DE EMISIÓN Y CORTE
    // ============================================
    {
      const evFuturo = await setupEvento({ diasHastaEvento: 30 });
      await crearCompra(evFuturo, { apellido: 'Ávila', menus: 1, entradas: 1 });
      const bFuturo = (await hoja(evFuturo.id)).body;

      const emitido = new Date(bFuturo.emitidoEn);
      check('6a) la hoja viene sellada con la hora del SERVIDOR, no la del navegador que imprime',
        !Number.isNaN(emitido.getTime()) && Math.abs(Date.now() - emitido.getTime()) < 60000,
        bFuturo.emitidoEn);

      check('6b) evento futuro → la hoja avisa que la lista todavía puede crecer',
        bFuturo.corte?.pasado === false && bFuturo.corte?.hora === CORTE, bFuturo.corte);

      const evPasado = await setupEvento({ diasHastaEvento: -2 });
      await crearCompra(evPasado, { apellido: 'Ávila', menus: 1, entradas: 1 });
      const bPasado = (await hoja(evPasado.id)).body;
      check('6c) evento pasado → la hoja avisa que la lista ya está cerrada',
        bPasado.corte?.pasado === true, bPasado.corte);

      // Config rota (solo se llega editando la base a mano). La cocina necesita
      // su hoja igual: se imprime sin afirmar un corte que no se puede calcular.
      await setHome({ menuCorteHora: '25:99' });
      const res = await hoja(evFuturo.id);
      check('6d) con la hora de corte rota, la hoja se imprime igual (200) y no afirma un corte inventado',
        res.statusCode === 200 && res.body.corte === null && res.body.aprobadas.length === 1,
        { status: res.statusCode, corte: res.body?.corte });
      await setHome({ menuCorteHora: CORTE });

      // Evento sin menú habilitado: la hoja existe pero no promete un corte.
      const evSinMenu = await setupEvento({ menuHabilitado: false });
      const bSinMenu = (await hoja(evSinMenu.id)).body;
      check('6e) evento sin menú habilitado → hoja vacía y sin corte, no un error',
        bSinMenu.aprobadas.length === 0 && bSinMenu.totales.menusAprobados === 0
        && bSinMenu.corte === null && bSinMenu.evento.menuHabilitado === false,
        bSinMenu.totales);
    }

    // ============================================
    // BLOQUE 7 — AISLAMIENTO POR EVENTO
    // ============================================
    {
      const evA = await setupEvento();
      const evB = await setupEvento();
      await crearCompra(evA, { apellido: 'DelEventoA', menus: 4, entradas: 4 });
      await crearCompra(evB, { apellido: 'DelEventoB', menus: 7, entradas: 7 });

      const bA = (await hoja(evA.id)).body;
      check('7a) la hoja de un evento no trae los menús del otro',
        bA.totales.menusAprobados === 4
        && bA.aprobadas.every((c) => c.apellido === 'DelEventoA'),
        bA.aprobadas.map((c) => c.apellido));
    }

    // ============================================
    // RESULTADO
    // ============================================
    const failed = checks.filter((c) => !c.ok);
    const passed = checks.length - failed.length;
    console.log('');
    console.log('========================================');
    console.log(`Tests Lista de cocina: ${passed}/${checks.length} OK`);
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
    await restaurarHome();
    await cleanup();
    await prisma.$disconnect();
  }
}

main();
