const reportTokenService = require('../services/reportToken.service');
const validationTokenService = require('../services/validationToken.service');

// Helper: chequea si la request entrante es una ruta de API.
// Usar req.originalUrl en vez de req.path — cuando el middleware está montado
// dentro de un subrouter (ej. adminRouter.use(requireAdmin) en /api/admin/...),
// req.path sólo tiene la parte POST-mount ("/") y no matchea "/api/...".
// originalUrl siempre tiene la URL completa desde la raíz.
function isApiRequest(req) {
  return (req.originalUrl || req.url || '').startsWith('/api/');
}

function requireAuth(req, res, next) {
  if (!req.session || !req.session.usuario) {
    if (isApiRequest(req)) {
      return res.status(401).json({ error: 'No autenticado' });
    }
    return res.redirect('/backoffice/login.html');
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session || !req.session.usuario) {
    if (isApiRequest(req)) {
      return res.status(401).json({ error: 'No autenticado' });
    }
    return res.redirect('/backoffice/login.html');
  }
  if (req.session.usuario.rol !== 1) {
    if (isApiRequest(req)) {
      return res.status(403).json({ error: 'Acceso denegado' });
    }
    return res.redirect('/backoffice/login.html');
  }
  next();
}

// Middleware del endpoint PÚBLICO de Reporte de Ventas por Evento (#9).
// Valida el token de la URL (req.params.token); si es válido, inyecta el
// eventoId en req.query/req.params para REUSAR los controllers del dashboard
// sin modificarlos (resumen lee req.query.eventoId; distribucion/cadencia leen
// req.params.id). La respuesta de fallo es UNIFORME (mismo 404 para token
// inexistente / revocado / vencido) — el code real solo se loguea, no se filtra
// al cliente. Ver insight_hardening_endpoint_publico.
async function requireReportToken(req, res, next) {
  try {
    const { valido, eventoId, registro, code } = await reportTokenService.validarToken(req.params.token);
    if (!valido) {
      console.warn(`[reporte] token rechazado code=${code}`);
      return res.status(404).json({ error: 'Reporte no disponible o expirado' });
    }
    req.query.eventoId = String(eventoId);
    req.params.id = String(eventoId);
    req.reportToken = registro;
    res.set('Cache-Control', 'no-store');
    next();
  } catch (err) {
    console.error('Error en requireReportToken:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// Middleware del endpoint PÚBLICO de validación de entradas por QR (ítem 2).
// Valida el token de la URL (req.params.token); si es válido, lo deja en
// req.validationToken y sigue. La respuesta de fallo es UNIFORME (mismo 404
// para token inexistente o revocado) — el code real solo se loguea. No inyecta
// eventoId: este token es global (valida QR de cualquier evento).
async function requireValidationToken(req, res, next) {
  try {
    const { valido, registro, code } = await validationTokenService.validarToken(req.params.token);
    if (!valido) {
      console.warn(`[validacion] token rechazado code=${code}`);
      return res.status(404).json({ error: 'Acceso de validación no disponible' });
    }
    req.validationToken = registro;
    res.set('Cache-Control', 'no-store');
    next();
  } catch (err) {
    console.error('Error en requireValidationToken:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

module.exports = { requireAuth, requireAdmin, requireReportToken, requireValidationToken };
