const express = require('express');
const controller = require('../controllers/compras.controller');
const { requireAdmin } = require('../middleware/auth.middleware');

// Rutas públicas: montadas en /api/compras
const publicRouter = express.Router();
publicRouter.post('/preferencia', controller.crearPreferencia);
publicRouter.post('/webhook', controller.webhook);
publicRouter.post('/check/:preferenciaId', controller.checkAndProcess);

// Rutas admin: montadas en /api/admin/compras
const adminRouter = express.Router();
adminRouter.use(requireAdmin);
adminRouter.delete('/pendientes', controller.adminEliminarPendientes);
adminRouter.post('/:id/reenviar-mail', controller.adminReenviarMail);
adminRouter.post('/:id/devolver', controller.adminDevolver);
adminRouter.delete('/:id', controller.adminEliminar);
// ⚠️ ANTES de '/:id': Express matchea por orden de registro, así que con
// '/:id' declarado primero la descarga entraría por `adminGetById` con
// `parseInt('export')` = NaN, y el operador vería "Compra no encontrada" en vez
// del CSV. Mismo motivo por el que '/pendientes' está arriba de todo.
adminRouter.get('/export', controller.adminExportar);
adminRouter.get('/:id', controller.adminGetById);
adminRouter.get('/', controller.adminListar);

module.exports = { publicRouter, adminRouter };
