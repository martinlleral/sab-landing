const service = require('../services/validationToken.service');

// Meta mínima del token para la vista pública (tras requireValidationToken, que
// ya verificó que existe y está activo). Permite que la pantalla muestre la
// descripción ("Validadores Casa Metro") y confirme que el acceso sigue vigente.
async function checkToken(req, res) {
  return res.json({ ok: true, descripcion: req.validationToken?.descripcion || '' });
}

// ── Admin (tras requireAdmin) ────────────────────────────────────────────────

async function adminGenerar(req, res) {
  try {
    const { descripcion } = req.body;
    const creadoPor = req.session?.usuario?.email || '';
    const registro = await service.generarToken({ descripcion, creadoPor });
    return res.status(201).json({
      id: registro.id,
      token: registro.token,
      descripcion: registro.descripcion,
      activo: registro.activo,
      url: `/validar/${registro.token}`,
      createdAt: registro.createdAt,
    });
  } catch (err) {
    console.error('Error en adminGenerar validacion:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

function mapToken(t) {
  return {
    id: t.id,
    token: t.token,
    descripcion: t.descripcion,
    activo: t.activo,
    creadoPor: t.creadoPor,
    ultimoAcceso: t.ultimoAcceso,
    createdAt: t.createdAt,
    url: `/validar/${t.token}`,
  };
}

async function adminListar(_req, res) {
  try {
    const tokens = await service.listar();
    return res.json(tokens.map(mapToken));
  } catch (err) {
    console.error('Error en adminListar validacion:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// Activa o desactiva un token (toggle). Body: { activo: boolean }.
async function adminSetActivo(req, res) {
  try {
    const { activo } = req.body;
    if (typeof activo !== 'boolean') {
      return res.status(400).json({ error: 'activo (boolean) requerido' });
    }
    const updated = await service.setActivo(req.params.id, activo);
    if (!updated) return res.status(404).json({ error: 'Token no encontrado' });
    return res.json({ id: updated.id, activo: updated.activo });
  } catch (err) {
    console.error('Error en adminSetActivo validacion:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

module.exports = { checkToken, adminGenerar, adminListar, adminSetActivo };
