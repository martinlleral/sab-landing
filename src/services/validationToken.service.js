const crypto = require('crypto');
const prisma = require('../utils/prisma');

// Token de acceso para validar entradas por QR (ítem 2 / Sprint 5).
// A diferencia del token de reporte (#9): es GLOBAL (no atado a un evento),
// NO expira (se desactiva a voluntad con `activo`) y es un único link
// compartido entre los validadores de una sede. La barrera es el token mismo
// (64 chars hex = 256 bits, no brute-forceable) + el toggle activo.

async function generarToken({ descripcion = '', creadoPor = '' } = {}) {
  const token = crypto.randomBytes(32).toString('hex'); // 64 chars
  return prisma.validationAccessToken.create({
    data: {
      token,
      descripcion: String(descripcion || '').trim(),
      creadoPor: String(creadoPor || ''),
    },
  });
}

// Valida un token. Devuelve el `code` interno REAL (para logging); el middleware
// es quien uniforma la respuesta pública (no filtrar inexistente vs revocado).
// No hay estado "expirado": estos tokens no vencen por tiempo.
async function validarToken(token) {
  if (!token || typeof token !== 'string') {
    return { valido: false, code: 'TOKEN_INEXISTENTE' };
  }
  const registro = await prisma.validationAccessToken.findUnique({ where: { token } });
  if (!registro) return { valido: false, code: 'TOKEN_INEXISTENTE' };
  if (!registro.activo) return { valido: false, code: 'TOKEN_REVOCADO' };

  // Auditoría de último acceso — best-effort, no bloquea la validación.
  prisma.validationAccessToken
    .update({ where: { id: registro.id }, data: { ultimoAcceso: new Date() } })
    .catch(() => {});

  return { valido: true, registro };
}

// Lista todos los tokens (para el backoffice). Activos primero, luego por fecha.
async function listar() {
  return prisma.validationAccessToken.findMany({
    orderBy: [{ activo: 'desc' }, { createdAt: 'desc' }],
  });
}

// Activa o desactiva un token (toggle). Desactivar = revocar el link sin
// borrarlo (preserva auditoría y permite reactivarlo para otro ciclo).
async function setActivo(id, activo) {
  const tokenId = parseInt(id, 10);
  if (!Number.isInteger(tokenId) || tokenId <= 0) return null;
  try {
    return await prisma.validationAccessToken.update({
      where: { id: tokenId },
      data: { activo: !!activo },
    });
  } catch (err) {
    if (err.code === 'P2025') return null; // no existe
    throw err;
  }
}

module.exports = { generarToken, validarToken, listar, setActivo };
