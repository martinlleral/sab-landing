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
const prisma = require('../utils/prisma');

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
async function sendViaBrevoHttp({ to, toName, subject, html, text, attachments = [] }) {
  const body = {
    sender: { name: config.smtp.fromName, email: config.smtp.from },
    to: [{ email: to, name: toName }],
    subject,
    htmlContent: html,
  };
  // Versión texto plano además del HTML: mejora la entregabilidad (los mails
  // multipart text+html parecen menos "promo") y la accesibilidad.
  if (text) body.textContent = text;
  if (attachments.length > 0) {
    body.attachment = attachments.map((a) => ({
      name: a.filename,
      content: a.content.toString('base64'),
    }));
  }

  // Reintento con backoff. CLAVE anti-duplicados: el endpoint de Brevo NO es
  // idempotente, así que SOLO se reintenta cuando es casi seguro que Brevo NO
  // llegó a encolar el mail. Si reintentáramos un fallo "ambiguo" (donde el
  // request pudo haberse encolado), el comprador recibiría 2 mails iguales.
  //   - Reintentables (no encoló): 429 (rate limit), 500/503 (error/indisp. del
  //     API), 522 (Cloudflare ni pudo conectar al origen — fue el caso real
  //     #1342) y errores de RED PRE-conexión (DNS/connection refused).
  //   - NO reintentables: 4xx permanentes y los gateway-timeout AMBIGUOS
  //     (502/504/520/524) y timeouts/resets de red post-envío, donde el mail
  //     pudo haber quedado encolado.
  // El envío corre en segundo plano (ver pagos.service.js), así que el backoff
  // no bloquea la respuesta al comprador.
  const RETRYABLE_STATUS = new Set([429, 500, 503, 522]);
  const RETRYABLE_NET = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);
  const delays = [1000, 3000, 8000]; // hasta 4 intentos en total
  let lastErr;
  for (let intento = 0; intento <= delays.length; intento++) {
    let res;
    try {
      res = await fetch(BREVO_API_URL, {
        method: 'POST',
        headers: {
          'api-key': config.brevo.apiKey,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (netErr) {
      lastErr = netErr;
      const code = (netErr && (netErr.code || (netErr.cause && netErr.cause.code))) || '';
      // Solo reintentar errores de red claramente PRE-conexión (no encoló).
      if (RETRYABLE_NET.has(code) && intento < delays.length) {
        console.warn(`⚠️ Brevo red ${code} (intento ${intento + 1}), reintento en ${delays[intento]}ms`);
        await new Promise((r) => setTimeout(r, delays[intento]));
        continue;
      }
      throw lastErr;
    }

    if (res.ok) {
      const json = await res.json().catch(() => ({}));
      return { messageId: json.messageId || 'brevo-http' };
    }

    const text = await res.text().catch(() => '');
    const err = new Error(`Brevo HTTP ${res.status}: ${text.slice(0, 300)}`);
    if (!RETRYABLE_STATUS.has(res.status) || intento >= delays.length) throw err;
    lastErr = err;
    console.warn(`⚠️ Brevo ${res.status} (intento ${intento + 1}), reintento en ${delays[intento]}ms`);
    await new Promise((r) => setTimeout(r, delays[intento]));
  }
  throw lastErr; // inalcanzable
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

function formatPesos(n) {
  return Number(n || 0).toLocaleString('es-AR');
}

// Bloque visible solo cuando la compra fue "Entrada con Aporte". Agradece y
// deja constancia del monto extra aportado (por entrada y total) para que el
// comprador tenga registro en el mail. Vacío si tipoEntrada=base o no viene.
function buildAporteBlock(compra) {
  if (!compra || compra.tipoEntrada !== 'aporte' || !compra.excedenteUnitario) return '';
  const totalAporte = compra.excedenteUnitario * compra.cantidadEntradas;
  const porUnidad = compra.cantidadEntradas > 1
    ? ` (${compra.cantidadEntradas} × $${formatPesos(compra.excedenteUnitario)})`
    : '';
  return `
      <div style="background:#e8f5e9; border-radius:8px; padding:14px 16px; margin:16px 0; border-left:4px solid #48bb78;">
        <p style="margin:0; color:#2f855a; font-size:14px;">
          🌱 <strong>Entrada con Aporte</strong> — Gracias por sumar $${formatPesos(totalAporte)}${porUnidad} a la cooperativa.
        </p>
      </div>`;
}

// Arma la línea de dirección del mail. Antes estaba hardcodeada ("Espacio Doble
// T — Calle 23..."), por lo que al mover un evento de sede el mail seguía
// mostrando la dirección vieja.
//
// Locación ACOPLADA: si el evento define cualquiera de sus campos de locación
// (lugar / dirección / ciudad), se usa SOLO lo del evento y no se completa con
// la sede default de Home. Así, al mover un evento a otra sede, no se mezcla la
// nueva con la calle de la sede por defecto (ej: "Teatro Coliseo — Calle 23..."
// de Doble T). Si el evento no pisa nada, se usa la sede default global de Home.
async function resolverDireccion(evento) {
  const t = (s) => (s && s.trim()) ? s.trim() : '';
  const oLugar     = t(evento.boxLugarOverride);
  const oDireccion = t(evento.boxDireccionOverride);
  const oCiudad    = t(evento.boxCiudadOverride);

  let lugar, direccion, ciudad;
  if (oLugar || oDireccion || oCiudad) {
    lugar = oLugar; direccion = oDireccion; ciudad = oCiudad;
  } else {
    const home = await prisma.home.findFirst();
    lugar     = (home && home.boxLugar)     || 'Espacio Doble T';
    direccion = (home && home.boxDireccion) || '';
    ciudad    = (home && home.boxCiudad)    || 'La Plata';
  }

  const sede = [lugar, direccion].filter(Boolean).join(' — ');
  return [sede, ciudad].filter(Boolean).join(', ');
}

function buildHtml({ nombre, evento, entradas, compra, direccionLinea }) {
  const esSingular = entradas.length === 1;
  const aporteBlock = buildAporteBlock(compra);
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
        <p style="margin:4px 0;"><strong>Dirección:</strong> ${direccionLinea}</p>
      </div>

      ${aporteBlock}

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

async function enviarConfirmacion({ email, nombre, evento, entradas, compra }) {
  const http = useBrevoHttp();
  const aporteTag = compra?.tipoEntrada === 'aporte' ? ' [aporte]' : '';
  console.log(`📧 Enviando confirmación a ${email} (${entradas.length} entrada(s)${aporteTag}, evento: ${evento.nombre}) — transport: ${http ? 'brevo-http' : 'smtp'}`);

  const direccionLinea = await resolverDireccion(evento);
  const html = buildHtml({ nombre, evento, entradas, compra, direccionLinea });
  const attachments = buildQrAttachments(entradas);
  // Asunto sin emoji al inicio: el 🎟️ delante empujaba el mail a la pestaña
  // Promociones de Gmail. Texto plano de respaldo para multipart.
  const subject = `${entradas.length === 1 ? 'Tu entrada' : 'Tus entradas'} para ${evento.nombre}`;
  const text = [
    `Hola ${nombre},`,
    '',
    `Tu compra fue confirmada para ${evento.nombre} (${formatFecha(evento.fecha)}, ${evento.hora} hs).`,
    `Dirección: ${direccionLinea}`,
    '',
    `Adjuntamos tu${entradas.length === 1 ? '' : 's'} entrada${entradas.length === 1 ? '' : 's'} con código QR. Presentá el QR en la puerta del evento.`,
    `Código${entradas.length === 1 ? '' : 's'}: ${entradas.map((e) => e.codigoQR).join(', ')}`,
    '',
    'Dudas: WhatsApp +54 9 221 591-7409',
    '— Sindicato Argentino de Boleros',
  ].join('\n');

  if (http) {
    // Doble vía para el QR, por robustez:
    //   1. En el HTML va como <img> por URL pública absoluta. Es lo que renderiza
    //      inline en la mayoría de clientes (Brevo proxy-cachea la imagen). Se usa
    //      URL pública y NO data URL/CID porque Gmail mobile y WhatsApp Web los
    //      bloquean (hallazgo de Tebi 24/4).
    //   2. Además se adjunta el PNG (buildQrAttachments) como archivo descargable,
    //      de respaldo para clientes que bloquean imágenes remotas: así el
    //      comprador siempre tiene su QR aunque no se renderice inline.
    const result = await sendViaBrevoHttp({ to: email, toName: nombre, subject, html, text, attachments });
    console.log(`📧 Email enviado OK — messageId: ${result.messageId}`);
    return result;
  }

  const transporter = getTransporter();
  const result = await transporter.sendMail({
    from: fromAddress(),
    to: `"${nombre}" <${email}>`,
    subject,
    html,
    text,
    attachments,
  });
  console.log(`📧 Email enviado OK — messageId: ${result.messageId}`);
  return result;
}

async function enviarInvitacion({ email, nombre, evento, entrada }) {
  const http = useBrevoHttp();
  console.log(`📧 Enviando invitación a ${email} (evento: ${evento.nombre}) — transport: ${http ? 'brevo-http' : 'smtp'}`);

  const direccionLinea = await resolverDireccion(evento);
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
        <p style="margin:4px 0;"><strong>Dirección:</strong> ${direccionLinea}</p>
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

module.exports = {
  enviarConfirmacion,
  enviarInvitacion,
  _buildHtmlForTest: buildHtml,
  _resolverDireccionForTest: resolverDireccion,
};
