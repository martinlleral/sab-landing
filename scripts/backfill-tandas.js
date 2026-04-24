/**
 * Backfill post-migración de tandas.
 *
 * Dos pasos, ambos idempotentes:
 *
 *   1. Para cada Evento que no tenga Tandas, crea una Tanda "General" con
 *      los valores legacy del evento (precioEntrada, cantidadDisponible,
 *      cantidadVendida).
 *
 *   2. Para cada Compra con tandaId=NULL (compras creadas antes de que
 *      existiera el campo), asignarle la primera tanda de su evento (por
 *      `orden` ascendente). Previene drift en el contador cuando estas
 *      compras pre-tandas se aprueban después del deploy.
 *
 * Uso:
 *   docker exec sab-app node scripts/backfill-tandas.js           # aplica
 *   docker exec sab-app node scripts/backfill-tandas.js --dry     # sólo reporta
 *
 * Exit codes:
 *   0 = OK (cambios aplicados o nada que hacer)
 *   1 = ERROR
 */

const prisma = require('../src/utils/prisma');

const DRY_RUN = process.argv.includes('--dry');

async function backfillTandas() {
  const eventos = await prisma.evento.findMany({
    include: { _count: { select: { tandas: true } } },
    orderBy: { id: 'asc' },
  });

  const sinTandas = eventos.filter((e) => e._count.tandas === 0);
  const conTandas = eventos.length - sinTandas.length;

  console.log('─'.repeat(60));
  console.log(`Paso 1/2 — Backfill de tandas ${DRY_RUN ? '(DRY RUN)' : ''}`);
  console.log('─'.repeat(60));
  console.log(`Total eventos:      ${eventos.length}`);
  console.log(`Ya con tandas:      ${conTandas} (saltados)`);
  console.log(`Sin tandas:         ${sinTandas.length} (a procesar)`);

  for (const ev of sinTandas) {
    const tanda = {
      eventoId: ev.id,
      nombre: 'General',
      precio: ev.precioEntrada,
      orden: 1,
      activa: true,
      capacidad: ev.cantidadDisponible > 0 ? ev.cantidadDisponible : null,
      cantidadVendida: ev.cantidadVendida,
      fechaLimite: null,
    };

    console.log(
      `  Evento #${ev.id} "${ev.nombre}" → Tanda General ` +
      `precio=$${tanda.precio} capacidad=${tanda.capacidad ?? '∞'} vendidas=${tanda.cantidadVendida}`
    );

    if (!DRY_RUN) {
      await prisma.tanda.create({ data: tanda });
    }
  }

  return { procesadas: sinTandas.length, saltadas: conTandas };
}

async function backfillComprasTandaId() {
  // Compras sin tandaId — creadas antes de que existiera el campo.
  const comprasSinTanda = await prisma.compra.findMany({
    where: { tandaId: null },
    select: { id: true, eventoId: true, mpEstado: true, createdAt: true },
    orderBy: { id: 'asc' },
  });

  console.log();
  console.log('─'.repeat(60));
  console.log(`Paso 2/2 — Backfill de Compra.tandaId ${DRY_RUN ? '(DRY RUN)' : ''}`);
  console.log('─'.repeat(60));
  console.log(`Compras sin tandaId:  ${comprasSinTanda.length}`);

  if (comprasSinTanda.length === 0) {
    return { procesadas: 0 };
  }

  // Cachear primera tanda por evento (orden ascendente)
  const eventoIds = [...new Set(comprasSinTanda.map((c) => c.eventoId))];
  const primeraPorEvento = new Map();
  for (const eid of eventoIds) {
    const tanda = await prisma.tanda.findFirst({
      where: { eventoId: eid },
      orderBy: { orden: 'asc' },
      select: { id: true, nombre: true },
    });
    if (tanda) primeraPorEvento.set(eid, tanda);
  }

  let procesadas = 0;
  for (const c of comprasSinTanda) {
    const tanda = primeraPorEvento.get(c.eventoId);
    if (!tanda) {
      console.log(`  ⚠ Compra #${c.id} (evento ${c.eventoId}) sin tanda disponible — saltada`);
      continue;
    }
    console.log(
      `  Compra #${c.id} (${c.mpEstado}, ${c.createdAt.toISOString().slice(0, 10)}) ` +
      `→ tandaId=${tanda.id} "${tanda.nombre}"`
    );
    procesadas += 1;
    if (!DRY_RUN) {
      await prisma.compra.update({ where: { id: c.id }, data: { tandaId: tanda.id } });
    }
  }

  return { procesadas };
}

async function main() {
  const r1 = await backfillTandas();
  const r2 = await backfillComprasTandaId();

  console.log();
  console.log('─'.repeat(60));
  const verbo = DRY_RUN ? 'se crearían/actualizarían' : 'aplicado';
  console.log(`✅ Backfill ${DRY_RUN ? '(DRY RUN) ' : ''}${verbo}.`);
  console.log(`   Tandas:  ${r1.procesadas}  (saltadas ${r1.saltadas})`);
  console.log(`   Compras: ${r2.procesadas}`);
  console.log('─'.repeat(60));
}

main()
  .catch((err) => {
    console.error('❌ ERROR:', err.message);
    console.error(err.stack);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
