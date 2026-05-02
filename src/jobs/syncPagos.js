const prisma = require('../utils/prisma');
const config = require('../config');
const mpService = require('../services/mercadopago.service');
const { procesarPagoAprobado, procesarPagoCancelado } = require('../services/pagos.service');

const VENTANA_HORAS = 168;
const HORAS_AUTOCANCEL = 72;
const ESTADOS_TERMINALES = ['rejected', 'cancelled', 'charged_back', 'refunded'];
const ESTADOS_ACTIVOS = ['pending', 'in_process', 'authorized'];

let corriendo = false; // Guard para evitar ejecuciones solapadas

async function syncPagosPendientes() {
  if (corriendo) return;
  corriendo = true;

  try {
    const desde = new Date(Date.now() - VENTANA_HORAS * 60 * 60 * 1000);
    const cutoffCancel = new Date(Date.now() - HORAS_AUTOCANCEL * 60 * 60 * 1000);

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

    const expectedCollector = config.mercadopago.userId;

    for (const compra of pendientes) {
      try {
        const pagos = await mpService.buscarPagoPorCompra(compra.id);

        // Filtrar primero pagos VÁLIDOS para esta compra (mismo collector + mismo monto).
        // Esto desambigua ruido por external_references reciclados (ej: pruebas viejas).
        const pagosValidos = pagos.filter((p) => {
          if (expectedCollector && String(p.collector_id) !== String(expectedCollector)) {
            return false;
          }
          if (Number(p.transaction_amount) !== Number(compra.totalPagado)) {
            return false;
          }
          return true;
        });

        const descartados = pagos.length - pagosValidos.length;
        if (descartados > 0) {
          console.log(`[sync] compra=${compra.id}: ${descartados} pago(s) MP descartado(s) por collector/monto`);
        }

        // 1) Approved válido → procesar (camino feliz)
        const aprobado = pagosValidos.find((p) => p.status === 'approved');
        if (aprobado) {
          const resultado = await procesarPagoAprobado(compra.id, aprobado.id);
          if (resultado.ya_procesada) {
            console.log(`⏭  Compra #${compra.id} ya estaba procesada`);
          } else {
            console.log(
              `✅ Compra #${compra.id} aprobada — ${resultado.entradas} entrada(s) generada(s) (pago ${aprobado.id})`
            );
          }
          continue;
        }

        // 2) Terminal válido (rejected/cancelled/charged_back/refunded) → reflejar en BD
        //    + liberar cupón si la compra lo tenía (atómico vía procesarPagoCancelado).
        const terminal = pagosValidos.find((p) => ESTADOS_TERMINALES.includes(p.status));
        if (terminal) {
          const r = await procesarPagoCancelado(compra.id, terminal.status, terminal.id);
          const cuponMsg = r.libero_cupon ? ' (cupón liberado)' : '';
          console.log(`❌ Compra #${compra.id} → ${terminal.status} (pago ${terminal.id})${cuponMsg}`);
          continue;
        }

        // 3) Pago activo válido (pending/in_process/authorized en MP) → seguir esperando.
        //    Cubre Rapipago/PagoFácil sin acreditar y revisiones de MP. NUNCA autocancelar acá.
        const activo = pagosValidos.find((p) => ESTADOS_ACTIVOS.includes(p.status));
        if (activo) {
          console.log(`⏳ Compra #${compra.id} con pago ${activo.status} en MP — esperando`);
          continue;
        }

        // 4) Sin ningún pago válido + compra vieja (>72h) → autocancelar (abandono).
        //    Libera el cupón asociado si lo tenía (atómico).
        if (compra.createdAt < cutoffCancel) {
          const r = await procesarPagoCancelado(compra.id, 'cancelled');
          const cuponMsg = r.libero_cupon ? ' (cupón liberado)' : '';
          console.log(`🗑  Compra #${compra.id} → cancelled (sin pago válido en ${HORAS_AUTOCANCEL}h)${cuponMsg}`);
          continue;
        }

        // 5) Compra reciente sin pago válido → seguir esperando (usuario aún en checkout)
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
