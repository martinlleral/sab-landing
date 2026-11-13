const path = require('path');
const service = require('../services/afiliados.service');

const PAGINA = path.join(__dirname, '../../public/afiliados/index.html');

// El HTML de la página de afiliadxs. Es estático y se sirve siempre: el JS de
// la página manda la dirección a /api/afiliados/:token y, si no está vigente,
// muestra el cartel. Los encabezados van acá porque la página no se indexa, no se
// guarda en ningún caché y no le pasa la dirección a nadie como Referer (ni a
// YouTube, ni a nuestros propios logs al pedir los assets).
function paginaHtml(_req, res) {
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  return res.sendFile(PAGINA);
}

// Lo que ve la página (tras requireAccesoAfiliados): la lista de videos (sólo
// su id) y los cupones de los próximos shows.
async function contenidoPublico(_req, res) {
  try {
    const [contenido, cupones] = await Promise.all([
      service.obtenerContenido(),
      service.cuponesListados(),
    ]);
    return res.json({
      lista: contenido.listaId ? { id: contenido.listaId } : null,
      cupones,
    });
  } catch (err) {
    console.error('Error en contenidoPublico afiliados:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// ── Admin (tras requireAdmin) ────────────────────────────────────────────────

function mapAcceso(a) {
  if (!a) return null;
  return {
    token: a.token,
    url: service.urlDeAcceso(a),
    creadoPor: a.creadoPor,
    createdAt: a.createdAt,
    ultimoAcceso: a.ultimoAcceso,
  };
}

async function adminGetAcceso(_req, res) {
  try {
    return res.json({ vigente: mapAcceso(await service.accesoVigente()) });
  } catch (err) {
    console.error('Error en adminGetAcceso:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// Crea una dirección nueva y apaga la anterior en el acto.
async function adminRotarAcceso(req, res) {
  try {
    const creadoPor = req.session?.usuario?.email || '';
    const nuevo = await service.rotarAcceso({ creadoPor });
    return res.status(201).json({ vigente: mapAcceso(nuevo) });
  } catch (err) {
    console.error('Error en adminRotarAcceso:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

async function adminGetContenido(_req, res) {
  try {
    return res.json(await service.obtenerContenido());
  } catch (err) {
    console.error('Error en adminGetContenido:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

async function adminPutContenido(req, res) {
  try {
    return res.json(await service.guardarListaUrl(req.body?.listaUrl));
  } catch (err) {
    if (err.code === 'LISTA_INVALIDA') {
      return res.status(400).json({ error: err.message, code: err.code });
    }
    console.error('Error en adminPutContenido:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

module.exports = {
  paginaHtml,
  contenidoPublico,
  adminGetAcceso,
  adminRotarAcceso,
  adminGetContenido,
  adminPutContenido,
};
