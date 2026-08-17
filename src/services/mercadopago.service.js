const { MercadoPagoConfig, Preference, Payment, PaymentSearch } = require('mercadopago');
const config = require('../config');

const client = new MercadoPagoConfig({
  accessToken: config.mercadopago.accessToken,
});

/**
 * Crea una preferencia de Checkout Pro.
 *
 * `itemsExtra` (opcional) suma líneas después de la de las entradas — hoy la usa
 * el menú de Casa Metro, para que su plata viaje identificada hasta el reporte de
 * MP en vez de venir escondida dentro del precio de la entrada. Cada ítem extra
 * es `{ title, unit_price, quantity }`; el currency_id lo pone esta función.
 * ⚠️ La SUMA de todos los ítems tiene que dar `Compra.totalPagado`: el webhook
 * cruza `transaction_amount` contra ese número y rechaza el pago si no coincide.
 */
async function crearPreferencia({ titulo, precio, cantidad, email, preferenciaId, backUrls, itemsExtra }) {
  const preference = new Preference(client);

  const base = config.baseUrl && config.baseUrl.startsWith('http')
    ? config.baseUrl
    : 'http://localhost:3000';

  const resolvedBackUrls = backUrls || {
    success: `${base}/?status=approved`,
    failure: `${base}/?status=rejected`,
    pending: `${base}/?status=pending`,
  };

  const items = [
    {
      title: titulo,
      unit_price: precio,
      quantity: cantidad,
      currency_id: 'ARS',
    },
  ];
  for (const extra of itemsExtra || []) {
    items.push({ currency_id: 'ARS', ...extra });
  }

  const body = {
    items,
    payer: { email },
    external_reference: preferenciaId,
    back_urls: resolvedBackUrls,
    notification_url: `${base}/api/compras/webhook`,
  };

  // auto_return solo funciona con HTTPS (no con localhost)
  if (resolvedBackUrls.success && resolvedBackUrls.success.startsWith('https://')) {
    body.auto_return = 'approved';
  }

  const result = await preference.create({ body });
  return result;
}

async function consultarPago(pagoId) {
  const payment = new Payment(client);
  return payment.get({ id: pagoId });
}

/**
 * Busca pagos en MP por external_reference (= compraId).
 * Retorna el array de pagos encontrados, ordenados por fecha desc.
 */
async function buscarPagoPorCompra(compraId) {
  try {
    const search = new PaymentSearch(client);
    const result = await search.search({
      options: {
        external_reference: String(compraId),
        sort: 'date_created',
        criteria: 'desc',
        limit: 5,
      },
    });
    return result.results || [];
  } catch (err) {
    // Fallback: si PaymentSearch no está disponible en esta versión del SDK
    try {
      const payment = new Payment(client);
      const result = await payment.search({
        options: {
          external_reference: String(compraId),
          sort: 'date_created',
          criteria: 'desc',
          limit: 5,
        },
      });
      return result.results || [];
    } catch (err2) {
      console.error(`buscarPagoPorCompra(${compraId}) falló:`, err2.message);
      return [];
    }
  }
}

module.exports = { crearPreferencia, consultarPago, buscarPagoPorCompra };
