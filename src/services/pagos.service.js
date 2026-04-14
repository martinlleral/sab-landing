const { v4: uuidv4 } = require('uuid');
const prisma = require('../utils/prisma');
const qrService = require('./qr.service');
const brevoService = require('./brevo.service');

/**
 * Procesa una compra aprobada: actualiza estado, genera entradas con QR y envía email.
 * Idempotente: si la compra ya está aprobada, retorna sin hacer nada.
 *
 * @param {number} compraId
 * @param {string|number} mpPaymentId
 * @returns {{ ya_procesada: boolean } | { procesada: boolean, entradas: number }}
 */
async function procesarPagoAprobado(compraId, mpPaymentId) {
  const compra = await prisma.compra.findUnique({
    where: { id: compraId },
    include: { evento: true, entradas: true },
  });

  if (!compra) throw new Error(`Compra ${compraId} no encontrada`);
  if (compra.mpEstado === 'approved') return { ya_procesada: true };

  await prisma.compra.update({
    where: { id: compra.id },
    data: { mpEstado: 'approved', mpPagoId: String(mpPaymentId) },
  });

  await prisma.evento.update({
    where: { id: compra.eventoId },
    data: { cantidadVendida: { increment: compra.cantidadEntradas } },
  });

  const entradasGeneradas = [];
  for (let i = 0; i < compra.cantidadEntradas; i++) {
    const codigo = uuidv4();
    const qrImageUrl = await qrService.generarQR(codigo);
    const entrada = await prisma.entrada.create({
      data: { compraId: compra.id, codigoQR: codigo, qrImageUrl },
    });
    const qrBase64 = await qrService.generarQRBase64(codigo);
    entradasGeneradas.push({ ...entrada, qrBase64: qrBase64.split(',')[1] });
  }

  try {
    await brevoService.enviarConfirmacion({
      email: compra.email,
      nombre: compra.nombre,
      evento: compra.evento,
      entradas: entradasGeneradas,
    });
  } catch (mailErr) {
    console.error('Error al enviar email (no crítico):', mailErr.message);
  }

  return { procesada: true, entradas: entradasGeneradas.length };
}

module.exports = { procesarPagoAprobado };
