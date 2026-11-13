const express = require('express');
const controller = require('../controllers/bajas.controller');
const { requireAdmin } = require('../middleware/auth.middleware');
const { bajasLimiter } = require('../middleware/rate-limit');

// ============================================================================
// El Botón de baja de servicio (Disposición 954/2025).
// ============================================================================

// PÚBLICA — montada en /api/bajas. Sin login: la norma no deja pedir
// registración previa. El límite por IP corta a quien lo use para mandar mails.
const publicRouter = express.Router();
publicRouter.post('/', bajasLimiter, controller.crear);

// ADMIN — montada en /api/admin/bajas (no-store ya lo pone /api/admin).
const adminRouter = express.Router();
adminRouter.use(requireAdmin);
adminRouter.get('/', controller.adminListar);
adminRouter.patch('/:id', controller.adminMarcar);

module.exports = { publicRouter, adminRouter };
