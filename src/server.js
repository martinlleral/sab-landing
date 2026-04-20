require('dotenv').config();
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const morgan = require('morgan');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const config = require('./config');
const prisma = require('./utils/prisma');
const routes = require('./routes');
const { syncPagosPendientes } = require('./jobs/syncPagos');
const { loginLimiter, comprasLimiter } = require('./middleware/rate-limit');

const app = express();

// Seguridad
app.use(helmet({
  contentSecurityPolicy: false,
}));

// Logs
app.use(morgan('combined'));

// Trust proxy (Cloudflare/nginx)
app.set('trust proxy', 1);

// CORS
// CORS restringido a dominios propios
// Lista por defecto + lo que se pase en ALLOWED_ORIGINS (separado por comas)
const defaultAllowedOrigins = [
  'https://sindicatoargentinodeboleros.com.ar',
  'https://www.sindicatoargentinodeboleros.com.ar',
  'http://localhost:3000',
];
const extraAllowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const allowedOrigins = [...defaultAllowedOrigins, ...extraAllowedOrigins];
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) cb(null, true);
    else cb(new Error('CORS no permitido'));
  },
  credentials: true,
}));

// Body parsers — límite conservador. Las subidas de imágenes pasan por
// multer (no json/urlencoded), así que bajar a 1mb no afecta uploads.
// Previene DoS por requests JSON grandes (10mb × 40 concurrentes = OOM
// fácil en un droplet de 512MB).
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Sesiones con SQLite
const SQLiteStore = require('connect-sqlite3')(session);
const sessionDbDir = path.join(__dirname, '../prisma');
if (!fs.existsSync(sessionDbDir)) fs.mkdirSync(sessionDbDir, { recursive: true });

app.use(session({
  store: new SQLiteStore({ db: 'sessions.db', dir: sessionDbDir }),
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false, // Cloudflare maneja HTTPS, conexión interna es HTTP
    httpOnly: true,
    maxAge: config.sessionDuration,
    sameSite: 'lax',
  },
}));

// Liveness + readiness probe: Prisma $queryRaw SELECT 1.
// Si la conexión a SQLite se pierde o Prisma entra en estado inconsistente,
// el endpoint devuelve 503 y Docker marca el container unhealthy → restart.
// nginx depende de esta healthcheck vía depends_on: service_healthy.
app.get('/healthz', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({
      status: 'ok',
      db: 'up',
      uptime: Math.round(process.uptime()),
    });
  } catch (err) {
    console.error('[healthz] DB check falló:', err.message);
    res.status(503).json({ status: 'error', db: 'down' });
  }
});

// Rate limiting en rutas sensibles (defensa en profundidad junto con nginx).
// Se montan antes de routes/static para que apliquen a las rutas del router.
// loginLimiter: bloquea bruteforce del admin en /api/auth/login.
// comprasLimiter: limita creación de preferencias MP, no toca /webhook (firma MP)
// ni /check (polling del cliente post-pago, parte del patrón 3-caminos).
app.use('/api/auth/login', loginLimiter);
app.use('/api/compras/preferencia', comprasLimiter);

// Guard del backoffice: express.static (que viene abajo) sirve cualquier archivo
// en public/, incluyendo public/backoffice/dashboard.html. Eso exponía la
// estructura del admin sin auth (no filtraba datos, pero daba señales al
// atacante). Este middleware deja pasar solo login.html; todo el resto
// redirige a login si no hay sesión admin activa.
app.use('/backoffice', (req, res, next) => {
  if (req.path === '/login.html' || req.path === '/login' || req.path === '/') {
    return next();
  }
  if (!req.session?.usuario || req.session.usuario.rol !== 1) {
    return res.redirect('/backoffice/login.html');
  }
  next();
});

// Archivos estáticos
app.use(express.static(path.join(__dirname, '../public'), {
  setHeaders: (res, filePath) => {
    // Cache-Control: no-store para HTML del backoffice (login + dashboard + CMS).
    // Previene que proxies intermedios o el botón "atrás" del browser sirvan
    // HTML cacheado tras logout.
    if (filePath.includes(`${path.sep}backoffice${path.sep}`)) {
      res.set('Cache-Control', 'no-store');
    }
  },
}));

// Asegurar que existan los directorios de uploads
const uploadDirs = [
  '../public/assets/img/uploads',
  '../public/assets/img/uploads/home',
  '../public/assets/img/uploads/eventos',
  '../public/assets/img/uploads/qr',
];
uploadDirs.forEach((dir) => {
  const full = path.join(__dirname, dir);
  if (!fs.existsSync(full)) fs.mkdirSync(full, { recursive: true });
});

// Rutas
app.use('/', routes);

// Manejo global de errores
app.use((err, req, res, _next) => {
  console.error('Error no manejado:', err);
  const status = err.status || 500;
  res.status(status).json({
    error: config.nodeEnv === 'production' ? 'Error interno del servidor' : err.message,
  });
});

// Iniciar servidor
let server;
let syncInterval;

// Fail-fast: verifica que los tokens de MercadoPago tengan el formato esperado.
// Previene typos silenciosos tipo "APP_USER-" vs "APP_USR-" que solo se manifiestan
// cuando un comprador real intenta pagar (aprendido el 20/4/2026).
function validateMpTokens() {
  const errors = [];
  const t = config.mercadopago.accessToken;
  const k = config.mercadopago.publicKey;

  if (!t) {
    errors.push('MP_ACCESS_TOKEN vacío');
  } else if (!t.startsWith('APP_USR-') && !t.startsWith('TEST-')) {
    errors.push(`MP_ACCESS_TOKEN formato inválido (esperado prefix "APP_USR-" o "TEST-", recibido "${t.substring(0, 10)}..."). Probable typo en .env`);
  }

  if (!k) {
    errors.push('MP_PUBLIC_KEY vacío');
  } else if (!k.startsWith('APP_USR-') && !k.startsWith('TEST-')) {
    errors.push(`MP_PUBLIC_KEY formato inválido (esperado prefix "APP_USR-" o "TEST-", recibido "${k.substring(0, 10)}..."). Probable typo en .env`);
  }

  return errors;
}

async function start() {
  if (config.nodeEnv === 'production' && config.sessionSecret === 'dev_secret_change_in_production') {
    console.error('FATAL: SESSION_SECRET no configurado en producción. Setear en .env antes de arrancar.');
    process.exit(1);
  }

  if (config.nodeEnv === 'production') {
    const mpErrors = validateMpTokens();
    if (mpErrors.length > 0) {
      console.error('FATAL: credenciales MercadoPago inválidas:');
      mpErrors.forEach((e) => console.error('  - ' + e));
      console.error('Corregir en .env antes de arrancar. Las credenciales correctas están en panel MP → Credenciales.');
      process.exit(1);
    }
  }

  try {
    await prisma.$connect();
    console.log('✅ Base de datos conectada');

    server = app.listen(config.port, () => {
      console.log(`🚀 Servidor corriendo en http://localhost:${config.port}`);
      console.log(`📋 Backoffice: http://localhost:${config.port}/backoffice/login.html`);

      // Cron: sync pagos pendientes con MP cada 60s
      syncPagosPendientes(); // ejecución inicial
      syncInterval = setInterval(syncPagosPendientes, 60 * 1000);
      console.log('⏱  Cron sync pagos activo (cada 60s)');
    });
  } catch (err) {
    console.error('❌ Error al iniciar el servidor:', err);
    process.exit(1);
  }
}

// Graceful shutdown: cierra conexiones HTTP en vuelo y Prisma antes de exit.
// Previene cortes a webhooks MP en pleno procesamiento durante docker compose restart.
async function shutdown(signal) {
  console.log(`[${signal}] recibido, iniciando graceful shutdown...`);

  // Failsafe: si algo se cuelga, forzar exit después de 10s.
  const forceExit = setTimeout(() => {
    console.error('[shutdown] timeout 10s, forzando exit');
    process.exit(1);
  }, 10000);
  forceExit.unref();

  try {
    if (syncInterval) clearInterval(syncInterval);
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      console.log('[shutdown] servidor HTTP cerrado');
    }
    await prisma.$disconnect();
    console.log('[shutdown] Prisma desconectado. Bye.');
    process.exit(0);
  } catch (err) {
    console.error('[shutdown] error durante shutdown:', err);
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start();
