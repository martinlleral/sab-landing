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

// Núcleo de validación de una entrada por su código QR. No formatea la respuesta
// HTTP: busca, chequea estado de pago y "ya usada", y si corresponde marca la
// entrada como validada. Lo comparten el endpoint admin (validarPorQR) y el
// público con token (validarPorQRPublico) para no duplicar la lógica de negocio.
// Devuelve { code: NOT_FOUND|NOT_PAID|ALREADY_USED|OK, entrada }.
async function _validarQRCore(codigoQR) {
  const incluirCompra = {
    compra: {
      include: { evento: { select: { id: true, nombre: true, fecha: true, hora: true } } },
    },
  };

  const entrada = await prisma.entrada.findUnique({
    where: { codigoQR },
    include: incluirCompra,
  });

  if (!entrada) return { code: 'NOT_FOUND', entrada: null };
  if (entrada.compra.mpEstado !== 'approved') return { code: 'NOT_PAID', entrada };
  if (entrada.validada) return { code: 'ALREADY_USED', entrada };

  const updated = await prisma.entrada.update({
    where: { id: entrada.id },
    data: { validada: true, validadaAt: new Date() },
    include: incluirCompra,
  });
  return { code: 'OK', entrada: updated };
}

async function validarPorQR(req, res) {
  try {
    const { codigoQR } = req.body;
    if (!codigoQR) return res.status(400).json({ error: 'codigoQR requerido' });

    const { code, entrada } = await _validarQRCore(codigoQR);

    if (code === 'NOT_FOUND') {
      return res.status(404).json({ valida: false, error: 'QR no reconocido', codigo: 'NOT_FOUND' });
    }
    if (code === 'NOT_PAID') {
      return res.status(400).json({ valida: false, error: 'La compra no está aprobada', codigo: 'NOT_PAID', entrada });
    }
    if (code === 'ALREADY_USED') {
      return res.status(409).json({ valida: false, error: 'Entrada ya utilizada', codigo: 'ALREADY_USED', entrada });
    }
    return res.json({ valida: true, codigo: 'OK', entrada });
  } catch (err) {
    console.error('Error en validarPorQR:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// Versión REDUCIDA de la entrada para el validador externo (token público): el
// nombre del comprador y el evento (para cotejar en la puerta), sin datos de
// contacto (email/teléfono). El cliente lo pidió "sin demasiada restricción"
// pero no hay motivo para exponer contacto a un tercero solo para validar.
function entradaReducida(entrada) {
  if (!entrada) return null;
  const compra = entrada.compra || {};
  const evento = compra.evento || null;
  return {
    id: entrada.id,
    validada: entrada.validada,
    validadaAt: entrada.validadaAt,
    nombre: compra.nombre || '',
    apellido: compra.apellido || '',
    evento: evento ? { nombre: evento.nombre, fecha: evento.fecha, hora: evento.hora } : null,
  };
}

// Endpoint público con token de validación (ítem 2). Misma lógica de negocio que
// el admin, pero la respuesta no incluye email/teléfono del comprador.
async function validarPorQRPublico(req, res) {
  try {
    const { codigoQR } = req.body;
    if (!codigoQR) return res.status(400).json({ valida: false, codigo: 'MISSING', error: 'codigoQR requerido' });

    const { code, entrada } = await _validarQRCore(codigoQR);

    if (code === 'NOT_FOUND') {
      return res.status(404).json({ valida: false, codigo: 'NOT_FOUND', error: 'QR no reconocido' });
    }
    if (code === 'NOT_PAID') {
      return res.status(400).json({ valida: false, codigo: 'NOT_PAID', error: 'La compra no está aprobada', entrada: entradaReducida(entrada) });
    }
    if (code === 'ALREADY_USED') {
      return res.status(409).json({ valida: false, codigo: 'ALREADY_USED', error: 'Entrada ya utilizada', entrada: entradaReducida(entrada) });
    }
    return res.json({ valida: true, codigo: 'OK', entrada: entradaReducida(entrada) });
  } catch (err) {
    console.error('Error en validarPorQRPublico:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

module.exports = { adminGetById, validar, validarPorQR, validarPorQRPublico };
