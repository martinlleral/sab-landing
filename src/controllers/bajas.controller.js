const path = require('path');
const service = require('../services/bajas.service');
const { abiertas } = require('../config/afiliaciones');

/**
 * El Botón de baja de servicio: la página /baja, el pedido público y la lista del
 * panel. La página existe desde el deploy (la prueba real la usa antes de la
 * salida); hasta la salida no se indexa, como /afiliate.
 */
const PAGINA = path.join(__dirname, '../../public/baja.html');

function pagina(_req, res) {
  if (!abiertas()) res.set('X-Robots-Tag', 'noindex, nofollow');
  return res.sendFile(PAGINA);
}

// POST /api/bajas — público, sin login (la norma no deja pedirlo), con límite
// por IP. Responde con el código y la fecha; nunca con los datos ni el id.
async function crear(req, res) {
  const v = service.validar(req.body);
  if (!v.ok) {
    return res.status(400).json({ error: 'Revisá los datos marcados.', code: 'BAJA_DATOS_INVALIDOS', campos: v.campos });
  }
  let baja;
  try {
    baja = await service.registrar(v.datos);
  } catch (err) {
    console.error('Error al registrar un pedido de baja:', err);
    return res.status(500).json({ error: 'No pudimos registrar tu pedido. Probá de nuevo en un rato.' });
  }
  // Los avisos van en segundo plano: Brevo reintenta con espera y quien pidió la
  // baja ya tiene su código en la pantalla. `avisar` no tira.
  service.avisar(baja).catch((err) => console.error('[bajas] avisar falló:', err));
  return res.status(201).json({ codigo: baja.codigo, createdAt: baja.createdAt });
}

// ── Admin (tras requireAdmin) ────────────────────────────────────────────────

function mapBaja(b) {
  return {
    id: b.id,
    codigo: b.codigo,
    nombre: b.nombre,
    email: b.email,
    mensaje: b.mensaje,
    createdAt: b.createdAt,
    confirmacionEnviadaAt: b.confirmacionEnviadaAt,
    avisoEnviadoAt: b.avisoEnviadoAt,
    atendidaAt: b.atendidaAt,
    atendidaPor: b.atendidaPor,
  };
}

async function adminListar(_req, res) {
  try {
    const bajas = await service.listar();
    return res.json({ bajas: bajas.map(mapBaja) });
  } catch (err) {
    console.error('Error en adminListar bajas:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// PATCH /api/admin/bajas/:id  { atendida: true | false }
async function adminMarcar(req, res) {
  const id = Number.parseInt(req.params.id, 10);
  const atendida = req.body ? req.body.atendida : undefined;
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Pedido inválido' });
  if (typeof atendida !== 'boolean') return res.status(400).json({ error: 'Falta decir si está hecha (sí o no)' });
  try {
    const por = (req.session && req.session.usuario && req.session.usuario.email) || '';
    const baja = await service.cambiarAtendida(id, atendida, por);
    if (!baja) return res.status(404).json({ error: 'No existe ese pedido' });
    return res.json({ baja: mapBaja(baja) });
  } catch (err) {
    console.error('Error en adminMarcar baja:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

module.exports = { pagina, crear, adminListar, adminMarcar };
