const { v4: uuidv4 } = require('uuid');
const prisma = require('../utils/prisma');
const qrService = require('./qr.service');
const brevoService = require('./brevo.service');

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
    // Legacy counter en Evento — se elimina en Fase B del refactor de tandas.
    await tx.evento.update({
      where: { id: compra.eventoId },
      data: { cantidadVendida: { increment: compra.cantidadEntradas } },
    });

    // Source of truth: tanda de la compra. Si tandaId es null (invitaciones
    // históricas pre-tandas), lo saltamos.
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
    });
  } catch (mailErr) {
    console.error('Error al enviar email (no crítico):', mailErr.message);
  }

  return { procesada: true, entradas: entradasParaMail.length };
}

module.exports = { procesarPagoAprobado };
