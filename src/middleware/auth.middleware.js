function requireAuth(req, res, next) {
  if (!req.session || !req.session.usuario) {
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'No autenticado' });
    }
    return res.redirect('/backoffice/login.html');
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session || !req.session.usuario) {
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'No autenticado' });
    }
    return res.redirect('/backoffice/login.html');
  }
  if (req.session.usuario.rol !== 1) {
    if (req.path.startsWith('/api/')) {
      return res.status(403).json({ error: 'Acceso denegado' });
    }
    return res.redirect('/backoffice/login.html');
  }
  next();
}

module.exports = { requireAuth, requireAdmin };
