const { MercadoPagoConfig, Preference, Payment, PaymentSearch } = require('mercadopago');
const config = require('../config');

const client = new MercadoPagoConfig({
  accessToken: config.mercadopago.accessToken,
});

async function crearPreferencia({ titulo, precio, cantidad, email, preferenciaId, backUrls }) {
  const preference = new Preference(client);

  const base = config.baseUrl && config.baseUrl.startsWith('http')
    ? config.baseUrl
    : 'http://localhost:3000';

  const resolvedBackUrls = backUrls || {
    success: `${base}/?status=approved`,
    failure: `${base}/?status=rejected`,
    pending: `${base}/?status=pending`,
  };

  const body = {
    items: [
      {
        title: titulo,
        unit_price: precio,
        quantity: cantidad,
        currency_id: 'ARS',
      },
    ],
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
