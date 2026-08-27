/**
 * Tests de integración — La reserva de cupo de menú VENCE (fix del 26/8/2026).
 *
 * EL BUG QUE ESTOS TESTS EXISTEN PARA QUE NO VUELVA:
 * el evento 28 (26/8, el primero con menú activo) llegó al día del show con el
 * checkout diciendo "menús agotados" y 29 menús vendidos sobre un tope de 50. Los
 * otros 21 cupos los retenían compras `pending` de gente que abrió el checkout y
 * nunca pagó. La regla original reservaba el cupo de TODO pendiente y confiaba en
 * el autocancel de 72 h para soltarlo — pero la venta del menú cierra a las 18:00
 * del día del evento: la reserva le sobrevivía al evento.
 *
 * ⚠️ POR QUÉ ESTE ARCHIVO ES NUEVO Y NO UN BLOQUE MÁS DE menu-tope.test.js:
 * cuando se escribió el fix, las 19 suites siguieron en verde. Ninguna veía la
 * diferencia, porque todas crean sus compras pendientes recién nacidas — y una
 * compra recién nacida reserva cupo en las dos versiones del código. Un test que
 * no distingue el código roto del arreglado no está protegiendo nada.
 *
 * LA REGLA, que es un OR de tres ramas INDEPENDIENTES (`whereMenuOcupado`):
 *   1. approved                          → siempre ocupa
 *   2. pending con mpPagoId              → ocupa sin vencimiento (Rapipago)
 *   3. pending reciente (< 30 min)       → ocupa hasta que vence
 *
 * Cada rama tiene abajo un check que se pone ROJO si se la saca sola. Eso es lo
 * que hace que la suite proteja la REGLA y no una línea: con dos guardas vivas,
 * romper una sola no se nota (ver insight_mutacion_por_regla_no_por_linea).
 *
 * BLOQUE 1 — la regla, rama por rama (in-memory y contra la base).
 * BLOQUE 2 — el bug real punta a punta: el checkout vuelve a vender.
 * BLOQUE 3 — lo que NO se puede perder al arreglarlo: la carrera de dos compras
 *            simultáneas por el último menú sigue frenada.
 * BLOQUE 4 — el botón de liberar cupo a mano, con su fail-closed.
 * BLOQUE 5 — la hoja de la cocina: el pendiente vencido se sigue VIENDO.
 *
 * ⚠️ NO se llama a `procesarPagoAprobado`: genera QR y dispara el mail por la
 * cuenta de Brevo del cliente. Para simular una compra pagada se escribe el
 * estado con Prisma. Igual se neutraliza brevo por las dudas.
 *
 * No mockea Prisma: usa dev.db real y limpia con prefijo `menu-vence-test-`.
 *
 * Uso local:
 *   node tests/integration/menu-reserva-vence.test.js
 *
 * Exit codes: 0 = PASS, 1 = FAIL
 */

const prisma = require('../../src/utils/prisma');
const config = require('../../src/config');
const compras = require('../../src/controllers/compras.controller');
const eventosCtrl = require('../../src/controllers/eventos.controller');
const mpService = require('../../src/services/mercadopago.service');
const brevoService = require('../../src/services/brevo.service');
const precios = require('../../src/services/precios.service');

const TEST_PREFIX = 'menu-vence-test-';
const PRECIO_ENTRADA = 10000;
const PRECIO_MENU = 7000;
const UNA_HORA = 60 * 60 * 1000;

// ---------- mocks de servicios externos ----------
const originalCrearPref = mpService.crearPreferencia;
mpService.crearPreferencia = async () => ({
  id: `mock-pref-${Date.now()}-${Math.random()}`,
  init_point: 'https://mock.invalid/pay',
});

// `buscarPagoPorCompra` se re-apunta por test (el bloque 4 necesita que MP diga
// cosas distintas). Default: MP no conoce ningún pago de esta compra.
const originalBuscarPago = mpService.buscarPagoPorCompra;
let respuestaMP = async () => [];
mpService.buscarPagoPorCompra = async (id) => respuestaMP(id);

const originalEnviarConfirmacion = brevoService.enviarConfirmacion;
brevoService.enviarConfirmacion = async () => {
  throw new Error('El test no debe enviar mails');
};

// ---------- helpers HTTP mock ----------
function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

async function call(handler, { body = {}, params = {}, query = {} } = {}) {
  const res = mockRes();
  await handler({ body, params, query, file: undefined, files: undefined, session: {} }, res);
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

let contadorEventos = 0;
async function setupEvento({ topeMenus = null, menuHabilitado = true, capacidad = null } = {}) {
  contadorEventos += 1;
  const evento = await prisma.evento.create({
    data: {
      nombre: `${TEST_PREFIX}${contadorEventos}`,
      descripcion: 'test',
      fecha: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      hora: '21:00',
      estaPublicado: true,
      menuHabilitado,
      topeMenus,
      tandas: {
        create: [{
          nombre: 'Única', precio: PRECIO_ENTRADA, orden: 1, activa: true, capacidad,
        }],
      },
    },
    include: { tandas: true },
  });
  return { evento, tanda: evento.tandas[0] };
}

let contadorCompradores = 0;
function datosComprador() {
  contadorCompradores += 1;
  return {
    email: `v${contadorCompradores}@test.invalid`,
    nombre: 'Test',
    apellido: `Vence${contadorCompradores}`,
    telefono: '221',
  };
}

async function comprar(evento, { cantidad = 1, menus = 1, cuponCodigo } = {}) {
  const body = {
    eventoId: evento.id, ...datosComprador(), cantidad, cantidadMenus: menus,
  };
  if (cuponCodigo) body.cuponCodigo = cuponCodigo;
  return call(compras.crearPreferencia, { body });
}

// Envejece una compra: la mueve N horas al pasado. Es el único helper que este
// archivo agrega sobre el molde de menu-tope, y es TODO el test — sin viajar en
// el tiempo, un pendiente siempre parece recién nacido y el bug no se ve.
async function envejecer(compraId, horas) {
  return prisma.compra.update({
    where: { id: compraId },
    data: { createdAt: new Date(Date.now() - horas * UNA_HORA) },
  });
}

async function marcarAprobada(compraId) {
  const compra = await prisma.compra.update({
    where: { id: compraId },
    data: { mpEstado: 'approved' },
  });
  if (compra.tandaId) {
    await prisma.tanda.update({
      where: { id: compra.tandaId },
      data: { cantidadVendida: { increment: compra.cantidadEntradas } },
    });
  }
  return compra;
}

// La compra que crea `crearPreferencia` para un evento dado, más reciente primero.
async function ultimaCompra(eventoId) {
  return prisma.compra.findFirst({
    where: { eventoId },
    orderBy: { id: 'desc' },
  });
}

async function main() {
  const checks = [];
  function check(name, cond, detail) {
    if (cond) checks.push({ name, ok: true });
    else checks.push({ name, ok: false, detail });
  }

  try {
    await cleanup();
    await setPrecioMenu(PRECIO_MENU);

    // ============================================
    // BLOQUE 1 — La regla, rama por rama
    // ============================================
    // Primero en memoria (`compraOcupaMenu`), que es la gemela que usan las
    // listas del backoffice. Si esta y `whereMenuOcupado` dijeran cosas
    // distintas, el operador vería un número y el checkout aplicaría otro — que
    // es exactamente el problema que el fix vino a cerrar, no a mover de lugar.
    {
      const ahora = new Date();
      const recien = new Date(ahora.getTime() - 5 * 60 * 1000);
      const viejo = new Date(ahora.getTime() - 2 * UNA_HORA);

      check('1a) approved viejo: ocupa cupo igual (el pago no vence)',
        precios.compraOcupaMenu({ mpEstado: 'approved', mpPagoId: '123', createdAt: viejo }, ahora) === true);

      check('1b) 🎯 pending reciente sin pago en MP: ocupa (alguien está pagando ahora)',
        precios.compraOcupaMenu({ mpEstado: 'pending', mpPagoId: '', createdAt: recien }, ahora) === true);

      check('1c) 🎯 pending VIEJO sin pago en MP: NO ocupa (es el bug del 26/8)',
        precios.compraOcupaMenu({ mpEstado: 'pending', mpPagoId: '', createdAt: viejo }, ahora) === false);

      check('1d) 🎯 pending viejo CON pago en MP: ocupa (cupón de Rapipago sin acreditar)',
        precios.compraOcupaMenu({ mpEstado: 'pending', mpPagoId: '99887', createdAt: viejo }, ahora) === true);

      check('1e) cancelled reciente: no ocupa',
        precios.compraOcupaMenu({ mpEstado: 'cancelled', mpPagoId: '', createdAt: recien }, ahora) === false);

      check('1f) el borde exacto de la ventana cuenta como adentro',
        precios.compraOcupaMenu({
          mpEstado: 'pending',
          mpPagoId: '',
          createdAt: new Date(ahora.getTime() - precios.MENU_RESERVA_MINUTOS * 60 * 1000),
        }, ahora) === true);
    }

    // Ahora contra la base, que es lo que corta la venta de verdad.
    {
      const { evento } = await setupEvento({ topeMenus: 10 });

      const r1 = await comprar(evento, { cantidad: 2, menus: 2 });
      const cPend = await ultimaCompra(evento.id);
      const r2 = await comprar(evento, { cantidad: 3, menus: 3 });
      const cVieja = await ultimaCompra(evento.id);
      const r3 = await comprar(evento, { cantidad: 1, menus: 1 });
      const cRapipago = await ultimaCompra(evento.id);

      check('1g) las tres compras entraron', r1.statusCode === 200 && r2.statusCode === 200 && r3.statusCode === 200,
        `status=${r1.statusCode}/${r2.statusCode}/${r3.statusCode}`);

      const ocupadosAntes = await precios.contarMenusOcupados(prisma, evento.id);
      check('1h) recién compradas, los 6 menús ocupan cupo', ocupadosAntes === 6, `ocupados=${ocupadosAntes}`);

      // Envejecemos dos: una queda abandonada, la otra tiene su pago en MP.
      await envejecer(cVieja.id, 2);
      await envejecer(cRapipago.id, 2);
      await prisma.compra.update({ where: { id: cRapipago.id }, data: { mpPagoId: '99887' } });

      const ocupadosDespues = await precios.contarMenusOcupados(prisma, evento.id);
      check('1i) 🎯 pasadas 2 h, la abandonada suelta sus 3 menús y las otras siguen',
        ocupadosDespues === 3, `ocupados=${ocupadosDespues} (esperado 3: 2 recientes + 1 rapipago)`);

      check('1j) la compra abandonada NO se borró ni cambió de estado — sólo dejó de reservar',
        (await prisma.compra.findUnique({ where: { id: cVieja.id } })).mpEstado === 'pending');
      void cPend;
    }

    // La rama Rapipago, sola y contra la base. Va aparte porque es la única que
    // NO tiene vencimiento: si alguien la saca creyendo que simplifica la regla,
    // el daño no es un cupo de más — es una persona que pagó su cupón en el kiosco
    // y se encuentra con que le vendieron el lugar. Este check existe para que esa
    // rama tenga su propio candado y no dependa del conteo mixto de arriba.
    {
      const { evento } = await setupEvento({ topeMenus: 2 });

      await comprar(evento, { cantidad: 2, menus: 2 });
      const rapipago = await ultimaCompra(evento.id);
      await envejecer(rapipago.id, 6);
      await prisma.compra.update({ where: { id: rapipago.id }, data: { mpPagoId: '123456' } });

      const ocupados = await precios.contarMenusOcupados(prisma, evento.id);
      check('1k) 🎯 6 h después, el cupón de Rapipago sin acreditar SIGUE reservando',
        ocupados === 2, `ocupados=${ocupados} (esperado 2)`);

      const rIntruso = await comprar(evento, { cantidad: 1, menus: 1 });
      check('1l) 🎯 y el checkout no le vende su lugar a otro',
        rIntruso.statusCode === 400, `status=${rIntruso.statusCode}`);
    }

    // ============================================
    // BLOQUE 2 — El bug real, punta a punta
    // ============================================
    // Reproduce en chico el evento 28: el tope lleno de pendientes abandonados,
    // el checkout diciendo "agotados" y alguien con la plata en la mano.
    {
      const { evento } = await setupEvento({ topeMenus: 3 });

      const rAbandono = await comprar(evento, { cantidad: 3, menus: 3 });
      const abandonada = await ultimaCompra(evento.id);
      check('2a) la primera compra toma los 3 menús del tope', rAbandono.statusCode === 200);

      const rBloqueada = await comprar(evento, { cantidad: 1, menus: 1 });
      check('2b) con el cupo tomado, el checkout NO vende (esto está bien)',
        rBloqueada.statusCode === 400, `status=${rBloqueada.statusCode}`);

      const resAntes = await call(eventosCtrl.getProximos);
      const evAntes = (resAntes.body || []).find((e) => e.id === evento.id);
      check('2c) y la portada dice 0 restantes', evAntes && evAntes.menusRestantes === 0,
        `menusRestantes=${evAntes && evAntes.menusRestantes}`);

      // Pasan dos horas. Nadie pagó.
      await envejecer(abandonada.id, 2);

      const resDespues = await call(eventosCtrl.getProximos);
      const evDespues = (resDespues.body || []).find((e) => e.id === evento.id);
      check('2d) 🎯 vencida la reserva, la portada vuelve a mostrar los 3 cupos',
        evDespues && evDespues.menusRestantes === 3,
        `menusRestantes=${evDespues && evDespues.menusRestantes}`);

      const rVende = await comprar(evento, { cantidad: 2, menus: 2 });
      check('2e) 🎯 y el checkout VENDE — que es la plata que el 26/8 se perdió',
        rVende.statusCode === 200, `status=${rVende.statusCode} body=${JSON.stringify(rVende.body)}`);
    }

    // ============================================
    // BLOQUE 3 — Lo que NO se puede perder al arreglarlo
    // ============================================
    // Contar sólo `approved` (la solución más obvia, y la que pidió el cliente)
    // habría arreglado el bloque 2 y roto ESTO: dos personas comprando el último
    // menú al mismo tiempo con tarjeta pasan las dos por `pending` durante unos
    // segundos. Sin la rama "reciente", ninguna de las dos vería a la otra.
    {
      const { evento } = await setupEvento({ topeMenus: 2 });

      const r1 = await comprar(evento, { cantidad: 2, menus: 2 });
      check('3a) la primera se lleva los 2 menús', r1.statusCode === 200);

      const r2 = await comprar(evento, { cantidad: 1, menus: 1 });
      check('3b) 🎯 la segunda, segundos después, es rechazada — la reserva reciente sigue valiendo',
        r2.statusCode === 400, `status=${r2.statusCode} body=${JSON.stringify(r2.body)}`);

      const ocupados = await precios.contarMenusOcupados(prisma, evento.id);
      check('3c) y no quedó una compra fantasma: el rollback dejó el cupo en 2',
        ocupados === 2, `ocupados=${ocupados}`);
    }

    // ============================================
    // BLOQUE 4 — El botón de liberar cupo a mano
    // ============================================
    {
      const { evento } = await setupEvento({ topeMenus: 20 });

      // 4a) Una aprobada no se libera ni por accidente.
      await comprar(evento, { cantidad: 1, menus: 1 });
      const aprobada = await ultimaCompra(evento.id);
      await marcarAprobada(aprobada.id);
      respuestaMP = async () => [];
      const rAprob = await call(compras.adminLiberarCupo, { params: { id: String(aprobada.id) } });
      check('4a) liberar una compra aprobada: 400 y no la toca',
        rAprob.statusCode === 400 && rAprob.body?.code === 'NOT_PENDING',
        `status=${rAprob.statusCode} body=${JSON.stringify(rAprob.body)}`);

      // 4b) Con mpPagoId ya escrito por el cron, ni se le pregunta a MP.
      await comprar(evento, { cantidad: 1, menus: 1 });
      const conPago = await ultimaCompra(evento.id);
      await prisma.compra.update({ where: { id: conPago.id }, data: { mpPagoId: '4455' } });
      let leProbenAMP = false;
      respuestaMP = async () => { leProbenAMP = true; return []; };
      const rConPago = await call(compras.adminLiberarCupo, { params: { id: String(conPago.id) } });
      check('4b) 🎯 pago en curso conocido: 409 y NO se cancela',
        rConPago.statusCode === 409 && rConPago.body?.code === 'PAGO_EN_CURSO',
        `status=${rConPago.statusCode} body=${JSON.stringify(rConPago.body)}`);
      check('4c) y ni siquiera se le preguntó a MP (el dato ya estaba)', leProbenAMP === false);

      // 4d) El cron todavía no pasó, pero MP sí tiene un pago vivo.
      await comprar(evento, { cantidad: 1, menus: 1 });
      const pagandoAhora = await ultimaCompra(evento.id);
      respuestaMP = async () => ([{
        id: 777001,
        status: 'pending',
        collector_id: config.mercadopago.userId || 'x',
        transaction_amount: pagandoAhora.totalPagado,
      }]);
      const rPagando = await call(compras.adminLiberarCupo, { params: { id: String(pagandoAhora.id) } });
      check('4d) 🎯 MP informa un pago pending: 409 (el cupón de Rapipago se respeta)',
        rPagando.statusCode === 409 && rPagando.body?.code === 'PAGO_EN_CURSO',
        `status=${rPagando.statusCode} body=${JSON.stringify(rPagando.body)}`);
      check('4e) y la compra sigue pending',
        (await prisma.compra.findUnique({ where: { id: pagandoAhora.id } })).mpEstado === 'pending');

      // 4f) MP no contesta → fail-closed. Es la diferencia entre "no sé" y "no hay".
      respuestaMP = async () => { throw new Error('ECONNRESET'); };
      const rSinMP = await call(compras.adminLiberarCupo, { params: { id: String(pagandoAhora.id) } });
      check('4f) 🎯 MP caído: 503 y la compra NO se cancela (fail-closed)',
        rSinMP.statusCode === 503 && rSinMP.body?.code === 'MP_NO_DISPONIBLE',
        `status=${rSinMP.statusCode} body=${JSON.stringify(rSinMP.body)}`);
      check('4g) sigue pending después del 503',
        (await prisma.compra.findUnique({ where: { id: pagandoAhora.id } })).mpEstado === 'pending');

      // 4h) Camino feliz: nadie está pagando, se libera.
      await comprar(evento, { cantidad: 4, menus: 4 });
      const abandonada = await ultimaCompra(evento.id);
      const ocupadosPrevios = await precios.contarMenusOcupados(prisma, evento.id);
      respuestaMP = async () => [];
      const rLibera = await call(compras.adminLiberarCupo, { params: { id: String(abandonada.id) } });
      check('4h) 🎯 sin pago en MP: libera y dice cuántos menús soltó',
        rLibera.statusCode === 200 && rLibera.body?.ok === true && rLibera.body?.menusLiberados === 4,
        `status=${rLibera.statusCode} body=${JSON.stringify(rLibera.body)}`);

      const trasLiberar = await prisma.compra.findUnique({ where: { id: abandonada.id } });
      check('4i) la compra quedó cancelled, NO borrada (queda el rastro de quién intentó comprar)',
        trasLiberar !== null && trasLiberar.mpEstado === 'cancelled',
        `estado=${trasLiberar && trasLiberar.mpEstado}`);

      const ocupadosPost = await precios.contarMenusOcupados(prisma, evento.id);
      check('4j) y los 4 menús volvieron al pool',
        ocupadosPost === ocupadosPrevios - 4, `antes=${ocupadosPrevios} despues=${ocupadosPost}`);

      // 4k) Idempotente: el cron y el operador pueden pisarse sin romper nada.
      const rOtraVez = await call(compras.adminLiberarCupo, { params: { id: String(abandonada.id) } });
      check('4k) liberar dos veces no rompe ni miente sobre lo que hizo',
        rOtraVez.statusCode === 400 && rOtraVez.body?.code === 'NOT_PENDING',
        `status=${rOtraVez.statusCode} body=${JSON.stringify(rOtraVez.body)}`);

      // 4l) `forzar` es la salida del operador que ya miró y decidió.
      await comprar(evento, { cantidad: 1, menus: 1 });
      const forzada = await ultimaCompra(evento.id);
      await prisma.compra.update({ where: { id: forzada.id }, data: { mpPagoId: '5566' } });
      const rForzada = await call(compras.adminLiberarCupo, {
        params: { id: String(forzada.id) },
        body: { forzar: true },
      });
      check('4l) forzar: saltea la guarda y libera igual',
        rForzada.statusCode === 200 && rForzada.body?.forzado === true,
        `status=${rForzada.statusCode} body=${JSON.stringify(rForzada.body)}`);
    }

    // 4m) El cupón de descuento también vuelve al pool.
    {
      const { evento } = await setupEvento({ topeMenus: 10 });
      const cupon = await prisma.cuponDescuento.create({
        data: {
          codigo: `${TEST_PREFIX}CUP`.toUpperCase().slice(0, 20),
          tipo: 'porcentaje',
          valor: 10,
          eventoId: evento.id,
          topeUsos: 1,
          usosActuales: 0,
          activo: true,
        },
      });
      const rCompra = await comprar(evento, { cantidad: 1, menus: 1, cuponCodigo: cupon.codigo });
      check('4m-pre) la compra con cupón entró', rCompra.statusCode === 200,
        `status=${rCompra.statusCode} body=${JSON.stringify(rCompra.body)}`);

      const usoTras = await prisma.cuponDescuento.findUnique({ where: { id: cupon.id } });
      const conCupon = await ultimaCompra(evento.id);
      respuestaMP = async () => [];
      const rLib = await call(compras.adminLiberarCupo, { params: { id: String(conCupon.id) } });
      const cuponFinal = await prisma.cuponDescuento.findUnique({ where: { id: cupon.id } });
      check('4m) 🎯 liberar el cupo devuelve también el uso del cupón',
        rLib.statusCode === 200 && usoTras.usosActuales === 1 && cuponFinal.usosActuales === 0,
        `status=${rLib.statusCode} usos_antes=${usoTras.usosActuales} usos_despues=${cuponFinal.usosActuales}`);
    }

    // ============================================
    // BLOQUE 5 — La hoja de la cocina sigue mostrando al vencido
    // ============================================
    // Que una compra deje de reservar NO significa que deje de existir. El
    // operador tiene que poder verla (para llamar a esa persona, o para liberarla
    // a mano). Si el vencido desapareciera de la pantalla, habríamos cambiado un
    // problema visible por uno invisible.
    {
      const { evento } = await setupEvento({ topeMenus: 10 });

      await comprar(evento, { cantidad: 2, menus: 2 });
      const reciente = await ultimaCompra(evento.id);
      await comprar(evento, { cantidad: 3, menus: 3 });
      const vencida = await ultimaCompra(evento.id);
      await envejecer(vencida.id, 5);

      const res = await call(eventosCtrl.adminEventoMenus, { params: { id: String(evento.id) } });
      const pend = res.body?.pendientes || [];

      check('5a) las dos pendientes se siguen viendo en la hoja',
        pend.length === 2, `pendientes=${pend.length}`);

      const filaReciente = pend.find((c) => c.id === reciente.id);
      const filaVencida = pend.find((c) => c.id === vencida.id);

      check('5b) 🎯 la reciente está marcada como que reserva cupo',
        filaReciente && filaReciente.reservaCupo === true,
        `reservaCupo=${filaReciente && filaReciente.reservaCupo}`);

      check('5c) 🎯 la vencida está marcada como que YA NO reserva',
        filaVencida && filaVencida.reservaCupo === false,
        `reservaCupo=${filaVencida && filaVencida.reservaCupo}`);

      check('5d) el total de pendientes los cuenta a los dos (5 menús)',
        res.body?.totales?.menusPendientes === 5, `menusPendientes=${res.body?.totales?.menusPendientes}`);

      check('5e) 🎯 pero el total que RESERVA cuenta sólo 2 — y ese cuadra con el cupo',
        res.body?.totales?.menusPendientesReservando === 2,
        `menusPendientesReservando=${res.body?.totales?.menusPendientesReservando}`);

      // El invariante que hace legible el contador del backoffice: lo que la
      // pantalla afirma tiene que ser lo mismo que corta la venta.
      const ocupados = await precios.contarMenusOcupados(prisma, evento.id);
      const aprobados = res.body?.totales?.menusAprobados || 0;
      check('5f) 🎯 invariante: aprobados + pendientes_que_reservan === ocupados',
        aprobados + res.body.totales.menusPendientesReservando === ocupados,
        `${aprobados} + ${res.body?.totales?.menusPendientesReservando} !== ${ocupados}`);

      check('5g) la hoja no filtra PII a la cocina (sin email ni teléfono)',
        pend.every((c) => c.email === undefined && c.telefono === undefined));
    }

    // ============================================
    // RESULTADO
    // ============================================
    const failed = checks.filter((c) => !c.ok);
    const passed = checks.length - failed.length;
    console.log('');
    console.log('========================================');
    console.log(`Tests Reserva de menú que vence: ${passed}/${checks.length} OK`);
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
    mpService.buscarPagoPorCompra = originalBuscarPago;
    brevoService.enviarConfirmacion = originalEnviarConfirmacion;
    await restaurarHome();
    await cleanup();
    await prisma.$disconnect();
  }
}

main();
