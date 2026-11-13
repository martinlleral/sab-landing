const express = require('express');
const controller = require('../controllers/afiliados.controller');
const { requireAdmin, requireAccesoAfiliados } = require('../middleware/auth.middleware');
const { afiliadosLimiter } = require('../middleware/rate-limit');

// ============================================================================
// La página de afiliadxs (escalón 0).
// ============================================================================

// PÚBLICA — montada en /api/afiliados. La dirección privada es la llave.
const publicRouter = express.Router();
publicRouter.use(afiliadosLimiter);
publicRouter.get('/:token', requireAccesoAfiliados, controller.contenidoPublico);

// ADMIN — montada en /api/admin/afiliados (no-store ya lo pone /api/admin).
const adminRouter = express.Router();
adminRouter.use(requireAdmin);
adminRouter.get('/acceso', controller.adminGetAcceso);          // la dirección vigente
adminRouter.post('/acceso/rotar', controller.adminRotarAcceso); // una nueva, apaga la anterior
adminRouter.get('/contenido', controller.adminGetContenido);    // la lista de videos
adminRouter.put('/contenido', controller.adminPutContenido);

module.exports = { publicRouter, adminRouter };
