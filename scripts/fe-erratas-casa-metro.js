// ⚠️ YA EJECUTADO — 8/7/2026. NO volver a correr con --send.
// Los 24 compradores del evento #16 ya recibieron esta corrección. Un segundo
// envío les llegaría como un mail repetido sobre un evento que ya pasó, desde la
// cuenta que manda las entradas reales. El script no puede detectarlo solo: no
// tiene control de doble envío (ver "Idempotencia" abajo).
//
// Se conserva en el repo por dos motivos: deja registro del texto exacto que
// recibieron esos compradores (si alguno pregunta), y es el molde para la próxima
// fe de erratas, que se hace copiándolo y cambiando EVENTO_ID y el cuerpo.
//
// ---
//
// Envío único de "fe de erratas" a los compradores del evento #16
// (RODA de Boleros en Casa Metro, 8/7). Esos mails de confirmación salieron
// con la dirección hardcodeada de Doble T antes del fix del 5/6/2026; este
// script les manda la dirección correcta de Casa Metro.
//
// Reutiliza el MISMO transporte y remitente que el sistema (Brevo HTTP API),
// para que el mail de corrección tenga la misma identidad y entregabilidad
// que el original.
//
// Uso (dentro del contenedor):
//   node /app/scripts/fe-erratas-casa-metro.js                 → DRY RUN (lista, no envía)
//   node /app/scripts/fe-erratas-casa-metro.js --test a@b.com   → manda UNA copia de prueba a ese mail
//   node /app/scripts/fe-erratas-casa-metro.js --send           → ENVÍA de verdad a los compradores
//
// Idempotencia: NO hay control de doble envío. Correr --send una sola vez.

const config = require('../src/config');
const prisma = require('../src/utils/prisma');

const EVENTO_ID = 16;
const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';
const SEND = process.argv.includes('--send');
const TEST_IDX = process.argv.indexOf('--test');
const TEST_EMAIL = TEST_IDX >= 0 ? process.argv[TEST_IDX + 1] : null;

function maskEmail(email) {
  const [u, d] = email.split('@');
  const shown = u.slice(0, 2);
  return `${shown}${'*'.repeat(Math.max(1, u.length - 2))}@${d}`;
}

function buildHtml(nombre, evento) {
  const saludo = nombre && nombre.trim() ? `¡Hola, ${nombre.trim()}!` : '¡Hola!';
  return `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:Arial,sans-serif; background:#f4f4f4; margin:0; padding:0;">
  <div style="max-width:600px; margin:0 auto; background:#fff;">
    <div style="background:#111; padding:32px; text-align:center;">
      <h1 style="color:#fff; margin:0; font-size:20px; letter-spacing:2px;">🎵 SINDICATO ARGENTINO DE BOLEROS</h1>
      <p style="color:#ccc; margin:8px 0 0;">Corrección de dirección</p>
    </div>
    <div style="padding:32px;">
      <h2 style="color:#111;">${saludo}</h2>
      <p style="color:#444; font-size:16px;">
        Te escribimos para corregir un dato del mail de confirmación de tu entrada para la
        <strong>RODA de Boleros del miércoles 8 de julio</strong>.
      </p>
      <p style="color:#444; font-size:16px;">
        Por un error en nuestro sistema, ese mail mostraba la dirección de nuestra sede habitual
        (Espacio Doble T). <strong>La dirección correcta del evento es:</strong>
      </p>

      <div style="background:#f9f9f9; border-radius:8px; padding:16px; margin:24px 0; border-left:4px solid #111;">
        <p style="margin:0; font-size:18px; color:#111;"><strong>🎵 Casa METRO</strong></p>
        <p style="margin:6px 0 0; font-size:16px; color:#444;">Calle 4 entre 51 y 53, La Plata</p>
      </div>

      <div style="background:#e8f5e9; border-radius:8px; padding:16px; margin:24px 0; border-left:4px solid #48bb78;">
        <p style="margin:0; color:#2f855a; font-size:15px;">
          ✅ <strong>Tu entrada y tu código QR siguen siendo válidos.</strong> No tenés que hacer nada,
          solo tener a mano la dirección correcta el día del show.
        </p>
      </div>

      <p style="color:#444; font-size:15px; margin-top:24px;">
        Disculpá las molestias y gracias por acompañar al Sindicato.
      </p>
      <p style="color:#666; font-size:14px; margin-top:16px; text-align:center;">
        Cualquier duda o consulta comunicate al WhatsApp
        <a href="https://wa.me/5492215917409" style="color:#111; font-weight:bold;">+54 9 221 591-7409</a>
      </p>
    </div>
    <div style="background:#111; padding:16px; text-align:center;">
      <p style="color:#888; font-size:12px; margin:0;">© Sindicato Argentino de Boleros — Todos los derechos reservados</p>
    </div>
  </div>
</body>
</html>`;
}

async function sendViaBrevoHttp({ to, toName, subject, html }) {
  const body = {
    sender: { name: config.smtp.fromName, email: config.smtp.from },
    to: [{ email: to, name: toName || to }],
    subject,
    htmlContent: html,
  };
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
    throw new Error(`Brevo HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = await res.json().catch(() => ({}));
  return json.messageId || 'brevo-http';
}

async function main() {
  const evento = await prisma.evento.findUnique({ where: { id: EVENTO_ID } });
  if (!evento) throw new Error(`Evento ${EVENTO_ID} no encontrado`);

  // Modo test: una sola copia a un mail arbitrario, sin tocar la lista real.
  if (TEST_EMAIL) {
    console.log(`\n=== TEST — Evento #${EVENTO_ID}: ${evento.nombre} ===`);
    console.log(`Enviando UNA copia de prueba a: ${TEST_EMAIL}`);
    const id = await sendViaBrevoHttp({
      to: TEST_EMAIL,
      toName: 'Martín',
      subject: '📍 Corrección de dirección — RODA de Boleros en Casa Metro (mié 8/7)',
      html: buildHtml('Martín', evento),
    });
    console.log(`✅ Test enviado — ${id}\n`);
    return;
  }

  // Compradores APROBADOS, deduplicados por email (un mail por persona).
  const compras = await prisma.compra.findMany({
    where: { eventoId: EVENTO_ID, mpEstado: 'approved' },
    select: { email: true, nombre: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });

  const porEmail = new Map();
  for (const c of compras) {
    const key = c.email.trim().toLowerCase();
    if (!key) continue;
    if (!porEmail.has(key)) porEmail.set(key, { email: key, nombre: c.nombre || '' });
  }
  const destinatarios = [...porEmail.values()];

  console.log(`\n=== FE DE ERRATAS — Evento #${EVENTO_ID}: ${evento.nombre} ===`);
  console.log(`Modo: ${SEND ? '🚀 ENVÍO REAL' : '🧪 DRY RUN (no envía)'}`);
  console.log(`Remitente: ${config.smtp.fromName} <${config.smtp.from}>`);
  console.log(`Compras aprobadas: ${compras.length} · Destinatarios únicos: ${destinatarios.length}\n`);

  destinatarios.forEach((d, i) => {
    console.log(`  ${String(i + 1).padStart(2)}. ${maskEmail(d.email).padEnd(28)} ${d.nombre}`);
  });

  if (!SEND) {
    console.log('\n🧪 DRY RUN: no se envió nada. Correr con --send para enviar.\n');
    return;
  }

  console.log('\nEnviando...\n');
  let ok = 0, fail = 0;
  for (const d of destinatarios) {
    try {
      const id = await sendViaBrevoHttp({
        to: d.email,
        toName: d.nombre,
        subject: '📍 Corrección de dirección — RODA de Boleros en Casa Metro (mié 8/7)',
        html: buildHtml(d.nombre, evento),
      });
      ok++;
      console.log(`  ✅ ${maskEmail(d.email)} — ${id}`);
    } catch (e) {
      fail++;
      console.log(`  ❌ ${maskEmail(d.email)} — ${e.message}`);
    }
  }
  console.log(`\n=== RESULTADO: ${ok} enviados, ${fail} fallidos ===\n`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
