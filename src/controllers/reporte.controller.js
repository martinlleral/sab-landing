const prisma = require('../utils/prisma');
const reportTokenService = require('../services/reportToken.service');

// ============================================================================
// Reporte de Ventas por Evento (#9) — link público con token de solo-lectura.
// Los datos del reporte (resumen/timeline/tandas/cadencia) los sirven los
// controllers del dashboard REUSADOS (ver reporte.routes.js); acá solo viven el
// `meta` público y los handlers admin de gestión de links.
// ============================================================================

// GET /api/reporte/:token/meta — datos mínimos del evento + expiración del link,
// para el encabezado de la vista pública y para detectar token inválido al
// inicio. El middleware requireReportToken ya validó el token e inyectó
// req.params.id con el eventoId del token.
async function meta(req, res) {
  try {
    const eventoId = parseInt(req.params.id, 10);
    const evento = await prisma.evento.findUnique({
      where: { id: eventoId },
      select: { nombre: true, fecha: true, hora: true },
    });
    if (!evento) {
      // El token apunta a un evento que ya no existe → mismo 404 uniforme.
      return res.status(404).json({ error: 'Reporte no disponible o expirado' });
    }
    return res.json({
      evento,
      expiraEn: req.reportToken ? req.reportToken.expiraEn : null,
    });
  } catch (err) {
    console.error('Error en reporte.meta:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// POST /api/admin/reportes — genera un link de reporte para un evento.
// Body: { eventoId, expiraEnDias }. Solo admin (requireAdmin en la ruta).
async function adminGenerar(req, res) {
  try {
    const { eventoId, expiraEnDias } = req.body || {};
    if (!eventoId) return res.status(400).json({ error: 'Falta eventoId' });

    const creadoPor = req.session?.usuario?.email || '';

    let registro;
    try {
      registro = await reportTokenService.generarToken(eventoId, { expiraEnDias, creadoPor });
    } catch (err) {
      if (err.code === 'EVENTO_NO_ENCONTRADO') return res.status(404).json({ error: 'Evento no encontrado' });
      if (err.code === 'EVENTO_INVALIDO') return res.status(400).json({ error: 'eventoId inválido' });
      throw err;
    }

    return res.status(201).json({
      id: registro.id,
      token: registro.token,
      url: `/reporte/${registro.token}`,
      expiraEn: registro.expiraEn,
      createdAt: registro.createdAt,
    });
  } catch (err) {
    console.error('Error en reporte.adminGenerar:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// GET /api/admin/reportes?eventoId=:id — lista los links de un evento (para
// re-copiar o revocar). El token completo se devuelve porque va tras requireAdmin.
async function adminListar(req, res) {
  try {
    const { eventoId } = req.query;
    if (!eventoId) return res.status(400).json({ error: 'Falta eventoId' });

    const tokens = await reportTokenService.listarPorEvento(eventoId);
    const ahora = Date.now();
    return res.json(tokens.map((t) => ({
      id: t.id,
      token: t.token,
      url: `/reporte/${t.token}`,
      expiraEn: t.expiraEn,
      activo: t.activo,
      vencido: t.expiraEn.getTime() < ahora,
      creadoPor: t.creadoPor,
      ultimoAcceso: t.ultimoAcceso,
      createdAt: t.createdAt,
    })));
  } catch (err) {
    console.error('Error en reporte.adminListar:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// DELETE /api/admin/reportes/:id — revoca un link (soft-delete activo=false).
// La fila queda para auditoría; el token deja de validar de inmediato.
async function adminRevocar(req, res) {
  try {
    const registro = await reportTokenService.revocar(req.params.id);
    if (!registro) return res.status(404).json({ error: 'Token no encontrado' });
    return res.json({ ok: true });
  } catch (err) {
    console.error('Error en reporte.adminRevocar:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

module.exports = { meta, adminGenerar, adminListar, adminRevocar };
