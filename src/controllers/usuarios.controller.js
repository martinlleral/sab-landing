const bcrypt = require('bcryptjs');
const prisma = require('../utils/prisma');

async function adminListar(req, res) {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const [usuarios, total] = await Promise.all([
      prisma.usuario.findMany({
        select: { id: true, nombre: true, apellido: true, email: true, telefono: true, rol: true, activo: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.usuario.count(),
    ]);

    return res.json({ usuarios, total, page, totalPages: Math.ceil(total / limit) });
  } catch (err) {
    console.error('Error en adminListar usuarios:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

async function adminCrear(req, res) {
  try {
    const { nombre, apellido, email, telefono, password, rol } = req.body;
    if (!nombre || !apellido || !email || !password) {
      return res.status(400).json({ error: 'Faltan campos requeridos' });
    }

    const existing = await prisma.usuario.findUnique({ where: { email } });
    if (existing) return res.status(400).json({ error: 'Ya existe un usuario con ese email' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const usuario = await prisma.usuario.create({
      data: {
        nombre,
        apellido,
        email,
        telefono: telefono || '',
        password: hashedPassword,
        rol: parseInt(rol) || 2,
      },
      select: { id: true, nombre: true, apellido: true, email: true, rol: true, activo: true, createdAt: true },
    });

    return res.status(201).json(usuario);
  } catch (err) {
    console.error('Error en adminCrear usuario:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

async function adminEditar(req, res) {
  try {
    const id = parseInt(req.params.id);
    const { nombre, apellido, email, telefono, password, rol, activo } = req.body;

    const existing = await prisma.usuario.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Usuario no encontrado' });

    const data = {};
    if (nombre !== undefined) data.nombre = nombre;
    if (apellido !== undefined) data.apellido = apellido;
    if (email !== undefined) data.email = email;
    if (telefono !== undefined) data.telefono = telefono;
    if (rol !== undefined) data.rol = parseInt(rol);
    if (activo !== undefined) data.activo = activo === 'true' || activo === true;
    if (password) data.password = await bcrypt.hash(password, 10);

    const usuario = await prisma.usuario.update({
      where: { id },
      data,
      select: { id: true, nombre: true, apellido: true, email: true, rol: true, activo: true, updatedAt: true },
    });

    return res.json(usuario);
  } catch (err) {
    console.error('Error en adminEditar usuario:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

module.exports = { adminListar, adminCrear, adminEditar };
