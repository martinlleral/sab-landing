// Servicio de envío de mails. El nombre del archivo es legacy (el proyecto
// nació usando Brevo). Soporta dos transports:
//
//   1. SMTP genérico vía nodemailer (SMTP_HOST/PORT/USER/PASS).
//      Funciona con Gmail, Brevo SMTP, SendGrid, etc.
//   2. Brevo HTTP API (POST api.brevo.com/v3/smtp/email).
//      Se activa si BREVO_API_KEY está seteada.
//      Workaround para DigitalOcean que bloquea puertos SMTP 25/465/587 outbound.
//
// El selector es automático: si hay BREVO_API_KEY → HTTP. Si no → SMTP.
const nodemailer = require('nodemailer');
const config = require('../config');

const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';

function useBrevoHttp() {
  return !!config.brevo.apiKey;
}

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

// Envío vía Brevo HTTP API. Convierte los attachments con CID (qr0, qr1, ...)
// a base64 en el campo `attachment` — Brevo soporta referenciarlos desde el
// HTML con `<img src="cid:qr0">` si el mimetype y el nombre son correctos.
async function sendViaBrevoHttp({ to, toName, subject, html, attachments = [] }) {
  const body = {
    sender: { name: config.smtp.fromName, email: config.smtp.from },
    to: [{ email: to, name: toName }],
    subject,
    htmlContent: html,
  };
  if (attachments.length > 0) {
    body.attachment = attachments.map((a) => ({
      name: a.filename,
      content: a.content.toString('base64'),
    }));
  }

  const res = await fetch(BREVO_API_URL, {
    method: 'POST',
    headers: {
      'api-key': config.brevo.apiKey,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Brevo HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  const json = await res.json().catch(() => ({}));
  return { messageId: json.messageId || 'brevo-http' };
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
  const esSingular = entradas.length === 1;
  // URL pública absoluta del QR. Usamos el PNG ya persistido en disk por
  // qrService.generarQR. Así evitamos data URLs (bloqueadas por Gmail mobile
  // y WhatsApp Web) y CIDs (renderizado inconsistente entre providers).
  const qrItems = entradas
    .map(
      (e, i) => `
      <div style="margin:16px 0; text-align:center; border:1px solid #eee; border-radius:8px; padding:16px;">
        <p style="font-weight:bold; font-size:16px;">${esSingular ? 'Tu entrada' : `Entrada #${i + 1}`}</p>
        <img src="${config.baseUrl}/assets/img/uploads/qr/${e.codigoQR}.png" alt="QR Entrada ${i + 1}" style="width:180px; height:180px;" />
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
      <p style="color:#444; font-size:16px;">Tu compra fue confirmada. A continuación encontrás ${esSingular ? 'tu entrada con el código QR' : 'tus entradas con los códigos QR'} para ingresar al evento.</p>

      <div style="background:#f9f9f9; border-radius:8px; padding:16px; margin:24px 0;">
        <h3 style="color:#111; margin:0 0 12px;">📅 Detalle del Evento</h3>
        <p style="margin:4px 0;"><strong>Evento:</strong> ${evento.nombre}</p>
        <p style="margin:4px 0;"><strong>Fecha:</strong> ${formatFecha(evento.fecha)}</p>
        <p style="margin:4px 0;"><strong>Hora:</strong> ${evento.hora}</p>
        ${evento.invitado ? `<p style="margin:4px 0;"><strong>Invitado especial:</strong> ${evento.invitado}</p>` : ''}
        <p style="margin:4px 0;"><strong>Dirección:</strong> Espacio Doble T — Calle 23 entre 43 y 44, Barrio La Loma, La Plata</p>
      </div>

      <h3 style="color:#111;">🎟️ ${esSingular ? 'Tu Entrada' : 'Tus Entradas'}</h3>
      ${qrItems}

      <div style="background:#fff3cd; border-radius:8px; padding:16px; margin:24px 0; border-left:4px solid #ffc107;">
        <h4 style="margin:0 0 8px; color:#856404;">Instrucciones de uso</h4>
        <ul style="margin:0; padding-left:20px; color:#856404;">
          <li>Presentá el código QR en la entrada del evento.</li>
          <li>${esSingular ? 'Tu código QR es personal' : 'Cada código QR es personal'} y se valida una sola vez.</li>
          <li><strong>No compartas la foto del QR.</strong> El primero que lo presente en puerta entra — si alguien lo usa antes que vos, no podemos emitir una entrada nueva.</li>
          <li>Podés mostrarlo desde el celular o impreso.</li>
        </ul>
      </div>

      <p style="color:#666; font-size:14px; margin-top:24px; text-align:center;">
        Cualquier duda o consulta comunicate al WhatsApp <a href="https://wa.me/5492215917409" style="color:#111; font-weight:bold;">+54 9 221 591-7409</a>
      </p>
    </div>
    <div style="background:#111; padding:16px; text-align:center;">
      <p style="color:#888; font-size:12px; margin:0;">© Sindicato Argentino de Boleros — Todos los derechos reservados</p>
    </div>
  </div>
</body>
</html>`;
}

// Reemplaza `src="cid:qrN"` por `src="data:image/png;base64,..."` usando los
// attachments con cid. Necesario para Brevo HTTP API, que no soporta inline
// CID de forma confiable. Los data URLs funcionan en Gmail, Outlook, Apple Mail.
function inlineCidsAsDataUrls(html, attachments) {
  let out = html;
  for (const a of attachments) {
    if (!a.cid) continue;
    const b64 = a.content.toString('base64');
    const dataUrl = `data:${a.contentType || 'image/png'};base64,${b64}`;
    const pattern = new RegExp(`cid:${a.cid}(?=["'])`, 'g');
    out = out.replace(pattern, dataUrl);
  }
  return out;
}

async function enviarConfirmacion({ email, nombre, evento, entradas }) {
  const http = useBrevoHttp();
  console.log(`📧 Enviando confirmación a ${email} (${entradas.length} entrada(s), evento: ${evento.nombre}) — transport: ${http ? 'brevo-http' : 'smtp'}`);

  const html = buildHtml({ nombre, evento, entradas });
  const attachments = buildQrAttachments(entradas);
  const subject = `🎟️ ${entradas.length === 1 ? 'Tu entrada' : 'Tus entradas'} para ${evento.nombre}`;

  if (http) {
    // Imágenes del HTML van por URL pública absoluta (ver buildHtml / enviarInvitacion).
    // Los attachments se mantienen como archivos adjuntos descargables por el user.
    const result = await sendViaBrevoHttp({ to: email, toName: nombre, subject, html });
    console.log(`📧 Email enviado OK — messageId: ${result.messageId}`);
    return result;
  }

  const transporter = getTransporter();
  const result = await transporter.sendMail({
    from: fromAddress(),
    to: `"${nombre}" <${email}>`,
    subject,
    html,
    attachments,
  });
  console.log(`📧 Email enviado OK — messageId: ${result.messageId}`);
  return result;
}

async function enviarInvitacion({ email, nombre, evento, entrada }) {
  const http = useBrevoHttp();
  console.log(`📧 Enviando invitación a ${email} (evento: ${evento.nombre}) — transport: ${http ? 'brevo-http' : 'smtp'}`);

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
        <p style="margin:4px 0;"><strong>Dirección:</strong> Espacio Doble T — Calle 23 entre 43 y 44, Barrio La Loma, La Plata</p>
      </div>

      <h3 style="color:#111;">🎟️ Tu Entrada</h3>
      <div style="margin:16px 0; text-align:center; border:1px solid #eee; border-radius:8px; padding:16px;">
        <p style="font-weight:bold; font-size:16px;">Entrada de Invitación</p>
        <img src="${config.baseUrl}/assets/img/uploads/qr/${entrada.codigoQR}.png" alt="QR Entrada" style="width:180px; height:180px;" />
        <p style="color:#666; font-size:12px; margin-top:8px;">Código: ${entrada.codigoQR}</p>
      </div>

      <div style="background:#fff3cd; border-radius:8px; padding:16px; margin:24px 0; border-left:4px solid #ffc107;">
        <h4 style="margin:0 0 8px; color:#856404;">Instrucciones de uso</h4>
        <ul style="margin:0; padding-left:20px; color:#856404;">
          <li>Presentá el código QR en la entrada del evento.</li>
          <li>Tu entrada es personal y se valida una sola vez.</li>
          <li><strong>No compartas la foto del QR.</strong> El primero que lo presente en puerta entra — si alguien lo usa antes que vos, no podemos emitir una invitación nueva.</li>
          <li>Podés mostrarlo desde el celular o impreso.</li>
        </ul>
      </div>

      <p style="color:#666; font-size:14px; margin-top:24px; text-align:center;">
        Cualquier duda o consulta comunicate al WhatsApp <a href="https://wa.me/5492215917409" style="color:#111; font-weight:bold;">+54 9 221 591-7409</a>
      </p>
    </div>
    <div style="background:#111; padding:16px; text-align:center;">
      <p style="color:#888; font-size:12px; margin:0;">© Sindicato Argentino de Boleros — Todos los derechos reservados</p>
    </div>
  </div>
</body>
</html>`;

  const subject = `🎟️ Tu entrada de invitación para ${evento.nombre}`;
  const attachments = [{
    filename: 'entrada-invitacion.png',
    content: Buffer.from(entrada.qrBase64, 'base64'),
    contentType: 'image/png',
    cid: 'qr0',
  }];

  if (http) {
    const htmlInline = inlineCidsAsDataUrls(html, attachments);
    return sendViaBrevoHttp({ to: email, toName: nombre, subject, html: htmlInline });
  }

  const transporter = getTransporter();
  return transporter.sendMail({
    from: fromAddress(),
    to: `"${nombre}" <${email}>`,
    subject,
    html,
    attachments,
  });
}

module.exports = { enviarConfirmacion, enviarInvitacion };
