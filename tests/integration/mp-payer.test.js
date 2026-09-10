/**
 * Tests de integración — datos del comprador (`payer`) en la preferencia de MP.
 *
 * POR QUÉ EXISTE ESTE TEST. En septiembre de 2026 aparecieron rechazos con
 * `status_detail: rejected_high_risk` ("por motivos de seguridad, esta
 * transacción no puede ser finalizada"). El rechazo lo decide el antifraude de
 * MP, no nosotros — pero MP cruza los datos del `payer` que le mandamos en la
 * preferencia para calcular ese riesgo, y hasta entonces mandábamos SOLO el
 * email teniendo nombre, apellido y teléfono guardados en la Compra.
 *
 * Cubre DOS capas, porque el bug puede vivir en cualquiera de las dos:
 *  - BLOQUE 1 — `construirBodyPreferencia`: lo que MP realmente recibe.
 *  - BLOQUE 2 — el controller: que los datos de la Compra lleguen hasta ahí.
 *    Un test que solo mirara el body pasaría aunque el controller no los pase.
 *
 * Uso local (con dev.db):
 *   node tests/integration/mp-payer.test.js
 */

const prisma = require('../../src/utils/prisma');
const compras = require('../../src/controllers/compras.controller');
const mpService = require('../../src/services/mercadopago.service');
const { construirBodyPreferencia } = mpService;

const TEST_PREFIX = 'mp-payer-test-';

let mpCalls = [];
const originalCrearPref = mpService.crearPreferencia;
mpService.crearPreferencia = async (args) => {
  mpCalls.push(args);
  return { id: `mock-pref-${Date.now()}`, init_point: 'https://mock.invalid/pay' };
};

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

async function call(body) {
  const res = mockRes();
  await compras.crearPreferencia({ body }, res);
  return res;
}

async function cleanup() {
  const eventos = await prisma.evento.findMany({
    where: { nombre: { startsWith: TEST_PREFIX } },
    select: { id: true },
  });
  const eventoIds = eventos.map((e) => e.id);
  if (eventoIds.length === 0) return;

  const cs = await prisma.compra.findMany({
    where: { eventoId: { in: eventoIds } },
    select: { id: true },
  });
  const compraIds = cs.map((c) => c.id);

  await prisma.entrada.deleteMany({ where: { compraId: { in: compraIds } } });
  await prisma.compra.deleteMany({ where: { id: { in: compraIds } } });
  await prisma.tanda.deleteMany({ where: { eventoId: { in: eventoIds } } });
  await prisma.evento.deleteMany({ where: { id: { in: eventoIds } } });
}

const argsBase = {
  titulo: 'Evento de prueba — 2 entrada(s)',
  precio: 10000,
  cantidad: 2,
  preferenciaId: '4242',
};

async function main() {
  const checks = [];
  try {
    // ============================================
    // BLOQUE 1 — el body que recibe Mercado Pago
    // ============================================

    const bodyCompleto = construirBodyPreferencia({
      ...argsBase,
      email: 'compradora@example.com',
      nombre: 'Carmen',
      apellido: 'Miranda',
      telefono: '2211234567',
    });

    checks.push({
      name: 'payer viaja con email + name + surname (no solo email)',
      pass: bodyCompleto.payer.email === 'compradora@example.com'
        && bodyCompleto.payer.name === 'Carmen'
        && bodyCompleto.payer.surname === 'Miranda',
      detail: JSON.stringify(bodyCompleto.payer),
    });

    checks.push({
      name: 'payer.phone.number lleva el teléfono del comprador',
      pass: bodyCompleto.payer.phone?.number === '2211234567',
      detail: JSON.stringify(bodyCompleto.payer.phone ?? null),
    });

    // Formato sucio: el form es un input libre y la gente escribe como quiere.
    const bodySucio = construirBodyPreferencia({
      ...argsBase,
      email: 'x@example.com',
      nombre: '  Carmen  ',
      apellido: '  Miranda  ',
      telefono: '+54 9 (221) 123-4567',
    });
    checks.push({
      name: 'teléfono con formato libre → solo dígitos; nombre/apellido sin espacios de sobra',
      pass: bodySucio.payer.phone?.number === '5492211234567'
        && bodySucio.payer.name === 'Carmen'
        && bodySucio.payer.surname === 'Miranda',
      detail: JSON.stringify(bodySucio.payer),
    });

    // Campos vacíos: se OMITEN, no viajan en blanco. Un dato vacío que MP cruza
    // es peor que un dato ausente.
    const bodySinDatos = construirBodyPreferencia({
      ...argsBase,
      email: 'x@example.com',
      nombre: '',
      apellido: '   ',
      telefono: '',
    });
    checks.push({
      name: 'campos vacíos se omiten del payer (no viajan como "")',
      pass: bodySinDatos.payer.email === 'x@example.com'
        && !('name' in bodySinDatos.payer)
        && !('surname' in bodySinDatos.payer)
        && !('phone' in bodySinDatos.payer),
      detail: JSON.stringify(bodySinDatos.payer),
    });

    // Teléfono que no tiene un solo dígito → tampoco inventamos un phone vacío.
    const bodyTelBasura = construirBodyPreferencia({
      ...argsBase, email: 'x@example.com', telefono: '---',
    });
    checks.push({
      name: 'teléfono sin dígitos → sin phone (no {number:""})',
      pass: !('phone' in bodyTelBasura.payer),
      detail: JSON.stringify(bodyTelBasura.payer),
    });

    // Regresión: el resto del body sigue igual que antes del cambio.
    checks.push({
      name: 'regresión: items, external_reference y notification_url intactos',
      pass: bodyCompleto.items.length === 1
        && bodyCompleto.items[0].unit_price === 10000
        && bodyCompleto.items[0].quantity === 2
        && bodyCompleto.items[0].currency_id === 'ARS'
        && bodyCompleto.external_reference === '4242'
        && String(bodyCompleto.notification_url).endsWith('/api/compras/webhook'),
      detail: `items=${bodyCompleto.items.length} ext_ref=${bodyCompleto.external_reference}`,
    });

    // Regresión: el ítem extra del menú de Casa Metro sigue sumándose.
    const bodyConMenu = construirBodyPreferencia({
      ...argsBase,
      email: 'x@example.com',
      itemsExtra: [{ title: 'Menú Casa Metro — 2 menú(s)', unit_price: 15000, quantity: 2 }],
    });
    checks.push({
      name: 'regresión: itemsExtra (menú Casa Metro) sigue viajando como línea aparte',
      pass: bodyConMenu.items.length === 2
        && bodyConMenu.items[1].unit_price === 15000
        && bodyConMenu.items[1].currency_id === 'ARS',
      detail: `items=${bodyConMenu.items.length}`,
    });

    // ============================================
    // BLOQUE 2 — el controller pasa los datos de la Compra
    // ============================================

    const evento = await prisma.evento.create({
      data: {
        nombre: `${TEST_PREFIX}${Date.now()}`,
        descripcion: 'test',
        fecha: new Date(Date.now() + 7 * 24 * 3600 * 1000),
        hora: '21:00',
        estaPublicado: true,
        tandas: {
          create: [{ nombre: 'Tanda 1', precio: 10000, orden: 1, activa: true }],
        },
      },
      include: { tandas: true },
    });

    mpCalls = [];
    const res = await call({
      eventoId: evento.id,
      email: 'compradora@example.com',
      nombre: 'Carmen',
      apellido: 'Miranda',
      telefono: '2211234567',
      cantidad: 2,
    });

    checks.push({
      name: 'controller: la compra se crea OK (200)',
      pass: res.statusCode === 200 && !!res.body?.compra_id,
      detail: `status=${res.statusCode} compra=${res.body?.compra_id}`,
    });

    const argsRecibidos = mpCalls[0] || {};
    checks.push({
      name: 'controller: le pasa nombre, apellido y teléfono al servicio de MP',
      pass: argsRecibidos.nombre === 'Carmen'
        && argsRecibidos.apellido === 'Miranda'
        && argsRecibidos.telefono === '2211234567',
      detail: `nombre=${argsRecibidos.nombre} apellido=${argsRecibidos.apellido} telefono=${argsRecibidos.telefono}`,
    });

    // El eslabón completo: con los args REALES del controller, el body que MP
    // recibiría lleva el payer completo. Esto es lo que ninguna de las dos capas
    // por separado puede afirmar.
    const bodyReal = construirBodyPreferencia(argsRecibidos);
    checks.push({
      name: 'punta a punta: el body derivado de una compra real lleva el payer completo',
      pass: bodyReal.payer.email === 'compradora@example.com'
        && bodyReal.payer.name === 'Carmen'
        && bodyReal.payer.surname === 'Miranda'
        && bodyReal.payer.phone?.number === '2211234567',
      detail: JSON.stringify(bodyReal.payer),
    });

    // Compra sin teléfono (el campo es opcional en el form): el controller
    // guarda '' y el payer no debe llevar phone.
    mpCalls = [];
    await call({
      eventoId: evento.id,
      email: 'otro@example.com',
      nombre: 'Juan',
      apellido: 'Pérez',
      cantidad: 1,
    });
    const bodySinTel = construirBodyPreferencia(mpCalls[0] || {});
    checks.push({
      name: 'punta a punta: compra sin teléfono → payer con nombre y sin phone',
      pass: bodySinTel.payer.name === 'Juan'
        && bodySinTel.payer.surname === 'Pérez'
        && !('phone' in bodySinTel.payer),
      detail: JSON.stringify(bodySinTel.payer),
    });

    // ============================================
    // REPORT
    // ============================================

    console.log('─'.repeat(72));
    console.log('MP payer — datos del comprador en la preferencia de Checkout Pro');
    console.log('─'.repeat(72));
    for (const c of checks) {
      console.log(`${c.pass ? '✅' : '❌'} ${c.name}`);
      console.log(`   ${c.detail}`);
    }
    console.log('─'.repeat(72));

    const failed = checks.filter((c) => !c.pass);
    if (failed.length > 0) {
      console.log(`\n❌ FAIL — ${failed.length}/${checks.length} checks fallaron`);
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
    try {
      await cleanup();
    } catch (cleanupErr) {
      console.error('WARN cleanup:', cleanupErr.message);
    }
    mpService.crearPreferencia = originalCrearPref;
    await prisma.$disconnect();
    process.exit(process.exitCode || 0);
  }
}

main();
