/**
 * Backfill de tandas para eventos existentes.
 *
 * Para cada Evento que no tenga Tandas, crea una Tanda "General" con los
 * valores legacy del evento (precioEntrada, cantidadDisponible, cantidadVendida).
 * Idempotente: si el evento ya tiene al menos una tanda, lo saltea.
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

async function main() {
  const eventos = await prisma.evento.findMany({
    include: { _count: { select: { tandas: true } } },
    orderBy: { id: 'asc' },
  });

  const sinTandas = eventos.filter((e) => e._count.tandas === 0);
  const conTandas = eventos.length - sinTandas.length;

  console.log('─'.repeat(60));
  console.log(`Backfill de tandas ${DRY_RUN ? '(DRY RUN)' : ''}`);
  console.log('─'.repeat(60));
  console.log(`Total eventos:      ${eventos.length}`);
  console.log(`Ya con tandas:      ${conTandas} (saltados)`);
  console.log(`Sin tandas:         ${sinTandas.length} (a procesar)`);
  console.log('─'.repeat(60));

  if (sinTandas.length === 0) {
    console.log('✅ Nada que hacer. Todos los eventos tienen al menos una tanda.');
    process.exit(0);
  }

  let creadas = 0;
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
      `Evento #${ev.id} "${ev.nombre}" → Tanda General ` +
      `precio=$${tanda.precio} capacidad=${tanda.capacidad ?? '∞'} vendidas=${tanda.cantidadVendida}`
    );

    if (!DRY_RUN) {
      await prisma.tanda.create({ data: tanda });
      creadas += 1;
    }
  }

  console.log('─'.repeat(60));
  if (DRY_RUN) {
    console.log(`✅ DRY RUN completo. ${sinTandas.length} tandas se crearían.`);
  } else {
    console.log(`✅ Backfill completo. ${creadas} tandas creadas.`);
  }
}

main()
  .catch((err) => {
    console.error('❌ ERROR:', err.message);
    console.error(err.stack);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
