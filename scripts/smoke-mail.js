#!/usr/bin/env node
/**
 * Smoke test de envío de email (confirmación de compra con QR).
 *
 * Se auto-selecciona entre Brevo HTTP API (si BREVO_API_KEY está seteada)
 * y SMTP clásico (SMTP_HOST/USER/PASS).
 *
 * Uso:
 *   SMOKE_TO=martin@ejemplo.com node scripts/smoke-mail.js
 *
 * Variables requeridas:
 *   SMOKE_TO           destinatario del mail de prueba
 *   EMAIL_FROM         remitente (dominio debe estar validado en Brevo/SPF)
 *   EMAIL_FROM_NAME    display name (opcional)
 *   BREVO_API_KEY      si se quiere usar HTTP API. Si no, usa SMTP.
 *   SMTP_HOST/USER/PASS  si no hay BREVO_API_KEY.
 *
 * Devuelve exit 0 si el envío fue OK. Exit 1 si falló.
 * Un envío "OK" significa que el proveedor aceptó el mail — todavía puede caer
 * en spam. Revisar la bandeja del destinatario y, si no llega, los logs de Brevo.
 */

require('dotenv').config();
const brevoService = require('../src/services/brevo.service');

const TO = process.env.SMOKE_TO;

if (!TO) {
  console.error('❌ Falta SMOKE_TO=destinatario@ejemplo.com');
  process.exit(1);
}

// QR dummy 1x1 transparente — es un PNG válido mínimo para no romper el render
const DUMMY_QR_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=';

(async () => {
  try {
    console.log(`\nSmoke test email → ${TO}\n`);
    const result = await brevoService.enviarConfirmacion({
      email: TO,
      nombre: 'Test Smoke',
      evento: {
        nombre: '[SMOKE TEST] Sindicato Argentino de Boleros',
        fecha: new Date(),
        hora: '21:30',
        invitado: 'Invitado de prueba',
      },
      entradas: [
        { codigoQR: 'SMOKE-001', qrBase64: DUMMY_QR_BASE64 },
      ],
    });
    console.log('\n✅ PASS — email enviado, messageId:', result.messageId);
    console.log('   Revisá la bandeja de', TO, '(y spam) en los próximos segundos.\n');
    process.exit(0);
  } catch (err) {
    console.error('\n❌ FAIL —', err.message);
    console.error('\nDiagnóstico:');
    if (err.message.includes('Brevo HTTP 401')) {
      console.error('  BREVO_API_KEY inválida o no autorizada. Verificar en https://app.brevo.com/settings/keys/api');
    } else if (err.message.includes('Brevo HTTP 400')) {
      console.error('  Payload rechazado. Típicamente: EMAIL_FROM no validado en Brevo (Senders & IP → Domains).');
    } else if (err.message.includes('ETIMEDOUT') || err.message.includes('ECONNREFUSED')) {
      console.error('  Puerto SMTP bloqueado. ¿Estás en DigitalOcean? Usar BREVO_API_KEY (HTTP) en vez de SMTP.');
    }
    console.error('\nFull error:', err);
    process.exit(1);
  }
})();
