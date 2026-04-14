const express = require('express');
const router = express.Router();
const controller = require('../controllers/usuarios.controller');
const { requireAdmin } = require('../middleware/auth.middleware');

router.get('/', requireAdmin, controller.adminListar);
router.post('/', requireAdmin, controller.adminCrear);
router.put('/:id', requireAdmin, controller.adminEditar);

module.exports = router;
