const { v4: uuidv4 } = require('uuid');
const prisma = require('../utils/prisma');
const qrService = require('./qr.service');
const brevoService = require('./brevo.service');
// Se referencia como `precios.liberarCupon` (no destructurado) a propósito: así
// el módulo queda monkey-patcheable desde los tests para forzar un fallo dentro
// de la transacción y verificar el rollback (patrón sin jest del proyecto).
const precios = require('./precios.service');

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
    // MENÚ DE CASA METRO: acá NO se genera nada por menú. Los menús no son
    // entradas — no tienen QR ni fila en `Entrada`, y no cuentan contra el aforo
    // de la tanda. Viven como cantidad en la compra (`Compra.cantidadMenus`), y el
    // control de entrega es la lista impresa que tilda la cocina, no el validador.
    //
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

  // Envío en SEGUNDO PLANO (no bloqueante): las entradas y el QR ya están
  // persistidos y la página de éxito los muestra desde la BD, así que no hace
  // falta esperar a Brevo (que con reintentos puede tardar varios segundos y
  // colgaría la respuesta post-pago). El mail es "no crítico": si falla, queda
  // logueado y se puede reenviar desde el backoffice.
  brevoService.enviarConfirmacion({
    email: compra.email,
    nombre: compra.nombre,
    evento: compra.evento,
    entradas: entradasParaMail,
    compra,
  }).catch((mailErr) => {
    console.error('Error al enviar email (no crítico):', mailErr.message);
  });

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
      await precios.liberarCupon(tx, uso.cuponId);
    }

    // MENÚ DE CASA METRO: los menús de esta compra quedan liberados sin código
    // propio. `Compra.cantidadMenus` no se toca (es historia contable) y la compra
    // sale del estado 'pending', así que cualquier conteo de menús vendidos que
    // filtre por estado deja de contarla. Esto vale MIENTRAS el tope se derive de
    // los estados de las compras; si se agregara un contador desnormalizado en
    // `Evento`, ESTE es uno de los tres lugares donde hay que decrementarlo (los
    // otros dos: procesarPagoAprobado y revertirCompraAprobada).
    return { procesada: true, libero_cupon: !!uso };
  });
}

/**
 * Marca una compra APROBADA como devuelta (US-A). Es la operación inversa de
 * procesarPagoAprobado: decrementa el stock que aprobar había incrementado y
 * libera el cupón. Se invoca desde el backoffice cuando Euge hace un refund en
 * Mercado Pago; el servicio es genérico (recibe compraId) para que un eventual
 * webhook lo reuse tal cual sin retrabajo.
 *
 * Atómico e idempotente con lock optimista: `updateMany` con
 * WHERE mpEstado='approved' es atómico en SQLite — un doble click / doble
 * request solo deja avanzar a uno; el otro obtiene count=0 y NO vuelve a
 * decrementar stock. Si cualquier paso posterior falla (ej. liberarCupon), toda
 * la transacción hace rollback y la compra queda approved intacta.
 *
 * NO reusa procesarPagoCancelado: esa asume `pending` (que nunca incrementó
 * stock) y por eso no lo decrementa. Acá el decremento es el corazón.
 *
 * @param {number} compraId
 * @param {{ revertidaPor?: string|null, motivo?: string|null }} [opts]
 * @returns {Promise<
 *   { ok: true, procesada: true, libero_cupon: boolean, stock_devuelto: number, menus_devueltos: number, entradas_ya_validadas: number }
 *   | { ok: false, code: 'NOT_FOUND' }
 *   | { ok: false, code: 'NOT_APPROVED', estado: string }
 * >}
 */
async function revertirCompraAprobada(compraId, { revertidaPor = null, motivo = null } = {}) {
  return prisma.$transaction(async (tx) => {
    const lock = await tx.compra.updateMany({
      where: { id: compraId, mpEstado: 'approved' },
      data: {
        mpEstado: 'refunded',
        devueltaAt: new Date(),
        devueltaPor: revertidaPor ? String(revertidaPor) : null,
        devueltaMotivo: motivo ? String(motivo).trim() || null : null,
      },
    });

    if (lock.count === 0) {
      const existe = await tx.compra.findUnique({
        where: { id: compraId }, select: { mpEstado: true },
      });
      if (!existe) return { ok: false, code: 'NOT_FOUND' };
      return { ok: false, code: 'NOT_APPROVED', estado: existe.mpEstado };
    }

    const compra = await tx.compra.findUnique({
      where: { id: compraId },
      include: { entradas: { select: { validada: true } } },
    });

    // Devolver stock: opuesto exacto al increment de procesarPagoAprobado. Si la
    // compra es legacy sin tanda (tandaId null), se saltea — nunca contó stock.
    let stockDevuelto = 0;
    if (compra.tandaId) {
      await tx.tanda.update({
        where: { id: compra.tandaId },
        data: { cantidadVendida: { decrement: compra.cantidadEntradas } },
      });
      stockDevuelto = compra.cantidadEntradas;
    }

    // Liberar el cupón si lo usó (CuponUso tiene @@unique([compraId])).
    const uso = await tx.cuponUso.findUnique({ where: { compraId } });
    if (uso) {
      await precios.liberarCupon(tx, uso.cuponId);
    }

    // MENÚ DE CASA METRO: los menús se devuelven junto con la compra. No hay nada
    // que decrementar — `Compra.cantidadMenus` se conserva (es historia contable:
    // hubo una compra de N menús que después se devolvió) y el cambio a 'refunded'
    // los saca de cualquier conteo que filtre por 'approved'. Se reporta la
    // cantidad para que el backoffice pueda avisar "esta devolución libera N menús"
    // — la cocina puede haberlos contado ya.
    // ⚠️ Si alguna vez se agrega un contador desnormalizado de menús en `Evento`,
    // acá va su decremento (y en procesarPagoCancelado, y en procesarPagoAprobado).
    const menusDevueltos = compra.cantidadMenus;

    // Las entradas ya validadas no bloquean la devolución (recomendación
    // acordada: la corrección contable vale aunque la persona haya entrado); se
    // reporta el conteo para que la UI muestre el aviso "esta entrada ya fue usada".
    const entradasYaValidadas = compra.entradas.filter((e) => e.validada).length;

    return {
      ok: true,
      procesada: true,
      libero_cupon: !!uso,
      stock_devuelto: stockDevuelto,
      menus_devueltos: menusDevueltos,
      entradas_ya_validadas: entradasYaValidadas,
    };
  });
}

module.exports = { procesarPagoAprobado, procesarPagoCancelado, revertirCompraAprobada };
