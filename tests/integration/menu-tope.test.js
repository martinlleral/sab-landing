/**
 * Tests de integración — Tope de menús por evento (ítem 43b, Sprint 7 · S2).
 *
 * Casa Metro cocina contra un número: si se venden más menús de los que puede
 * hacer, el problema aparece la noche del evento y no hay software que lo
 * arregle. El tope es `Evento.topeMenus` (null = sin tope).
 *
 * LA DECISIÓN DE DISEÑO QUE ESTOS TESTS PROTEGEN: no hay contador desnormalizado
 * de menús vendidos. La cantidad ocupada se DERIVA sumando `Compra.cantidadMenus`
 * de las compras aprobadas + pendientes. El proyecto ya tiene un contador
 * desnormalizado (`Tanda.cantidadVendida`) con una race conocida; el eje E6 del
 * sprint dice explícitamente que no se sume un segundo.
 *
 * Eso parte los tests en dos mitades:
 *
 *   BLOQUES 1-4 — la RESERVA, que sí es código: pre-chequeo amable, reserva
 *                 atómica dentro de la transacción, y el rollback cuando el cupo
 *                 se rompe entre que se leyó y se compró.
 *   BLOQUES 5-6 — la LIBERACIÓN, que NO es código: al salir de pending/approved
 *                 la compra deja de contar sola. Eso hay que VERIFICARLO, no
 *                 asumirlo — es toda la evidencia de que no hacen falta
 *                 decrementos en los 3 puntos de pagos.service.js.
 *   BLOQUE 7    — que el número que ve el operador y el que ve el comprador sean
 *                 el mismo.
 *   BLOQUE 8    — las whitelists: sin ellas el campo "guarda" sin guardar.
 *
 * ⚠️ NO se llama a `procesarPagoAprobado`: genera QR y dispara el mail de
 * confirmación por la cuenta de Brevo del cliente (aprendizaje de S1b). Para
 * simular una compra pagada se escribe el estado con Prisma, que es lo que
 * `revertirCompraAprobada` necesita. Igual se neutraliza brevo por las dudas.
 *
 * No mockea Prisma: usa dev.db real y limpia con prefijo `menu-tope-test-`.
 *
 * Uso local:
 *   node tests/integration/menu-tope.test.js
 *
 * Exit codes: 0 = PASS, 1 = FAIL
 */

const prisma = require('../../src/utils/prisma');
const compras = require('../../src/controllers/compras.controller');
const eventosCtrl = require('../../src/controllers/eventos.controller');
const mpService = require('../../src/services/mercadopago.service');
const brevoService = require('../../src/services/brevo.service');
const precios = require('../../src/services/precios.service');
const { procesarPagoCancelado, revertirCompraAprobada } = require('../../src/services/pagos.service');

const TEST_PREFIX = 'menu-tope-test-';
const PRECIO_ENTRADA = 10000;
const PRECIO_MENU = 15000;

// Referencia REAL al contador, capturada antes de cualquier monkey-patch: el
// bloque 3 patchea `precios.contarMenusOcupados` para simular un pre-chequeo con
// datos viejos, y los asserts tienen que seguir viendo la base de verdad.
const contarReal = precios.contarMenusOcupados;

// ---------- mocks de servicios externos ----------
const originalCrearPref = mpService.crearPreferencia;
mpService.crearPreferencia = async () => ({
  id: `mock-pref-${Date.now()}-${Math.random()}`,
  init_point: 'https://mock.invalid/pay',
});

// Red de seguridad: ninguna ruta de este test debería mandar mail, pero la cuenta
// de Brevo es la que manda las entradas reales. Si alguna vez alguien suma un
// paso que llame a esto, que falle acá y no en la bandeja de un comprador.
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
    email: `c${contadorCompradores}@test.invalid`,
    nombre: 'Test',
    apellido: 'Tope',
    telefono: '221',
  };
}

// Compra por el camino real (crearPreferencia). Devuelve el res mockeado.
async function comprar(evento, { cantidad = 1, menus = 1, cuponCodigo } = {}) {
  const body = {
    eventoId: evento.id, ...datosComprador(), cantidad, cantidadMenus: menus,
  };
  if (cuponCodigo) body.cuponCodigo = cuponCodigo;
  return call(compras.crearPreferencia, { body });
}

// Simula el pago acreditado SIN pasar por procesarPagoAprobado (que manda mail).
// Se mueve también el contador de la tanda para que la devolución, que lo
// decrementa, quede simétrica y no lo deje en negativo.
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
    // BLOQUE 1 — Sin tope: null NO es 0
    // ============================================
    // La confusión entre "sin límite" y "agotado" es la que deja de vender sin
    // que nadie se entere, así que es el primer check.
    {
      const { evento } = await setupEvento({ topeMenus: null });
      const res = await comprar(evento, { cantidad: 5, menus: 5 });
      check('1a) sin tope: se venden 5 menús sin límite', res.statusCode === 200,
        `status=${res.statusCode} body=${JSON.stringify(res.body)}`);

      const resProximos = await call(eventosCtrl.getProximos);
      const ev = (resProximos.body || []).find((e) => e.id === evento.id);
      check('1b) sin tope: la API pública devuelve menusRestantes = null (no 0)',
        ev && ev.menusRestantes === null, `menusRestantes=${ev && ev.menusRestantes}`);
    }

    // ============================================
    // BLOQUE 2 — Pre-chequeo: el mensaje tiene que decir el número
    // ============================================
    {
      const { evento } = await setupEvento({ topeMenus: 3 });

      // "Quedan 3 y pediste 5": el caso que el prompt pedía definir. No alcanza
      // con rechazar — hay que decir cuántos quedan, o la persona prueba a ciegas.
      const resExceso = await comprar(evento, { cantidad: 5, menus: 5 });
      check('2a) quedan 3 y pide 5 → 400 MENUS_SIN_CUPO',
        resExceso.statusCode === 400 && resExceso.body?.code === 'MENUS_SIN_CUPO',
        `status=${resExceso.statusCode} code=${resExceso.body?.code}`);
      check('2b) el rechazo incluye menusRestantes=3 para que la UI recorte el select',
        resExceso.body?.menusRestantes === 3, `menusRestantes=${resExceso.body?.menusRestantes}`);
      check('2c) el mensaje nombra el número, no es genérico',
        /3/.test(resExceso.body?.error || ''), `error="${resExceso.body?.error}"`);

      const comprasTrasRechazo = await prisma.compra.count({ where: { eventoId: evento.id } });
      check('2d) el pedido rechazado no dejó ninguna compra', comprasTrasRechazo === 0,
        `compras=${comprasTrasRechazo}`);

      // Justo el tope: tiene que entrar.
      const resJusto = await comprar(evento, { cantidad: 3, menus: 3 });
      check('2e) 3 menús con tope 3 entran (el borde vende, no rechaza)',
        resJusto.statusCode === 200, `status=${resJusto.statusCode} body=${JSON.stringify(resJusto.body)}`);
      check('2f) el cupo quedó tomado por una compra PENDIENTE de pago',
        (await contarReal(prisma, evento.id)) === 3,
        `ocupados=${await contarReal(prisma, evento.id)}`);

      // Agotado.
      const resAgotado = await comprar(evento, { cantidad: 1, menus: 1 });
      check('2g) con el cupo lleno → 400 MENUS_AGOTADOS',
        resAgotado.statusCode === 400 && resAgotado.body?.code === 'MENUS_AGOTADOS',
        `status=${resAgotado.statusCode} code=${resAgotado.body?.code}`);

      // 🔒 CANDADO (R1). El rechazo por agotado tiene que traer su cupo igual que
      // el 2b, aunque el número sea siempre 0. Es lo único que le permite al
      // checkout corregir el select viejo: sin esto, la persona que abrió el modal
      // cuando quedaban menús se quedaba con "2 menús" elegidos, el cartel le decía
      // "podés seguir con las entradas solas" y cada reintento moría con el mismo
      // error, porque el front solo se recupera cuando el cupo viene en la
      // respuesta. Las dos formas de llegar a "agotado" se comportaban distinto.
      check('🔒 2g2) el rechazo por agotado incluye menusRestantes=0 (el front recorta el select solo)',
        resAgotado.body?.menusRestantes === 0,
        `menusRestantes=${JSON.stringify(resAgotado.body?.menusRestantes)}`);

      // 🎯 El tope es del MENÚ, no del evento: quedarse sin menús no puede
      // frenar la venta de entradas. Romper esto sería perder plata del SAB por
      // un límite de la cocina.
      const resSinMenu = await comprar(evento, { cantidad: 2, menus: 0 });
      check('2h) 🎯 con los menús agotados, las entradas SIN menú se siguen vendiendo',
        resSinMenu.statusCode === 200, `status=${resSinMenu.statusCode} body=${JSON.stringify(resSinMenu.body)}`);
    }

    // ============================================
    // BLOQUE 3 — 🎯 EL TEST DEL ÍTEM: la race y su rollback
    // ============================================
    // Prisma con SQLite serializa las escrituras, así que dos requests en
    // paralelo no interleavean de verdad dentro del proceso (eso se cubre igual
    // en el bloque 4). Lo que se reproduce acá es la ÚNICA condición que importa:
    // que el pre-chequeo haya leído un número que dejó de ser cierto. Se logra
    // cegándolo a propósito — `reservarMenus` llama al contador de forma interna,
    // así que la guarda de la transacción sigue viendo la realidad.
    {
      const { evento } = await setupEvento({ topeMenus: 1 });
      const cupon = await prisma.cuponDescuento.create({
        data: {
          eventoId: evento.id,
          codigo: `TOPE${Date.now()}`,
          tipo: 'porcentaje',
          valor: 25,
          activo: true,
        },
      });

      const resA = await comprar(evento, { cantidad: 1, menus: 1 });
      check('3a) la primera compra toma el último menú', resA.statusCode === 200,
        `status=${resA.statusCode}`);

      // Pre-chequeo ciego: ve el cupo como estaba antes de la compra A.
      precios.contarMenusOcupados = async () => 0;
      const resB = await comprar(evento, { cantidad: 1, menus: 1, cuponCodigo: cupon.codigo });
      precios.contarMenusOcupados = contarReal;

      check('3b) 🎯 la segunda pasa el pre-chequeo pero la transacción la ataja → MENUS_AGOTADO_RACE',
        resB.statusCode === 400 && resB.body?.code === 'MENUS_AGOTADO_RACE',
        `status=${resB.statusCode} code=${resB.body?.code} error="${resB.body?.error}"`);

      const totalCompras = await prisma.compra.count({ where: { eventoId: evento.id } });
      check('3c) rollback: no quedó una compra fantasma', totalCompras === 1,
        `compras=${totalCompras}`);
      check('3d) rollback: el cupo no se pasó del tope',
        (await contarReal(prisma, evento.id)) === 1,
        `ocupados=${await contarReal(prisma, evento.id)}`);

      // El rollback tiene que deshacer TODA la transacción, no solo la compra: el
      // cupón se reserva en la misma tx, unas líneas antes.
      const cuponTrasRace = await prisma.cuponDescuento.findUnique({ where: { id: cupon.id } });
      const usos = await prisma.cuponUso.count({ where: { cuponId: cupon.id } });
      check('3e) 🎯 rollback completo: el cupón no consumió su uso',
        cuponTrasRace.usosActuales === 0 && usos === 0,
        `usosActuales=${cuponTrasRace.usosActuales} cuponUso=${usos}`);
    }

    // ============================================
    // BLOQUE 4 — Dos compras concurrentes por el último menú
    // ============================================
    {
      const { evento } = await setupEvento({ topeMenus: 1 });
      const [r1, r2] = await Promise.all([
        comprar(evento, { cantidad: 1, menus: 1 }),
        comprar(evento, { cantidad: 1, menus: 1 }),
      ]);

      const ok = [r1, r2].filter((r) => r.statusCode === 200);
      const fallidas = [r1, r2].filter((r) => r.statusCode === 400);
      check('4a) de dos compras simultáneas del último menú, gana exactamente una',
        ok.length === 1 && fallidas.length === 1,
        `status=[${r1.statusCode}, ${r2.statusCode}]`);
      check('4b) la que pierde falla por cupo, no con un error genérico',
        fallidas.length === 1
          && ['MENUS_SIN_CUPO', 'MENUS_AGOTADOS', 'MENUS_AGOTADO_RACE'].includes(fallidas[0].body?.code),
        `code=${fallidas[0]?.body?.code}`);
      check('4c) no se sobrevendió: el cupo quedó en 1',
        (await contarReal(prisma, evento.id)) === 1,
        `ocupados=${await contarReal(prisma, evento.id)}`);
    }

    // ============================================
    // BLOQUE 5 — 🎯 La liberación ocurre SOLA (no hay decrementos que escribir)
    // ============================================
    // Este bloque es la evidencia de la corrección de S1a: los 3 puntos de
    // pagos.service.js no necesitan código nuevo. Si alguna vez se agrega un
    // contador desnormalizado y se olvidan de decrementarlo, estos checks caen.
    {
      const { evento } = await setupEvento({ topeMenus: 2 });

      // --- autocancel de una pendiente ---
      const resPend = await comprar(evento, { cantidad: 2, menus: 2 });
      const compraPend = await prisma.compra.findUnique({ where: { id: resPend.body.compra_id } });
      check('5a) la compra pendiente ocupa el cupo entero',
        (await contarReal(prisma, evento.id)) === 2,
        `ocupados=${await contarReal(prisma, evento.id)}`);

      const cancel = await procesarPagoCancelado(compraPend.id, 'cancelled');
      check('5b) 🎯 el autocancel libera el cupo sin tocar ningún contador',
        cancel.procesada === true && (await contarReal(prisma, evento.id)) === 0,
        `procesada=${cancel.procesada} ocupados=${await contarReal(prisma, evento.id)}`);

      const cancelada = await prisma.compra.findUnique({ where: { id: compraPend.id } });
      check('5c) la compra cancelada CONSERVA cantidadMenus (es historia contable)',
        cancelada.mpEstado === 'cancelled' && cancelada.cantidadMenus === 2,
        `estado=${cancelada.mpEstado} cantidadMenus=${cancelada.cantidadMenus}`);

      // --- devolución de una aprobada (US-A) ---
      const resAprob = await comprar(evento, { cantidad: 2, menus: 2 });
      await marcarAprobada(resAprob.body.compra_id);
      check('5d) la compra aprobada ocupa el cupo',
        (await contarReal(prisma, evento.id)) === 2,
        `ocupados=${await contarReal(prisma, evento.id)}`);

      const rev = await revertirCompraAprobada(resAprob.body.compra_id, { revertidaPor: 'test' });
      check('5e) 🎯 la devolución libera el cupo y reporta cuántos menús soltó',
        rev.ok === true && rev.menus_devueltos === 2
          && (await contarReal(prisma, evento.id)) === 0,
        `ok=${rev.ok} menus_devueltos=${rev.menus_devueltos} ocupados=${await contarReal(prisma, evento.id)}`);

      // --- el ciclo completo del criterio de éxito ---
      const resReventa = await comprar(evento, { cantidad: 2, menus: 2 });
      check('5f) 🎯 ciclo comprar → cancelar → devolver → comprar: no se perdió cupo',
        resReventa.statusCode === 200 && (await contarReal(prisma, evento.id)) === 2,
        `status=${resReventa.statusCode} ocupados=${await contarReal(prisma, evento.id)}`);
    }

    // ============================================
    // BLOQUE 6 — Bajar el tope por debajo de lo vendido no rompe nada
    // ============================================
    // Caso real de operación: la cocina avisa que puede menos de lo que dijo.
    {
      const { evento } = await setupEvento({ topeMenus: 5 });
      await comprar(evento, { cantidad: 4, menus: 4 });
      await prisma.evento.update({ where: { id: evento.id }, data: { topeMenus: 2 } });

      const ocupados = await contarReal(prisma, evento.id);
      check('6a) el cupo restante no se va a negativo (queda en 0)',
        precios.calcularMenusRestantes(2, ocupados) === 0,
        `restantes=${precios.calcularMenusRestantes(2, ocupados)} ocupados=${ocupados}`);

      const res = await comprar(evento, { cantidad: 1, menus: 1 });
      check('6b) con el tope bajado, no se vende ni uno más',
        res.statusCode === 400 && res.body?.code === 'MENUS_AGOTADOS',
        `status=${res.statusCode} code=${res.body?.code}`);
    }

    // ============================================
    // BLOQUE 7 — El operador y el comprador ven el MISMO número
    // ============================================
    {
      const { evento, tanda } = await setupEvento({ topeMenus: 10 });
      await comprar(evento, { cantidad: 3, menus: 3 });          // pending

      // Compra con menús y totalPagado 0. ⚠️ Fixture SINTÉTICO: hoy la app no
      // puede producir este estado (adminEnviarInvitacion no setea cantidadMenus,
      // y una compra con menús siempre tiene total > 0 porque el cupón no toca el
      // menú). Está acá como CANDADO DE DEFINICIÓN: `restantes` se cuenta con su
      // propio criterio (aprobadas + pendientes, valga lo que valga la compra) y
      // no se deriva de `menus.cantidad`, que filtra totalPagado > 0 porque mide
      // PLATA. Si mañana una invitación puede llevar menú, la cocina tiene que
      // cocinarlo igual — y este check ya lo exige.
      await prisma.compra.create({
        data: {
          eventoId: evento.id,
          tandaId: tanda.id,
          email: `inv@test.invalid`,
          nombre: 'Test',
          apellido: 'Invitación',
          cantidadEntradas: 2,
          precioUnitario: PRECIO_ENTRADA,
          totalPagado: 0,
          mpEstado: 'approved',
          cantidadMenus: 2,
          menuUnitario: PRECIO_MENU,
        },
      });

      const resStats = await call(eventosCtrl.adminEventoStats, { params: { id: String(evento.id) } });
      const menus = resStats.body?.menus;
      check('7a) el backoffice publica tope / ocupados / restantes',
        menus?.tope === 10 && menus?.ocupados === 5 && menus?.restantes === 5,
        `tope=${menus?.tope} ocupados=${menus?.ocupados} restantes=${menus?.restantes}`);
      check('7b) 🎯 el cupo cuenta los menús de invitaciones, la plata no',
        menus?.ocupados === 5 && menus?.cantidad === 0 && menus?.total === 0,
        `ocupados=${menus?.ocupados} cantidad=${menus?.cantidad} total=${menus?.total}`);

      const resProximos = await call(eventosCtrl.getProximos);
      const evPub = (resProximos.body || []).find((e) => e.id === evento.id);
      check('7c) el checkout recibe el mismo restante que ve el operador',
        evPub?.menusRestantes === menus?.restantes,
        `publico=${evPub?.menusRestantes} backoffice=${menus?.restantes}`);

      // Un evento con tope pero con el menú apagado no ofrece nada: el checkout
      // usa menusRestantes solo cuando menuHabilitado, y null evita que muestre
      // "quedan N" de algo que no se vende.
      await prisma.evento.update({ where: { id: evento.id }, data: { menuHabilitado: false } });
      const resApagado = await call(eventosCtrl.getProximos);
      const evApagado = (resApagado.body || []).find((e) => e.id === evento.id);
      check('7d) con el menú apagado, el cupo público es null',
        evApagado?.menusRestantes === null, `menusRestantes=${evApagado?.menusRestantes}`);
    }

    // ============================================
    // BLOQUE 8 — Whitelists: sin esto el campo guarda sin guardar
    // ============================================
    {
      const { evento } = await setupEvento({ topeMenus: null });

      await call(eventosCtrl.adminEditar, {
        params: { id: String(evento.id) }, body: { topeMenus: '40' },
      });
      let actual = await prisma.evento.findUnique({ where: { id: evento.id } });
      check('8a) adminEditar persiste el tope', actual.topeMenus === 40,
        `topeMenus=${actual.topeMenus}`);

      // Vaciar el campo = sacar el tope. Tiene que llegar a null, no quedarse en 40.
      await call(eventosCtrl.adminEditar, {
        params: { id: String(evento.id) }, body: { topeMenus: '' },
      });
      actual = await prisma.evento.findUnique({ where: { id: evento.id } });
      check('8b) vaciar el campo saca el tope (null, no 0)', actual.topeMenus === null,
        `topeMenus=${actual.topeMenus}`);

      // Un 0 es un tope legítimo: "no vender más menús en esta fecha".
      await call(eventosCtrl.adminEditar, {
        params: { id: String(evento.id) }, body: { topeMenus: '0' },
      });
      actual = await prisma.evento.findUnique({ where: { id: evento.id } });
      check('8c) 0 se guarda como 0 (distinto de sin tope)', actual.topeMenus === 0,
        `topeMenus=${actual.topeMenus}`);

      // Basura no pisa un valor válido, misma guarda que precioMenu en updateHome.
      await call(eventosCtrl.adminEditar, {
        params: { id: String(evento.id) }, body: { topeMenus: 'abc' },
      });
      actual = await prisma.evento.findUnique({ where: { id: evento.id } });
      check('8d) un valor inválido no pisa el tope guardado', actual.topeMenus === 0,
        `topeMenus=${actual.topeMenus}`);

      // Un request que no manda el campo no lo toca.
      await prisma.evento.update({ where: { id: evento.id }, data: { topeMenus: 25 } });
      await call(eventosCtrl.adminEditar, {
        params: { id: String(evento.id) }, body: { nombre: `${TEST_PREFIX}renombrado` },
      });
      actual = await prisma.evento.findUnique({ where: { id: evento.id } });
      check('8e) editar otra cosa no borra el tope', actual.topeMenus === 25,
        `topeMenus=${actual.topeMenus}`);

      // adminCrear: el form de "Nuevo evento" es el mismo que el de edición.
      const resCrear = await call(eventosCtrl.adminCrear, {
        body: {
          nombre: `${TEST_PREFIX}nuevo`,
          descripcion: 'test',
          fecha: '2030-01-15',
          hora: '21:00',
          precioEntrada: '10000',
          cantidadDisponible: '100',
          menuHabilitado: 'true',
          topeMenus: '12',
        },
      });
      check('8f) 🎯 adminCrear guarda el tope al crear el evento (no se pierde en silencio)',
        resCrear.statusCode === 201 && resCrear.body?.topeMenus === 12,
        `status=${resCrear.statusCode} topeMenus=${resCrear.body?.topeMenus}`);
    }

    // ============================================
    // RESULTADO
    // ============================================
    const failed = checks.filter((c) => !c.ok);
    const passed = checks.length - failed.length;
    console.log('');
    console.log('========================================');
    console.log(`Tests Tope de menús: ${passed}/${checks.length} OK`);
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
    precios.contarMenusOcupados = contarReal;
    mpService.crearPreferencia = originalCrearPref;
    brevoService.enviarConfirmacion = originalEnviarConfirmacion;
    await restaurarHome();
    await cleanup();
    await prisma.$disconnect();
  }
}

main();
