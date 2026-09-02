/**
 * Test de integración: una compra cobrada nunca puede quedarse sin QR.
 *
 * El caso real (compra #2352, 27/8/2026): el webhook de MP marcó la compra como
 * `approved` —el lock que evita entradas duplicadas— y la transacción que crea
 * las entradas murió a los 5088 ms por contención de SQLite. La compra quedó
 * cobrada, sin entradas, sin stock descontado y sin mail. Y sin salida: los tres
 * caminos que emiten entradas (webhook, checkAndProcess y el cron) hacen early
 * return ante una compra ya aprobada, así que nadie volvía a intentarlo. La
 * compradora se enteró cinco días después.
 *
 * Lo que se valida acá es la salida, en sus dos capas:
 *   1. Si la emisión falla, la compra vuelve a `pending` y el reintento la
 *      completa. Con el código anterior este bloque queda en ROJO: la compra se
 *      quedaba en `approved` para siempre.
 *   2. Si igual quedara una a mitad de camino, el barrido `repararComprasSinEntradas`
 *      la levanta — emitiendo las entradas, ajustando el stock y mandando el mail.
 *   3. Y ese barrido NO se mete con lo que está en curso: exige que la compra
 *      lleve un rato quieta, porque `adminEnviarInvitacion` crea la compra
 *      aprobada y su entrada en dos pasos, y la ventana entre ambos se le parece
 *      demasiado a una compra rota.
 *
 * Uso:
 *   node tests/integration/entradas-emision-resiliente.test.js
 *
 * Exit codes: 0 = PASS · 1 = FAIL
 */

const fs = require('fs');
const path = require('path');
const prisma = require('../../src/utils/prisma');
const pagos = require('../../src/services/pagos.service');
const qrService = require('../../src/services/qr.service');
const brevoService = require('../../src/services/brevo.service');

const QR_DIR = path.join(__dirname, '../../public/assets/img/uploads/qr');
const TEST_EMAIL_PREFIX = 'emision-resiliente-test-';
const TEST_EVENTO_NAME = 'Emision Resiliente Test Event';

const checks = [];
const check = (name, pass, detail = '') => checks.push({ name, pass: !!pass, detail });

// Envejece una compra moviéndole el `updatedAt` al pasado. Va por SQL crudo
// porque `updatedAt` es @updatedAt: cualquier update de Prisma lo pisaría con
// "ahora", y sin poder envejecerla el barrido nunca la mira. Prisma guarda los
// DateTime de SQLite como ms Unix en una columna INTEGER.
async function envejecer(compraId, minutos) {
  const ms = Date.now() - minutos * 60 * 1000;
  await prisma.$executeRawUnsafe('UPDATE Compra SET updatedAt = ? WHERE id = ?', ms, compraId);
}

async function cleanup() {
  const compras = await prisma.compra.findMany({
    where: { email: { contains: TEST_EMAIL_PREFIX } },
    select: { id: true, eventoId: true, entradas: { select: { codigoQR: true } } },
  });

  for (const c of compras) {
    for (const e of c.entradas) {
      const fp = path.join(QR_DIR, `${e.codigoQR}.png`);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    }
  }

  const compraIds = compras.map((c) => c.id);
  const eventoIds = [...new Set(compras.map((c) => c.eventoId))];

  await prisma.entrada.deleteMany({ where: { compraId: { in: compraIds } } });
  await prisma.compra.deleteMany({ where: { id: { in: compraIds } } });
  await prisma.tanda.deleteMany({ where: { eventoId: { in: eventoIds } } });
  await prisma.evento.deleteMany({ where: { id: { in: eventoIds }, nombre: TEST_EVENTO_NAME } });

  return { compras: compras.length, eventos: eventoIds.length };
}

async function crearEscenario(ts, sufijo, { cantidadEntradas, estado }) {
  const evento = await prisma.evento.create({
    data: {
      nombre: TEST_EVENTO_NAME,
      descripcion: 'Evento temporal para el test de emisión resiliente',
      fecha: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      hora: '21:00',
      estaPublicado: false,
      tandas: { create: [{ nombre: 'General', precio: 1000, orden: 1, activa: true, capacidad: 50, cantidadVendida: 0 }] },
    },
    include: { tandas: true },
  });

  const compra = await prisma.compra.create({
    data: {
      eventoId: evento.id,
      tandaId: evento.tandas[0].id,
      email: `${TEST_EMAIL_PREFIX}${sufijo}-${ts}@test.invalid`,
      nombre: 'Emision',
      apellido: 'Resiliente',
      telefono: '0',
      cantidadEntradas,
      precioUnitario: 1000,
      totalPagado: cantidadEntradas * 1000,
      mpEstado: estado,
      mpPreferenciaId: `test-pref-${sufijo}-${ts}`,
    },
    include: { evento: true },
  });

  return { evento, tandaId: evento.tandas[0].id, compra };
}

const stockDe = async (tandaId) =>
  (await prisma.tanda.findUnique({ where: { id: tandaId } })).cantidadVendida;

async function main() {
  const ts = Date.now();

  // El mail no se manda de verdad, pero sí se cuenta: que la reparación avise al
  // comprador es parte de lo que se está probando, no un efecto secundario.
  const enviarOriginal = brevoService.enviarConfirmacion;
  const generarQROriginal = qrService.generarQR;
  let mailsEnviados = [];
  brevoService.enviarConfirmacion = async ({ email, entradas }) => {
    mailsEnviados.push({ email, entradas: entradas.length });
    return { ok: true };
  };

  try {
    await cleanup();

    // ─── 1. La emisión falla después del lock ───────────────────────────────
    {
      const { tandaId, compra } = await crearEscenario(ts, 'falla', { cantidadEntradas: 3, estado: 'pending' });

      qrService.generarQR = async () => { throw new Error('disco lleno (simulado)'); };

      let lanzo = false;
      try {
        await pagos.procesarPagoAprobado(compra.id, `TEST-PAGO-FALLA-${ts}`);
      } catch (err) {
        lanzo = true;
      }
      check('1a) procesarPagoAprobado propaga el error de la emisión', lanzo);

      const post = await prisma.compra.findUnique({ where: { id: compra.id } });
      check('1b) 🎯 la compra vuelve a pending — no queda cobrada e inalcanzable',
        post.mpEstado === 'pending', `mpEstado=${post.mpEstado}`);
      check('1c) el mpPagoId queda registrado igual (hubo un pago real)',
        post.mpPagoId === `TEST-PAGO-FALLA-${ts}`, `mpPagoId=${post.mpPagoId}`);

      const entradas = await prisma.entrada.count({ where: { compraId: compra.id } });
      check('1d) no quedaron entradas a medias', entradas === 0, `entradas=${entradas}`);
      check('1e) el stock de la tanda no se movió', (await stockDe(tandaId)) === 0);

      qrService.generarQR = generarQROriginal;

      const r = await pagos.procesarPagoAprobado(compra.id, `TEST-PAGO-OK-${ts}`);
      check('1f) 🎯 el reintento la completa: la compra era recuperable',
        r.procesada === true && r.entradas === 3, JSON.stringify(r));
      check('1g) ahora sí quedó approved',
        (await prisma.compra.findUnique({ where: { id: compra.id } })).mpEstado === 'approved');
      check('1h) el stock se descontó una sola vez', (await stockDe(tandaId)) === 3,
        `cantidadVendida=${await stockDe(tandaId)}`);
    }

    // ─── 2. El barrido levanta lo que quedó a mitad de camino ───────────────
    {
      const { tandaId, compra } = await crearEscenario(ts, 'barrido', { cantidadEntradas: 7, estado: 'approved' });
      await envejecer(compra.id, 10);
      mailsEnviados = [];

      const reparadas = await pagos.repararComprasSinEntradas();
      const mia = reparadas.find((r) => r.compraId === compra.id);

      check('2a) 🎯 el barrido encuentra y repara la compra aprobada sin entradas',
        !!mia && mia.entradas === 7, JSON.stringify(reparadas));
      check('2b) quedaron las 7 entradas',
        (await prisma.entrada.count({ where: { compraId: compra.id } })) === 7);
      check('2c) el stock se ajustó por las 7 emitidas', (await stockDe(tandaId)) === 7,
        `cantidadVendida=${await stockDe(tandaId)}`);
      check('2d) al comprador le llegó su mail con las 7 entradas',
        mailsEnviados.some((m) => m.email === compra.email && m.entradas === 7),
        JSON.stringify(mailsEnviados));

      const pngs = (await prisma.entrada.findMany({ where: { compraId: compra.id } }))
        .map((e) => fs.existsSync(path.join(QR_DIR, `${e.codigoQR}.png`)));
      check('2e) los 7 PNG están en disco', pngs.length === 7 && pngs.every(Boolean));

      // Segunda pasada: nada que hacer.
      const otraVez = await pagos.repararComprasSinEntradas();
      check('2f) correrlo de nuevo no duplica nada (idempotente)',
        !otraVez.find((r) => r.compraId === compra.id) &&
        (await prisma.entrada.count({ where: { compraId: compra.id } })) === 7 &&
        (await stockDe(tandaId)) === 7);
    }

    // ─── 3. El barrido no se mete con lo que recién pasó ────────────────────
    {
      const { tandaId, compra } = await crearEscenario(ts, 'reciente', { cantidadEntradas: 1, estado: 'approved' });

      const reparadas = await pagos.repararComprasSinEntradas();

      check('3a) 🎯 una compra aprobada recién creada NO se toca (puede ser una emisión en vuelo o una invitación a medio hacer)',
        !reparadas.find((r) => r.compraId === compra.id), JSON.stringify(reparadas));
      check('3b) sigue sin entradas y sin stock movido',
        (await prisma.entrada.count({ where: { compraId: compra.id } })) === 0 &&
        (await stockDe(tandaId)) === 0);
    }

    // ─── 4. Emisión parcial: completa sólo lo que falta ─────────────────────
    {
      const { tandaId, compra } = await crearEscenario(ts, 'parcial', { cantidadEntradas: 4, estado: 'approved' });
      await prisma.entrada.create({
        data: { compraId: compra.id, codigoQR: `parcial-${ts}`, qrImageUrl: '/fake.png' },
      });
      await prisma.tanda.update({ where: { id: tandaId }, data: { cantidadVendida: 1 } });

      const { creadas } = await pagos.emitirEntradasFaltantes(compra, { enviarMail: false });

      check('4a) emite sólo las 3 que faltaban', creadas === 3, `creadas=${creadas}`);
      check('4b) el stock sube por las 3, no por las 4', (await stockDe(tandaId)) === 4,
        `cantidadVendida=${await stockDe(tandaId)}`);
      check('4c) la compra queda con sus 4 entradas',
        (await prisma.entrada.count({ where: { compraId: compra.id } })) === 4);

      const nada = await pagos.emitirEntradasFaltantes(compra, { enviarMail: false });
      check('4d) con la compra completa no emite nada', nada.creadas === 0);
    }

    console.log('─'.repeat(70));
    console.log('Emisión resiliente de entradas — test de integración');
    console.log('─'.repeat(70));
    for (const c of checks) {
      console.log(`${c.pass ? '✅' : '❌'} ${c.name}`);
      if (c.detail) console.log(`   ${c.detail}`);
    }
    console.log('─'.repeat(70));

    const fallados = checks.filter((c) => !c.pass);
    if (fallados.length) {
      console.log(`\n❌ FAIL — ${fallados.length}/${checks.length} checks fallaron`);
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
    qrService.generarQR = generarQROriginal;
    brevoService.enviarConfirmacion = enviarOriginal;
    try {
      const r = await cleanup();
      console.log(`\ncleanup: ${r.compras} compras, ${r.eventos} eventos`);
    } catch (cleanupErr) {
      console.error('WARN cleanup:', cleanupErr.message);
    }
    await prisma.$disconnect();
    process.exit(process.exitCode || 0);
  }
}

main();
