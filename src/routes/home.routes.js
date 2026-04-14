const express = require('express');
const controller = require('../controllers/home.controller');
const { requireAdmin } = require('../middleware/auth.middleware');
const { uploadHome } = require('../middleware/upload.middleware');

// Rutas públicas: montadas en /api/home
const publicRouter = express.Router();
publicRouter.get('/', controller.getHome);

// Rutas admin: montadas en /api/admin/home
const adminRouter = express.Router();
adminRouter.use(requireAdmin);
adminRouter.put('/', (req, res, next) => {
  uploadHome(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, controller.updateHome);

module.exports = { publicRouter, adminRouter };
