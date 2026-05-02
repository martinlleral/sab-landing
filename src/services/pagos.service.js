const { v4: uuidv4 } = require('uuid');
const prisma = require('../utils/prisma');
const qrService = require('./qr.service');
const brevoService = require('./brevo.service');
const { liberarCupon } = require('./precios.service');

/**
 * Procesa una compra aprobada: actualiza estado, genera entradas con QR y envía email.
 *
 * Idempotencia con lock optimista:
 * `updateMany` con WHERE mpEstado != 'approved' es atómico en SQLite — si dos
 * procesos corren en paralelo (webhook + checkAndProcess + cron), solo uno
 * obtiene count=1 y avanza; los otros obtienen count=0 y hacen early return.
 * Esto previene entradas/emails/cantidadVendida duplicados.
 *
 * Trade-off: si falla DESPUÉS del lock (ej. qr.generarQR lanza), la compra
 * queda como approved sin entradas generadas. Es estado inconsistente pero
 * recuperable manualmente desde backoffice, y es mejor que la alternativa
 * (mantener el lock fuera y tener duplicados silenciosos).
 *
 * @param {number} compraId
 * @param {string|number} mpPaymentId
 * @returns {{ ya_procesada: boolean } | { procesada: boolean, entradas: number }}
 */
async function procesarPagoAprobado(compraId, mpPaymentId) {
  const lockResult = await prisma.compra.updateMany({
    where: { id: compraId, mpEstado: { not: 'approved' } },
    data: { mpEstado: 'approved', mpPagoId: String(mpPaymentId) },
  });

  if (lockResult.count === 0) {
    return { ya_procesada: true };
  }

  const compra = await prisma.compra.findUnique({
    where: { id: compraId },
    include: { evento: true },
  });

  if (!compra) throw new Error(`Compra ${compraId} no encontrada tras ganar lock`);

  const codigos = Array.from({ length: compra.cantidadEntradas }, () => uuidv4());
  const qrFiles = [];
  for (const codigo of codigos) {
    const qrImageUrl = await qrService.generarQR(codigo);
    qrFiles.push({ codigo, qrImageUrl });
  }

  const entradasCreadas = await prisma.$transaction(async (tx) => {
    // Source of truth: tanda de la compra. Todas las compras post-backfill
    // tienen tandaId asignado; si por algún edge case llegara null, el increment
    // se saltea — preferimos no tocar contadores a tocar el equivocado.
    if (compra.tandaId) {
      await tx.tanda.update({
        where: { id: compra.tandaId },
        data: { cantidadVendida: { increment: compra.cantidadEntradas } },
      });
    }

    const entradas = [];
    for (const { codigo, qrImageUrl } of qrFiles) {
      const entrada = await tx.entrada.create({
        data: { compraId: compra.id, codigoQR: codigo, qrImageUrl },
      });
      entradas.push(entrada);
    }
    return entradas;
  });

  const entradasParaMail = [];
  for (const entrada of entradasCreadas) {
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
  } catch (mailErr) {
    console.error('Error al enviar email (no crítico):', mailErr.message);
  }

  return { procesada: true, entradas: entradasParaMail.length };
}

/**
 * Marca una compra `pending` como cancelada/rechazada/etc y libera el cupón
 * asociado si lo tenía. Atómico: si liberar el cupón falla, el cambio de
 * estado de la compra también hace rollback (queda pending y el job reintenta).
 *
 * Se invoca desde el job `syncPagosPendientes` cuando MP devuelve un estado
 * terminal o cuando expira la ventana de autocancel. NO se invoca para compras
 * que ya estuvieron approved — el job filtra esas antes de entrar acá, así que
 * liberar el cupón siempre es seguro (nunca liberamos un uso real).
 *
 * Idempotente: si ya está en estado terminal, devuelve { ya_procesada: true }
 * sin tocar el cupón.
 *
 * @param {number} compraId
 * @param {'cancelled'|'rejected'|'charged_back'|'refunded'} nuevoEstado
 * @param {string|number|null} [mpPagoId]
 * @returns {Promise<{ ya_procesada: boolean } | { procesada: boolean, libero_cupon: boolean }>}
 */
async function procesarPagoCancelado(compraId, nuevoEstado, mpPagoId = null) {
  return prisma.$transaction(async (tx) => {
    const dataUpdate = { mpEstado: nuevoEstado };
    if (mpPagoId) dataUpdate.mpPagoId = String(mpPagoId);

    const lockResult = await tx.compra.updateMany({
      where: { id: compraId, mpEstado: 'pending' },
      data: dataUpdate,
    });

    if (lockResult.count === 0) {
      return { ya_procesada: true };
    }

    // CuponUso tiene @@unique([compraId]) — a lo sumo 1 por compra.
    const uso = await tx.cuponUso.findUnique({ where: { compraId } });
    if (uso) {
      await liberarCupon(tx, uso.cuponId);
    }

    return { procesada: true, libero_cupon: !!uso };
  });
}

module.exports = { procesarPagoAprobado, procesarPagoCancelado };
