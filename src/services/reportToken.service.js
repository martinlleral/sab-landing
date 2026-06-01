const crypto = require('crypto');
const prisma = require('../utils/prisma');

// Días de validez permitidos para el link de reporte (el admin elige al generar).
// Whitelist defensiva: cualquier otro valor cae al default. Ver #9 / plan E1.
const DIAS_VALIDOS = [7, 30, 90];
const DIAS_DEFAULT = 30;

function normalizarDias(dias) {
  const n = parseInt(dias, 10);
  return DIAS_VALIDOS.includes(n) ? n : DIAS_DEFAULT;
}

// Genera un token de acceso de solo-lectura para el reporte de un evento.
// El token es 64 chars hex (256 bits de entropía) — no brute-forceable. La
// expiración es OBLIGATORIA: siempre seteamos expiraEn (default 30 días).
async function generarToken(eventoId, { expiraEnDias, creadoPor = '' } = {}) {
  const id = parseInt(eventoId, 10);
  if (!Number.isInteger(id) || id <= 0) {
    const err = new Error('eventoId inválido');
    err.code = 'EVENTO_INVALIDO';
    throw err;
  }
  const evento = await prisma.evento.findUnique({ where: { id } });
  if (!evento) {
    const err = new Error('Evento no encontrado');
    err.code = 'EVENTO_NO_ENCONTRADO';
    throw err;
  }

  const dias = normalizarDias(expiraEnDias);
  const token = crypto.randomBytes(32).toString('hex'); // 64 chars
  const expiraEn = new Date(Date.now() + dias * 24 * 60 * 60 * 1000);

  return prisma.reportAccessToken.create({
    data: { eventoId: id, token, expiraEn, creadoPor: String(creadoPor || '') },
  });
}

// Valida un token de reporte. Devuelve el `code` interno REAL (para logging) —
// es el middleware quien uniforma la respuesta pública (no filtrar si el token
// no existe vs está revocado vs vencido). Ver requireReportToken.
async function validarToken(token) {
  if (!token || typeof token !== 'string') {
    return { valido: false, code: 'TOKEN_INEXISTENTE' };
  }
  const registro = await prisma.reportAccessToken.findUnique({ where: { token } });
  if (!registro) return { valido: false, code: 'TOKEN_INEXISTENTE' };
  if (!registro.activo) return { valido: false, code: 'TOKEN_REVOCADO' };
  if (registro.expiraEn.getTime() < Date.now()) {
    return { valido: false, code: 'TOKEN_EXPIRADO' };
  }

  // Auditoría de último acceso — best-effort: no bloquea ni rompe la validación
  // si falla (el dato es informativo, no de control de acceso).
  prisma.reportAccessToken
    .update({ where: { id: registro.id }, data: { ultimoAcceso: new Date() } })
    .catch(() => {});

  return { valido: true, eventoId: registro.eventoId, registro };
}

// Lista los tokens de un evento (para el backoffice). Activos primero, luego
// por fecha de creación descendente.
async function listarPorEvento(eventoId) {
  const id = parseInt(eventoId, 10);
  if (!Number.isInteger(id) || id <= 0) return [];
  return prisma.reportAccessToken.findMany({
    where: { eventoId: id },
    orderBy: [{ activo: 'desc' }, { createdAt: 'desc' }],
  });
}

// Revoca un token (soft-delete: activo=false). Preservamos la fila para
// auditoría — mismo criterio que cupones (no se borra lo que tuvo uso real).
async function revocar(id) {
  const tokenId = parseInt(id, 10);
  if (!Number.isInteger(tokenId) || tokenId <= 0) return null;
  try {
    return await prisma.reportAccessToken.update({
      where: { id: tokenId },
      data: { activo: false },
    });
  } catch (err) {
    if (err.code === 'P2025') return null; // no existe
    throw err;
  }
}

module.exports = {
  generarToken,
  validarToken,
  listarPorEvento,
  revocar,
  DIAS_VALIDOS,
  DIAS_DEFAULT,
};
