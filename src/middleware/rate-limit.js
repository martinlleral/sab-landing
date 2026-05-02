const rateLimit = require('express-rate-limit');

// Rate limiter para /api/auth/login
// Objetivo: bloquear bruteforce del backoffice. Con bcrypt cost 10 sin lockout,
// un diccionario de 10k passwords se prueba en minutos si se paraleliza.
// 10 intentos / 15 min es holgado para humanos legítimos (incluso tipeando mal
// el password 3-4 veces) pero corta cualquier script de fuerza bruta.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_LOGIN_MAX, 10) || 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos. Esperá unos minutos.' },
});

// Rate limiter para /api/compras/preferencia
// Objetivo: evitar que un bot llene la tabla de compras pending, consuma la
// cuota de la API de MP y ensucie el cron de sync (que itera pending cada 60s).
// 20 req/min es ~1 compra cada 3s sostenido, muy por arriba del tráfico humano
// esperado incluso en pico de venta. NO afecta /webhook ni /check/:id.
const comprasLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_COMPRAS_MAX, 10) || 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes. Esperá un momento.' },
});

// Rate limiter para /api/cupones/validar
// Objetivo: el endpoint es público y permite chequear si un código de cupón
// existe/aplica. Sin límite, alguien podría brute-forcear el espacio de códigos.
// 30 req/min por IP es holgado para uso humano legítimo (alguien probando
// 2-3 códigos antes de pagar) pero corta scripts. NO afecta crearPreferencia.
const cuponesValidarLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_CUPON_VALIDAR_MAX, 10) || 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de validación. Esperá un momento.' },
});

module.exports = { loginLimiter, comprasLimiter, cuponesValidarLimiter };
