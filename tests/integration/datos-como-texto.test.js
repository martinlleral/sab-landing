/**
 * Tests de integración — los datos de quien compra son texto.
 *
 * El nombre, el apellido, el mail y el teléfono los escribe alguien de afuera y
 * los lee el panel. Hay dos guardas, independientes a propósito:
 *  - BLOQUE 1 — al recibir: `crearPreferencia` rechaza `<` y `>` y un mail sin
 *    formato. Lo legítimo (apóstrofes, `&`, comillas, paréntesis) sigue pasando.
 *  - BLOQUE 2 — al mostrar: el panel pinta con un único helper (`esc`, en bo.js).
 *    Una fila vieja en la base puede traer cualquier cosa, y tiene que verse como
 *    se escribió.
 *  - BLOQUE 3 — los mails escapan el nombre.
 *  - BLOQUE 4 — el identificador de la preferencia viaja codificado.
 *
 * El bloque 2 lee el código de las pantallas: no levanta un navegador. Frena lo
 * que ya pasó (un dato sin el helper, una copia local que choca con el global).
 *
 * Uso local (con dev.db):
 *   node tests/integration/datos-como-texto.test.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const nodemailer = require('nodemailer');

const prisma = require('../../src/utils/prisma');
const compras = require('../../src/controllers/compras.controller');
const brevo = require('../../src/services/brevo.service');

const REPO = path.join(__dirname, '..', '..');
const BACKOFFICE = path.join(REPO, 'public', 'backoffice');
const EVENTO_QUE_NO_EXISTE = 999999999;

const checks = [];
const check = (nombre, pasa, detalle = '') => {
  checks.push({ nombre, pasa: !!pasa });
  console.log(`${pasa ? '✅' : '❌'} ${nombre}${detalle ? `\n   ${detalle}` : ''}`);
};

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

// Un evento que no existe corta justo después de la validación: un 404 prueba que
// el dato pasó, sin crear nada y sin tocar Mercado Pago.
async function comprar(datos) {
  const req = {
    body: {
      eventoId: EVENTO_QUE_NO_EXISTE,
      nombre: 'Ana',
      apellido: 'Ejemplo',
      email: 'ana@example.invalid',
      telefono: '2210000000',
      cantidad: 1,
      ...datos,
    },
  };
  const res = mockRes();
  await compras.crearPreferencia(req, res);
  return res;
}

function archivosDelPanel() {
  const html = fs.readdirSync(BACKOFFICE)
    .filter((f) => f.endsWith('.html'))
    .map((f) => path.join(BACKOFFICE, f));
  const js = fs.readdirSync(path.join(BACKOFFICE, 'assets', 'js'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => path.join(BACKOFFICE, 'assets', 'js', f));
  return [...html, ...js];
}

async function main() {
  try {
    // ── BLOQUE 1 — Al recibir ──
    const rechazados = {
      nombre: 'a<b',
      apellido: 'a>b',
      email: 'a<b@example.invalid',
      telefono: '<1',
    };
    for (const [campo, valor] of Object.entries(rechazados)) {
      const r = await comprar({ [campo]: valor });
      check(
        `1) ${campo} con menor o mayor: 400 DATOS_NO_ADMITIDOS`,
        r.statusCode === 400 && r.body?.code === 'DATOS_NO_ADMITIDOS',
        `status=${r.statusCode} code=${r.body?.code}`
      );
    }

    for (const email of ['sinarroba', 'dos partes@example.invalid', 'a@sinpunto']) {
      const r = await comprar({ email });
      check(
        `1) mail sin formato (${email}): 400 EMAIL_INVALIDO`,
        r.statusCode === 400 && r.body?.code === 'EMAIL_INVALIDO',
        `status=${r.statusCode} code=${r.body?.code}`
      );
    }

    const legitimos = [
      { apellido: "O'Connor" },
      { apellido: "D'Angelo" },
      { nombre: 'Juan & María' },
      { nombre: 'José "Pepe"' },
      { apellido: 'Núñez-Ibáñez' },
      { telefono: '+54 (221) 000-0000' },
      { email: "o'connor&familia@example.invalid" },
    ];
    for (const datos of legitimos) {
      const r = await comprar(datos);
      check(
        `1) legítimo pasa la validación: ${Object.values(datos)[0]}`,
        r.statusCode === 404,
        `status=${r.statusCode} code=${r.body?.code}`
      );
    }

    // ── BLOQUE 2 — Al mostrar ──
    const boJs = fs.readFileSync(path.join(BACKOFFICE, 'assets', 'js', 'bo.js'), 'utf8');
    const fuenteEsc = boJs.match(/function esc\(valor\) \{[\s\S]*?\n\}/)?.[0];
    check('2) bo.js define el helper', !!fuenteEsc);
    const contexto = {};
    vm.runInNewContext(fuenteEsc || '', contexto);
    const { esc } = contexto;

    check(
      '2) el helper escapa los cinco signos',
      esc(`<b>&"'`) === '&lt;b&gt;&amp;&quot;&#39;',
      esc(`<b>&"'`)
    );
    check('2) sin dato devuelve vacío, no «null» ni «undefined»', esc(null) === '' && esc(undefined) === '');
    check('2) un número llega como texto, y el cero no se pierde', esc(0) === '0');

    const panel = archivosDelPanel().map((ruta) => ({
      nombre: path.relative(BACKOFFICE, ruta),
      fuente: fs.readFileSync(ruta, 'utf8'),
    }));

    // En un script clásico, `const esc` sobre un `function esc` global es un error
    // de sintaxis, y se lleva puesto todo el script de esa pantalla.
    const conCopia = panel
      .filter((a) => a.nombre !== path.join('assets', 'js', 'bo.js'))
      .filter((a) => /(?:const|let|var|function)\s+esc\b/.test(a.fuente))
      .map((a) => a.nombre);
    check('2) ninguna pantalla declara su propio esc', conCopia.length === 0, conCopia.join(', '));

    const sinHelperCargado = panel
      .filter((a) => a.nombre.endsWith('.html') && /\besc\(/.test(a.fuente))
      .filter((a) => !a.fuente.includes('assets/js/bo.js'))
      .map((a) => a.nombre);
    check('2) toda pantalla que usa el helper carga bo.js', sinHelperCargado.length === 0, sinHelperCargado.join(', '));

    // El lector QR arma acá un dato para su historial, que después pinta con esc().
    const armaUnDato = /^\s*nombre: `\$\{c\.nombre\} \$\{c\.apellido\}`,$/;
    const crudo = /\$\{(?:c|inv|compra|u\.compra)\.(?:nombre|apellido|email|telefono)\b/;
    const sinEscapar = panel.flatMap((a) => a.fuente.split('\n')
      .map((linea, i) => ({ linea, n: i + 1, archivo: a.nombre }))
      .filter(({ linea }) => crudo.test(linea) && !armaUnDato.test(linea))
      .map(({ archivo, n }) => `${archivo}:${n}`));
    check('2) ningún dato de compra se pinta sin el helper', sinEscapar.length === 0, sinEscapar.join(', '));

    const compraHtml = fs.readFileSync(path.join(BACKOFFICE, 'evento-compras.html'), 'utf8');
    check(
      '2) el mail no viaja dentro del onclick de Reenviar',
      compraHtml.includes('data-email="${esc(c.email)}"')
        && compraHtml.includes('reenviarMail(${c.id}, this.dataset.email)'),
    );

    // ── BLOQUE 3 — Los mails ──
    const conMarcado = '<b>Ana</b>';
    const evento = { nombre: 'Show de prueba', fecha: new Date(), hora: '21:00' };
    const htmlConfirmacion = brevo._buildHtmlForTest({
      nombre: conMarcado,
      evento,
      entradas: [{ codigoQR: 'qr-de-prueba', qrImageUrl: '' }],
      compra: { totalPagado: 1 },
      direccionLinea: 'Una dirección',
    });
    check(
      '3) mail de confirmación: el nombre va escapado',
      !htmlConfirmacion.includes(conMarcado) && htmlConfirmacion.includes('&lt;b&gt;Ana&lt;/b&gt;'),
    );

    // Nada sale de la máquina: `.env` puede traer la clave real, así que se pisan
    // los dos caminos de envío ANTES de llamar.
    let htmlInvitacion = null;
    const fetchReal = global.fetch;
    const transportReal = nodemailer.createTransport;
    global.fetch = async (_url, opciones) => {
      htmlInvitacion = JSON.parse(opciones.body).htmlContent;
      return { ok: true, status: 201, json: async () => ({ messageId: 'test' }), text: async () => '{}' };
    };
    nodemailer.createTransport = () => ({
      sendMail: async (opciones) => { htmlInvitacion = opciones.html; return {}; },
    });
    try {
      await brevo.enviarInvitacion({
        email: 'invitacion@example.invalid',
        nombre: conMarcado,
        evento,
        entrada: { codigoQR: 'qr-de-prueba', qrImageUrl: '', qrBase64: 'AA==' },
      });
    } finally {
      global.fetch = fetchReal;
      nodemailer.createTransport = transportReal;
    }
    check('3) el envío de la invitación se capturó', htmlInvitacion !== null);
    check(
      '3) mail de invitación: el nombre va escapado',
      htmlInvitacion && !htmlInvitacion.includes(conMarcado) && htmlInvitacion.includes('&lt;b&gt;Ana&lt;/b&gt;'),
    );

    // ── BLOQUE 4 — El identificador ──
    const appJs = fs.readFileSync(path.join(REPO, 'public', 'assets', 'js', 'app.js'), 'utf8');
    check(
      '4) el identificador de la preferencia viaja codificado',
      appJs.includes('/api/compras/check/${encodeURIComponent(preferenciaId)}')
        && !appJs.includes('/api/compras/check/${preferenciaId}'),
    );

    const fallaron = checks.filter((c) => !c.pasa).length;
    if (fallaron) {
      console.log(`\n❌ FAIL — ${fallaron}/${checks.length} checks fallaron`);
      process.exitCode = 1;
    } else {
      console.log(`\n✅ PASS — ${checks.length}/${checks.length} checks OK`);
      process.exitCode = 0;
    }
  } catch (err) {
    console.error('❌ ERROR INESPERADO:', err.message);
    console.error(err.stack);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
    process.exit(process.exitCode || 0);
  }
}

main();
