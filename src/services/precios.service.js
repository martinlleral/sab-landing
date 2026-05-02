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

module.exports = {
  TIPO_ENTRADA,
  TIPO_CUPON,
  normalizarCodigo,
  validarCupon,
  calcularPrecioFinal,
  reservarCupon,
  liberarCupon,
};
