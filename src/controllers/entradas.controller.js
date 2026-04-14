const prisma = require('../utils/prisma');

async function adminGetById(req, res) {
  try {
    const id = parseInt(req.params.id);
    const entrada = await prisma.entrada.findUnique({
      where: { id },
      include: { compra: { include: { evento: true } } },
    });
    if (!entrada) return res.status(404).json({ error: 'Entrada no encontrada' });
    return res.json(entrada);
  } catch (err) {
    console.error('Error en adminGetById entrada:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

async function validar(req, res) {
  try {
    const id = parseInt(req.params.id);
    const entrada = await prisma.entrada.findUnique({ where: { id } });
    if (!entrada) return res.status(404).json({ error: 'Entrada no encontrada' });
    if (entrada.validada) {
      return res.status(400).json({ error: 'La entrada ya fue validada', validadaAt: entrada.validadaAt });
    }

    const updated = await prisma.entrada.update({
      where: { id },
      data: { validada: true, validadaAt: new Date() },
    });
    return res.json(updated);
  } catch (err) {
    console.error('Error en validar entrada:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

async function validarPorQR(req, res) {
  try {
    const { codigoQR } = req.body;
    if (!codigoQR) return res.status(400).json({ error: 'codigoQR requerido' });

    const entrada = await prisma.entrada.findUnique({
      where: { codigoQR },
      include: {
        compra: {
          include: { evento: { select: { id: true, nombre: true, fecha: true, hora: true } } },
        },
      },
    });

    if (!entrada) {
      return res.status(404).json({ valida: false, error: 'QR no reconocido', codigo: 'NOT_FOUND' });
    }

    if (entrada.compra.mpEstado !== 'approved') {
      return res.status(400).json({
        valida: false,
        error: 'La compra no está aprobada',
        codigo: 'NOT_PAID',
        entrada,
      });
    }

    if (entrada.validada) {
      return res.status(409).json({
        valida: false,
        error: 'Entrada ya utilizada',
        codigo: 'ALREADY_USED',
        entrada,
      });
    }

    const updated = await prisma.entrada.update({
      where: { id: entrada.id },
      data: { validada: true, validadaAt: new Date() },
      include: {
        compra: {
          include: { evento: { select: { id: true, nombre: true, fecha: true, hora: true } } },
        },
      },
    });

    return res.json({ valida: true, codigo: 'OK', entrada: updated });
  } catch (err) {
    console.error('Error en validarPorQR:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

module.exports = { adminGetById, validar, validarPorQR };
