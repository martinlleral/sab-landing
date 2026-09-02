const { v4: uuidv4 } = require('uuid');
const prisma = require('../utils/prisma');
const qrService = require('./qr.service');
const brevoService = require('./brevo.service');
// Se referencia como `precios.liberarCupon` (no destructurado) a propósito: así
// el módulo queda monkey-patcheable desde los tests para forzar un fallo dentro
// de la transacción y verificar el rollback (patrón sin jest del proyecto).
const precios = require('./precios.service');

/**
 * Cuánto margen tiene la transacción que crea las entradas.
 *
 * El default de Prisma son 5000 ms y el 27/8/2026 no alcanzaron: una compra de 7
 * entradas hacía 8 statements (1 update de stock + 7 inserts) contra una SQLite
 * que en ese momento también estaba atendiendo al cron de pagos. La transacción
 * se cerró a los 5088 ms, la compra quedó `approved` sin una sola entrada y la
 * compradora se enteró cinco días después.
 *
 * Dos cambios contra eso, y son independientes: el trabajo de adentro bajó a 2
 * statements (`createMany` en vez de N inserts) y el margen subió a 20 s.
 */
const TX_OPTS = { timeout: 20000, maxWait: 15000 };

/**
 * Emite las entradas que le FALTAN a una compra: genera el QR de cada una, las
 * crea, ajusta el stock de la tanda por las que efectivamente creó y manda el
 * mail con todas.
 *
 * Es el corazón compartido entre el camino feliz (`procesarPagoAprobado`, donde
 * "las que faltan" son todas) y la reparación (`repararComprasSinEntradas`,
 * donde puede ser un remanente). Escribirlo una sola vez es lo que garantiza
 * que una entrada reparada sea idéntica a una emitida bien la primera vez.
 *
 * El increment del stock va por `creadas` y no por `cantidadEntradas` porque
 * vive en la misma transacción que los inserts: si no hay entradas, tampoco
 * hubo increment, y reparar tiene que sumar exactamente lo que emite.
 *
 * @param {object} compra compra con `evento` incluido (lo necesita el mail)
 * @param {{ enviarMail?: boolean }} [opts]
 * @returns {Promise<{ creadas: number, entradas: object[] }>}
 */
async function emitirEntradasFaltantes(compra, { enviarMail = true } = {}) {
  const yaCreadas = await prisma.entrada.count({ where: { compraId: compra.id } });
  const faltan = compra.cantidadEntradas - yaCreadas;
  if (faltan <= 0) return { creadas: 0, entradas: [] };

  // Los PNG se escriben a disco ANTES de abrir la transacción: es E/S lenta y no
  // hay razón para hacerla con la base tomada. Si el disco falla, falla acá,
  // antes de haber tocado nada.
  const qrFiles = [];
  for (let i = 0; i < faltan; i++) {
    const codigo = uuidv4();
    const qrImageUrl = await qrService.generarQR(codigo);
    qrFiles.push({ codigo, qrImageUrl });
  }

  const entradas = await prisma.$transaction(async (tx) => {
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
        data: { cantidadVendida: { increment: qrFiles.length } },
      });
    }

    await tx.entrada.createMany({
      data: qrFiles.map(({ codigo, qrImageUrl }) => ({
        compraId: compra.id,
        codigoQR: codigo,
        qrImageUrl,
      })),
    });

    return tx.entrada.findMany({
      where: { compraId: compra.id },
      orderBy: { id: 'asc' },
    });
  }, TX_OPTS);

  if (!enviarMail) return { creadas: qrFiles.length, entradas };

  const entradasParaMail = [];
  for (const entrada of entradas) {
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

  return { creadas: qrFiles.length, entradas };
}

/**
 * Devuelve una compra a `pending` cuando la emisión de entradas falló DESPUÉS de
 * haber ganado el lock. Sin esto, el lock que existe para no duplicar entradas
 * se convierte en el candado que impide generarlas: la compra queda `approved` y
 * ningún camino vuelve a intentarlo, porque los tres (webhook, checkAndProcess y
 * cron) hacen early return ante una compra ya aprobada.
 *
 * Con la compra otra vez en `pending`, `syncPagosPendientes` la encuentra en la
 * vuelta siguiente, ve el pago aprobado en MP y la reprocesa: se arregla sola en
 * unos 60 segundos.
 *
 * Se niega a soltar el lock si ya hay entradas creadas — ahí el problema es otro
 * y volver a `pending` sería peor (dejaría entradas vivas colgando de una compra
 * que el sistema considera impaga).
 *
 * @returns {Promise<boolean>} true si la compra volvió a pending
 */
async function soltarLockAprobado(compraId) {
  const entradas = await prisma.entrada.count({ where: { compraId } });
  if (entradas > 0) return false;

  const r = await prisma.compra.updateMany({
    where: { id: compraId, mpEstado: 'approved' },
    data: { mpEstado: 'pending' },
  });
  return r.count > 0;
}

/**
 * Procesa una compra aprobada: actualiza estado, genera entradas con QR y envía email.
 *
 * Idempotencia con lock optimista:
 * `updateMany` con WHERE mpEstado != 'approved' es atómico en SQLite — si dos
 * procesos corren en paralelo (webhook + checkAndProcess + cron), solo uno
 * obtiene count=1 y avanza; los otros obtienen count=0 y hacen early return.
 * Esto previene entradas/emails/cantidadVendida duplicados.
 *
 * Si la emisión falla después del lock, la compra vuelve a `pending`
 * (`soltarLockAprobado`) y el cron la reprocesa en la vuelta siguiente. Antes no
 * volvía: quedaba cobrada y sin entradas, sin ningún camino que la retomara.
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

  try {
    const { creadas } = await emitirEntradasFaltantes(compra);
    return { procesada: true, entradas: creadas };
  } catch (err) {
    const volvioAPending = await soltarLockAprobado(compraId);
    console.error(
      `❌ Compra #${compraId}: falló la emisión de entradas (${err.message}). ` +
      (volvioAPending
        ? 'Vuelve a pending — el sync la reprocesa en la próxima vuelta.'
        : 'NO se pudo soltar el lock (ya tenía entradas) — revisar a mano.')
    );
    throw err;
  }
}

/**
 * Barrido de red: busca compras aprobadas que se quedaron sin entradas y las
 * emite. Es la última línea, la que cubre lo que `soltarLockAprobado` no llega a
 * cubrir — un proceso que muere entre el lock y el catch, un deploy en el peor
 * milisegundo, cualquier cosa que deje el estado a mitad de camino.
 *
 * Solo mira compras que llevan un rato quietas (`ANTIGUEDAD_MINIMA_MS`). Sin esa
 * espera se metería en el medio de dos cosas que están bien: un
 * `procesarPagoAprobado` todavía en vuelo, y `adminEnviarInvitacion`, que crea la
 * compra `approved` y su entrada en dos pasos separados — el barrido vería la
 * ventana entre ambos como una compra rota y emitiría una entrada de más.
 *
 * @param {{ limite?: number }} [opts]
 * @returns {Promise<Array<{ compraId: number, entradas: number, email: string }>>}
 */
const ANTIGUEDAD_MINIMA_MS = 5 * 60 * 1000;

async function repararComprasSinEntradas({ limite = 5 } = {}) {
  const quietasDesde = new Date(Date.now() - ANTIGUEDAD_MINIMA_MS);

  const rotas = await prisma.compra.findMany({
    where: {
      mpEstado: 'approved',
      entradas: { none: {} },
      updatedAt: { lt: quietasDesde },
    },
    include: { evento: true },
    orderBy: { id: 'desc' },
    take: limite,
  });

  const reparadas = [];
  for (const compra of rotas) {
    try {
      const { creadas } = await emitirEntradasFaltantes(compra);
      if (!creadas) continue;
      reparadas.push({ compraId: compra.id, entradas: creadas, email: compra.email });
      console.log(
        `🩹 Compra #${compra.id} reparada — ${creadas} entrada(s) emitida(s), ` +
        `stock ajustado y mail a ${compra.email}`
      );
    } catch (err) {
      console.error(`Error reparando compra #${compra.id}:`, err.message);
    }
  }
  return reparadas;
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
 * Desde el 26/8/2026 tiene un segundo caller: `adminLiberarCupo`, el botón del
 * backoffice para soltar a mano el cupo de menú que retiene un pendiente. Ese
 * controller sostiene el mismo invariante (rechaza con 400 todo lo que no esté
 * `pending`), y encima le pregunta a MP si hay un pago en curso antes de llamar.
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

module.exports = {
  procesarPagoAprobado,
  procesarPagoCancelado,
  revertirCompraAprobada,
  emitirEntradasFaltantes,
  repararComprasSinEntradas,
};
