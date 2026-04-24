/**
 * Lógica de tandas: cálculo de tanda vigente + estado del evento.
 *
 * Una Tanda está disponible para la venta si cumple las 3 condiciones:
 *   1. activa === true (toggle manual del admin)
 *   2. capacidad === null  OR  cantidadVendida < capacidad
 *   3. fechaLimite === null  OR  now < fechaLimite
 *
 * Las tandas son secuenciales: la vigente es la PRIMERA por `orden`
 * que cumpla las 3 condiciones. Si ninguna las cumple, el evento
 * no tiene venta disponible.
 */

function estaDisponible(tanda, now) {
  if (!tanda.activa) return false;
  if (tanda.capacidad !== null && tanda.cantidadVendida >= tanda.capacidad) return false;
  if (tanda.fechaLimite !== null && now >= new Date(tanda.fechaLimite)) return false;
  return true;
}

function getTandaVigente(tandas, now = new Date()) {
  if (!Array.isArray(tandas) || tandas.length === 0) return null;
  const ordenadas = [...tandas].sort((a, b) => a.orden - b.orden);
  return ordenadas.find((t) => estaDisponible(t, now)) || null;
}

// Estado de una tanda para mostrar badge en el backoffice.
// Asume que ya existe `vigente` = getTandaVigente(todas).
function getEstadoTanda(tanda, vigente, now = new Date()) {
  if (!tanda.activa) return 'desactivada';
  if (vigente && tanda.id === vigente.id) return 'vigente';
  if (tanda.capacidad !== null && tanda.cantidadVendida >= tanda.capacidad) return 'agotada';
  if (tanda.fechaLimite !== null && now >= new Date(tanda.fechaLimite)) return 'vencida';
  return 'proxima';
}

module.exports = { getTandaVigente, getEstadoTanda, estaDisponible };
