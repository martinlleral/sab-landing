/**
 * Tests de integración — venta de menú de Casa Metro (ítem 43a, Sprint 7).
 *
 * El menú es una CANTIDAD propia de la compra, ortogonal a `tipoEntrada`: no es
 * un tipo de entrada ni un flag. Estos tests cubren las cuatro cosas que pueden
 * salir mal y costar plata de verdad:
 *
 *   BLOQUE 1 — las 4 combinaciones base/aporte × con/sin menú, y que el menú no
 *              corra la semántica del Sprint 3 (tipoEntrada / excedenteUnitario).
 *   BLOQUE 2 — 🎯 EL TEST DEL ÍTEM: ningún cupón toca el menú, ni de porcentaje ni
 *              de monto. Un cupón que descuente el menú es plata que la coop le
 *              paga IGUAL a Casa Metro: con AMIGOS25 y 10 entradas con menú son
 *              $37.500 del bolsillo del SAB.
 *   BLOQUE 3 — las 3 reglas duras confirmadas por el operador el 17/8/2026:
 *              mínimo 1 entrada · menús ≤ entradas · nada de menú si el evento no
 *              lo tiene habilitado.
 *   BLOQUE 4 — persistencia real por `crearPreferencia` (precio congelado, ítem
 *              aparte en la preferencia de MP, invariante del webhook) y
 *              devolución: una compra con menús revertida deja todo en su lugar.
 *
 * Llama al controller con req/res mock y mockea `mpService.crearPreferencia` para
 * no llegar a MP real (CommonJS: el require comparte la misma instancia con el
 * controller, así que sobreescribir la propiedad acá afecta también al controller).
 *
 * ⚠️ `Home` es config global de una sola fila: los tests la pisan para fijar
 * `precioMenu` y la restauran en el `finally`.
 *
 * Uso local (con dev.db):
 *   node tests/integration/menu-checkout.test.js
 *
 * Exit codes: 0 = PASS, 1 = FAIL
 */

const prisma = require('../../src/utils/prisma');
const compras = require('../../src/controllers/compras.controller');
const mpService = require('../../src/services/mercadopago.service');
const { revertirCompraAprobada } = require('../../src/services/pagos.service');
const {
  calcularTotalCompra,
  validarMenu,
  TIPO_CUPON,
  TIPO_ENTRADA,
} = require('../../src/services/precios.service');

const TEST_PREFIX = 'menu-test-';
const PRECIO_MENU = 15000;

// ---------- mock de MP ----------
let mpCalls = [];
const originalCrearPref = mpService.crearPreferencia;
mpService.crearPreferencia = async (args) => {
  mpCalls.push(args);
  return { id: `mock-pref-${Date.now()}-${Math.random()}`, init_point: 'https://mock.invalid/pay' };
};

// ---------- helpers de HTTP mock ----------
function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

async function call(body) {
  const res = mockRes();
  await compras.crearPreferencia({ body }, res);
  return res;
}

// ---------- Home (config global de 1 fila) ----------
let homeOriginal = null;
let homeCreadoId = null;

async function setPrecioMenu(valor) {
  const home = await prisma.home.findFirst();
  if (!home) {
    const creado = await prisma.home.create({ data: { precioMenu: valor } });
    homeCreadoId = creado.id;
    return;
  }
  if (homeOriginal === null) homeOriginal = { id: home.id, precioMenu: home.precioMenu };
  await prisma.home.update({ where: { id: home.id }, data: { precioMenu: valor } });
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
      data: { precioMenu: homeOriginal.precioMenu },
    });
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

  const cupones = await prisma.cuponDescuento.findMany({
    where: { eventoId: { in: eventoIds } },
    select: { id: true },
  });
  const cuponIds = cupones.map((c) => c.id);

  const comprasTest = await prisma.compra.findMany({
    where: { eventoId: { in: eventoIds } },
    select: { id: true },
  });
  const compraIds = comprasTest.map((c) => c.id);

  await prisma.cuponUso.deleteMany({ where: { cuponId: { in: cuponIds } } });
  await prisma.cuponDescuento.deleteMany({ where: { id: { in: cuponIds } } });
  await prisma.entrada.deleteMany({ where: { compraId: { in: compraIds } } });
  await prisma.compra.deleteMany({ where: { id: { in: compraIds } } });
  await prisma.tanda.deleteMany({ where: { eventoId: { in: eventoIds } } });
  await prisma.evento.deleteMany({ where: { id: { in: eventoIds } } });
}

async function setupEvento({
  precio = 10000,
  porcentajeAporte = 0,
  menuHabilitado = false,
  topeMenus = null,
  capacidad = null,
  sufijo = '',
} = {}) {
  const evento = await prisma.evento.create({
    data: {
      nombre: `${TEST_PREFIX}${sufijo || Date.now()}`,
      descripcion: 'test',
      fecha: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      hora: '21:00',
      estaPublicado: true,
      menuHabilitado,
      topeMenus,
      tandas: {
        create: [{ nombre: 'Única', precio, orden: 1, activa: true, capacidad, porcentajeAporte }],
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
      codigo: overrides.codigo || `MENU${Date.now()}${Math.floor(Math.random() * 1000)}`,
      tipo: overrides.tipo || TIPO_CUPON.PORCENTAJE,
      valor: overrides.valor ?? 25,
      topeUsos: overrides.topeUsos ?? null,
      validoHasta: overrides.validoHasta ?? null,
      activo: overrides.activo ?? true,
    },
  });
}

function datosComprador(extra = {}) {
  return {
    email: `m${Date.now()}${Math.floor(Math.random() * 1000)}@test.invalid`,
    nombre: 'Test',
    apellido: 'Menú',
    telefono: '221',
    ...extra,
  };
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

function sumaItems(mpArgs) {
  const items = [{ unit_price: mpArgs.precio, quantity: mpArgs.cantidad }, ...(mpArgs.itemsExtra || [])];
  return items.reduce((acc, i) => acc + i.unit_price * i.quantity, 0);
}

async function main() {
  const checks = [];
  try {
    await cleanup();
    await setPrecioMenu(PRECIO_MENU);

    // ============================================================
    // BLOQUE 1 — Las 4 combinaciones base/aporte × con/sin menú
    // ============================================================

    const { tanda: tBase } = await setupEvento({ precio: 10000, menuHabilitado: true, sufijo: '1base' });
    const { tanda: tAporte } = await setupEvento({
      precio: 10000, porcentajeAporte: 30, menuHabilitado: true, sufijo: '1aporte',
    });

    const c1 = await calcularTotalCompra(tBase, {
      cantidad: 2, tipoEntrada: TIPO_ENTRADA.BASE, cantidadMenus: 0, menuHabilitado: true, precioMenu: PRECIO_MENU,
    });
    checks.push({
      name: '1a) base × SIN menú → 2 × $10k = $20k, menuUnitario congelado en 0',
      pass: c1.totalPagado === 20000 && c1.totales.menus === 0 && c1.cantidadMenus === 0 && c1.menuUnitario === 0,
      detail: JSON.stringify(c1.totales) + ` menuUnitario=${c1.menuUnitario}`,
    });

    const c2 = await calcularTotalCompra(tBase, {
      cantidad: 2, tipoEntrada: TIPO_ENTRADA.BASE, cantidadMenus: 1, menuHabilitado: true, precioMenu: PRECIO_MENU,
    });
    checks.push({
      name: '1b) base × CON menú → $20k entradas + $15k menú = $35k (1 menú para 2 entradas)',
      pass: c2.totales.entradas === 20000 && c2.totales.menus === 15000 && c2.totalPagado === 35000,
      detail: JSON.stringify(c2.totales),
    });

    const c3 = await calcularTotalCompra(tAporte, {
      cantidad: 2, tipoEntrada: TIPO_ENTRADA.APORTE, cantidadMenus: 0, menuHabilitado: true, precioMenu: PRECIO_MENU,
    });
    checks.push({
      name: '1c) aporte 30% × SIN menú → 2 × $13k = $26k (excedente $3k intacto)',
      pass: c3.totalPagado === 26000 && c3.excedenteUnitario === 3000 && c3.totales.menus === 0,
      detail: JSON.stringify(c3.totales) + ` excedente=${c3.excedenteUnitario}`,
    });

    const c4 = await calcularTotalCompra(tAporte, {
      cantidad: 2, tipoEntrada: TIPO_ENTRADA.APORTE, cantidadMenus: 2, menuHabilitado: true, precioMenu: PRECIO_MENU,
    });
    checks.push({
      name: '1d) aporte 30% × CON menú → $26k entradas + $30k menús = $56k',
      pass: c4.totales.entradas === 26000 && c4.totales.menus === 30000 && c4.totalPagado === 56000
        && c4.excedenteUnitario === 3000,
      detail: JSON.stringify(c4.totales) + ` excedente=${c4.excedenteUnitario}`,
    });

    checks.push({
      name: '🎯 1e) ORTOGONALIDAD: sumar menú NO corre tipoEntrada ni excedenteUnitario',
      pass: c1.tipoEntrada === c2.tipoEntrada && c1.excedenteUnitario === c2.excedenteUnitario
        && c3.tipoEntrada === c4.tipoEntrada && c3.excedenteUnitario === c4.excedenteUnitario
        && c2.precioUnitarioFinal === c1.precioUnitarioFinal
        && c4.precioUnitarioFinal === c3.precioUnitarioFinal,
      detail: `base: ${c1.tipoEntrada}/${c1.excedenteUnitario} vs ${c2.tipoEntrada}/${c2.excedenteUnitario} · `
        + `aporte: ${c3.tipoEntrada}/${c3.excedenteUnitario} vs ${c4.tipoEntrada}/${c4.excedenteUnitario}`,
    });

    // ============================================================
    // BLOQUE 2 — 🎯 EL TEST DEL ÍTEM: el cupón NO toca el menú
    // ============================================================

    await crearCupon(tBase.eventoId, { codigo: 'MENUAMIGOS25', tipo: TIPO_CUPON.PORCENTAJE, valor: 25 });

    // El caso de los $37.500: 10 entradas con menú y un 25 % de descuento.
    const cCupon = await calcularTotalCompra(tBase, {
      cantidad: 10, cantidadMenus: 10, cuponCodigo: 'MENUAMIGOS25',
      menuHabilitado: true, precioMenu: PRECIO_MENU,
    });
    checks.push({
      name: '🎯 2a) cupón 25% × 10 entradas × 10 menús → entradas $75k CON descuento, menús $150k SIN descuento',
      pass: cCupon.descuentoUnitario === 2500
        && cCupon.totales.entradas === 75000
        && cCupon.totales.menus === 150000
        && cCupon.totalPagado === 225000,
      detail: JSON.stringify(cCupon.totales) + ` (si el cupón tocara el menú: menus=112500, o sea $37.500 menos)`,
    });

    await crearCupon(tBase.eventoId, { codigo: 'MENUMONTO3K', tipo: TIPO_CUPON.MONTO, valor: 3000 });
    const cMonto = await calcularTotalCompra(tBase, {
      cantidad: 2, cantidadMenus: 2, cuponCodigo: 'MENUMONTO3K',
      menuHabilitado: true, precioMenu: PRECIO_MENU,
    });
    checks.push({
      name: '🎯 2b) cupón MONTO $3k → entradas 2 × $7k = $14k, menús $30k intactos',
      pass: cMonto.descuentoUnitario === 3000 && cMonto.totales.entradas === 14000
        && cMonto.totales.menus === 30000 && cMonto.totalPagado === 44000,
      detail: JSON.stringify(cMonto.totales),
    });

    await crearCupon(tBase.eventoId, { codigo: 'MENUGRATIS', tipo: TIPO_CUPON.MONTO, valor: 50000 });
    const cOverkill = await calcularTotalCompra(tBase, {
      cantidad: 1, cantidadMenus: 1, cuponCodigo: 'MENUGRATIS',
      menuHabilitado: true, precioMenu: PRECIO_MENU,
    });
    checks.push({
      name: '🎯 2c) cupón overkill ($50k sobre base $10k) → entrada $0, menú $15k ÍNTEGRO',
      pass: cOverkill.totales.entradas === 0 && cOverkill.totales.menus === 15000
        && cOverkill.totalPagado === 15000,
      detail: JSON.stringify(cOverkill.totales),
    });

    // Cupón + aporte + menú: los tres ejes a la vez, cada uno en su carril.
    await crearCupon(tAporte.eventoId, { codigo: 'MENUTRIPLE', tipo: TIPO_CUPON.PORCENTAJE, valor: 25 });
    const cTriple = await calcularTotalCompra(tAporte, {
      cantidad: 1, cantidadMenus: 1, tipoEntrada: TIPO_ENTRADA.APORTE, cuponCodigo: 'MENUTRIPLE',
      menuHabilitado: true, precioMenu: PRECIO_MENU,
    });
    checks.push({
      name: '🎯 2d) cupón 25% + aporte 30% + menú → base $7.5k + aporte $3k + menú $15k = $25.5k',
      pass: cTriple.descuentoUnitario === 2500 && cTriple.excedenteUnitario === 3000
        && cTriple.totales.entradas === 10500 && cTriple.totales.menus === 15000
        && cTriple.totalPagado === 25500,
      detail: JSON.stringify(cTriple.totales),
    });

    // El descuento no crece por sumar menús (blinda contra un futuro "descuento sobre el total").
    const sinMenu = await calcularTotalCompra(tBase, {
      cantidad: 2, cantidadMenus: 0, cuponCodigo: 'MENUAMIGOS25', menuHabilitado: true, precioMenu: PRECIO_MENU,
    });
    const conMenu = await calcularTotalCompra(tBase, {
      cantidad: 2, cantidadMenus: 2, cuponCodigo: 'MENUAMIGOS25', menuHabilitado: true, precioMenu: PRECIO_MENU,
    });
    checks.push({
      name: '🎯 2e) el descuento NO crece al sumar menús (mismo descuentoUnitario y mismas entradas)',
      pass: sinMenu.descuentoUnitario === conMenu.descuentoUnitario
        && sinMenu.totales.entradas === conMenu.totales.entradas
        && conMenu.totalPagado - sinMenu.totalPagado === 2 * PRECIO_MENU,
      detail: `desc=${sinMenu.descuentoUnitario}/${conMenu.descuentoUnitario} · `
        + `delta total=${conMenu.totalPagado - sinMenu.totalPagado} (esperado ${2 * PRECIO_MENU})`,
    });

    // ============================================================
    // BLOQUE 3 — Las 3 reglas duras (validador puro + controller)
    // ============================================================

    const errSuelto = await expectThrow(
      () => calcularTotalCompra(tBase, { cantidad: 0, cantidadMenus: 2, menuHabilitado: true, precioMenu: PRECIO_MENU }),
      'CANTIDAD_INVALIDA'
    );
    checks.push({ name: '🎯 3a) menú suelto (0 entradas, 2 menús) → throw CANTIDAD_INVALIDA', ...errSuelto });

    const errExceden = await expectThrow(
      () => calcularTotalCompra(tBase, { cantidad: 2, cantidadMenus: 3, menuHabilitado: true, precioMenu: PRECIO_MENU }),
      'MENUS_EXCEDEN_ENTRADAS'
    );
    checks.push({ name: '🎯 3b) 3 menús para 2 entradas → throw MENUS_EXCEDEN_ENTRADAS', ...errExceden });

    const errNoHab = await expectThrow(
      () => calcularTotalCompra(tBase, { cantidad: 2, cantidadMenus: 1, menuHabilitado: false, precioMenu: PRECIO_MENU }),
      'MENU_NO_HABILITADO'
    );
    checks.push({ name: '🎯 3c) evento con menuHabilitado=false → throw MENU_NO_HABILITADO', ...errNoHab });

    const errPrecio = await expectThrow(
      () => calcularTotalCompra(tBase, { cantidad: 1, cantidadMenus: 1, menuHabilitado: true, precioMenu: 0 }),
      'MENU_PRECIO_NO_CONFIGURADO'
    );
    checks.push({ name: '3d) menú habilitado con precio global en $0 → throw MENU_PRECIO_NO_CONFIGURADO', ...errPrecio });

    const errNeg = await expectThrow(
      () => validarMenu({ cantidad: 2, cantidadMenus: -1, menuHabilitado: true, precioMenu: PRECIO_MENU }),
      'MENUS_INVALIDO'
    );
    checks.push({ name: '3e) cantidadMenus negativa → throw MENUS_INVALIDO', ...errNeg });

    const errNaN = await expectThrow(
      () => validarMenu({ cantidad: 2, cantidadMenus: NaN, menuHabilitado: true, precioMenu: PRECIO_MENU }),
      'MENUS_INVALIDO'
    );
    checks.push({ name: '3f) cantidadMenus no numérica → throw MENUS_INVALIDO', ...errNaN });

    // Las mismas reglas, pero por el camino real (HTTP → controller → 400)
    const { evento: evSinMenu } = await setupEvento({ menuHabilitado: false, sufijo: '3sinmenu' });
    const resNoHab = await call(datosComprador({ eventoId: evSinMenu.id, cantidad: 2, cantidadMenus: 1 }));
    const comprasNoHab = await prisma.compra.count({ where: { eventoId: evSinMenu.id } });
    checks.push({
      name: '🎯 3g) controller: menú en evento sin menú → 400 MENU_NO_HABILITADO y NINGUNA compra creada',
      pass: resNoHab.statusCode === 400 && resNoHab.body?.code === 'MENU_NO_HABILITADO' && comprasNoHab === 0,
      detail: `status=${resNoHab.statusCode} code=${resNoHab.body?.code} compras=${comprasNoHab}`,
    });

    const { evento: evConMenu } = await setupEvento({ menuHabilitado: true, sufijo: '3conmenu' });
    const resExceden = await call(datosComprador({ eventoId: evConMenu.id, cantidad: 1, cantidadMenus: 2 }));
    checks.push({
      name: '🎯 3h) controller: 2 menús para 1 entrada → 400 MENUS_EXCEDEN_ENTRADAS',
      pass: resExceden.statusCode === 400 && resExceden.body?.code === 'MENUS_EXCEDEN_ENTRADAS',
      detail: `status=${resExceden.statusCode} code=${resExceden.body?.code}`,
    });

    // El "menú suelto" por la puerta real: `cantidad: '0'` es un string truthy, así
    // que pasa la guarda de campos requeridos del controller y llega al validador.
    const resSuelto = await call(datosComprador({ eventoId: evConMenu.id, cantidad: '0', cantidadMenus: 2 }));
    const comprasSuelto = await prisma.compra.count({ where: { eventoId: evConMenu.id } });
    checks.push({
      name: '🎯 3i) controller: 0 entradas + 2 menús → 400 CANTIDAD_INVALIDA y NINGUNA compra creada',
      pass: resSuelto.statusCode === 400 && resSuelto.body?.code === 'CANTIDAD_INVALIDA' && comprasSuelto === 0,
      detail: `status=${resSuelto.statusCode} code=${resSuelto.body?.code} compras=${comprasSuelto}`,
    });

    // REGRESIÓN: el body sin `cantidadMenus` (cliente viejo / evento sin menú) sigue funcionando.
    mpCalls = [];
    const resRegresion = await call(datosComprador({ eventoId: evSinMenu.id, cantidad: 2 }));
    const compraRegresion = resRegresion.body?.compra_id
      ? await prisma.compra.findUnique({ where: { id: resRegresion.body.compra_id } })
      : null;
    checks.push({
      name: '🎯 3j) REGRESIÓN: compra sin el campo cantidadMenus → 200, 0 menús, sin ítem extra en MP',
      pass: resRegresion.statusCode === 200 && compraRegresion?.cantidadMenus === 0
        && compraRegresion?.menuUnitario === 0 && compraRegresion?.totalPagado === 20000
        && mpCalls[0]?.itemsExtra === undefined,
      detail: `status=${resRegresion.statusCode} menus=${compraRegresion?.cantidadMenus} `
        + `total=${compraRegresion?.totalPagado} itemsExtra=${JSON.stringify(mpCalls[0]?.itemsExtra)}`,
    });

    // 🔒 CANDADO (R1). El check 3f de arriba llama a `validarMenu` DIRECTO y por eso
    // pasaba en verde aunque el camino real estuviera roto: el controller hace
    // `parseInt('dos')` → NaN, y `calcularTotalCompra` lo convertía en 0 con `|| 0`
    // ANTES de que el validador lo viera. Resultado: compra creada sin menús y sin
    // error, justo el estado que este sprint declara caro (una compra sin menú no
    // se arregla después). Los negativos sí se rechazaban, así que la validación
    // era inconsistente según por dónde entrara el número.
    // Estos dos checks cubren el hueco por las dos capas: la función que el
    // controller usa de verdad, y el 400 del endpoint.
    const errNaNTotal = await expectThrow(
      () => calcularTotalCompra(tBase, { cantidad: 2, cantidadMenus: NaN, menuHabilitado: true, precioMenu: PRECIO_MENU }),
      'MENUS_INVALIDO'
    );
    checks.push({ name: '🔒 3k) calcularTotalCompra con NaN → throw MENUS_INVALIDO (no lo pisa a 0)', ...errNaNTotal });

    const resBasura = await call(datosComprador({ eventoId: evConMenu.id, cantidad: 2, cantidadMenus: 'dos' }));
    const comprasBasura = await prisma.compra.count({ where: { eventoId: evConMenu.id } });
    checks.push({
      name: '🔒 3l) controller: cantidadMenus basura ("dos") → 400 MENUS_INVALIDO y NINGUNA compra creada',
      pass: resBasura.statusCode === 400 && resBasura.body?.code === 'MENUS_INVALIDO' && comprasBasura === 0,
      detail: `status=${resBasura.statusCode} code=${resBasura.body?.code} compras=${comprasBasura}`,
    });

    // ============================================================
    // BLOQUE 4 — Persistencia real + preferencia de MP + devolución
    // ============================================================

    const { evento: evFlujo, tanda: tFlujo } = await setupEvento({
      precio: 10000, menuHabilitado: true, sufijo: '4flujo',
    });

    mpCalls = [];
    const resCompra = await call(datosComprador({ eventoId: evFlujo.id, cantidad: 2, cantidadMenus: 2 }));
    const compraId = resCompra.body?.compra_id;
    const compraCreada = compraId ? await prisma.compra.findUnique({ where: { id: compraId } }) : null;

    checks.push({
      name: '🎯 4a) crearPreferencia persiste 2 menús a $15k y totalPagado = $20k + $30k = $50k',
      pass: resCompra.statusCode === 200 && compraCreada?.cantidadMenus === 2
        && compraCreada?.menuUnitario === PRECIO_MENU && compraCreada?.totalPagado === 50000,
      detail: `status=${resCompra.statusCode} menus=${compraCreada?.cantidadMenus} `
        + `menuUnitario=${compraCreada?.menuUnitario} total=${compraCreada?.totalPagado}`,
    });

    const argsMp = mpCalls[0] || {};
    checks.push({
      name: '🎯 4b) el menú viaja como ÍTEM APARTE en la preferencia de MP (plata diferenciada)',
      pass: Array.isArray(argsMp.itemsExtra) && argsMp.itemsExtra.length === 1
        && argsMp.itemsExtra[0].unit_price === PRECIO_MENU && argsMp.itemsExtra[0].quantity === 2
        && argsMp.precio === 10000 && argsMp.cantidad === 2,
      detail: `entrada=${argsMp.precio}×${argsMp.cantidad} · extra=${JSON.stringify(argsMp.itemsExtra)}`,
    });

    checks.push({
      name: '🎯 4c) INVARIANTE DEL WEBHOOK: suma de ítems de MP === compra.totalPagado',
      pass: sumaItems(argsMp) === compraCreada?.totalPagado,
      detail: `suma ítems=${sumaItems(argsMp)} vs totalPagado=${compraCreada?.totalPagado}`,
    });

    // Precio congelado: subir el global no reescribe la compra ya hecha.
    await setPrecioMenu(20000);
    const compraTrasSuba = await prisma.compra.findUnique({ where: { id: compraId } });
    const homeTrasSuba = await prisma.home.findFirst({ select: { precioMenu: true } });
    checks.push({
      name: '🎯 4d) PRECIO CONGELADO: subir Home.precioMenu a $20k no toca la compra ($15k)',
      pass: homeTrasSuba.precioMenu === 20000 && compraTrasSuba.menuUnitario === PRECIO_MENU
        && compraTrasSuba.totalPagado === 50000,
      detail: `global=${homeTrasSuba.precioMenu} compra.menuUnitario=${compraTrasSuba.menuUnitario}`,
    });
    await setPrecioMenu(PRECIO_MENU);

    // Aprobar a mano (como hace compras-devolucion.test.js: sin QR ni mail) y devolver.
    await prisma.compra.update({ where: { id: compraId }, data: { mpEstado: 'approved' } });
    await prisma.tanda.update({ where: { id: tFlujo.id }, data: { cantidadVendida: 2 } });

    const menusAprobadosAntes = await prisma.compra.aggregate({
      where: { eventoId: evFlujo.id, mpEstado: 'approved' },
      _sum: { cantidadMenus: true },
    });

    const rev = await revertirCompraAprobada(compraId, { revertidaPor: 'admin@test.invalid', motivo: 'test menú' });
    const compraTrasRev = await prisma.compra.findUnique({ where: { id: compraId } });
    const tandaTrasRev = await prisma.tanda.findUnique({ where: { id: tFlujo.id } });
    const menusAprobadosDespues = await prisma.compra.aggregate({
      where: { eventoId: evFlujo.id, mpEstado: 'approved' },
      _sum: { cantidadMenus: true },
    });

    checks.push({
      name: '🎯 4e) DEVOLUCIÓN: refunded + stock devuelto + reporta menus_devueltos=2',
      pass: rev.ok === true && compraTrasRev.mpEstado === 'refunded'
        && tandaTrasRev.cantidadVendida === 0 && rev.stock_devuelto === 2 && rev.menus_devueltos === 2,
      detail: `ok=${rev.ok} estado=${compraTrasRev.mpEstado} vendida=${tandaTrasRev.cantidadVendida} `
        + `menus_devueltos=${rev.menus_devueltos}`,
    });

    checks.push({
      name: '🎯 4f) los menús salen del conteo de aprobadas (2 → 0) pero la compra CONSERVA su historia',
      pass: (menusAprobadosAntes._sum.cantidadMenus || 0) === 2
        && (menusAprobadosDespues._sum.cantidadMenus || 0) === 0
        && compraTrasRev.cantidadMenus === 2 && compraTrasRev.menuUnitario === PRECIO_MENU,
      detail: `aprobados antes=${menusAprobadosAntes._sum.cantidadMenus} después=${menusAprobadosDespues._sum.cantidadMenus} · `
        + `en la compra siguen ${compraTrasRev.cantidadMenus} menús a $${compraTrasRev.menuUnitario}`,
    });

    // ============================================================
    // REPORT
    // ============================================================

    console.log('─'.repeat(72));
    console.log('Menú de Casa Metro — Test del backend de venta de menú (ítem 43a)');
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
      await restaurarHome();
    } catch (cleanupErr) {
      console.error('WARN cleanup:', cleanupErr.message);
    }
    mpService.crearPreferencia = originalCrearPref;
    await prisma.$disconnect();
    process.exit(process.exitCode || 0);
  }
}

main();
