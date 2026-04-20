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

module.exports = { requireAuth, requireAdmin };
