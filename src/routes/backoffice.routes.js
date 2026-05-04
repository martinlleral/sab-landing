const express = require('express');
const path = require('path');
const router = express.Router();
const { requireAdmin } = require('../middleware/auth.middleware');

const BACKOFFICE_DIR = path.join(__dirname, '../../public/backoffice');

router.get('/login.html', (_req, res) => {
  res.sendFile(path.join(BACKOFFICE_DIR, 'login.html'));
});

router.get('/dashboard.html', requireAdmin, (_req, res) => {
  res.sendFile(path.join(BACKOFFICE_DIR, 'dashboard.html'));
});

router.get('/reportes.html', requireAdmin, (_req, res) => {
  res.sendFile(path.join(BACKOFFICE_DIR, 'reportes.html'));
});

router.get('/home-cms.html', requireAdmin, (_req, res) => {
  res.sendFile(path.join(BACKOFFICE_DIR, 'home-cms.html'));
});

router.get('/eventos-lista.html', requireAdmin, (_req, res) => {
  res.sendFile(path.join(BACKOFFICE_DIR, 'eventos-lista.html'));
});

router.get('/evento-detalle.html', requireAdmin, (_req, res) => {
  res.sendFile(path.join(BACKOFFICE_DIR, 'evento-detalle.html'));
});

router.get('/evento-compras.html', requireAdmin, (_req, res) => {
  res.sendFile(path.join(BACKOFFICE_DIR, 'evento-compras.html'));
});

router.get('/lector-qr.html', requireAdmin, (_req, res) => {
  res.sendFile(path.join(BACKOFFICE_DIR, 'lector-qr.html'));
});

router.get('/', (_req, res) => {
  res.redirect('/backoffice/login.html');
});

module.exports = router;
