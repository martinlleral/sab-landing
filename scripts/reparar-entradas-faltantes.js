/**
 * Reparación de compras aprobadas que se quedaron sin entradas.
 *
 * Completa lo que `procesarPagoAprobado` dejó a medias: genera los QR que
 * faltan, crea las filas de `Entrada` y —dentro de la misma transacción—
 * incrementa el `cantidadVendida` de la tanda por las entradas que efectivamente
 * crea. El increment va acá porque la transacción original es atómica: si no hay
 * entradas, tampoco hubo increment (ambos viven en el mismo `$transaction`).
 * Si el diagnóstico muestra que el contador YA incluye estas entradas, correr
 * con --sin-stock.
 *
 * Es idempotente: relee las entradas dentro de la transacción y solo crea las
 * que faltan, así que correrlo dos veces no duplica nada.
 *
 * Uso (desde la máquina de trabajo):
 *   # 1) ver qué haría, sin tocar nada
 *   ssh sab-droplet 'docker exec -i sab-app node -' < scripts/reparar-entradas-faltantes.js
 *   # 2) aplicar (y mandar el mail con las entradas)
 *   ssh sab-droplet 'docker exec -i -e ARGS="--apply --mail" sab-app node -' < scripts/reparar-entradas-faltantes.js
 *
 * Flags (por variable de entorno ARGS, porque `node -` no recibe argv):
 *   --apply       escribe de verdad (sin esto es dry-run)
 *   --mail        envía el mail de confirmación al comprador
 *   --sin-stock   no toca el contador de la tanda
 *   --compra=ID   limita la reparación a una compra puntual
 */
const { v4: uuidv4 } = require('uuid');
const prisma = require('/app/src/utils/prisma');
const qrService = require('/app/src/services/qr.service');
const brevoService = require('/app/src/services/brevo.service');

const ARGS = (process.env.ARGS || '').split(/\s+/).filter(Boolean);
const APLICAR = ARGS.includes('--apply');
const MANDAR_MAIL = ARGS.includes('--mail');
const SIN_STOCK = ARGS.includes('--sin-stock');
const SOLO_COMPRA = (() => {
  const arg = ARGS.find((a) => a.startsWith('--compra='));
  return arg ? parseInt(arg.split('=')[1], 10) : null;
})();

async function main() {
  const where = { mpEstado: 'approved' };
  if (SOLO_COMPRA) where.id = SOLO_COMPRA;

  const candidatas = await prisma.compra.findMany({
    where,
    include: { evento: true, _count: { select: { entradas: true } } },
    orderBy: { id: 'asc' },
  });

  const rotas = candidatas.filter((c) => c._count.entradas < c.cantidadEntradas);

  console.log(`Modo: ${APLICAR ? 'APLICAR' : 'DRY-RUN (no escribe nada)'}` +
    `${MANDAR_MAIL ? ' + mail' : ' · sin mail'}${SIN_STOCK ? ' · sin tocar stock' : ''}`);
  console.log(`Compras aprobadas revisadas: ${candidatas.length} · a reparar: ${rotas.length}\n`);

  if (!rotas.length) {
    await prisma.$disconnect();
    return;
  }

  for (const compra of rotas) {
    const faltan = compra.cantidadEntradas - compra._count.entradas;
    console.log(`#${compra.id} ${compra.email} · evento "${compra.evento.nombre}" · ` +
      `crear ${faltan} de ${compra.cantidadEntradas} entrada(s)`);

    if (!APLICAR) continue;

    // Los QR se generan ANTES de abrir la transacción: escribir archivos es lo
    // que puede fallar (disco), y si falla queremos enterarnos sin haber tocado
    // la base.
    const nuevos = [];
    for (let i = 0; i < faltan; i++) {
      const codigo = uuidv4();
      const qrImageUrl = await qrService.generarQR(codigo);
      nuevos.push({ codigo, qrImageUrl });
    }

    const creadas = await prisma.$transaction(async (tx) => {
      const yaHay = await tx.entrada.count({ where: { compraId: compra.id } });
      const pendientes = compra.cantidadEntradas - yaHay;
      if (pendientes <= 0) return [];

      const aCrear = nuevos.slice(0, pendientes);
      if (compra.tandaId && !SIN_STOCK) {
        await tx.tanda.update({
          where: { id: compra.tandaId },
          data: { cantidadVendida: { increment: aCrear.length } },
        });
      }

      const out = [];
      for (const { codigo, qrImageUrl } of aCrear) {
        out.push(await tx.entrada.create({
          data: { compraId: compra.id, codigoQR: codigo, qrImageUrl },
        }));
      }
      return out;
    });

    console.log(`   ✅ ${creadas.length} entrada(s) creada(s)` +
      `${compra.tandaId && !SIN_STOCK ? ` · stock de la tanda ${compra.tandaId} +${creadas.length}` : ''}`);

    if (MANDAR_MAIL && creadas.length) {
      const todas = await prisma.entrada.findMany({
        where: { compraId: compra.id },
        orderBy: { createdAt: 'asc' },
      });
      const entradasParaMail = [];
      for (const entrada of todas) {
        const qrBase64 = await qrService.generarQRBase64(entrada.codigoQR);
        entradasParaMail.push({ ...entrada, qrBase64: qrBase64.split(',')[1] });
      }
      try {
        await brevoService.enviarConfirmacion({
          email: compra.email,
          nombre: compra.nombre,
          evento: compra.evento,
          entradas: entradasParaMail,
          compra,
        });
        console.log(`   📧 mail enviado a ${compra.email} con ${entradasParaMail.length} entrada(s)`);
      } catch (mailErr) {
        console.error(`   ⚠️  mail NO enviado a ${compra.email}: ${mailErr.message}`);
      }
    }
  }

  if (!APLICAR) {
    console.log('\nNada se escribió. Para aplicar: ARGS="--apply --mail".');
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('Error en la reparación:', err);
  await prisma.$disconnect();
  process.exit(1);
});
