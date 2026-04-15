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
adminRouter.delete('/:id', controller.adminEliminar);
adminRouter.get('/:id', controller.adminGetById);
adminRouter.get('/', controller.adminListar);

module.exports = { publicRouter, adminRouter };
