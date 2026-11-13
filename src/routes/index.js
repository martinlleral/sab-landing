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
const { publicRouter: validacionPublic, adminRouter: validacionAdmin } = require('./validacion.routes');
const { publicRouter: afiliadosPublic, adminRouter: afiliadosAdmin } = require('./afiliados.routes');
const { publicRouter: bajasPublic, adminRouter: bajasAdmin } = require('./bajas.routes');
const afiliadosController = require('../controllers/afiliados.controller');
const afiliateController = require('../controllers/afiliate.controller');
const bajasController = require('../controllers/bajas.controller');
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
router.use('/api/validacion', validacionPublic);
router.use('/api/afiliados', afiliadosPublic);
router.use('/api/bajas', bajasPublic);

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
router.use('/api/admin/validacion-tokens', validacionAdmin);
router.use('/api/admin/afiliados', afiliadosAdmin);
router.use('/api/admin/bajas', bajasAdmin);

// Vista pública del Reporte por Evento (#9). El token va en el path; el HTML es
// estático y siempre se sirve — el JS valida el token contra /api/reporte/:token.
// No va bajo /backoffice, así que el guard de sesión (server.js) no lo bloquea.
// express.static ya sirve public/reporte/assets/*; solo /reporte/<token> cae acá.
router.get('/reporte/:token', (_req, res) => {
  res.sendFile(path.join(__dirname, '../../public/reporte/index.html'));
});

// Vista pública del validador de entradas por QR (ítem 2). El token va en el
// path; el HTML es estático y siempre se sirve — el JS valida el token contra
// /api/validacion/:token/check y escanea contra /api/validacion/:token/qr. No va
// bajo /backoffice, así que el guard de sesión no lo bloquea.
router.get('/validar/:token', (_req, res) => {
  res.sendFile(path.join(__dirname, '../../public/validar/index.html'));
});

// La página de afiliadxs (escalón 0). La dirección privada va en el path; el
// HTML es estático y siempre se sirve, con noindex, no-store y no-referrer — el
// JS manda la dirección a /api/afiliados/:token. `/afiliados` sola muestra el
// mismo cartel de «no vigente».
router.get(['/afiliados', '/afiliados/:token'], afiliadosController.paginaHtml);

// La página pública para afiliarse y la vuelta desde Mercado Pago (escalón 0).
// Existen desde el deploy; los links de la portada aparecen recién con la salida
// (src/config/afiliaciones.js).
router.get('/afiliate', afiliateController.pagina);
router.get('/afiliate/gracias', afiliateController.gracias);

// El Botón de baja de servicio (Disposición 954/2025): un formulario sin login
// que da un código. Existe desde el deploy; el link de la portada aparece con la
// salida y el de las páginas de afiliación está siempre.
router.get('/baja', bajasController.pagina);

// Backoffice HTML
router.use('/backoffice', backofficeRoutes);

// Rutas estáticas (catch-all)
router.use('/', staticRoutes);

module.exports = router;
