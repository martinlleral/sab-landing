/**
 * Los tres planes de suscripción que muestra /afiliate (escalón 0).
 *
 * Viven en la fila de `Home` (nombre, monto y link de cada uno) y los carga la
 * coordinación desde el panel: el repo no lleva ni montos ni links. Cada botón
 * «Afiliarme» va directo al link de su plan en Mercado Pago, sin formulario.
 *
 * El link termina como `href` en una página pública, así que sólo se acepta de
 * Mercado Pago y por https. Sin esto, un `javascript:` cargado en el panel
 * correría en el navegador de quien visita la página. Se valida al guardar y
 * otra vez al leer, por si alguien lo cargó directo en la base.
 */

const CANTIDAD = 3;
const NOMBRE_MAX = 60; // el tope del nombre del plan en el panel de MP
const MONTO_MAX = 2000000; // el tope del monto de un plan en el panel de MP
const HOSTS_MP = new Set(['mercadopago.com.ar', 'www.mercadopago.com.ar', 'mpago.la', 'www.mpago.la']);

function campos(i) {
  return {
    nombre: `afiliacionPlan${i}Nombre`,
    monto: `afiliacionPlan${i}Monto`,
    link: `afiliacionPlan${i}Link`,
  };
}

function linkPlanValido(raw) {
  if (typeof raw !== 'string') return false;
  const s = raw.trim();
  if (!s || s.length > 500) return false;
  let u;
  try { u = new URL(s); } catch (_) { return false; }
  if (u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  return HOSTS_MP.has(u.hostname.toLowerCase());
}

/**
 * Lee del body del panel los campos de los planes que vinieron.
 * Devuelve `{ data }` para sumar al update, o `{ error }` si algún link no es
 * de Mercado Pago (en ese caso no se guarda nada: lo decide el controller).
 * Un campo que no vino no se toca; un monto que no es número tampoco pisa el
 * guardado (la misma regla que `precioMenu`); un link vacío lo borra.
 */
function parsePlanes(body = {}) {
  const data = {};
  for (let i = 1; i <= CANTIDAD; i += 1) {
    const c = campos(i);
    if (body[c.nombre] !== undefined) {
      data[c.nombre] = String(body[c.nombre]).trim().slice(0, NOMBRE_MAX);
    }
    if (body[c.monto] !== undefined) {
      const n = parseInt(body[c.monto], 10);
      if (Number.isFinite(n) && n >= 0 && n <= MONTO_MAX) data[c.monto] = n;
    }
    if (body[c.link] !== undefined) {
      const s = String(body[c.link]).trim();
      if (s === '') data[c.link] = '';
      else if (linkPlanValido(s)) data[c.link] = s;
      else return { error: `El link del plan ${i} tiene que ser el de Mercado Pago (empieza con https://www.mercadopago.com.ar o https://mpago.la)` };
    }
  }
  return { data };
}

/**
 * Lo que recibe la página: sólo los planes con nombre y monto, en orden. El link
 * va si pasa la validación; si no, null, y la página ofrece el WhatsApp.
 */
function planesPublicos(home) {
  if (!home) return [];
  const lista = [];
  for (let i = 1; i <= CANTIDAD; i += 1) {
    const c = campos(i);
    const nombre = String(home[c.nombre] || '').trim();
    const monto = Number(home[c.monto]) || 0;
    if (!nombre || monto <= 0) continue;
    const link = linkPlanValido(home[c.link]) ? String(home[c.link]).trim() : null;
    lista.push({ nombre, monto, link });
  }
  return lista;
}

module.exports = { CANTIDAD, linkPlanValido, parsePlanes, planesPublicos };
