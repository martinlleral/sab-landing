const prisma = require('../utils/prisma');
const { getEstadoTanda, getTandaVigente } = require('../services/tandas.service');

// Helpers para normalizar input del form (string/boolean/int/fecha opcional)
function toBool(v) {
  return v === 'true' || v === true;
}

function toIntOrNull(v) {
  if (v === null || v === undefined || v === '' || v === 'null') return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

function toDateOrNull(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Adjunta `estado` (vigente/proxima/agotada/vencida/desactivada) a cada tanda
// del array. Cálculo único: corre getTandaVigente una vez y deriva el resto.
function adjuntarEstados(tandas) {
  const vigente = getTandaVigente(tandas);
  return tandas
    .slice()
    .sort((a, b) => a.orden - b.orden)
    .map((t) => ({ ...t, estado: getEstadoTanda(t, vigente) }));
}

async function adminListar(req, res) {
  try {
    const eventoId = parseInt(req.query.eventoId, 10);
    if (!eventoId) return res.status(400).json({ error: 'Falta eventoId' });

    const tandas = await prisma.tanda.findMany({
      where: { eventoId },
      orderBy: { orden: 'asc' },
    });
    return res.json(adjuntarEstados(tandas));
  } catch (err) {
    console.error('Error en adminListar tandas:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

async function adminCrear(req, res) {
  try {
    const { eventoId, nombre, precio, orden, activa, capacidad, fechaLimite } = req.body;

    if (!eventoId) return res.status(400).json({ error: 'Falta eventoId' });
    if (!nombre || !precio || orden === undefined) {
      return res.status(400).json({ error: 'nombre, precio y orden son obligatorios' });
    }

    const evento = await prisma.evento.findUnique({ where: { id: parseInt(eventoId, 10) } });
    if (!evento) return res.status(404).json({ error: 'Evento no encontrado' });

    // Prisma tira P2002 si se viola unique(eventoId, orden). Capturamos para error amigable.
    try {
      const tanda = await prisma.tanda.create({
        data: {
          eventoId: parseInt(eventoId, 10),
          nombre: String(nombre).trim(),
          precio: parseInt(precio, 10),
          orden: parseInt(orden, 10),
          activa: activa === undefined ? true : toBool(activa),
          capacidad: toIntOrNull(capacidad),
          fechaLimite: toDateOrNull(fechaLimite),
        },
      });
      return res.status(201).json(tanda);
    } catch (err) {
      if (err.code === 'P2002') {
        return res.status(400).json({ error: `Ya existe una tanda con orden ${orden} en este evento` });
      }
      throw err;
    }
  } catch (err) {
    console.error('Error en adminCrear tanda:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

async function adminActualizar(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = await prisma.tanda.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Tanda no encontrada' });

    const { nombre, precio, orden, activa, capacidad, fechaLimite } = req.body;

    const data = {};
    if (nombre !== undefined) data.nombre = String(nombre).trim();
    if (precio !== undefined) data.precio = parseInt(precio, 10);
    if (orden !== undefined) data.orden = parseInt(orden, 10);
    if (activa !== undefined) data.activa = toBool(activa);
    if (capacidad !== undefined) data.capacidad = toIntOrNull(capacidad);
    if (fechaLimite !== undefined) data.fechaLimite = toDateOrNull(fechaLimite);

    // Proteger la regla: capacidad nunca puede bajar por debajo de lo ya vendido,
    // si quedara negativo se interpretaría como stock disponible infinito al restar.
    if (data.capacidad !== undefined && data.capacidad !== null && data.capacidad < existing.cantidadVendida) {
      return res.status(400).json({
        error: `No podés bajar la capacidad a ${data.capacidad} — ya se vendieron ${existing.cantidadVendida}`,
      });
    }

    // Swap atómico: si el admin reordena una tanda a un `orden` ya ocupado por
    // otra tanda del mismo evento, intercambiamos ambos órdenes en una sola
    // transacción con un valor temporal negativo para evitar el UNIQUE violation.
    if (data.orden !== undefined && data.orden !== existing.orden) {
      const conflicto = await prisma.tanda.findFirst({
        where: { eventoId: existing.eventoId, orden: data.orden, id: { not: id } },
      });
      if (conflicto) {
        const tempOrden = -Math.abs(id); // valor temporal único y sin colisión posible
        const tanda = await prisma.$transaction(async (tx) => {
          // 1. Sacar al conflicto de la "zona de colisión" con un orden temporal.
          await tx.tanda.update({ where: { id: conflicto.id }, data: { orden: tempOrden } });
          // 2. Aplicar todos los cambios pedidos a `existing` (incluyendo el nuevo orden).
          const actualizada = await tx.tanda.update({ where: { id }, data });
          // 3. Mover al conflicto al orden viejo de `existing`.
          await tx.tanda.update({ where: { id: conflicto.id }, data: { orden: existing.orden } });
          return actualizada;
        });
        return res.json(tanda);
      }
    }

    try {
      const tanda = await prisma.tanda.update({ where: { id }, data });
      return res.json(tanda);
    } catch (err) {
      if (err.code === 'P2002') {
        return res.status(400).json({ error: `Ya existe otra tanda con orden ${data.orden}` });
      }
      throw err;
    }
  } catch (err) {
    console.error('Error en adminActualizar tanda:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

async function adminEliminar(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = await prisma.tanda.findUnique({
      where: { id },
      include: { _count: { select: { compras: true } } },
    });
    if (!existing) return res.status(404).json({ error: 'Tanda no encontrada' });

    // Regla: si la tanda tiene ventas (aun aprobadas o pending con tandaId),
    // no permitimos borrar — preservamos historia. El admin debe desactivarla.
    if (existing.cantidadVendida > 0 || existing._count.compras > 0) {
      return res.status(400).json({
        error: 'No se puede eliminar una tanda con compras. Desactivala en su lugar.',
      });
    }

    await prisma.tanda.delete({ where: { id } });
    return res.json({ ok: true });
  } catch (err) {
    console.error('Error en adminEliminar tanda:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

module.exports = {
  adminListar,
  adminCrear,
  adminActualizar,
  adminEliminar,
};
