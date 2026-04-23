const crypto = require('crypto');
const prisma = require('../utils/prisma');
const config = require('../config');
const mpService = require('../services/mercadopago.service');
const { procesarPagoAprobado } = require('../services/pagos.service');

// Verifica la firma HMAC-SHA256 del webhook MP.
// Manifest: id:<data.id>;request-id:<x-request-id>;ts:<ts>;
// Docs: https://www.mercadopago.com.ar/developers/es/docs/your-integrations/notifications/webhooks
function verifyMpSignature(req, secret) {
  const sigHeader = req.headers['x-signature'];
  const requestId = req.headers['x-request-id'];
  if (!sigHeader || !requestId) return { valid: false, reason: 'missing_headers' };

  let ts, v1;
  for (const part of String(sigHeader).split(',')) {
    const [rawKey, rawVal] = part.split('=');
    if (!rawKey || !rawVal) continue;
    const key = rawKey.trim();
    const val = rawVal.trim();
    if (key === 'ts') ts = val;
    else if (key === 'v1') v1 = val;
  }
  if (!ts || !v1) return { valid: false, reason: 'malformed_signature' };

  const dataId = req.query['data.id'] || req.body?.data?.id;
  if (!dataId) return { valid: false, reason: 'missing_data_id' };

  const manifest = `id:${String(dataId)};request-id:${requestId};ts:${ts};`;
  const expected = crypto.createHmac('sha256', secret).update(manifest).digest('hex');

  let expectedBuf, v1Buf;
  try {
    expectedBuf = Buffer.from(expected, 'hex');
    v1Buf = Buffer.from(v1, 'hex');
  } catch {
    return { valid: false, reason: 'hex_decode' };
  }
  if (expectedBuf.length !== v1Buf.length) return { valid: false, reason: 'length_mismatch' };

  const ok = crypto.timingSafeEqual(expectedBuf, v1Buf);
  return { valid: ok, reason: ok ? 'ok' : 'hmac_mismatch' };
}

async function crearPreferencia(req, res) {
  try {
    const { eventoId, email, nombre, apellido, telefono, cantidad } = req.body;

    if (!eventoId || !email || !nombre || !apellido || !cantidad) {
      return res.status(400).json({ error: 'Faltan campos requeridos' });
    }

    const evento = await prisma.evento.findUnique({ where: { id: parseInt(eventoId) } });
    if (!evento) return res.status(404).json({ error: 'Evento no encontrado' });
    if (!evento.estaPublicado) return res.status(400).json({ error: 'Evento no disponible' });
    if (evento.estaAgotado) return res.status(400).json({ error: 'Entradas agotadas para este evento' });

    const disponibles = evento.cantidadDisponible - evento.cantidadVendida;
    if (disponibles < parseInt(cantidad)) {
      return res.status(400).json({ error: `Solo quedan ${disponibles} entradas disponibles` });
    }

    const total = evento.precioEntrada * parseInt(cantidad);

    const compra = await prisma.compra.create({
      data: {
        eventoId: evento.id,
        email,
        nombre,
        apellido,
        telefono: telefono || '',
        cantidadEntradas: parseInt(cantidad),
        precioUnitario: evento.precioEntrada,
        totalPagado: total,
        mpEstado: 'pending',
      },
    });

    const preferencia = await mpService.crearPreferencia({
      titulo: `${evento.nombre} — ${parseInt(cantidad)} entrada(s)`,
      precio: evento.precioEntrada,
      cantidad: parseInt(cantidad),
      email,
      preferenciaId: String(compra.id),
    });

    await prisma.compra.update({
      where: { id: compra.id },
      data: { mpPreferenciaId: preferencia.id },
    });

    return res.json({
      init_point: preferencia.init_point,
      preferencia_id: preferencia.id,
      compra_id: compra.id,
    });
  } catch (err) {
    console.error('Error en crearPreferencia:', err);
    return res.status(500).json({ error: 'Error al crear la preferencia de pago' });
  }
}

async function webhook(req, res) {
  try {
    const secret = config.mercadopago.webhookSecret;

    // Fail-closed: sin secret configurado, rechazamos todo. Los 3 fallbacks
    // (checkAndProcess desde cliente + syncPagosPendientes cada 60s) igual
    // procesan las compras legítimas, así que cerrar el webhook no pierde ventas.
    if (!secret) {
      console.error(
        '[webhook MP] ERROR: MP_WEBHOOK_SECRET no configurado. ' +
        'Activar firma en panel MP del SAB → Webhooks → Configurar notificaciones.'
      );
      return res.status(503).json({ error: 'webhook_not_configured' });
    }

    const verification = verifyMpSignature(req, secret);
    if (!verification.valid) {
      const ip = req.headers['x-forwarded-for'] || req.ip;
      console.warn(`[webhook MP] WARN: firma inválida (${verification.reason}) desde IP ${ip}`);
      return res.status(401).json({ error: 'invalid_signature' });
    }

    const { type, data } = req.body;
    if (type !== 'payment' || !data || !data.id) {
      return res.sendStatus(200);
    }

    const pago = await mpService.consultarPago(data.id);
    if (!pago || pago.status !== 'approved') return res.sendStatus(200);

    // Validar que el pago corresponde al merchant SAB (si MP_USER_ID está configurado).
    // Previene que alguien reenvíe un webhook firmado de otra cuenta MP.
    const expectedCollector = config.mercadopago.userId;
    if (expectedCollector && String(pago.collector_id) !== String(expectedCollector)) {
      console.warn(
        `[webhook MP] WARN: collector_id mismatch ` +
        `(got ${pago.collector_id}, expected ${expectedCollector}) pago=${pago.id}`
      );
      return res.status(403).json({ error: 'collector_mismatch' });
    }

    const compraId = parseInt(pago.external_reference);
    if (!compraId) return res.sendStatus(200);

    // Cargar la compra para cruzar el monto. Si el monto no coincide, alguien
    // intentó pagar una fracción de una entrada y confirmar la compra completa.
    const compra = await prisma.compra.findUnique({
      where: { id: compraId },
      select: { id: true, totalPagado: true },
    });
    if (!compra) {
      console.warn(`[webhook MP] compra ${compraId} no encontrada (pago ${pago.id})`);
      return res.sendStatus(200);
    }

    const montoPagado = Number(pago.transaction_amount);
    const montoEsperado = Number(compra.totalPagado);
    if (!Number.isFinite(montoPagado) || montoPagado !== montoEsperado) {
      console.warn(
        `[webhook MP] WARN: amount mismatch compra=${compraId} ` +
        `pagado=${montoPagado} esperado=${montoEsperado} pago=${pago.id}`
      );
      return res.status(400).json({ error: 'amount_mismatch' });
    }

    await procesarPagoAprobado(compraId, pago.id);
    return res.sendStatus(200);
  } catch (err) {
    console.error('Error en webhook MP:', err);
    return res.sendStatus(500);
  }
}

async function checkAndProcess(req, res) {
  try {
    const { preferenciaId } = req.params;
    const compra = await prisma.compra.findFirst({
      where: { mpPreferenciaId: preferenciaId },
      include: { evento: true, entradas: true },
    });
    if (!compra) return res.status(404).json({ error: 'Compra no encontrada' });

    // Si ya está aprobada, devolver directamente
    if (compra.mpEstado === 'approved') {
      return res.json({ status: 'approved', compraId: compra.id, entradas: compra.entradas.length });
    }

    // Buscar pagos en MP para esta compra
    const pagos = await mpService.buscarPagoPorCompra(compra.id);
    const aprobado = pagos.find((p) => p.status === 'approved');

    if (aprobado) {
      const resultado = await procesarPagoAprobado(compra.id, aprobado.id);
      console.log(`✅ checkAndProcess: Compra #${compra.id} procesada desde confirmación`);
      return res.json({ status: 'approved', compraId: compra.id, entradas: resultado.entradas || 0 });
    }

    return res.json({ status: compra.mpEstado, compraId: compra.id });
  } catch (err) {
    console.error('Error en checkAndProcess:', err);
    return res.status(500).json({ error: 'Error al verificar el pago' });
  }
}

async function adminListar(req, res) {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;
    const where = {};
    if (req.query.eventoId) where.eventoId = parseInt(req.query.eventoId);

    const [compras, total] = await Promise.all([
      prisma.compra.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: { evento: { select: { nombre: true, fecha: true } } },
      }),
      prisma.compra.count({ where }),
    ]);

    return res.json({ compras, total, page, totalPages: Math.ceil(total / limit) });
  } catch (err) {
    console.error('Error en adminListar compras:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

async function adminGetById(req, res) {
  try {
    const id = parseInt(req.params.id);
    const compra = await prisma.compra.findUnique({
      where: { id },
      include: {
        evento: true,
        entradas: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!compra) return res.status(404).json({ error: 'Compra no encontrada' });
    return res.json(compra);
  } catch (err) {
    console.error('Error en adminGetById compra:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

async function adminEliminar(req, res) {
  try {
    const id = parseInt(req.params.id);
    const compra = await prisma.compra.findUnique({ where: { id } });
    if (!compra) return res.status(404).json({ error: 'Compra no encontrada' });

    if (compra.mpEstado === 'approved') {
      return res.status(400).json({ error: 'No se puede eliminar una compra aprobada' });
    }

    // Eliminar entradas asociadas primero
    await prisma.entrada.deleteMany({ where: { compraId: id } });
    // Eliminar la compra
    await prisma.compra.delete({ where: { id } });

    return res.json({ ok: true, message: 'Compra eliminada correctamente' });
  } catch (err) {
    console.error('Error en adminEliminar compra:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

async function adminEliminarPendientes(req, res) {
  try {
    const eventoId = parseInt(req.query.eventoId);
    if (!eventoId) return res.status(400).json({ error: 'Se requiere eventoId' });

    const pendientes = await prisma.compra.findMany({
      where: { eventoId, mpEstado: { not: 'approved' } },
      select: { id: true },
    });

    const ids = pendientes.map(c => c.id);
    if (!ids.length) return res.json({ ok: true, eliminadas: 0 });

    await prisma.entrada.deleteMany({ where: { compraId: { in: ids } } });
    const result = await prisma.compra.deleteMany({ where: { id: { in: ids } } });

    return res.json({ ok: true, eliminadas: result.count });
  } catch (err) {
    console.error('Error en adminEliminarPendientes:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

module.exports = { crearPreferencia, webhook, checkAndProcess, adminListar, adminGetById, adminEliminar, adminEliminarPendientes };
