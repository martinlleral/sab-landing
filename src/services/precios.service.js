/**
 * Servicio de cálculo de precios para checkout.
 *
 * Centraliza la lógica que combina tipo de entrada (base/aporte) y cupones de
 * descuento. Es la fuente de verdad de qué precio se cobra al comprador y qué
 * monto va a la preferencia de MercadoPago.
 *
 * Reglas (Sprint 3, decididas el 2/5/2026):
 *  - El cupón se aplica SOLO sobre el precio base de la tanda. El excedente del
 *    aporte ("A la Gorra") nunca se descuenta — siempre llega íntegro a la coop.
 *  - Códigos de cupón son case-insensitive: se normalizan a UPPERCASE.
 *  - Si el descuento por monto fijo supera el precio base, la entrada queda en
 *    el mínimo de la base = $0 (más el excedente si corresponde). El backoffice
 *    debe alertar al admin al crear cupones con valor > precio mínimo del evento.
 *  - El incremento del contador de usos es responsabilidad del controller dentro
 *    de una transacción Prisma (ver `reservarCupon`). Este helper solo CALCULA y
 *    VALIDA, no muta estado.
 *
 * Regla del menú de Casa Metro (Sprint 7, 17/8/2026):
 *  - EL CUPÓN NO DESCUENTA EL MENÚ. Nunca. Es la misma protección que tiene el
 *    excedente del aporte, pero por un motivo más caro: el aporte descontado es
 *    plata que la coop no recibe, mientras que el menú descontado es plata que la
 *    coop le paga IGUAL a Casa Metro. Con AMIGOS25 (25 %) y 10 entradas con menú
 *    a $15.000, serían $37.500 saliendo del bolsillo del SAB.
 *    La protección acá es ESTRUCTURAL, no un `if`: el menú no entra nunca a
 *    `calcularPrecioFinal` (que es donde vive el descuento), sino que se suma
 *    aparte en `calcularTotalCompra`. Para que un cupón toque el menú habría que
 *    reescribir la composición de las dos funciones, no olvidarse de una guarda.
 *  - El menú es una CANTIDAD propia, ortogonal a `tipoEntrada`: las 4
 *    combinaciones (base/aporte × con/sin menú) se calculan sin tocar nada de la
 *    semántica del Sprint 3.
 *
 * Tope de menús por evento (Sprint 7, S2):
 *  - `Evento.topeMenus` (null = sin tope) es cuántos menús puede cocinar la sede.
 *  - NO hay contador desnormalizado de menús vendidos, a propósito: la cantidad
 *    ocupada se DERIVA sumando `Compra.cantidadMenus` por estado. El proyecto ya
 *    tiene un contador desnormalizado (`Tanda.cantidadVendida`) con una race
 *    conocida; sumar un segundo sería repetir el error.
 *  - Consecuencia buena: la liberación del cupo es AUTOMÁTICA. Cuando una compra
 *    sale de pending/approved (autocancel → 'cancelled', devolución →
 *    'refunded'), deja de contar sola. No hay decremento que olvidarse.
 */

const prisma = require('../utils/prisma');

const TIPO_ENTRADA = Object.freeze({
  BASE: 'base',
  APORTE: 'aporte',
});

const TIPO_CUPON = Object.freeze({
  PORCENTAJE: 'porcentaje',
  MONTO: 'monto',
});

function normalizarCodigo(codigo) {
  return String(codigo || '').trim().toUpperCase();
}

/**
 * Valida un cupón contra un evento sin mutar estado. Tira Error con .code para
 * que el controller mapee a HTTP 400 con mensaje específico.
 */
function validarCupon(cupon, eventoId, ahora = new Date()) {
  if (!cupon || !cupon.activo) {
    const e = new Error('Cupón inválido o desactivado');
    e.code = 'CUPON_INVALIDO';
    throw e;
  }
  if (cupon.eventoId !== eventoId) {
    const e = new Error('El cupón no aplica a este evento');
    e.code = 'CUPON_OTRO_EVENTO';
    throw e;
  }
  if (cupon.validoHasta && ahora > new Date(cupon.validoHasta)) {
    const e = new Error('El cupón está vencido');
    e.code = 'CUPON_VENCIDO';
    throw e;
  }
  if (cupon.topeUsos !== null && cupon.usosActuales >= cupon.topeUsos) {
    const e = new Error('El cupón alcanzó el tope de usos');
    e.code = 'CUPON_AGOTADO';
    throw e;
  }
  if (![TIPO_CUPON.PORCENTAJE, TIPO_CUPON.MONTO].includes(cupon.tipo)) {
    const e = new Error('Tipo de cupón desconocido');
    e.code = 'CUPON_TIPO_INVALIDO';
    throw e;
  }
}

/**
 * Calcula el precio final de UNA entrada según tipo + cupón.
 *
 * @param {Object} tanda - Tanda vigente (debe traer precio, eventoId, porcentajeAporte)
 * @param {Object} [opciones]
 * @param {string} [opciones.tipoEntrada='base'] - 'base' | 'aporte'
 * @param {string} [opciones.cuponCodigo] - código a aplicar (opcional)
 * @returns {Promise<{
 *   precioUnitarioFinal: number,
 *   precioBase: number,
 *   excedenteUnitario: number,
 *   descuentoUnitario: number,
 *   tipoEntrada: string,
 *   cupon: Object|null,
 *   breakdown: { base: number, descuento: number, excedente: number, total: number }
 * }>}
 */
async function calcularPrecioFinal(tanda, opciones = {}) {
  const tipoEntrada = opciones.tipoEntrada || TIPO_ENTRADA.BASE;
  const cuponCodigo = opciones.cuponCodigo ? normalizarCodigo(opciones.cuponCodigo) : null;

  if (![TIPO_ENTRADA.BASE, TIPO_ENTRADA.APORTE].includes(tipoEntrada)) {
    const e = new Error('Tipo de entrada inválido');
    e.code = 'TIPO_ENTRADA_INVALIDO';
    throw e;
  }

  const precioBase = tanda.precio;

  let excedenteUnitario = 0;
  if (tipoEntrada === TIPO_ENTRADA.APORTE) {
    if (!tanda.porcentajeAporte || tanda.porcentajeAporte <= 0) {
      const e = new Error('Esta tanda no admite entrada con aporte');
      e.code = 'APORTE_NO_HABILITADO';
      throw e;
    }
    excedenteUnitario = Math.round(precioBase * (tanda.porcentajeAporte / 100));
  }

  let descuentoUnitario = 0;
  let cupon = null;

  if (cuponCodigo) {
    cupon = await prisma.cuponDescuento.findUnique({
      where: { codigo: cuponCodigo },
    });
    validarCupon(cupon, tanda.eventoId);

    // El descuento se aplica SOLO sobre la base, nunca sobre el excedente del aporte.
    if (cupon.tipo === TIPO_CUPON.PORCENTAJE) {
      descuentoUnitario = Math.round(precioBase * (cupon.valor / 100));
    } else {
      descuentoUnitario = Math.min(cupon.valor, precioBase);
    }
  }

  const baseConDescuento = Math.max(0, precioBase - descuentoUnitario);
  const precioUnitarioFinal = baseConDescuento + excedenteUnitario;

  return {
    precioUnitarioFinal,
    precioBase,
    excedenteUnitario,
    descuentoUnitario,
    tipoEntrada,
    cupon,
    breakdown: {
      base: precioBase,
      descuento: descuentoUnitario,
      excedente: excedenteUnitario,
      total: precioUnitarioFinal,
    },
  };
}

/**
 * ── Corte horario de venta de menús (Sprint 7, S3) ──
 *
 * Casa Metro cocina contra un número y necesita cerrar la cuenta: pasada la hora
 * de corte del día del evento (`Home.menuCorteHora`, default "18:00") ya no se
 * vende menú. Las entradas siguen a la venta — el corte es del menú, no del
 * evento.
 *
 * TIMEZONE (el proyecto ya tuvo un fix por esto, 8-9/5/2026). La convención
 * vigente es: las fechas se GUARDAN como si fueran hora local (mediodía UTC del
 * día del evento, ver `parsearFechaLocal`) y se LEEN forzando UTC (el front
 * formatea con `timeZone:'UTC'`). Por eso el día calendario del evento sale de
 * los componentes UTC crudos de `fecha` y NO de restarle 3 h: restar movería al
 * día anterior a cualquier fecha guardada entre las 00:00 y las 03:00 UTC, que
 * es exactamente el bug de aquella sesión. El offset de Argentina (UTC-3, sin
 * DST desde 2009) se suma del otro lado, al construir el instante de corte:
 * 18:00 ART del 23/8 = 2026-08-23T21:00:00Z.
 *
 * `Date.UTC` normaliza solo el overflow: un corte a las 22:00 ART cae a la 01:00
 * UTC del día siguiente, que es el instante correcto.
 */
const HORA_HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const OFFSET_ART_HORAS = 3;

/**
 * Instante exacto en que cierra la venta de menús de un evento.
 *
 * Fail-closed a propósito: un `corteHora` que no sea "HH:MM" válido TIRA en vez
 * de caer a un default. Un `|| '18:00'` acá dejaría el corte en una hora que
 * nadie eligió y el error viviría en silencio hasta la noche del evento (es el
 * mismo hallazgo que R1 encontró con el `|| 0` de `cantidadMenus`). La whitelist
 * del CMS no deja persistir basura, así que llegar acá con un valor malo
 * significa que alguien editó la base a mano: se corta la venta del menú y se
 * avisa, que es lo barato de revertir. Vender menús sin corte no lo es.
 *
 * @param {Date|string} fechaEvento - `Evento.fecha`
 * @param {string} corteHora - `Home.menuCorteHora`, formato "HH:MM"
 * @returns {Date} instante UTC del corte
 */
function calcularCorteMenu(fechaEvento, corteHora) {
  const fecha = fechaEvento instanceof Date ? fechaEvento : new Date(fechaEvento);
  if (!(fecha instanceof Date) || Number.isNaN(fecha.getTime())) {
    const e = new Error('La fecha del evento no es válida');
    e.code = 'MENU_CORTE_INVALIDO';
    throw e;
  }
  const m = HORA_HHMM.exec(String(corteHora === undefined || corteHora === null ? '' : corteHora).trim());
  if (!m) {
    const e = new Error('El horario de cierre del menú no está bien configurado');
    e.code = 'MENU_CORTE_INVALIDO';
    throw e;
  }
  return new Date(Date.UTC(
    fecha.getUTCFullYear(),
    fecha.getUTCMonth(),
    fecha.getUTCDate(),
    parseInt(m[1], 10) + OFFSET_ART_HORAS,
    parseInt(m[2], 10),
    0,
    0
  ));
}

/**
 * ¿Ya cerró la venta de menús? Misma forma que `estaDisponible(tanda, now)` de
 * tandas.service.js: recibe el dato y el reloj, devuelve un booleano y no toca
 * la base.
 *
 * Sin `corteHora` no hay corte configurado y no se bloquea nada (las llamadas
 * que no pasan el dato —tests unitarios de precio, clientes viejos— siguen
 * calculando igual). El corte real siempre viaja: `Home.menuCorteHora` es un
 * String NOT NULL con default "18:00".
 *
 * @param {Date|string} fechaEvento
 * @param {string} corteHora
 * @param {Date} [ahora=new Date()]
 * @returns {boolean}
 */
function menuVentaCerrada(fechaEvento, corteHora, ahora = new Date()) {
  if (corteHora === undefined || corteHora === null || String(corteHora).trim() === '') return false;
  if (!fechaEvento) return false;
  return ahora >= calcularCorteMenu(fechaEvento, corteHora);
}

/**
 * Valida las reglas duras del menú de Casa Metro. Puras: no tocan la base de
 * datos. Tiran Error con .code para que el controller mapee a 400 con mensaje
 * específico, igual que `validarCupon`.
 *
 * Las tres reglas las confirmó el operador el 17/8/2026 (antes eran supuestos):
 *   1. Mínimo 1 entrada — no existe la compra de menú suelto.
 *   2. `cantidadMenus <= cantidadEntradas` — 2 entradas y 5 menús no tiene
 *      sentido físico.
 *   3. Si el evento no tiene `menuHabilitado`, no se vende menú.
 *
 * Ojo con la 1: se aplica a TODA compra (con o sin menú), y es lo que hace que
 * "menú suelto" sea imposible por construcción. Antes de esto, una compra con
 * `cantidad: 0` llegaba hasta Prisma y explotaba con un 500.
 *
 * La cuarta regla (S2) es el TOPE: `menusRestantes` es cuántos quedan según el
 * cupo del evento. Llega ya calculado (el conteo es una lectura a la base, y este
 * helper es puro) y null significa "sin tope". Es un chequeo de cortesía: da un
 * mensaje concreto ANTES de crear nada, igual que `validarCupon` respecto de
 * `reservarCupon`. La garantía real la da `reservarMenus` dentro de la
 * transacción — este número puede quedar viejo entre que se lee y se compra.
 *
 * @param {Object} params
 * @param {number} params.cantidad - entradas pedidas (ya parseado a Int)
 * @param {number} [params.cantidadMenus=0] - menús pedidos (ya parseado a Int)
 * @param {boolean} [params.menuHabilitado=false] - `Evento.menuHabilitado`
 * @param {number} [params.precioMenu=0] - `Home.precioMenu` vigente
 * La quinta regla (S3) es el CORTE HORARIO: pasada `menuCorteHora` del día del
 * evento, Casa Metro ya cerró la cuenta de cuánto cocinar. Acá entran los datos
 * crudos (`fechaEvento` + `menuCorteHora`) y no un booleano resuelto afuera,
 * porque el cálculo es aritmética de fechas y no una lectura a la base — el
 * precedente literal es `validarCupon(cupon, eventoId, ahora = new Date())`, que
 * ya resuelve un vencimiento con esta misma forma. El reloj entra por parámetro
 * para que se pueda testear con una hora fija en vez de con `new Date()`.
 *
 * @param {number|null} [params.menusRestantes=null] - cupo libre; null = sin tope
 * @param {Date|string} [params.fechaEvento] - `Evento.fecha`; sin esto no hay corte
 * @param {string} [params.menuCorteHora] - `Home.menuCorteHora` ("HH:MM")
 * @param {Date} [params.ahora=new Date()] - reloj, inyectable para tests
 */
function validarMenu({
  cantidad, cantidadMenus = 0, menuHabilitado = false, precioMenu = 0, menusRestantes = null,
  fechaEvento = null, menuCorteHora = null, ahora = new Date(),
}) {
  if (!Number.isInteger(cantidad) || cantidad < 1) {
    const e = new Error('La cantidad de entradas debe ser al menos 1');
    e.code = 'CANTIDAD_INVALIDA';
    throw e;
  }
  if (!Number.isInteger(cantidadMenus) || cantidadMenus < 0) {
    const e = new Error('La cantidad de menús no es válida');
    e.code = 'MENUS_INVALIDO';
    throw e;
  }

  if (cantidadMenus === 0) return;

  if (!menuHabilitado) {
    const e = new Error('Este evento no ofrece menú');
    e.code = 'MENU_NO_HABILITADO';
    throw e;
  }
  // Corte horario. Va pegado a MENU_NO_HABILITADO porque las dos contestan la
  // misma pregunta —¿esta fecha vende menú AHORA?— y esa respuesta le gana a
  // cualquier reproche sobre la cantidad pedida: decirle "no compres más menús
  // que entradas" a alguien que ya no puede comprar ninguno es mandarlo a
  // arreglar algo que no lo va a desbloquear.
  if (menuVentaCerrada(fechaEvento, menuCorteHora, ahora)) {
    const hora = String(menuCorteHora).trim();
    const e = new Error(`La venta de menús cerró a las ${hora} del día del evento`);
    e.code = 'MENU_CORTE_PASADO';
    // Viaja la hora igual que `menusRestantes` viaja con MENUS_AGOTADOS: es lo
    // que le permite al checkout corregir su estado y dejar el pedido comprable
    // con entradas solas, diciendo además por qué.
    e.menuCorteHora = hora;
    throw e;
  }
  if (cantidadMenus > cantidad) {
    const e = new Error(`No se pueden comprar más menús (${cantidadMenus}) que entradas (${cantidad})`);
    e.code = 'MENUS_EXCEDEN_ENTRADAS';
    throw e;
  }
  // Guarda de configuración: si el evento tiene el menú habilitado pero el precio
  // global quedó en 0, es un error de carga del backoffice. Vender un menú en $0
  // en silencio sería plata que la coop le debe pagar igual a Casa Metro.
  if (!Number.isInteger(precioMenu) || precioMenu <= 0) {
    const e = new Error('El menú no tiene precio configurado');
    e.code = 'MENU_PRECIO_NO_CONFIGURADO';
    throw e;
  }

  // Tope del evento. Se separan los dos casos porque la persona necesita cosas
  // distintas: con 0 no hay nada que ajustar (se cierra el menú), con 3 y pidió 5
  // el pedido se arregla cambiando un número — y para eso hay que decirle cuál.
  if (menusRestantes !== null && menusRestantes !== undefined) {
    if (menusRestantes <= 0) {
      const e = new Error('Los menús de esta fecha se agotaron');
      e.code = 'MENUS_AGOTADOS';
      // Viaja con el cupo igual que MENUS_SIN_CUPO, aunque acá el número sea
      // siempre 0: es lo que le permite al checkout corregir su estado viejo y
      // dejar el pedido comprable con entradas solas. Sin esto, el select seguía
      // mostrando los menús que la persona había elegido y cada reintento moría
      // con el mismo error — las dos formas de llegar a "agotado" se comportaban
      // distinto por una línea de diferencia.
      e.menusRestantes = 0;
      throw e;
    }
    if (cantidadMenus > menusRestantes) {
      const e = new Error(
        `Quedan ${menusRestantes} menú(s) disponibles y pediste ${cantidadMenus}`
      );
      e.code = 'MENUS_SIN_CUPO';
      e.menusRestantes = menusRestantes;
      throw e;
    }
  }
}

/**
 * Calcula el TOTAL de la compra: entradas (con tipo y cupón) + menús.
 *
 * Es el único punto de entrada que debería usar el checkout, porque es el que
 * garantiza el orden correcto de las operaciones:
 *
 *   1. valida las reglas duras del menú,
 *   2. calcula el precio por entrada con `calcularPrecioFinal` — que aplica el
 *      descuento SOLO sobre la base y no sabe que el menú existe,
 *   3. suma el menú DESPUÉS, sobre un total ya descontado.
 *
 * `menuUnitario` es el precio que hay que CONGELAR en la compra: se devuelve
 * resuelto (0 si no lleva menú) para que el controller lo persista sin recalcular.
 *
 * @param {Object} tanda - Tanda vigente (precio, eventoId, porcentajeAporte)
 * @param {Object} opciones
 * @param {number} opciones.cantidad - entradas
 * @param {string} [opciones.tipoEntrada='base'] - 'base' | 'aporte'
 * @param {string} [opciones.cuponCodigo]
 * @param {number} [opciones.cantidadMenus=0]
 * @param {boolean} [opciones.menuHabilitado=false] - `Evento.menuHabilitado`
 * @param {number} [opciones.precioMenu=0] - `Home.precioMenu` vigente
 * @param {number|null} [opciones.menusRestantes=null] - cupo libre; null = sin tope
 * @param {Date|string} [opciones.fechaEvento] - `Evento.fecha` (corte horario)
 * @param {string} [opciones.menuCorteHora] - `Home.menuCorteHora` ("HH:MM")
 * @param {Date} [opciones.ahora] - reloj, inyectable para tests
 * @returns {Promise<Object>} lo mismo que `calcularPrecioFinal` (por entrada) más
 *   `cantidad`, `cantidadMenus`, `menuUnitario`, `totalPagado` y el desglose
 *   `totales: { entradas, menus, total }`.
 */
async function calcularTotalCompra(tanda, opciones = {}) {
  const cantidad = opciones.cantidad;
  // `??` y no `||`: los dos mandan ausente (undefined/null) a 0 —el caso legítimo
  // del checkout sin menú o del cliente viejo—, pero `||` también se tragaba NaN,
  // y NaN es lo que devuelve `parseInt('dos')`. Con `|| 0` la compra se creaba
  // sin menús y sin error, esquivando el MENUS_INVALIDO que la guarda documenta
  // (los negativos sí se rechazaban: la validación quedaba inconsistente).
  const cantidadMenus = opciones.cantidadMenus ?? 0;
  const precioMenu = opciones.precioMenu || 0;

  validarMenu({
    cantidad,
    cantidadMenus,
    menuHabilitado: opciones.menuHabilitado,
    precioMenu,
    menusRestantes: opciones.menusRestantes ?? null,
    // El corte horario entra por acá y no por una guarda al lado en el
    // controller: así las cinco reglas duras del menú viven en un solo lugar y
    // el camino real (controller → calcularTotalCompra → validarMenu) las aplica
    // todas, que es lo que el candado de R1 pide para cualquier regla que
    // proteja plata.
    fechaEvento: opciones.fechaEvento ?? null,
    menuCorteHora: opciones.menuCorteHora ?? null,
    ahora: opciones.ahora ?? new Date(),
  });

  const precioCalc = await calcularPrecioFinal(tanda, opciones);

  const menuUnitario = cantidadMenus > 0 ? precioMenu : 0;
  const totalEntradas = precioCalc.precioUnitarioFinal * cantidad;
  const totalMenus = menuUnitario * cantidadMenus;

  return {
    ...precioCalc,
    cantidad,
    cantidadMenus,
    menuUnitario,
    totalPagado: totalEntradas + totalMenus,
    totales: {
      entradas: totalEntradas,
      menus: totalMenus,
      total: totalEntradas + totalMenus,
    },
  };
}

/**
 * Reserva atómicamente un uso del cupón dentro de una transacción Prisma.
 * Debe llamarse desde dentro de `prisma.$transaction(async (tx) => { ... })`
 * junto con la creación de la Compra y del CuponUso. Si el tope se rompe por
 * race condition (otro usuario tomó el último uso entre la lectura y el
 * increment), tira CUPON_AGOTADO_RACE y la transacción hace rollback.
 *
 * @param {Object} tx - cliente Prisma de la transacción
 * @param {number} cuponId
 * @returns {Promise<Object>} cupón actualizado
 */
async function reservarCupon(tx, cuponId) {
  const updated = await tx.cuponDescuento.update({
    where: { id: cuponId },
    data: { usosActuales: { increment: 1 } },
  });
  if (updated.topeUsos !== null && updated.usosActuales > updated.topeUsos) {
    const e = new Error('El cupón alcanzó el tope de usos');
    e.code = 'CUPON_AGOTADO_RACE';
    throw e;
  }
  return updated;
}

/**
 * Libera un uso del cupón. Se invoca desde el job de autocancel (D3) cuando
 * una compra con cupón expira sin pago, para que el uso vuelva al pool.
 * Idempotente: si ya está en 0, no hace nada (Math.max evita negativos).
 *
 * @param {Object} prismaClient - cliente Prisma o transacción
 * @param {number} cuponId
 * @returns {Promise<Object|null>} cupón actualizado o null si no existe
 */
async function liberarCupon(prismaClient, cuponId) {
  const cupon = await prismaClient.cuponDescuento.findUnique({ where: { id: cuponId } });
  if (!cupon) return null;
  if (cupon.usosActuales <= 0) return cupon;
  return prismaClient.cuponDescuento.update({
    where: { id: cuponId },
    data: { usosActuales: { decrement: 1 } },
  });
}

/**
 * Estados de compra que OCUPAN cupo de menú. Un pendiente todavía puede pagarse
 * (la ventana de autocancel llega a 72 h por Rapipago), así que reservar su menú
 * es lo correcto: si no se paga, el autocancel lo libera solo.
 *
 * Es la definición ÚNICA de "cupo tomado". Cualquier lugar que muestre menús
 * restantes tiene que usarla, o el backoffice y el checkout dirían números
 * distintos sobre la misma sede.
 */
const ESTADOS_MENU_OCUPADO = Object.freeze(['approved', 'pending']);

/**
 * Cuenta los menús que hoy ocupan cupo en un evento. Se DERIVA de las compras:
 * no hay contador desnormalizado (ver la nota de la cabecera).
 *
 * @param {Object} prismaClient - cliente Prisma o transacción
 * @param {number} eventoId
 * @returns {Promise<number>}
 */
async function contarMenusOcupados(prismaClient, eventoId) {
  const agg = await prismaClient.compra.aggregate({
    where: { eventoId, mpEstado: { in: ESTADOS_MENU_OCUPADO } },
    _sum: { cantidadMenus: true },
  });
  return agg._sum.cantidadMenus || 0;
}

/**
 * Cuántos menús quedan por vender. null = sin tope (no es lo mismo que 0).
 *
 * @param {number|null} topeMenus - `Evento.topeMenus`
 * @param {number} ocupados
 * @returns {number|null}
 */
function calcularMenusRestantes(topeMenus, ocupados) {
  if (topeMenus === null || topeMenus === undefined) return null;
  return Math.max(0, topeMenus - (ocupados || 0));
}

/**
 * Reserva atómicamente el cupo de menús dentro de una transacción Prisma. Es el
 * gemelo de `reservarCupon` con una diferencia de forma que importa: acá no hay
 * contador que incrementar — el "increment" es el INSERT de la Compra, que ya
 * ocurrió cuando esto se llama.
 *
 * Debe invocarse DESPUÉS de `tx.compra.create(...)` y dentro de la misma
 * transacción: recién ahí el aggregate incluye la compra nueva. Si el total pasó
 * el tope, tira MENUS_AGOTADO_RACE y el rollback deshace la compra entera (y la
 * reserva del cupón, si había).
 *
 * Por qué esto es atómico en SQLite: el INSERT toma el lock de escritura antes
 * del aggregate, y SQLite admite un solo escritor a la vez. Ninguna otra
 * transacción puede colar un INSERT entre nuestro create y nuestro conteo. Es
 * exactamente la garantía en la que se apoya `reservarCupon`.
 *
 * Llama a `contarMenusOcupados` de forma interna (no por referencia al módulo) a
 * propósito: los tests monkey-patchean `precios.contarMenusOcupados` para simular
 * un pre-chequeo con datos viejos, y esta guarda tiene que seguir viendo la
 * realidad.
 *
 * @param {Object} tx - cliente Prisma de la transacción
 * @param {number} eventoId
 * @param {number|null} topeMenus - null = sin tope, no hay nada que reservar
 * @returns {Promise<number|null>} menús ocupados tras la compra, o null si no hay tope
 */
async function reservarMenus(tx, eventoId, topeMenus) {
  if (topeMenus === null || topeMenus === undefined) return null;

  const ocupados = await contarMenusOcupados(tx, eventoId);
  if (ocupados > topeMenus) {
    const e = new Error('Los menús de esta fecha se agotaron mientras completabas la compra');
    e.code = 'MENUS_AGOTADO_RACE';
    throw e;
  }
  return ocupados;
}

module.exports = {
  TIPO_ENTRADA,
  TIPO_CUPON,
  ESTADOS_MENU_OCUPADO,
  normalizarCodigo,
  validarCupon,
  validarMenu,
  calcularCorteMenu,
  menuVentaCerrada,
  calcularPrecioFinal,
  calcularTotalCompra,
  reservarCupon,
  liberarCupon,
  contarMenusOcupados,
  calcularMenusRestantes,
  reservarMenus,
};
