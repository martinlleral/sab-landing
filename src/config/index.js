require('dotenv').config();

module.exports = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT) || 3000,
  databaseUrl: process.env.DATABASE_URL || 'file:./dev.db',
  sessionSecret: process.env.SESSION_SECRET || 'dev_secret_change_in_production',
  sessionDuration: 8 * 60 * 60 * 1000, // 8 horas en ms
  mercadopago: {
    accessToken: process.env.MP_ACCESS_TOKEN || '',
    publicKey: process.env.MP_PUBLIC_KEY || '',
    webhookSecret: process.env.MP_WEBHOOK_SECRET || '',
    userId: process.env.MP_USER_ID || '',
  },
  smtp: {
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT) || 587,
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.EMAIL_FROM || 'noreply@sindicatodeboleros.com',
    fromName: process.env.EMAIL_FROM_NAME || 'Sindicato Argentino de Boleros',
  },
  // Si BREVO_API_KEY está seteada, el servicio de mail usa HTTP API de Brevo
  // (POST api.brevo.com/v3/smtp/email) en vez de SMTP. Workaround para el
  // bloqueo de puertos 25/465/587 outbound de DigitalOcean.
  brevo: {
    apiKey: process.env.BREVO_API_KEY || '',
  },
  baseUrl: process.env.BASE_URL || 'http://localhost:3000',
  uploadLimits: {
    fileSize: 5 * 1024 * 1024, // 5MB
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
  },
};
