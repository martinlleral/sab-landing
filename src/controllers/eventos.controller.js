const { v4: uuidv4 } = require('uuid');
const prisma = require('../utils/prisma');
const qrService = require('../services/qr.service');
const brevoService = require('../services/brevo.service');
const { getTandaVigente } = require('../services/tandas.service');

// Adjunta al evento la tandaVigente calculada + precio/stock derivados para el
// frontend público. No reemplaza los campos legacy del evento (ese cleanup es
// en Fase B); los suma al response para que el frontend pueda migrar sin
// downtime de lectura.
function adjuntarTandaVigente(evento) {
  const vigente = getTandaVigente(evento.tandas);
  return { ...evento, tandaVigente: vigente };
}

async function getDestacado(req, res) {
  try {
    const evento = await prisma.evento.findFirst({
      where: { esDestacado: true, estaPublicado: true },
      include: { tandas: true },
    });
    if (!evento) return res.status(404).json({ error: 'No hay evento destacado' });
    return res.json(adjuntarTandaVigente(evento));
  } catch (err) {
    console.error('Error en getDestacado:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

async function getProximos(req, res) {
  try {
    const eventos = await prisma.evento.findMany({
      where: {
        estaPublicado: true,
        fecha: { gte: new Date() },
      },
      orderBy: { fecha: 'asc' },
      take: 3,
      include: { tandas: true },
    });
    return res.json(eventos.map(adjuntarTandaVigente));
  } catch (err) {
    console.error('Error en getProximos:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

async function adminListar(req, res) {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const [eventos, total] = await Promise.all([
      prisma.evento.findMany({
        orderBy: { fecha: 'desc' },
        skip,
        take: limit,
        include: { _count: { select: { compras: true } } },
      }),
      prisma.evento.count(),
    ]);

    return res.json({ eventos, total, page, totalPages: Math.ceil(total / limit) });
  } catch (err) {
    console.error('Error en adminListar eventos:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

async function adminListarPasados(req, res) {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const [eventos, total] = await Promise.all([
      prisma.evento.findMany({
        where: { fecha: { lt: new Date() } },
        orderBy: { fecha: 'desc' },
        skip,
        take: limit,
        include: { _count: { select: { compras: true } } },
      }),
      prisma.evento.count({ where: { fecha: { lt: new Date() } } }),
    ]);

    return res.json({ eventos, total, page, totalPages: Math.ceil(total / limit) });
  } catch (err) {
    console.error('Error en adminListarPasados:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

async function adminGetById(req, res) {
  try {
    const id = parseInt(req.params.id);
    const evento = await prisma.evento.findUnique({
      where: { id },
      include: {
        compras: {
          orderBy: { createdAt: 'desc' },
          take: 50,
        },
        _count: { select: { compras: true } },
      },
    });
    if (!evento) return res.status(404).json({ error: 'Evento no encontrado' });
    return res.json(evento);
  } catch (err) {
    console.error('Error en adminGetById evento:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// Parsea una fecha en formato YYYY-MM-DD como mediodía UTC,
// para que al leerla en cualquier timezone (Argentina UTC-3 incluido) muestre el día correcto.
function parsearFechaLocal(fechaStr) {
  // Si ya viene con tiempo, devolverla tal cual
  if (typeof fechaStr === 'string' && fechaStr.includes('T')) return new Date(fechaStr);
  // Si es solo fecha YYYY-MM-DD, parsearla como mediodía UTC
  return new Date(fechaStr + 'T12:00:00.000Z');
}

async function adminCrear(req, res) {
  try {
    const {
      nombre, descripcion, fecha, hora, invitado,
      precioEntrada, cantidadDisponible,
      esDestacado, estaPublicado, estaAgotado, esExterno, linkExterno,
    } = req.body;

    if (!nombre || !descripcion || !fecha || !hora || !precioEntrada || !cantidadDisponible) {
      return res.status(400).json({ error: 'Faltan campos requeridos' });
    }

    const flyerUrl = req.file ? `/assets/img/uploads/eventos/${req.file.filename}` : '';

    const evento = await prisma.evento.create({
      data: {
        nombre,
        descripcion,
        fecha: parsearFechaLocal(fecha),
        hora,
        invitado: invitado || '',
        precioEntrada: parseInt(precioEntrada),
        cantidadDisponible: parseInt(cantidadDisponible),
        flyerUrl,
        esDestacado: esDestacado === 'true' || esDestacado === true,
        estaPublicado: estaPublicado === 'true' || estaPublicado === true,
        estaAgotado: estaAgotado === 'true' || estaAgotado === true,
        esExterno: esExterno === 'true' || esExterno === true,
        linkExterno: linkExterno || null,
      },
    });

    return res.status(201).json(evento);
  } catch (err) {
    console.error('Error en adminCrear evento:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

async function adminEditar(req, res) {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.evento.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Evento no encontrado' });

    const {
      nombre, descripcion, fecha, hora, invitado,
      precioEntrada, cantidadDisponible,
      esDestacado, estaPublicado, estaAgotado, esExterno, linkExterno,
    } = req.body;

    const data = {};
    if (nombre !== undefined) data.nombre = nombre;
    if (descripcion !== undefined) data.descripcion = descripcion;
    if (fecha !== undefined) data.fecha = parsearFechaLocal(fecha);
    if (hora !== undefined) data.hora = hora;
    if (invitado !== undefined) data.invitado = invitado;
    if (precioEntrada !== undefined) data.precioEntrada = parseInt(precioEntrada);
    if (cantidadDisponible !== undefined) data.cantidadDisponible = parseInt(cantidadDisponible);
    if (esDestacado !== undefined) data.esDestacado = esDestacado === 'true' || esDestacado === true;
    if (estaPublicado !== undefined) data.estaPublicado = estaPublicado === 'true' || estaPublicado === true;
    if (estaAgotado !== undefined) data.estaAgotado = estaAgotado === 'true' || estaAgotado === true;
    if (esExterno !== undefined) data.esExterno = esExterno === 'true' || esExterno === true;
    if (linkExterno !== undefined) data.linkExterno = linkExterno || null;
    if (req.file) data.flyerUrl = `/assets/img/uploads/eventos/${req.file.filename}`;

    const evento = await prisma.evento.update({ where: { id }, data });
    return res.json(evento);
  } catch (err) {
    console.error('Error en adminEditar evento:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

async function adminEliminar(req, res) {
  try {
    const id = parseInt(req.params.id);

    // Eliminar entradas de todas las compras del evento
    const compras = await prisma.compra.findMany({ where: { eventoId: id }, select: { id: true } });
    const compraIds = compras.map(c => c.id);
    if (compraIds.length) {
      await prisma.entrada.deleteMany({ where: { compraId: { in: compraIds } } });
    }
    // Eliminar compras del evento
    await prisma.compra.deleteMany({ where: { eventoId: id } });
    // Eliminar evento
    await prisma.evento.delete({ where: { id } });

    return res.json({ ok: true });
  } catch (err) {
    console.error('Error en adminEliminar evento:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

async function adminEnviarInvitacion(req, res) {
  try {
    const eventoId = parseInt(req.params.id);
    const { email, nombre, apellido } = req.body;

    if (!email) return res.status(400).json({ error: 'Email requerido' });

    const evento = await prisma.evento.findUnique({
      where: { id: eventoId },
      include: { tandas: true },
    });
    if (!evento) return res.status(404).json({ error: 'Evento no encontrado' });

    const tandaVigente = getTandaVigente(evento.tandas);
    if (!tandaVigente) {
      return res.status(400).json({ error: 'El evento no tiene tanda vigente — no se pueden enviar invitaciones' });
    }

    const compra = await prisma.compra.create({
      data: {
        eventoId,
        tandaId: tandaVigente.id,
        email,
        nombre: nombre || 'Invitado',
        apellido: apellido || '',
        cantidadEntradas: 1,
        precioUnitario: 0,
        totalPagado: 0,
        mpEstado: 'approved',
        mpPreferenciaId: `inv-${Date.now()}`,
      },
    });

    // Incrementa ambos contadores: legacy en Evento (se elimina en Fase B) +
    // source of truth en Tanda. Las invitaciones consumen cupo de la tanda vigente.
    await prisma.$transaction([
      prisma.evento.update({
        where: { id: eventoId },
        data: { cantidadVendida: { increment: 1 } },
      }),
      prisma.tanda.update({
        where: { id: tandaVigente.id },
        data: { cantidadVendida: { increment: 1 } },
      }),
    ]);

    const codigo = uuidv4();
    const qrImageUrl = await qrService.generarQR(codigo);
    const entrada = await prisma.entrada.create({
      data: { compraId: compra.id, codigoQR: codigo, qrImageUrl },
    });
    const qrBase64 = await qrService.generarQRBase64(codigo);

    try {
      // Timeout de 15s para envío de email
      await Promise.race([
        brevoService.enviarInvitacion({
          email,
          nombre: nombre || 'Invitado',
          evento,
          entrada: { ...entrada, qrBase64: qrBase64.split(',')[1] },
        }),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Email timeout (15s)')), 15000)
        )
      ]);
      console.log(`✅ Invitación enviada a ${email}`);
    } catch (mailErr) {
      console.error('❌ Error al enviar email invitación:', mailErr.message);
      // No crítico - la entrada ya fue creada
    }

    return res.status(201).json({ compra, entrada });
  } catch (err) {
    console.error('Error en adminEnviarInvitacion:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

async function adminListarInvitaciones(req, res) {
  try {
    const eventoId = parseInt(req.params.id);
    const invitaciones = await prisma.compra.findMany({
      where: { eventoId, totalPagado: 0, mpEstado: 'approved' },
      include: { entradas: { select: { id: true, codigoQR: true, qrImageUrl: true, validada: true, validadaAt: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return res.json(invitaciones);
  } catch (err) {
    console.error('Error en adminListarInvitaciones:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

module.exports = {
  getDestacado,
  getProximos,
  adminListar,
  adminListarPasados,
  adminGetById,
  adminCrear,
  adminEditar,
  adminEliminar,
  adminEnviarInvitacion,
  adminListarInvitaciones,
};
