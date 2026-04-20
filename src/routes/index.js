const express = require('express');
const router = express.Router();

const authController = require('../controllers/auth.controller');
const staticRoutes = require('./static.routes');
const { publicRouter: eventosPublic, adminRouter: eventosAdmin } = require('./eventos.routes');
const { publicRouter: comprasPublic, adminRouter: comprasAdmin } = require('./compras.routes');
const { publicRouter: homePublic, adminRouter: homeAdmin } = require('./home.routes');
const entradasRoutes = require('./entradas.routes');
const usuariosRoutes = require('./usuarios.routes');
const backofficeRoutes = require('./backoffice.routes');

// Auth
router.post('/api/auth/login', authController.login);
router.post('/api/auth/logout', authController.logout);
router.get('/api/auth/me', authController.me);

// API pública
router.use('/api/eventos', eventosPublic);
router.use('/api/compras', comprasPublic);
router.use('/api/home', homePublic);

// API admin — Cache-Control: no-store para no filtrar datos privados vía proxies o btn "atrás"
router.use('/api/admin', (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
router.use('/api/admin/eventos', eventosAdmin);
router.use('/api/admin/compras', comprasAdmin);
router.use('/api/admin/entradas', entradasRoutes);
router.use('/api/admin/usuarios', usuariosRoutes);
router.use('/api/admin/home', homeAdmin);

// Backoffice HTML
router.use('/backoffice', backofficeRoutes);

// Rutas estáticas (catch-all)
router.use('/', staticRoutes);

module.exports = router;
