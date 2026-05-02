const prisma = require('../utils/prisma');
const { TIPO_CUPON, normalizarCodigo, calcularPrecioFinal } = require('../services/precios.service');
const { getTandaVigente } = require('../services/tandas.service');

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

// Reglas de validación numérica de un cupón. Centralizado para reusar en
// crear y, eventualmente, en preview/dry-run desde el frontend.
function validarCamposCupon({ tipo, valor, topeUsos }) {
  if (![TIPO_CUPON.PORCENTAJE, TIPO_CUPON.MONTO].includes(tipo)) {
    return 'tipo debe ser "porcentaje" o "monto"';
  }
  if (!Number.isFinite(valor) || valor <= 0) {
    return 'valor debe ser un número mayor a 0';
  }
  if (tipo === TIPO_CUPON.PORCENTAJE && valor > 100) {
    return 'valor no puede ser mayor a 100 cuando tipo es "porcentaje"';
  }
  if (topeUsos !== null && (!Number.isInteger(topeUsos) || topeUsos <= 0)) {
    return 'topeUsos debe ser un entero positivo o null';
  }
  return null;
}

// Cubre la regla C: si el cupón monto puede dejar alguna tanda del evento en $0,
// devolvemos un warning para que el admin lo sepa al crear (no falla el crear).
async function chequearRiesgoEntradaEnCero(eventoId, tipo, valor) {
  if (tipo !== TIPO_CUPON.MONTO) return null;
  const tandas = await prisma.tanda.findMany({
    where: { eventoId },
    select: { nombre: true, precio: true },
  });
  const conflictos = tandas.filter((t) => valor >= t.precio);
  if (conflictos.length === 0) return null;
  const lista = conflictos.map((t) => `${t.nombre} ($${t.precio})`).join(', ');
  return (
    `El descuento $${valor} cubre o supera el precio de ${conflictos.length} tanda(s): ${lista}. ` +
    `Las entradas de esas tandas quedarán en $0 al aplicar el cupón.`
  );
}

async function adminListar(req, res) {
  try {
    const where = {};
    if (req.query.eventoId) where.eventoId = parseInt(req.query.eventoId, 10);
    if (req.query.activo !== undefined) where.activo = toBool(req.query.activo);

    const cupones = await prisma.cuponDescuento.findMany({
      where,
      orderBy: [{ activo: 'desc' }, { createdAt: 'desc' }],
      include: {
        evento: { select: { id: true, nombre: true, fecha: true } },
        _count: { select: { usos: true } },
      },
    });
    return res.json(cupones);
  } catch (err) {
    console.error('Error en adminListar cupones:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

async function adminGetById(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    const cupon = await prisma.cuponDescuento.findUnique({
      where: { id },
      include: {
        evento: { select: { id: true, nombre: true, fecha: true } },
        usos: {
          include: {
            compra: {
              select: { id: true, email: true, nombre: true, apellido: true, totalPagado: true, mpEstado: true, createdAt: true },
            },
          },
          orderBy: { createdAt: 'desc' },
        },
      },
    });
    if (!cupon) return res.status(404).json({ error: 'Cupón no encontrado' });
    return res.json(cupon);
  } catch (err) {
    console.error('Error en adminGetById cupon:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

async function adminCrear(req, res) {
  try {
    const { eventoId, codigo, tipo, valor, topeUsos, validoHasta, activo } = req.body;

    if (!eventoId || !codigo || !tipo || valor === undefined) {
      return res.status(400).json({ error: 'Faltan campos requeridos: eventoId, codigo, tipo, valor' });
    }

    const evento = await prisma.evento.findUnique({ where: { id: parseInt(eventoId, 10) } });
    if (!evento) return res.status(404).json({ error: 'Evento no encontrado' });

    const codigoNorm = normalizarCodigo(codigo);
    if (codigoNorm.length < 3) {
      return res.status(400).json({ error: 'El código debe tener al menos 3 caracteres' });
    }

    const valorInt = parseInt(valor, 10);
    const topeInt = toIntOrNull(topeUsos);

    const errCampos = validarCamposCupon({ tipo, valor: valorInt, topeUsos: topeInt });
    if (errCampos) return res.status(400).json({ error: errCampos });

    const warnings = [];
    const warningCero = await chequearRiesgoEntradaEnCero(parseInt(eventoId, 10), tipo, valorInt);
    if (warningCero) warnings.push(warningCero);

    try {
      const cupon = await prisma.cuponDescuento.create({
        data: {
          eventoId: parseInt(eventoId, 10),
          codigo: codigoNorm,
          tipo,
          valor: valorInt,
          topeUsos: topeInt,
          validoHasta: toDateOrNull(validoHasta),
          activo: activo === undefined ? true : toBool(activo),
        },
      });
      return res.status(201).json({ cupon, warnings });
    } catch (err) {
      if (err.code === 'P2002') {
        return res.status(400).json({ error: `Ya existe un cupón con código "${codigoNorm}"` });
      }
      throw err;
    }
  } catch (err) {
    console.error('Error en adminCrear cupon:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// Solo permite cambiar `topeUsos`, `validoHasta` y `activo`. Cambiar `codigo`,
// `tipo`, `valor` o `eventoId` invalidaría la auditoría histórica de los usos
// ya registrados — para esos casos el admin debe crear un cupón nuevo.
async function adminActualizar(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = await prisma.cuponDescuento.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Cupón no encontrado' });

    const { topeUsos, validoHasta, activo } = req.body;
    const data = {};

    if (topeUsos !== undefined) {
      const topeInt = toIntOrNull(topeUsos);
      if (topeInt !== null && (!Number.isInteger(topeInt) || topeInt <= 0)) {
        return res.status(400).json({ error: 'topeUsos debe ser un entero positivo o null' });
      }
      // Si bajan el tope por debajo de los usos actuales, advertimos pero permitimos
      // (los usos ya consumidos no se devuelven; queda inactivo de hecho).
      if (topeInt !== null && topeInt < existing.usosActuales) {
        return res.status(400).json({
          error: `No podés bajar el tope a ${topeInt} — el cupón ya tiene ${existing.usosActuales} usos. Desactivalo en su lugar.`,
        });
      }
      data.topeUsos = topeInt;
    }
    if (validoHasta !== undefined) data.validoHasta = toDateOrNull(validoHasta);
    if (activo !== undefined) data.activo = toBool(activo);

    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: 'Nada para actualizar (solo topeUsos, validoHasta y activo son editables)' });
    }

    const cupon = await prisma.cuponDescuento.update({ where: { id }, data });
    return res.json(cupon);
  } catch (err) {
    console.error('Error en adminActualizar cupon:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// Solo permite borrar si nunca fue usado. Si tiene usos, la opción es
// desactivar (PATCH activo=false) — preservamos la historia.
async function adminEliminar(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = await prisma.cuponDescuento.findUnique({
      where: { id },
      include: { _count: { select: { usos: true } } },
    });
    if (!existing) return res.status(404).json({ error: 'Cupón no encontrado' });

    if (existing._count.usos > 0 || existing.usosActuales > 0) {
      return res.status(400).json({
        error: 'No se puede eliminar un cupón con usos. Desactivalo en su lugar.',
      });
    }

    await prisma.cuponDescuento.delete({ where: { id } });
    return res.json({ ok: true });
  } catch (err) {
    console.error('Error en adminEliminar cupon:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// Mapea los .code del helper de precios a mensajes user-friendly + decide si el
// mensaje puede revelar info (CUPON_OTRO_EVENTO se uniforma con CUPON_INVALIDO
// para no exponer la existencia del código en otros eventos).
function mensajeUsuarioCupon(code) {
  switch (code) {
    case 'CUPON_VENCIDO':
      return 'Este cupón está vencido';
    case 'CUPON_AGOTADO':
      return 'Este cupón ya alcanzó su tope de usos';
    case 'APORTE_NO_HABILITADO':
      return 'Esta tanda no admite entrada con aporte';
    case 'TIPO_ENTRADA_INVALIDO':
      return 'Tipo de entrada inválido';
    case 'CUPON_INVALIDO':
    case 'CUPON_OTRO_EVENTO':
    case 'CUPON_TIPO_INVALIDO':
    default:
      return 'Cupón no válido';
  }
}

// Endpoint público: preview de descuento sin reservar uso ni crear Compra.
// Lo usa el modal de checkout del público para mostrar el precio nuevo antes
// de ir a MP. Rate-limited (ver middleware/rate-limit.js).
async function validarPublico(req, res) {
  try {
    const { eventoId, codigo, tipoEntrada } = req.body || {};

    if (!eventoId || !codigo) {
      return res.status(400).json({ ok: false, error: 'Faltan eventoId o codigo' });
    }

    const evento = await prisma.evento.findUnique({
      where: { id: parseInt(eventoId, 10) },
      include: { tandas: true },
    });
    if (!evento || !evento.estaPublicado || evento.estaAgotado) {
      return res.status(400).json({ ok: false, error: 'Evento no disponible' });
    }

    const tandaVigente = getTandaVigente(evento.tandas);
    if (!tandaVigente) {
      return res.status(400).json({ ok: false, error: 'Entradas no disponibles para este evento' });
    }

    let precio;
    try {
      precio = await calcularPrecioFinal(tandaVigente, { tipoEntrada, cuponCodigo: codigo });
    } catch (err) {
      if (err.code) {
        return res.status(400).json({
          ok: false,
          error: mensajeUsuarioCupon(err.code),
          code: err.code,
        });
      }
      throw err;
    }

    if (!precio.cupon) {
      // calcularPrecioFinal puede devolver cupon=null si cuponCodigo viene vacío
      // tras normalizar — defensa adicional aunque ya validamos arriba.
      return res.status(400).json({ ok: false, error: 'Cupón no válido' });
    }

    return res.json({
      ok: true,
      cupon: {
        codigo: precio.cupon.codigo,
        tipo: precio.cupon.tipo,
        valor: precio.cupon.valor,
      },
      precio: {
        base: precio.precioBase,
        descuento: precio.descuentoUnitario,
        excedente: precio.excedenteUnitario,
        total: precio.precioUnitarioFinal,
      },
    });
  } catch (err) {
    console.error('Error en validarPublico cupon:', err);
    return res.status(500).json({ ok: false, error: 'Error interno del servidor' });
  }
}

module.exports = {
  validarPublico,
  adminListar,
  adminGetById,
  adminCrear,
  adminActualizar,
  adminEliminar,
};
