const express = require('express');
const path = require('path');
const router = express.Router();

const authController = require('../controllers/auth.controller');
const eventosController = require('../controllers/eventos.controller');
const { requireAdmin } = require('../middleware/auth.middleware');
const staticRoutes = require('./static.routes');
const { publicRouter: eventosPublic, adminRouter: eventosAdmin } = require('./eventos.routes');
const { publicRouter: comprasPublic, adminRouter: comprasAdmin } = require('./compras.routes');
const { publicRouter: homePublic, adminRouter: homeAdmin } = require('./home.routes');
const { adminRouter: tandasAdmin } = require('./tandas.routes');
const { publicRouter: cuponesPublic, adminRouter: cuponesAdmin } = require('./cupones.routes');
const { publicRouter: reportePublic, adminRouter: reporteAdmin } = require('./reporte.routes');
const dashboardRoutes = require('./dashboard.routes');
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
router.use('/api/cupones', cuponesPublic);
router.use('/api/reporte', reportePublic);

// API admin — Cache-Control: no-store para no filtrar datos privados vía proxies o btn "atrás"
router.use('/api/admin', (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
router.get('/api/admin/stats', requireAdmin, eventosController.adminStatsGlobal);
router.use('/api/admin/eventos', eventosAdmin);
router.use('/api/admin/compras', comprasAdmin);
router.use('/api/admin/entradas', entradasRoutes);
router.use('/api/admin/usuarios', usuariosRoutes);
router.use('/api/admin/home', homeAdmin);
router.use('/api/admin/tandas', tandasAdmin);
router.use('/api/admin/cupones', cuponesAdmin);
router.use('/api/admin/dashboard', dashboardRoutes);
router.use('/api/admin/reportes', reporteAdmin);

// Vista pública del Reporte por Evento (#9). El token va en el path; el HTML es
// estático y siempre se sirve — el JS valida el token contra /api/reporte/:token.
// No va bajo /backoffice, así que el guard de sesión (server.js) no lo bloquea.
// express.static ya sirve public/reporte/assets/*; solo /reporte/<token> cae acá.
router.get('/reporte/:token', (_req, res) => {
  res.sendFile(path.join(__dirname, '../../public/reporte/index.html'));
});

// Backoffice HTML
router.use('/backoffice', backofficeRoutes);

// Rutas estáticas (catch-all)
router.use('/', staticRoutes);

module.exports = router;
