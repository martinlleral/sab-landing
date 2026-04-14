const express = require('express');
const router = express.Router();
const controller = require('../controllers/entradas.controller');
const { requireAdmin } = require('../middleware/auth.middleware');

router.post('/validar-qr', requireAdmin, controller.validarPorQR);
router.get('/:id', requireAdmin, controller.adminGetById);
router.put('/:id/validar', requireAdmin, controller.validar);

module.exports = router;
