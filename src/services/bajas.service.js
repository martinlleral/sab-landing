const crypto = require('crypto');
const prisma = require('../utils/prisma');
const brevo = require('./brevo.service');

/**
 * El Botón de baja de servicio (Disposición 954/2025, arts. 4 y 5).
 *
 * Quien contrató la afiliación por la web la puede dar de baja por la web, sin
 * registrarse ni ningún otro trámite, y recibe un código de identificación por el
 * mismo medio. En el escalón 0 no hay afiliadxs en el sistema: la suscripción vive
 * en Mercado Pago y la cancela la coordinación desde su panel, buscando el mail.
 * Por eso el pedido:
 *   1. se valida y se GUARDA (el comprobante es el código, que sale en pantalla);
 *   2. después se avisa, en segundo plano: a la persona, su código; a la
 *      coordinación, el pedido entero. Un mail que falla no pierde el pedido: el
 *      panel lo lista igual, sin la marca de enviado.
 *
 * El sitio no sabe quién está afiliadx, así que cualquier nombre y mail con forma
 * válida da un código: no hay forma de usar el formulario para averiguar nada.
 */

// Sin 0/O, 1/I/L ni U: el código se dicta por teléfono y se copia a mano.
const ALFABETO = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const LARGO = { nombreMin: 2, nombreMax: 120, emailMax: 254, mensajeMax: 500 };
const SIGNOS_NO_ADMITIDOS = /[<>]/;
const FORMA_MAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Tope de pedidos con mail en 24 h. El formulario no tiene login (la norma no
// deja pedirlo), así que un script podría usarlo para mandar mails a cualquier
// dirección y comerse el cupo diario de Brevo, que es el mismo de los mails con
// el QR de las entradas. Pasado el tope el pedido se guarda y la persona ve su
// código igual: sólo no salen los mails (y el panel lo muestra).
const TOPE_PEDIDOS_DIA = 20;
const VENTANA_MS = 24 * 60 * 60 * 1000;

function texto(v) {
  return typeof v === 'string' ? v : '';
}

/**
 * Valida lo que llega del formulario. Devuelve `{ ok: true, datos }` con todo
 * recortado (y el mail en minúscula), o `{ ok: false, campos }` con un mensaje
 * por cada campo que falla, para mostrarlo al lado del campo.
 */
function validar(body) {
  const b = body && typeof body === 'object' ? body : {};
  const nombre = texto(b.nombre).replace(/\s+/g, ' ').trim();
  const email = texto(b.email).trim().toLowerCase();
  const mensaje = texto(b.mensaje).trim();
  const campos = {};

  if (!nombre) campos.nombre = 'Escribí tu nombre y apellido.';
  else if (nombre.length < LARGO.nombreMin || nombre.length > LARGO.nombreMax) campos.nombre = `Entre ${LARGO.nombreMin} y ${LARGO.nombreMax} letras.`;
  else if (SIGNOS_NO_ADMITIDOS.test(nombre)) campos.nombre = 'El nombre no admite los signos de menor y mayor.';

  if (!email) campos.email = 'Escribí tu mail.';
  else if (email.length > LARGO.emailMax || !FORMA_MAIL.test(email) || SIGNOS_NO_ADMITIDOS.test(email)) campos.email = 'Revisá el mail: tiene que ser como nombre@ejemplo.com.';

  if (mensaje.length > LARGO.mensajeMax) campos.mensaje = `Hasta ${LARGO.mensajeMax} letras.`;
  else if (SIGNOS_NO_ADMITIDOS.test(mensaje)) campos.mensaje = 'El comentario no admite los signos de menor y mayor.';

  if (Object.keys(campos).length) return { ok: false, campos };
  return { ok: true, datos: { nombre, email, mensaje } };
}

function generarCodigo() {
  let s = '';
  for (let i = 0; i < 8; i += 1) s += ALFABETO[crypto.randomInt(ALFABETO.length)];
  return `BAJA-${s.slice(0, 4)}-${s.slice(4)}`;
}

// Guarda el pedido con un código único. Un choque de códigos (30^8 combinaciones)
// es casi imposible; si pasa, se prueba con otro.
async function registrar(datos) {
  for (let intento = 0; intento < 5; intento += 1) {
    try {
      return await prisma.bajaServicio.create({ data: { ...datos, codigo: generarCodigo() } });
    } catch (err) {
      if (err && err.code === 'P2002') continue;
      throw err;
    }
  }
  throw new Error('No se pudo generar un código de baja único');
}

// A quién avisarle: BAJAS_AVISO_EMAIL, una o varias direcciones separadas por
// coma. Va en el .env del servidor, no en el repo.
function destinatariosCoordinacion() {
  return (process.env.BAJAS_AVISO_EMAIL || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => FORMA_MAIL.test(s));
}

async function marcar(id, campo, cuando) {
  await prisma.bajaServicio.update({ where: { id }, data: { [campo]: cuando } }).catch((err) => {
    console.error(`[bajas] no se pudo marcar ${campo} en el pedido ${id}:`, err.message);
  });
}

/**
 * Manda los dos avisos de un pedido ya guardado. Nunca tira: devuelve qué pasó
 * con cada uno ('enviado' · 'fallo' · 'omitido' por el tope · 'sin-destino').
 */
async function avisar(baja, { ahora = new Date() } = {}) {
  const resultado = { persona: 'omitido', coordinacion: 'omitido' };
  let enVentana;
  try {
    enVentana = await prisma.bajaServicio.count({
      where: { createdAt: { gt: new Date(ahora.getTime() - VENTANA_MS), lte: ahora } },
    });
  } catch (err) {
    console.error('[bajas] no se pudo contar los pedidos del día:', err.message);
    return resultado;
  }
  if (enVentana > TOPE_PEDIDOS_DIA) {
    console.warn(`[bajas] tope diario alcanzado (${enVentana} pedidos en 24 h): el pedido ${baja.codigo} queda guardado sin mails`);
    return resultado;
  }

  try {
    await brevo.enviarBajaRecibida({ email: baja.email, codigo: baja.codigo });
    resultado.persona = 'enviado';
    await marcar(baja.id, 'confirmacionEnviadaAt', new Date());
  } catch (err) {
    resultado.persona = 'fallo';
    console.error(`[bajas] no salió el mail con el código ${baja.codigo}:`, err.message);
  }

  const destinatarios = destinatariosCoordinacion();
  if (!destinatarios.length) {
    resultado.coordinacion = 'sin-destino';
    console.warn(`[bajas] BAJAS_AVISO_EMAIL vacía: el pedido ${baja.codigo} sólo se ve en el panel`);
    return resultado;
  }
  try {
    await brevo.enviarAvisoBaja({ destinatarios, baja });
    resultado.coordinacion = 'enviado';
    await marcar(baja.id, 'avisoEnviadoAt', new Date());
  } catch (err) {
    resultado.coordinacion = 'fallo';
    console.error(`[bajas] no salió el aviso a la coordinación del pedido ${baja.codigo}:`, err.message);
  }
  return resultado;
}

// ── El panel ──────────────────────────────────────────────────────────────────

// Los pedidos sin atender primero, después los más nuevos. Doscientos alcanzan
// de sobra para el escalón 0; los viejos quedan en la base.
async function listar() {
  const filas = await prisma.bajaServicio.findMany({ orderBy: { createdAt: 'desc' }, take: 200 });
  // sort es estable: dentro de cada grupo queda el orden por fecha.
  return filas.sort((a, b) => Number(a.atendidaAt !== null) - Number(b.atendidaAt !== null));
}

async function cambiarAtendida(id, atendida, por) {
  const existe = await prisma.bajaServicio.findUnique({ where: { id } });
  if (!existe) return null;
  return prisma.bajaServicio.update({
    where: { id },
    data: atendida
      ? { atendidaAt: existe.atendidaAt || new Date(), atendidaPor: existe.atendidaAt ? existe.atendidaPor : (por || '') }
      : { atendidaAt: null, atendidaPor: '' },
  });
}

module.exports = {
  ALFABETO,
  LARGO,
  TOPE_PEDIDOS_DIA,
  validar,
  generarCodigo,
  registrar,
  avisar,
  listar,
  cambiarAtendida,
};
