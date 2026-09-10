const { MercadoPagoConfig, Preference, Payment, PaymentSearch } = require('mercadopago');
const config = require('../config');

const client = new MercadoPagoConfig({
  accessToken: config.mercadopago.accessToken,
});

/**
 * Arma el bloque `payer` de la preferencia con TODO lo que el formulario ya nos
 * pidió, no solo el email.
 *
 * El motor antifraude de MP cruza estos datos para decidir si aprueba: un payer
 * flaco (solo email) sube el score de riesgo del comprador y produce rechazos
 * `rejected_high_risk` que no tienen nada que ver con sus fondos ni con nosotros
 * — el comprador ve "por motivos de seguridad, esta transacción no puede ser
 * finalizada" y abandona. Se observó en producción en septiembre de 2026:
 * cinco intentos seguidos de una misma persona, todos rechazados, mientras
 * otras compras del mismo evento y el mismo monto se aprobaban sin problema.
 *
 * Los campos vacíos se OMITEN en vez de viajar en blanco: un `name: ""` es un
 * dato que MP cruza y no matchea; que falte es mejor que que venga vacío.
 */
function construirPayer({ email, nombre, apellido, telefono }) {
  const payer = { email };

  const name = String(nombre || '').trim();
  const surname = String(apellido || '').trim();
  if (name) payer.name = name;
  if (surname) payer.surname = surname;

  // El teléfono viaja como dígitos crudos en `number`, SIN `area_code`. El
  // formulario lo pide en un campo único y en Argentina el área va de 2 a 4
  // dígitos: no hay forma confiable de partirlo. Un split adivinado sería un
  // dato mal cruzado, que para el antifraude es peor que un dato ausente.
  const digits = String(telefono || '').replace(/\D/g, '');
  if (digits) payer.phone = { number: digits };

  return payer;
}

/**
 * Arma el body completo de la preferencia de Checkout Pro. Es PURA a propósito
 * (no toca la red): así los tests pueden verificar lo que realmente se le manda
 * a MP, en vez de verificar los argumentos con que se llamó al servicio — que es
 * una capa antes y deja pasar los errores de armado.
 *
 * `itemsExtra` (opcional) suma líneas después de la de las entradas — hoy la usa
 * el menú de Casa Metro, para que su plata viaje identificada hasta el reporte de
 * MP en vez de venir escondida dentro del precio de la entrada. Cada ítem extra
 * es `{ title, unit_price, quantity }`; el currency_id lo pone esta función.
 * ⚠️ La SUMA de todos los ítems tiene que dar `Compra.totalPagado`: el webhook
 * cruza `transaction_amount` contra ese número y rechaza el pago si no coincide.
 */
function construirBodyPreferencia({
  titulo, precio, cantidad, email, nombre, apellido, telefono,
  preferenciaId, backUrls, itemsExtra,
}) {
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
    payer: construirPayer({ email, nombre, apellido, telefono }),
    external_reference: preferenciaId,
    back_urls: resolvedBackUrls,
    notification_url: `${base}/api/compras/webhook`,
  };

  // auto_return solo funciona con HTTPS (no con localhost)
  if (resolvedBackUrls.success && resolvedBackUrls.success.startsWith('https://')) {
    body.auto_return = 'approved';
  }

  return body;
}

async function crearPreferencia(args) {
  const preference = new Preference(client);
  const body = construirBodyPreferencia(args);
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

module.exports = {
  crearPreferencia,
  consultarPago,
  buscarPagoPorCompra,
  // Exportadas para los tests: el body es lo que MP realmente recibe.
  construirPayer,
  construirBodyPreferencia,
};
