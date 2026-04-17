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

// Body parsers
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

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

// Archivos estáticos
app.use(express.static(path.join(__dirname, '../public')));

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

async function start() {
  if (config.nodeEnv === 'production' && config.sessionSecret === 'dev_secret_change_in_production') {
    console.error('FATAL: SESSION_SECRET no configurado en producción. Setear en .env antes de arrancar.');
    process.exit(1);
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
