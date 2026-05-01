const express = require('express');
const controller = require('../controllers/eventos.controller');
const { requireAdmin } = require('../middleware/auth.middleware');
const { uploadEvento } = require('../middleware/upload.middleware');

function withUpload(handler) {
  return (req, res, next) => {
    uploadEvento(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message });
      next();
    });
  };
}

// Rutas públicas: montadas en /api/eventos
const publicRouter = express.Router();
publicRouter.get('/destacado', controller.getDestacado);
publicRouter.get('/proximos', controller.getProximos);

// Rutas admin: montadas en /api/admin/eventos
const adminRouter = express.Router();
adminRouter.use(requireAdmin);
adminRouter.get('/pasados', controller.adminListarPasados);
adminRouter.get('/:id/stats', controller.adminEventoStats);
adminRouter.get('/:id/invitaciones', controller.adminListarInvitaciones);
adminRouter.post('/:id/invitacion', controller.adminEnviarInvitacion);
adminRouter.get('/:id', controller.adminGetById);
adminRouter.get('/', controller.adminListar);
adminRouter.post('/', withUpload(), controller.adminCrear);
adminRouter.put('/:id', withUpload(), controller.adminEditar);
adminRouter.delete('/:id', controller.adminEliminar);

module.exports = { publicRouter, adminRouter };
