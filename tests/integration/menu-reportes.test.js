/**
 * Tests de integración — Menú de la sede en reportes y backoffice (Sprint 7, S1b).
 *
 * Cubre EL hallazgo de S1a: `Compra.totalPagado` incluye la plata del menú (tiene
 * que incluirla — es lo que el comprador paga y lo que el webhook cruza contra MP),
 * y TODA la recaudación del backoffice se calcula sumando `totalPagado`. Sin restar
 * el menú, el SAB lee como propia plata que le tiene que pagar a la sede.
 *
 * Los 6 lugares donde se calculaba recaudación con SUM(totalPagado):
 *   1. dashboard.resumen           → KPI del dashboard + reporte público por token
 *   2. dashboard.ventasTimeline    → gráfico y acumulado (admin + token)
 *   3. dashboard.distribucionTandas→ por tanda (admin + token)
 *   4. dashboard.comparativaEventos→ tabla cross de reportes.html
 *   5. eventos.adminEventoStats    → boxes de evento-compras.html
 *   6. eventos.adminStatsGlobal    → KPI grande de dashboard.html
 *
 * Y las dos whitelists que hacen que el backoffice "guarde sin guardar":
 *   7. home.updateHome    → precioMenu
 *   8. eventos.adminEditar→ menuHabilitado
 *
 * El test que más muerde es el del PRECIO CONGELADO: una compra vieja con
 * menuUnitario=12000 tiene que seguir valiendo 12000 después de que el precio
 * global suba a 15000. Si algún reporte leyera `Home.precioMenu` en vez de
 * `Compra.menuUnitario`, ese check se pone en rojo.
 *
 * No mockea Prisma — usa dev.db real y limpia con prefijo `menu-rep-test-`
 * (mismo patrón que los demás tests de integración).
 *
 * Uso local:
 *   node tests/integration/menu-reportes.test.js
 */

const prisma = require('../../src/utils/prisma');
const dashboard = require('../../src/controllers/dashboard.controller');
const eventos = require('../../src/controllers/eventos.controller');
const home = require('../../src/controllers/home.controller');

const TEST_PREFIX = 'menu-rep-test-';

// Precios del fixture. PRECIO_MENU_VIEJO existe para probar el congelamiento:
// una compra hecha cuando el menú costaba 12.000 tiene que seguir valiendo eso.
const PRECIO_ENTRADA = 10000;
const PRECIO_MENU = 15000;
const PRECIO_MENU_VIEJO = 12000;

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

function mockReq({ query = {}, params = {}, body = {} } = {}) {
  return { query, params, body, files: undefined, file: undefined, session: {} };
}

async function call(handler, reqOpts = {}) {
  const res = mockRes();
  await handler(mockReq(reqOpts), res);
  return res;
}

async function cleanup() {
  const eventosTest = await prisma.evento.findMany({
    where: { nombre: { startsWith: TEST_PREFIX } },
    select: { id: true },
  });
  const eventoIds = eventosTest.map((e) => e.id);
  if (eventoIds.length === 0) return;

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

// ============================================
// SETUP
// ============================================
// Evento A (con menú): dos tandas.
//   T1 — porcentajeAporte 20:
//     cm1: 2 entradas base  + 2 menús a 15.000 → 20.000 + 30.000 = 50.000
//     cm2: 1 entrada aporte + 1 menú  a 15.000 → 12.000 + 15.000 = 27.000
//     cm4: pending, 1 entrada + 3 menús        → no cuenta como aprobado
//     cm5: refunded, 1 entrada + 2 menús       → no cuenta (la devolución libera solo)
//   T2 — sin aporte:
//     cm3: 1 entrada base, sin menú            → 10.000
//     cm6: 1 entrada base + 1 menú a 12.000    → 10.000 + 12.000 = 22.000  ← precio viejo
//
// Totales esperados del evento A (aprobadas con plata):
//   recaudado (cobrado por MP) = 50.000 + 27.000 + 10.000 + 22.000 = 109.000
//   menús                      = 3 × 15.000 + 1 × 12.000           =  57.000
//   aporteExtra                = 2.000 × 1                          =   2.000
//   base (entradas puras)      = 109.000 − 2.000 − 57.000           =  50.000
//   sab (queda a la coop)      = 109.000 − 57.000                   =  52.000
//   menús pendientes           = 3
//
// Evento B (sin menú): 1 compra de 5.000. Sirve de control: sus números no se mueven.
const ESPERADO = {
  recaudadoTotal: 109000,
  menusTotal: 57000,
  menusCantidad: 4,
  aporteExtra: 2000,
  base: 50000,
  sab: 52000,
  menusPendientes: 3,
  t1: { recaudado: 77000, menus: 45000, sab: 32000 },
  t2: { recaudado: 32000, menus: 12000, sab: 20000 },
};

async function setupFixture() {
  const evA = await prisma.evento.create({
    data: {
      nombre: `${TEST_PREFIX}ConMenu-${Date.now()}`,
      descripcion: 'Test menú',
      fecha: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      hora: '21:00',
      estaPublicado: true,
      menuHabilitado: true,
      tandas: {
        create: [
          { nombre: 'T1', precio: PRECIO_ENTRADA, orden: 1, activa: true, capacidad: 20, cantidadVendida: 3, porcentajeAporte: 20 },
          { nombre: 'T2', precio: PRECIO_ENTRADA, orden: 2, activa: true, capacidad: 20, cantidadVendida: 2, porcentajeAporte: 0 },
        ],
      },
    },
    include: { tandas: { orderBy: { orden: 'asc' } } },
  });
  const [t1, t2] = evA.tandas;

  const evB = await prisma.evento.create({
    data: {
      nombre: `${TEST_PREFIX}SinMenu-${Date.now()}`,
      descripcion: 'Test sin menú',
      fecha: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
      hora: '21:00',
      estaPublicado: true,
      tandas: {
        create: [{ nombre: 'TB', precio: 5000, orden: 1, activa: true, capacidad: 10, cantidadVendida: 1, porcentajeAporte: 0 }],
      },
    },
    include: { tandas: true },
  });
  const tb = evB.tandas[0];

  const ahora = new Date();
  ahora.setHours(15, 0, 0, 0);
  const ayer = new Date(ahora.getTime() - 24 * 60 * 60 * 1000);

  const base = (extra) => ({
    eventoId: evA.id,
    email: `${TEST_PREFIX}x@t.invalid`,
    nombre: 'Test',
    apellido: 'Menu',
    precioUnitario: PRECIO_ENTRADA,
    tipoEntrada: 'base',
    createdAt: ahora,
    ...extra,
  });

  // cm1 — 2 entradas base + 2 menús al precio vigente
  await prisma.compra.create({
    data: base({
      tandaId: t1.id, cantidadEntradas: 2, totalPagado: 50000, mpEstado: 'approved',
      cantidadMenus: 2, menuUnitario: PRECIO_MENU,
      entradas: { create: [
        { codigoQR: `qr-${TEST_PREFIX}cm1a`, qrImageUrl: '', validada: false },
        { codigoQR: `qr-${TEST_PREFIX}cm1b`, qrImageUrl: '', validada: false },
      ] },
    }),
  });

  // cm2 — aporte + menú: prueba que los dos ejes conviven en la misma compra
  await prisma.compra.create({
    data: base({
      tandaId: t1.id, cantidadEntradas: 1, totalPagado: 27000, mpEstado: 'approved',
      tipoEntrada: 'aporte', excedenteUnitario: 2000,
      cantidadMenus: 1, menuUnitario: PRECIO_MENU,
      entradas: { create: [{ codigoQR: `qr-${TEST_PREFIX}cm2`, qrImageUrl: '', validada: false }] },
    }),
  });

  // cm3 — sin menú (control)
  await prisma.compra.create({
    data: base({
      tandaId: t2.id, cantidadEntradas: 1, totalPagado: 10000, mpEstado: 'approved',
      entradas: { create: [{ codigoQR: `qr-${TEST_PREFIX}cm3`, qrImageUrl: '', validada: false }] },
    }),
  });

  // cm4 — pending con 3 menús: NO son plata cobrada, pero la cocina los tiene que ver
  await prisma.compra.create({
    data: base({
      tandaId: t1.id, cantidadEntradas: 3, totalPagado: 75000, mpEstado: 'pending',
      cantidadMenus: 3, menuUnitario: PRECIO_MENU,
    }),
  });

  // cm5 — devuelta con 2 menús: la liberación del cupo ocurre sola al salir de approved
  await prisma.compra.create({
    data: base({
      tandaId: t1.id, cantidadEntradas: 2, totalPagado: 50000, mpEstado: 'refunded',
      cantidadMenus: 2, menuUnitario: PRECIO_MENU, createdAt: ayer,
    }),
  });

  // cm6 — menú al PRECIO VIEJO. Es el check que distingue leer de la compra
  // (correcto) de leer del precio global (incorrecto).
  await prisma.compra.create({
    data: base({
      tandaId: t2.id, cantidadEntradas: 1, totalPagado: 22000, mpEstado: 'approved',
      cantidadMenus: 1, menuUnitario: PRECIO_MENU_VIEJO,
      entradas: { create: [{ codigoQR: `qr-${TEST_PREFIX}cm6`, qrImageUrl: '', validada: false }] },
    }),
  });

  // Evento B — control sin menús
  await prisma.compra.create({
    data: {
      eventoId: evB.id, tandaId: tb.id, email: `${TEST_PREFIX}b@t.invalid`,
      nombre: 'Test', apellido: 'SinMenu', cantidadEntradas: 1,
      precioUnitario: 5000, totalPagado: 5000, tipoEntrada: 'base',
      mpEstado: 'approved', createdAt: ahora,
      entradas: { create: [{ codigoQR: `qr-${TEST_PREFIX}b1`, qrImageUrl: '', validada: false }] },
    },
  });

  return { evA, evB, t1, t2 };
}

// ============================================
// MAIN
// ============================================
async function main() {
  const checks = [];
  function check(name, cond, detail) {
    if (cond) checks.push({ name, ok: true });
    else checks.push({ name, ok: false, detail });
  }

  // El precio global se toca en el bloque 7 (whitelist de updateHome): se guarda el
  // valor real para restaurarlo, porque dev.db es compartida entre suites.
  let homeOriginal = null;

  try {
    await cleanup();
    const f = await setupFixture();
    homeOriginal = await prisma.home.findFirst({ select: { id: true, precioMenu: true, menuCorteHora: true } });

    // ============================================
    // BLOQUE 1 — dashboard.resumen: la resta principal
    // ============================================
    {
      const r = await call(dashboard.resumen, { query: { eventoId: String(f.evA.id) } });
      check('resumen: status 200', r.statusCode === 200, r.statusCode);
      const b = r.body;

      check('resumen: total = 109000 (cobrado por MP, incluye menú)',
        b.recaudado.total === ESPERADO.recaudadoTotal, b.recaudado.total);
      check('resumen: menus = 57000',
        b.recaudado.menus === ESPERADO.menusTotal, b.recaudado.menus);
      check('resumen: sab = 52000 (total − menús)',
        b.recaudado.sab === ESPERADO.sab, b.recaudado.sab);
      check('resumen: base = 50000 (total − aporte − menús)',
        b.recaudado.base === ESPERADO.base, b.recaudado.base);
      check('resumen: aporteExtra = 2000 (el menú no lo tocó)',
        b.recaudado.aporteExtra === ESPERADO.aporteExtra, b.recaudado.aporteExtra);
      check('resumen: menus.cantidad = 4',
        b.menus.cantidad === ESPERADO.menusCantidad, b.menus.cantidad);

      // El invariante: las tres porciones tienen que sumar el total cobrado.
      check('resumen: base + aporte + menús = total',
        b.recaudado.base + b.recaudado.aporteExtra + b.recaudado.menus === b.recaudado.total,
        { base: b.recaudado.base, aporte: b.recaudado.aporteExtra, menus: b.recaudado.menus, total: b.recaudado.total });

      // 🔴 EL CHECK QUE MUERDE: si algún reporte leyera Home.precioMenu en vez de
      // Compra.menuUnitario, cm6 valdría 15.000 y el total daría 60.000.
      check('resumen: el menú se lee de la compra, NO del precio global (57000 ≠ 60000)',
        b.recaudado.menus === 57000 && b.recaudado.menus !== 4 * PRECIO_MENU, b.recaudado.menus);

      // Ni la compra pending ni la devuelta cuentan como plata de menú cobrada.
      check('resumen: pending y refunded NO suman al menú cobrado',
        b.recaudado.menus === ESPERADO.menusTotal, b.recaudado.menus);
    }

    // ============================================
    // BLOQUE 2 — resumen del evento SIN menú (control de no-regresión)
    // ============================================
    {
      const r = await call(dashboard.resumen, { query: { eventoId: String(f.evB.id) } });
      const b = r.body;
      check('resumen evB: total = 5000', b.recaudado.total === 5000, b.recaudado.total);
      check('resumen evB: menus = 0', b.recaudado.menus === 0, b.recaudado.menus);
      check('resumen evB: sab = total (sin menú no hay resta)',
        b.recaudado.sab === b.recaudado.total, { sab: b.recaudado.sab, total: b.recaudado.total });
      check('resumen evB: base = total − aporte (comportamiento previo intacto)',
        b.recaudado.base === b.recaudado.total - b.recaudado.aporteExtra, b.recaudado.base);
    }

    // ============================================
    // BLOQUE 3 — dashboard.ventasTimeline
    // ============================================
    {
      const r = await call(dashboard.ventasTimeline, { query: { eventoId: String(f.evA.id), granularidad: 'dia' } });
      check('timeline: status 200', r.statusCode === 200, r.statusCode);
      const b = r.body;

      const sumaRecaudado = b.data.reduce((s, x) => s + x.recaudado, 0);
      const sumaMenus = b.data.reduce((s, x) => s + x.menus, 0);
      const sumaSab = b.data.reduce((s, x) => s + x.recaudadoSab, 0);

      check('timeline: suma recaudado = 109000', sumaRecaudado === ESPERADO.recaudadoTotal, sumaRecaudado);
      check('timeline: suma menus = 57000', sumaMenus === ESPERADO.menusTotal, sumaMenus);
      check('timeline: suma recaudadoSab = 52000', sumaSab === ESPERADO.sab, sumaSab);

      const ultimo = b.data[b.data.length - 1];
      check('timeline: recaudadoSabAcumulado final = 52000',
        ultimo.recaudadoSabAcumulado === ESPERADO.sab, ultimo.recaudadoSabAcumulado);
      check('timeline: recaudadoAcumulado final = 109000 (el total sigue disponible)',
        ultimo.recaudadoAcumulado === ESPERADO.recaudadoTotal, ultimo.recaudadoAcumulado);
      check('timeline: recaudadoSabAcumulado <= recaudadoAcumulado en todos los periodos',
        b.data.every((x) => x.recaudadoSabAcumulado <= x.recaudadoAcumulado));
    }

    // ============================================
    // BLOQUE 4 — dashboard.distribucionTandas (se comparte por token)
    // ============================================
    {
      const r = await call(dashboard.distribucionTandas, { params: { id: String(f.evA.id) } });
      check('tandas: status 200', r.statusCode === 200, r.statusCode);
      const porNombre = Object.fromEntries(r.body.tandas.map((t) => [t.nombre, t]));

      check('tandas T1: recaudado = 77000', porNombre.T1.recaudado === ESPERADO.t1.recaudado, porNombre.T1.recaudado);
      check('tandas T1: menus = 45000', porNombre.T1.menus === ESPERADO.t1.menus, porNombre.T1.menus);
      check('tandas T1: recaudadoSab = 32000', porNombre.T1.recaudadoSab === ESPERADO.t1.sab, porNombre.T1.recaudadoSab);
      check('tandas T1: cantidadMenus = 3', porNombre.T1.cantidadMenus === 3, porNombre.T1.cantidadMenus);

      check('tandas T2: recaudado = 32000', porNombre.T2.recaudado === ESPERADO.t2.recaudado, porNombre.T2.recaudado);
      check('tandas T2: menus = 12000 (precio viejo congelado)',
        porNombre.T2.menus === ESPERADO.t2.menus, porNombre.T2.menus);
      check('tandas T2: recaudadoSab = 20000', porNombre.T2.recaudadoSab === ESPERADO.t2.sab, porNombre.T2.recaudadoSab);

      const sumaMenusTandas = r.body.tandas.reduce((s, t) => s + t.menus, 0);
      check('tandas: la suma de menús por tanda = el total del evento',
        sumaMenusTandas === ESPERADO.menusTotal, sumaMenusTandas);
    }

    // ============================================
    // BLOQUE 5 — dashboard.comparativaEventos
    // ============================================
    {
      const r = await call(dashboard.comparativaEventos);
      check('comparativa: status 200', r.statusCode === 200, r.statusCode);
      const rowA = r.body.eventos.find((e) => e.eventoId === f.evA.id);
      const rowB = r.body.eventos.find((e) => e.eventoId === f.evB.id);

      check('comparativa evA: recaudado = 109000', rowA.recaudado === ESPERADO.recaudadoTotal, rowA.recaudado);
      check('comparativa evA: menus = 57000', rowA.menus === ESPERADO.menusTotal, rowA.menus);
      check('comparativa evA: recaudadoSab = 52000', rowA.recaudadoSab === ESPERADO.sab, rowA.recaudadoSab);
      check('comparativa evA: cantidadMenus = 4', rowA.cantidadMenus === ESPERADO.menusCantidad, rowA.cantidadMenus);
      check('comparativa evB: menus = 0 y recaudadoSab = recaudado',
        rowB.menus === 0 && rowB.recaudadoSab === rowB.recaudado, { menus: rowB.menus, sab: rowB.recaudadoSab });
    }

    // ============================================
    // BLOQUE 6 — eventos.adminEventoStats y adminStatsGlobal
    // ============================================
    {
      const r = await call(eventos.adminEventoStats, { params: { id: String(f.evA.id) } });
      check('eventoStats: status 200', r.statusCode === 200, r.statusCode);
      const b = r.body;
      check('eventoStats: recaudado = 109000', b.recaudado === ESPERADO.recaudadoTotal, b.recaudado);
      check('eventoStats: recaudadoSab = 52000', b.recaudadoSab === ESPERADO.sab, b.recaudadoSab);
      check('eventoStats: menus.total = 57000', b.menus.total === ESPERADO.menusTotal, b.menus.total);
      check('eventoStats: menus.cantidad = 4', b.menus.cantidad === ESPERADO.menusCantidad, b.menus.cantidad);
      check('eventoStats: menus.pendientes = 3 (la cocina los tiene que ver)',
        b.menus.pendientes === ESPERADO.menusPendientes, b.menus.pendientes);

      const rg = await call(eventos.adminStatsGlobal);
      check('statsGlobal: status 200', rg.statusCode === 200, rg.statusCode);
      // Global incluye las compras de otras suites, así que se verifica la relación
      // (no el valor absoluto): el neto nunca puede ser mayor que el cobrado, y la
      // diferencia tiene que ser exactamente el menú.
      check('statsGlobal: recaudado − recaudadoSab = menus.total',
        rg.body.recaudado - rg.body.recaudadoSab === rg.body.menus.total,
        { recaudado: rg.body.recaudado, sab: rg.body.recaudadoSab, menus: rg.body.menus.total });
      check('statsGlobal: menus.total >= 57000 (los del fixture están contados)',
        rg.body.menus.total >= ESPERADO.menusTotal, rg.body.menus.total);
    }

    // ============================================
    // BLOQUE 7 — whitelist de updateHome: precioMenu se guarda de verdad
    // ============================================
    if (homeOriginal) {
      const nuevo = 18500;
      const r = await call(home.updateHome, { body: { precioMenu: String(nuevo) } });
      check('updateHome: status 200', r.statusCode === 200, r.statusCode);
      const fila = await prisma.home.findFirst({ select: { precioMenu: true } });
      check('updateHome: precioMenu PERSISTIDO (whitelist del destructuring)',
        fila.precioMenu === nuevo, fila.precioMenu);

      // 0 es válido: es la forma de apagar la venta de menú globalmente.
      await call(home.updateHome, { body: { precioMenu: '0' } });
      const fila0 = await prisma.home.findFirst({ select: { precioMenu: true } });
      check('updateHome: precioMenu = 0 se acepta (apaga la venta de menú)',
        fila0.precioMenu === 0, fila0.precioMenu);

      // Un valor inválido no debe pisar el que había.
      await call(home.updateHome, { body: { precioMenu: 'no-es-un-numero' } });
      const filaMal = await prisma.home.findFirst({ select: { precioMenu: true } });
      check('updateHome: un precioMenu inválido no pisa el valor guardado',
        filaMal.precioMenu === 0, filaMal.precioMenu);

      // Hora de corte del menú (S3). Misma whitelist, mismos tres casos que
      // `parseTopeMenus`, con una diferencia declarada: acá el vacío NO borra
      // nada (el campo es String NOT NULL; para vender hasta el final del día se
      // carga 23:59). Sin estos checks el campo "guarda" sin guardar y el corte
      // se queda en el default para siempre.
      await call(home.updateHome, { body: { menuCorteHora: '20:30' } });
      const filaHora = await prisma.home.findFirst({ select: { menuCorteHora: true } });
      check('updateHome: menuCorteHora PERSISTIDO (whitelist del destructuring)',
        filaHora.menuCorteHora === '20:30', filaHora.menuCorteHora);

      // "25:00" es el caso caro: una hora que no existe deja el checkout del menú
      // caído con MENU_CORTE_INVALIDO hasta que alguien lo note.
      await call(home.updateHome, { body: { menuCorteHora: '25:00' } });
      const filaMala = await prisma.home.findFirst({ select: { menuCorteHora: true } });
      check('updateHome: una hora imposible ("25:00") no pisa la guardada',
        filaMala.menuCorteHora === '20:30', filaMala.menuCorteHora);

      await call(home.updateHome, { body: { menuCorteHora: '' } });
      const filaVacia = await prisma.home.findFirst({ select: { menuCorteHora: true } });
      check('updateHome: vaciar el campo NO borra el corte (no hay "sin corte": es 23:59)',
        filaVacia.menuCorteHora === '20:30', filaVacia.menuCorteHora);

      await call(home.updateHome, { body: { textoEvento: 'otra cosa' } });
      const filaIntacta = await prisma.home.findFirst({ select: { menuCorteHora: true } });
      check('updateHome: editar otro campo no toca el corte',
        filaIntacta.menuCorteHora === '20:30', filaIntacta.menuCorteHora);

      // 🔴 El precio global cambió DOS veces y los reportes no se movieron: es lo
      // que garantiza menuUnitario congelado. Sin eso, subir el precio reescribiría
      // la contabilidad de las compras viejas.
      const rr = await call(dashboard.resumen, { query: { eventoId: String(f.evA.id) } });
      check('congelado: cambiar Home.precioMenu NO movió los reportes (sigue 57000)',
        rr.body.recaudado.menus === ESPERADO.menusTotal, rr.body.recaudado.menus);
    } else {
      check('updateHome: dev.db sin fila Home — bloque 7 no corrió', false, 'no hay Home en dev.db');
    }

    // ============================================
    // BLOQUE 8 — whitelist de adminEditar: menuHabilitado se guarda de verdad
    // ============================================
    {
      // Apagar: el caso que más se rompe, porque un checkbox desmarcado no viaja
      // en el FormData y hay que setearlo explícito del lado del cliente.
      const rOff = await call(eventos.adminEditar, {
        params: { id: String(f.evA.id) },
        body: { menuHabilitado: 'false' },
      });
      check('adminEditar: status 200 al apagar el menú', rOff.statusCode === 200, rOff.statusCode);
      const evOff = await prisma.evento.findUnique({ where: { id: f.evA.id }, select: { menuHabilitado: true } });
      check('adminEditar: menuHabilitado=false PERSISTIDO', evOff.menuHabilitado === false, evOff.menuHabilitado);

      const rOn = await call(eventos.adminEditar, {
        params: { id: String(f.evA.id) },
        body: { menuHabilitado: 'true' },
      });
      check('adminEditar: status 200 al encender el menú', rOn.statusCode === 200, rOn.statusCode);
      const evOn = await prisma.evento.findUnique({ where: { id: f.evA.id }, select: { menuHabilitado: true } });
      check('adminEditar: menuHabilitado=true PERSISTIDO', evOn.menuHabilitado === true, evOn.menuHabilitado);

      // Editar sin mandar el campo no lo debe tocar (los demás formularios del
      // backoffice no lo incluyen y no tienen que apagarlo de rebote).
      await call(eventos.adminEditar, { params: { id: String(f.evA.id) }, body: { invitado: 'Alguien' } });
      const evIntacto = await prisma.evento.findUnique({ where: { id: f.evA.id }, select: { menuHabilitado: true } });
      check('adminEditar: un edit que no manda menuHabilitado no lo cambia',
        evIntacto.menuHabilitado === true, evIntacto.menuHabilitado);
    }

    // ============================================
    // RESULTADO
    // ============================================
    const failed = checks.filter((c) => !c.ok);
    const passed = checks.length - failed.length;
    console.log('');
    console.log('========================================');
    console.log(`Tests Menú en reportes: ${passed}/${checks.length} OK`);
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
    // Restaurar el precio global real ANTES de limpiar: el bloque 7 lo movió y
    // dev.db la comparten todas las suites.
    if (homeOriginal) {
      await prisma.home.update({
        where: { id: homeOriginal.id },
        data: { precioMenu: homeOriginal.precioMenu, menuCorteHora: homeOriginal.menuCorteHora },
      });
    }
    await cleanup();
    await prisma.$disconnect();
  }
}

main();
