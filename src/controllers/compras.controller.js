const prisma = require('../utils/prisma');
const mpService = require('../services/mercadopago.service');
const { procesarPagoAprobado } = require('../services/pagos.service');

async function crearPreferencia(req, res) {
  try {
    const { eventoId, email, nombre, apellido, telefono, cantidad } = req.body;

    if (!eventoId || !email || !nombre || !apellido || !cantidad) {
      return res.status(400).json({ error: 'Faltan campos requeridos' });
    }

    const evento = await prisma.evento.findUnique({ where: { id: parseInt(eventoId) } });
    if (!evento) return res.status(404).json({ error: 'Evento no encontrado' });
    if (!evento.estaPublicado) return res.status(400).json({ error: 'Evento no disponible' });

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
    const { type, data } = req.body;

    if (type !== 'payment' || !data || !data.id) {
      return res.sendStatus(200);
    }

    const pago = await mpService.consultarPago(data.id);
    if (!pago || pago.status !== 'approved') return res.sendStatus(200);

    const compraId = parseInt(pago.external_reference);
    if (!compraId) return res.sendStatus(200);

    await procesarPagoAprobado(compraId, pago.id);
    return res.sendStatus(200);
  } catch (err) {
    console.error('Error en webhook MP:', err);
    return res.sendStatus(500);
  }
}

async function getStatus(req, res) {
  try {
    const { preferenciaId } = req.params;
    const compra = await prisma.compra.findFirst({
      where: { mpPreferenciaId: preferenciaId },
      include: { evento: true, entradas: { select: { id: true, codigoQR: true, qrImageUrl: true, validada: true } } },
    });
    if (!compra) return res.status(404).json({ error: 'Compra no encontrada' });
    return res.json(compra);
  } catch (err) {
    console.error('Error en getStatus:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
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

module.exports = { crearPreferencia, webhook, getStatus, checkAndProcess, adminListar, adminGetById, adminEliminar, adminEliminarPendientes };
