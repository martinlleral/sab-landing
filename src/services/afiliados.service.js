const crypto = require('crypto');
const prisma = require('../utils/prisma');
const { umbralVisibilidadART } = require('../controllers/eventos.controller');

// ============================================================================
// La página de afiliadxs (escalón 0): una dirección privada que la coordinación
// le manda a cada afiliadx, la lista de videos y los cupones de afiliadxs de los
// próximos shows, que se listan solos.
//
// La dirección es una capability URL (`/afiliados/<64 hex>`): quien la tiene
// entra, sin login. Se acepta porque la página es igual para todos y no muestra
// datos de nadie. Se rota desde el backoffice: rotar crea una nueva y apaga la
// anterior en el acto, en la misma transacción (una sola activa a la vez).
// ============================================================================

const TOKEN_RE = /^[0-9a-f]{64}$/;

function urlDeAcceso(registro) {
  return `/afiliados/${registro.token}`;
}

// La dirección vigente: la activa más nueva. Con la rotación transaccional hay a
// lo sumo una, pero si alguna vez quedaran dos, manda la última.
async function accesoVigente() {
  return prisma.accesoAfiliados.findFirst({
    where: { activo: true },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
}

async function rotarAcceso({ creadoPor = '' } = {}) {
  const token = crypto.randomBytes(32).toString('hex'); // 64 chars, 256 bits
  const [, nuevo] = await prisma.$transaction([
    prisma.accesoAfiliados.updateMany({ where: { activo: true }, data: { activo: false } }),
    prisma.accesoAfiliados.create({ data: { token, creadoPor: String(creadoPor || '') } }),
  ]);
  return nuevo;
}

// Devuelve el `code` REAL para el log; la respuesta pública la uniforma el
// middleware (no se distingue una dirección vieja de una inventada).
async function validarAcceso(token) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) {
    return { valido: false, code: 'TOKEN_MAL_FORMADO' };
  }
  const registro = await prisma.accesoAfiliados.findUnique({ where: { token } });
  if (!registro) return { valido: false, code: 'TOKEN_INEXISTENTE' };
  if (!registro.activo) return { valido: false, code: 'TOKEN_ROTADO' };

  // Último uso: informativo, best-effort; no bloquea la entrada si falla.
  prisma.accesoAfiliados
    .update({ where: { id: registro.id }, data: { ultimoAcceso: new Date() } })
    .catch(() => {});

  return { valido: true, registro };
}

// ── La lista de videos ──────────────────────────────────────────────────────

const HOSTS_YOUTUBE = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'];
const LISTA_ID_RE = /^[A-Za-z0-9_-]{10,80}$/;

// Saca el id de la lista de un link de YouTube. Sólo acepta links de YouTube
// (https) que traigan `list=`; cualquier otra cosa da null. Se guarda el link
// normalizado y a la página va sólo el id: el reproductor se arma del lado de la
// página con youtube-nocookie.
function extraerListaId(raw) {
  if (typeof raw !== 'string') return null;
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !HOSTS_YOUTUBE.includes(url.hostname)) return null;
  const id = url.searchParams.get('list');
  return id && LISTA_ID_RE.test(id) ? id : null;
}

function urlDeLista(id) {
  return `https://www.youtube.com/playlist?list=${id}`;
}

// Una sola fila (id 1). Sin fila = sin lista.
async function obtenerContenido() {
  const fila = await prisma.contenidoAfiliados.findUnique({ where: { id: 1 } });
  const listaUrl = fila ? fila.listaUrl : '';
  return { listaUrl, listaId: extraerListaId(listaUrl), updatedAt: fila ? fila.updatedAt : null };
}

// '' vacía la lista. Un link que no es de una lista de YouTube tira
// LISTA_INVALIDA y no toca lo guardado.
async function guardarListaUrl(raw) {
  let listaUrl = '';
  if (!(typeof raw === 'string' && raw.trim() === '')) {
    const id = extraerListaId(raw);
    if (!id) {
      const e = new Error('Pegá el link de una lista de YouTube (tiene que traer «list=»).');
      e.code = 'LISTA_INVALIDA';
      throw e;
    }
    listaUrl = urlDeLista(id);
  }
  await prisma.contenidoAfiliados.upsert({
    where: { id: 1 },
    create: { id: 1, listaUrl },
    update: { listaUrl },
  });
  return obtenerContenido();
}

// ── Los cupones que se listan ───────────────────────────────────────────────

// Los cupones de afiliadxs que la página muestra: activos, sin vencer, de shows
// publicados, con venta en la web y por venir (el mismo umbral de la portada).
// Los que llegaron al tope, o los de un show agotado, se listan marcados: la
// entrada es «sujeta a disponibilidad» y conviene que se vea por qué no está.
// Sólo sale lo que la página muestra: ni usos, ni topes, ni ids del cupón.
async function cuponesListados({ ahora = new Date() } = {}) {
  const cupones = await prisma.cuponDescuento.findMany({
    where: {
      paraAfiliados: true,
      activo: true,
      OR: [{ validoHasta: null }, { validoHasta: { gt: ahora } }],
      evento: { estaPublicado: true, esExterno: false, fecha: { gte: umbralVisibilidadART() } },
    },
    include: {
      evento: { select: { id: true, nombre: true, fecha: true, hora: true, invitado: true, estaAgotado: true } },
    },
    orderBy: [{ evento: { fecha: 'asc' } }, { id: 'asc' }],
    take: 50,
  });
  return cupones.map((c) => ({
    codigo: c.codigo,
    beneficio: { tipo: c.tipo, valor: c.valor },
    agotado: (c.topeUsos !== null && c.usosActuales >= c.topeUsos) || c.evento.estaAgotado,
    evento: {
      id: c.evento.id,
      nombre: c.evento.nombre,
      fecha: c.evento.fecha,
      hora: c.evento.hora,
      invitado: c.evento.invitado,
    },
  }));
}

module.exports = {
  urlDeAcceso,
  accesoVigente,
  rotarAcceso,
  validarAcceso,
  extraerListaId,
  obtenerContenido,
  guardarListaUrl,
  cuponesListados,
};
