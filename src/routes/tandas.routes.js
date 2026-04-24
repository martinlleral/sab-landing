const express = require('express');
const controller = require('../controllers/tandas.controller');
const { requireAdmin } = require('../middleware/auth.middleware');

// Rutas admin: montadas en /api/admin/tandas
const adminRouter = express.Router();
adminRouter.use(requireAdmin);
adminRouter.get('/', controller.adminListar);       // GET /api/admin/tandas?eventoId=:id
adminRouter.post('/', controller.adminCrear);        // POST /api/admin/tandas
adminRouter.patch('/:id', controller.adminActualizar);
adminRouter.delete('/:id', controller.adminEliminar);

module.exports = { adminRouter };
