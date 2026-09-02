/**
 * Diagnóstico (SOLO LECTURA): compras aprobadas que se quedaron sin entradas.
 *
 * `procesarPagoAprobado` toma el lock (mpEstado -> 'approved') y DESPUÉS genera
 * los QR y las entradas. Si algo falla en el medio —el disco sin espacio, un
 * restart del contenedor a mitad de camino, la transacción abortada— la compra
 * queda cobrada y sin entrada, y el backoffice no ofrece ninguna forma de
 * arreglarlo: "Reenviar mail" contesta 400 porque no hay entradas que mandar.
 *
 * Este script no escribe nada. Contesta tres preguntas:
 *   1. ¿Qué compras están en ese estado? (quiénes son, cuánto pagaron, cuándo)
 *   2. ¿El stock de la tanda quedó bien contado? (la transacción que crea las
 *      entradas es la misma que incrementa `cantidadVendida`)
 *   3. ¿Faltan PNG de QR en disco? (síntoma de que el disco fue la causa)
 *
 * Uso, desde la máquina de trabajo:
 *   ssh sab-droplet 'docker exec -i sab-app node -' < scripts/diagnostico-entradas-faltantes.js
 */
const path = require('path');
const fs = require('fs');
const prisma = require('/app/src/utils/prisma');

const QR_DIR = '/app/public/assets/img/uploads/qr';
const fmt = (d) => (d ? new Date(d).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : '—');

async function main() {
  const compras = await prisma.compra.findMany({
    where: { mpEstado: 'approved' },
    include: {
      evento: { select: { id: true, nombre: true, fecha: true } },
      tanda: { select: { id: true, nombre: true, cantidadVendida: true, capacidad: true } },
      _count: { select: { entradas: true } },
    },
    orderBy: { id: 'asc' },
  });

  const rotas = compras.filter((c) => c._count.entradas === 0);
  const parciales = compras.filter(
    (c) => c._count.entradas > 0 && c._count.entradas !== c.cantidadEntradas
  );

  console.log('=== 1. COMPRAS APROBADAS SIN ENTRADAS ===');
  console.log(`Aprobadas totales: ${compras.length} · sin entradas: ${rotas.length} · con entradas incompletas: ${parciales.length}\n`);

  for (const c of [...rotas, ...parciales]) {
    console.log(
      `#${c.id}  ${c.email}  ${c.nombre} ${c.apellido}\n` +
      `   evento ${c.evento.id} "${c.evento.nombre}" (${fmt(c.evento.fecha)})\n` +
      `   entradas esperadas ${c.cantidadEntradas} / creadas ${c._count.entradas} · menús ${c.cantidadMenus} · $${c.totalPagado}\n` +
      `   mpPagoId ${c.mpPagoId || '(vacío)'} · pref ${c.mpPreferenciaId || '(vacía)'}\n` +
      `   tanda ${c.tandaId || '(sin tanda)'} · creada ${fmt(c.createdAt)} · actualizada ${fmt(c.updatedAt)}\n`
    );
  }

  console.log('=== 2. STOCK DE LAS TANDAS INVOLUCRADAS ===');
  const tandaIds = [...new Set([...rotas, ...parciales].map((c) => c.tandaId).filter(Boolean))];
  for (const tandaId of tandaIds) {
    const tanda = await prisma.tanda.findUnique({ where: { id: tandaId } });
    const agg = await prisma.compra.aggregate({
      where: { tandaId, mpEstado: 'approved' },
      _sum: { cantidadEntradas: true },
    });
    const vendidasReales = agg._sum.cantidadEntradas || 0;
    const delta = tanda.cantidadVendida - vendidasReales;
    console.log(
      `tanda ${tanda.id} "${tanda.nombre}" · capacidad ${tanda.capacidad ?? '∞'} · ` +
      `contador ${tanda.cantidadVendida} vs suma de compras approved ${vendidasReales} ` +
      `→ ${delta === 0 ? 'OK' : `DESFASE ${delta > 0 ? '+' : ''}${delta}`}`
    );
  }
  if (!tandaIds.length) console.log('(ninguna)');

  console.log('\n=== 3. PNG DE QR EN DISCO ===');
  const ultimas = await prisma.entrada.findMany({
    orderBy: { id: 'desc' },
    take: 200,
    select: { id: true, codigoQR: true, compraId: true, createdAt: true },
  });
  const faltantes = ultimas.filter((e) => !fs.existsSync(path.join(QR_DIR, `${e.codigoQR}.png`)));
  console.log(`Últimas ${ultimas.length} entradas · PNG faltantes: ${faltantes.length}`);
  for (const e of faltantes.slice(0, 20)) {
    console.log(`   entrada ${e.id} (compra #${e.compraId}, ${fmt(e.createdAt)}) → falta ${e.codigoQR}.png`);
  }
  if (ultimas.length) {
    console.log(`Rango revisado: entradas ${ultimas[ultimas.length - 1].id}–${ultimas[0].id}`);
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('Error en el diagnóstico:', err);
  await prisma.$disconnect();
  process.exit(1);
});
