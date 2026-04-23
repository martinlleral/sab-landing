/**
 * Test de integración: persistencia de QR en disk tras procesarPagoAprobado.
 *
 * Previene la regresión silenciosa que gatilló la auditoría del 22/4/2026 (falso P0.3):
 * si qr.service.generarQR() deja de usar QRCode.toFile() y pasa a solo base64,
 * este test lo detecta antes de llegar a prod.
 *
 * Qué valida:
 *   1. procesarPagoAprobado() marca la compra como approved.
 *   2. Se crea una Entrada por cada cantidadEntradas de la compra.
 *   3. Cada Entrada tiene su archivo PNG correspondiente en public/assets/img/uploads/qr/.
 *   4. Los archivos tienen tamaño > 0 (no son placeholders vacíos).
 *   5. Una segunda llamada con el mismo compraId es idempotente (no duplica entradas ni archivos).
 *
 * Uso:
 *   docker exec sab-app node tests/integration/qr-persistence.test.js
 *   # o agregar `npm run test:integration:qr` al package.json si corrés fuera del container
 *
 * Exit codes:
 *   0 = PASS
 *   1 = FAIL (algún check no pasó, ver stderr)
 */

const fs = require('fs');
const path = require('path');
const prisma = require('../../src/utils/prisma');
const { procesarPagoAprobado } = require('../../src/services/pagos.service');

const QR_DIR = path.join(__dirname, '../../public/assets/img/uploads/qr');
const TEST_EMAIL_PREFIX = 'qr-persistence-test-';
const TEST_EVENTO_NAME = 'QR Persistence Test Event';

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
  await prisma.evento.deleteMany({
    where: { id: { in: eventoIds }, nombre: TEST_EVENTO_NAME },
  });

  return { compras: compras.length, eventos: eventoIds.length };
}

async function main() {
  const ts = Date.now();
  const CANTIDAD = 3;
  let compraId = null;

  try {
    await cleanup();

    const evento = await prisma.evento.create({
      data: {
        nombre: TEST_EVENTO_NAME,
        descripcion: 'Evento temporal para test de integración de persistencia QR',
        fecha: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        hora: '21:00',
        precioEntrada: 1000,
        cantidadDisponible: 10,
        cantidadVendida: 0,
        estaPublicado: false,
      },
    });

    const compra = await prisma.compra.create({
      data: {
        eventoId: evento.id,
        email: `${TEST_EMAIL_PREFIX}${ts}@test.invalid`,
        nombre: 'QR-Test',
        apellido: 'Persistence',
        telefono: '0',
        cantidadEntradas: CANTIDAD,
        precioUnitario: 1000,
        totalPagado: CANTIDAD * 1000,
        mpEstado: 'pending',
        mpPreferenciaId: `test-pref-${ts}`,
      },
    });
    compraId = compra.id;

    const result = await procesarPagoAprobado(compra.id, `TEST-PAGO-${ts}`);

    const checks = [];

    checks.push({
      name: 'resultado contiene procesada:true',
      pass: result.procesada === true && result.entradas === CANTIDAD,
      detail: JSON.stringify(result),
    });

    const compraPost = await prisma.compra.findUnique({ where: { id: compra.id } });
    checks.push({
      name: 'compra.mpEstado === "approved"',
      pass: compraPost.mpEstado === 'approved',
      detail: `mpEstado=${compraPost.mpEstado}`,
    });

    const entradas = await prisma.entrada.findMany({ where: { compraId: compra.id } });
    checks.push({
      name: `entradas en DB === ${CANTIDAD}`,
      pass: entradas.length === CANTIDAD,
      detail: `count=${entradas.length}`,
    });

    const filesOnDisk = entradas.map((e) => {
      const fp = path.join(QR_DIR, `${e.codigoQR}.png`);
      return {
        codigo: e.codigoQR,
        path: fp,
        exists: fs.existsSync(fp),
        size: fs.existsSync(fp) ? fs.statSync(fp).size : 0,
      };
    });

    checks.push({
      name: `todos los QR PNG persisten en ${QR_DIR}`,
      pass: filesOnDisk.every((f) => f.exists),
      detail: filesOnDisk.map((f) => `${f.codigo}:${f.exists ? 'OK' : 'MISSING'}`).join(', '),
    });

    checks.push({
      name: 'todos los QR PNG tienen tamaño > 0',
      pass: filesOnDisk.every((f) => f.size > 0),
      detail: filesOnDisk.map((f) => `${f.codigo}:${f.size}b`).join(', '),
    });

    const result2 = await procesarPagoAprobado(compra.id, `TEST-PAGO-${ts}`);
    checks.push({
      name: 'segunda llamada retorna ya_procesada:true (idempotencia)',
      pass: result2.ya_procesada === true,
      detail: JSON.stringify(result2),
    });

    const entradasPost = await prisma.entrada.count({ where: { compraId: compra.id } });
    checks.push({
      name: `idempotencia no duplica entradas (sigue en ${CANTIDAD})`,
      pass: entradasPost === CANTIDAD,
      detail: `count post 2da llamada=${entradasPost}`,
    });

    console.log('─'.repeat(60));
    console.log('QR Persistence Integration Test');
    console.log('─'.repeat(60));
    for (const c of checks) {
      console.log(`${c.pass ? '✅' : '❌'} ${c.name}`);
      console.log(`   ${c.detail}`);
    }
    console.log('─'.repeat(60));

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
      const result = await cleanup();
      console.log(`\ncleanup: ${result.compras} compras, ${result.eventos} eventos`);
    } catch (cleanupErr) {
      console.error('WARN cleanup:', cleanupErr.message);
    }
    await prisma.$disconnect();
    process.exit(process.exitCode || 0);
  }
}

main();
