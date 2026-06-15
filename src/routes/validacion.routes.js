const express = require('express');
const entradasController = require('../controllers/entradas.controller');
const validacionTokenController = require('../controllers/validacionToken.controller');
const { requireAdmin, requireValidationToken } = require('../middleware/auth.middleware');
const { validacionQRLimiter } = require('../middleware/rate-limit');

// ============================================================================
// Validación de entradas por QR con token compartible (ítem 2 / Sprint 5).
// ============================================================================

// Rutas PÚBLICAS — montadas en /api/validacion. El rate-limiter aplica a todo el
// router; requireValidationToken valida el token de la URL. El token es global
// (sirve para cualquier evento) y no expira: se desactiva desde el backoffice.
const publicRouter = express.Router();
publicRouter.use(validacionQRLimiter);
publicRouter.get('/:token/check', requireValidationToken, validacionTokenController.checkToken);
publicRouter.post('/:token/qr', requireValidationToken, entradasController.validarPorQRPublico);

// Rutas ADMIN — montadas en /api/admin/validacion-tokens (tras requireAdmin).
const adminRouter = express.Router();
adminRouter.use(requireAdmin);
adminRouter.post('/', validacionTokenController.adminGenerar);       // crear token
adminRouter.get('/', validacionTokenController.adminListar);         // listar tokens
adminRouter.patch('/:id', validacionTokenController.adminSetActivo); // activar/desactivar

module.exports = { publicRouter, adminRouter };
