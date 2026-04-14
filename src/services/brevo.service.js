const nodemailer = require('nodemailer');
const config = require('../config');

function getTransporter() {
  return nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: false,
    auth: {
      user: config.smtp.user,
      pass: config.smtp.pass,
    },
  });
}

function fromAddress() {
  return `"${config.smtp.fromName}" <${config.smtp.from}>`;
}

function formatFecha(fecha) {
  return new Date(fecha).toLocaleDateString('es-AR', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function buildQrAttachments(entradas) {
  return entradas.map((entrada, i) => ({
    filename: `entrada-${i + 1}.png`,
    content: Buffer.from(entrada.qrBase64, 'base64'),
    contentType: 'image/png',
    cid: `qr${i}`,
  }));
}

function buildHtml({ nombre, evento, entradas }) {
  const qrItems = entradas
    .map(
      (e, i) => `
      <div style="margin:16px 0; text-align:center; border:1px solid #eee; border-radius:8px; padding:16px;">
        <p style="font-weight:bold; font-size:16px;">Entrada #${i + 1}</p>
        <img src="cid:qr${i}" alt="QR Entrada ${i + 1}" style="width:180px; height:180px;" />
        <p style="color:#666; font-size:12px; margin-top:8px;">Código: ${e.codigoQR}</p>
      </div>`
    )
    .join('');

  return `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:Arial,sans-serif; background:#f4f4f4; margin:0; padding:0;">
  <div style="max-width:600px; margin:0 auto; background:#fff;">
    <div style="background:#111; padding:32px; text-align:center;">
      <h1 style="color:#fff; margin:0; font-size:20px; letter-spacing:2px;">🎵 SINDICATO ARGENTINO DE BOLEROS</h1>
      <p style="color:#ccc; margin:8px 0 0;">Confirmación de compra</p>
    </div>
    <div style="padding:32px;">
      <h2 style="color:#111;">¡Hola, ${nombre}!</h2>
      <p style="color:#444; font-size:16px;">Tu compra fue confirmada. A continuación encontrás tus entradas con los códigos QR para ingresar al evento.</p>

      <div style="background:#f9f9f9; border-radius:8px; padding:16px; margin:24px 0;">
        <h3 style="color:#111; margin:0 0 12px;">📅 Detalle del Evento</h3>
        <p style="margin:4px 0;"><strong>Evento:</strong> ${evento.nombre}</p>
        <p style="margin:4px 0;"><strong>Fecha:</strong> ${formatFecha(evento.fecha)}</p>
        <p style="margin:4px 0;"><strong>Hora:</strong> ${evento.hora}</p>
        ${evento.invitado ? `<p style="margin:4px 0;"><strong>Invitado especial:</strong> ${evento.invitado}</p>` : ''}
      </div>

      <h3 style="color:#111;">🎟️ Tus Entradas</h3>
      ${qrItems}

      <div style="background:#fff3cd; border-radius:8px; padding:16px; margin:24px 0; border-left:4px solid #ffc107;">
        <h4 style="margin:0 0 8px; color:#856404;">Instrucciones de uso</h4>
        <ul style="margin:0; padding-left:20px; color:#856404;">
          <li>Presentá el código QR en la entrada del evento.</li>
          <li>Cada código QR es de uso único y personal.</li>
          <li>No compartas tu entrada con otras personas.</li>
          <li>Podés mostrar el QR desde tu celular o impreso.</li>
        </ul>
      </div>
    </div>
    <div style="background:#111; padding:16px; text-align:center;">
      <p style="color:#888; font-size:12px; margin:0;">© Sindicato Argentino de Boleros — Todos los derechos reservados</p>
    </div>
  </div>
</body>
</html>`;
}

async function enviarConfirmacion({ email, nombre, evento, entradas }) {
  console.log(`📧 Enviando confirmación a ${email} (${entradas.length} entrada(s), evento: ${evento.nombre})`);
  console.log(`   SMTP: ${config.smtp.host}:${config.smtp.port} user=${config.smtp.user ? '✓' : '✗'} pass=${config.smtp.pass ? '✓' : '✗'}`);

  const transporter = getTransporter();
  const html = buildHtml({ nombre, evento, entradas });
  const attachments = buildQrAttachments(entradas);

  const result = await transporter.sendMail({
    from: fromAddress(),
    to: `"${nombre}" <${email}>`,
    subject: `🎟️ Tus entradas para ${evento.nombre}`,
    html,
    attachments,
  });

  console.log(`📧 Email enviado OK — messageId: ${result.messageId}`);
  return result;
}

async function enviarInvitacion({ email, nombre, evento, entrada }) {
  console.log(`📧 Enviando invitación a ${email} (evento: ${evento.nombre})`);
  console.log(`   SMTP: ${config.smtp.host}:${config.smtp.port} user=${config.smtp.user ? '✓' : '✗'} pass=${config.smtp.pass ? '✓' : '✗'}`);
  const transporter = getTransporter();

  const html = `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:Arial,sans-serif; background:#f4f4f4; margin:0; padding:0;">
  <div style="max-width:600px; margin:0 auto; background:#fff;">
    <div style="background:#111; padding:32px; text-align:center;">
      <h1 style="color:#fff; margin:0; font-size:20px; letter-spacing:2px;">🎵 SINDICATO ARGENTINO DE BOLEROS</h1>
      <p style="color:#ccc; margin:8px 0 0;">Entrada de invitación</p>
    </div>
    <div style="padding:32px;">
      <h2 style="color:#111;">¡Hola, ${nombre}!</h2>
      <p style="color:#444; font-size:16px;">
        Te enviamos una <strong>entrada de invitación</strong> para el siguiente evento. 
        Tu asistencia es completamente gratuita — ¡te esperamos!
      </p>

      <div style="background:#f9f9f9; border-radius:8px; padding:16px; margin:24px 0;">
        <h3 style="color:#111; margin:0 0 12px;">📅 Detalle del Evento</h3>
        <p style="margin:4px 0;"><strong>Evento:</strong> ${evento.nombre}</p>
        <p style="margin:4px 0;"><strong>Fecha:</strong> ${formatFecha(evento.fecha)}</p>
        <p style="margin:4px 0;"><strong>Hora:</strong> ${evento.hora}</p>
        ${evento.invitado ? `<p style="margin:4px 0;"><strong>Invitado especial:</strong> ${evento.invitado}</p>` : ''}
      </div>

      <h3 style="color:#111;">🎟️ Tu Entrada</h3>
      <div style="margin:16px 0; text-align:center; border:1px solid #eee; border-radius:8px; padding:16px;">
        <p style="font-weight:bold; font-size:16px;">Entrada de Invitación</p>
        <img src="cid:qr0" alt="QR Entrada" style="width:180px; height:180px;" />
        <p style="color:#666; font-size:12px; margin-top:8px;">Código: ${entrada.codigoQR}</p>
      </div>

      <div style="background:#fff3cd; border-radius:8px; padding:16px; margin:24px 0; border-left:4px solid #ffc107;">
        <h4 style="margin:0 0 8px; color:#856404;">Instrucciones de uso</h4>
        <ul style="margin:0; padding-left:20px; color:#856404;">
          <li>Presentá el código QR en la entrada del evento.</li>
          <li>Tu entrada es personal e intransferible.</li>
          <li>Podés mostrar el QR desde tu celular o impreso.</li>
        </ul>
      </div>
    </div>
    <div style="background:#111; padding:16px; text-align:center;">
      <p style="color:#888; font-size:12px; margin:0;">© Sindicato Argentino de Boleros — Todos los derechos reservados</p>
    </div>
  </div>
</body>
</html>`;

  return transporter.sendMail({
    from: fromAddress(),
    to: `"${nombre}" <${email}>`,
    subject: `🎟️ Tu entrada de invitación para ${evento.nombre}`,
    html,
    attachments: [{
      filename: 'entrada-invitacion.png',
      content: Buffer.from(entrada.qrBase64, 'base64'),
      contentType: 'image/png',
      cid: 'qr0',
    }],
  });
}

module.exports = { enviarConfirmacion, enviarInvitacion };
