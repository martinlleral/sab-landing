const express = require('express');
const controller = require('../controllers/dashboard.controller');
const { requireAdmin } = require('../middleware/auth.middleware');

// Todos los endpoints son /api/admin/dashboard/*. El middleware Cache-Control
// no-store de /api/admin ya está aplicado en routes/index.js.
const router = express.Router();
router.use(requireAdmin);

router.get('/resumen', controller.resumen);
router.get('/ventas-timeline', controller.ventasTimeline);
router.get('/distribucion-tandas/:id', controller.distribucionTandas);
router.get('/comparativa-eventos', controller.comparativaEventos);
router.get('/aporte-extra', controller.aporteExtra);
router.get('/cadencia-tandas/:id', controller.cadenciaTandas);
router.get('/validacion-qr', controller.validacionQR);
router.get('/top-cupones', controller.topCupones);
router.get('/waitlist', controller.waitlist);

module.exports = router;
