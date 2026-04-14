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
async function start() {
  try {
    await prisma.$connect();
    console.log('✅ Base de datos conectada');

    app.listen(config.port, () => {
      console.log(`🚀 Servidor corriendo en http://localhost:${config.port}`);
      console.log(`📋 Backoffice: http://localhost:${config.port}/backoffice/login.html`);

      // Cron: sync pagos pendientes con MP cada 60s
      syncPagosPendientes(); // ejecución inicial
      setInterval(syncPagosPendientes, 60 * 1000);
      console.log('⏱  Cron sync pagos activo (cada 60s)');
    });
  } catch (err) {
    console.error('❌ Error al iniciar el servidor:', err);
    process.exit(1);
  }
}

process.on('SIGTERM', async () => {
  await prisma.$disconnect();
  process.exit(0);
});

start();
