const express = require('express');
const reporteController = require('../controllers/reporte.controller');
const dashboardController = require('../controllers/dashboard.controller');
const { requireAdmin, requireReportToken } = require('../middleware/auth.middleware');
const { reportePublicoLimiter } = require('../middleware/rate-limit');

// ============================================================================
// Reporte de Ventas por Evento (#9).
// ============================================================================

// Rutas PÚBLICAS — montadas en /api/reporte. El rate-limiter aplica a todo el
// router; requireReportToken valida el token de la URL e inyecta el eventoId en
// req.query/req.params, de modo que los controllers del dashboard se reusan SIN
// tocarlos. Solo se exponen los 4 endpoints estrictamente por-evento: NO se
// montan aporteExtra/validacionQR/comparativaEventos/topCupones porque devuelven
// breakdowns con datos de OTROS eventos (ver plan #9 / hallazgo de scoping).
const publicRouter = express.Router();
publicRouter.use(reportePublicoLimiter);
publicRouter.get('/:token/meta', requireReportToken, reporteController.meta);
publicRouter.get('/:token/resumen', requireReportToken, dashboardController.resumen);
publicRouter.get('/:token/ventas-timeline', requireReportToken, dashboardController.ventasTimeline);
publicRouter.get('/:token/distribucion-tandas', requireReportToken, dashboardController.distribucionTandas);
publicRouter.get('/:token/cadencia-tandas', requireReportToken, dashboardController.cadenciaTandas);

// Rutas ADMIN — montadas en /api/admin/reportes (tras requireAdmin).
const adminRouter = express.Router();
adminRouter.use(requireAdmin);
adminRouter.post('/', reporteController.adminGenerar);      // POST   /api/admin/reportes
adminRouter.get('/', reporteController.adminListar);        // GET    /api/admin/reportes?eventoId=:id
adminRouter.delete('/:id', reporteController.adminRevocar); // DELETE /api/admin/reportes/:id

module.exports = { publicRouter, adminRouter };
