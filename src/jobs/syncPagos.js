const prisma = require('../utils/prisma');
const config = require('../config');
const mpService = require('../services/mercadopago.service');
const { procesarPagoAprobado } = require('../services/pagos.service');

const VENTANA_HORAS = 168;
const ESTADOS_TERMINALES = ['rejected', 'cancelled', 'charged_back', 'refunded'];

let corriendo = false; // Guard para evitar ejecuciones solapadas

async function syncPagosPendientes() {
  if (corriendo) return;
  corriendo = true;

  try {
    const desde = new Date(Date.now() - VENTANA_HORAS * 60 * 60 * 1000);

    const pendientes = await prisma.compra.findMany({
      where: {
        mpEstado: 'pending',
        mpPreferenciaId: { not: '' },
        createdAt: { gte: desde },
      },
      orderBy: { createdAt: 'asc' },
    });

    if (!pendientes.length) return;

    console.log(`🔄 Sync pagos MP: ${pendientes.length} compra(s) pendiente(s)`);

    for (const compra of pendientes) {
      try {
        const pagos = await mpService.buscarPagoPorCompra(compra.id);

        if (!pagos.length) {
          // Sin pagos registrados aún — normal si el usuario no completó el pago
          continue;
        }

        // Tomamos el pago más reciente con estado definitivo
        const aprobado = pagos.find((p) => p.status === 'approved');
        const terminal = pagos.find((p) => ESTADOS_TERMINALES.includes(p.status));

        if (aprobado) {
          const expectedCollector = config.mercadopago.userId;
          if (expectedCollector && String(aprobado.collector_id) !== String(expectedCollector)) {
            console.warn(
              `[sync] WARN: collector_id mismatch compra=${compra.id} ` +
              `(got ${aprobado.collector_id}, expected ${expectedCollector}) — skip`
            );
            continue;
          }

          if (Number(aprobado.transaction_amount) !== Number(compra.totalPagado)) {
            console.warn(
              `[sync] WARN: amount mismatch compra=${compra.id} ` +
              `(pagado ${aprobado.transaction_amount}, esperado ${compra.totalPagado}) — skip`
            );
            continue;
          }

          const resultado = await procesarPagoAprobado(compra.id, aprobado.id);
          if (resultado.ya_procesada) {
            console.log(`⏭  Compra #${compra.id} ya estaba procesada`);
          } else {
            console.log(
              `✅ Compra #${compra.id} aprobada — ${resultado.entradas} entrada(s) generada(s) (pago ${aprobado.id})`
            );
          }
        } else if (terminal) {
          await prisma.compra.update({
            where: { id: compra.id },
            data: {
              mpEstado: terminal.status,
              mpPagoId: String(terminal.id),
            },
          });
          console.log(`❌ Compra #${compra.id} → ${terminal.status} (pago ${terminal.id})`);
        }
      } catch (err) {
        console.error(`Error procesando compra #${compra.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('Error en syncPagosPendientes:', err.message);
  } finally {
    corriendo = false;
  }
}

module.exports = { syncPagosPendientes };
