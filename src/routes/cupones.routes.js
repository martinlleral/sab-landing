const express = require('express');
const controller = require('../controllers/cupones.controller');
const { requireAdmin } = require('../middleware/auth.middleware');

// Rutas admin: montadas en /api/admin/cupones
const adminRouter = express.Router();
adminRouter.use(requireAdmin);
adminRouter.get('/', controller.adminListar);          // GET /api/admin/cupones?eventoId=:id&activo=true
adminRouter.get('/:id', controller.adminGetById);      // GET /api/admin/cupones/:id (incluye usos)
adminRouter.post('/', controller.adminCrear);          // POST /api/admin/cupones
adminRouter.patch('/:id', controller.adminActualizar); // PATCH /api/admin/cupones/:id
adminRouter.delete('/:id', controller.adminEliminar);  // DELETE /api/admin/cupones/:id (solo si usosActuales=0)

module.exports = { adminRouter };
