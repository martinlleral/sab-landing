/**
 * Orden alfabético de personas, con la colación que espera un ojo hispanohablante.
 *
 * Existe como módulo propio porque el criterio se usa en DOS lugares que tienen
 * que coincidir: el listado de compras del backoffice (ítem 40, cerrado el
 * 15/8) y la lista de menús que se imprime para la cocina (ítem 44). Si cada
 * uno ordenara por su cuenta, el operador buscaría un apellido en dos pantallas
 * y lo encontraría en dos lugares distintos.
 *
 * Por qué no lo ordena SQLite: usa colación binaria (compara bytes), así que
 * "SANTORO" (S=83) cae antes que "Abad" (b=98) y "diaz" se va al final de todo.
 * Sobre la base real eso descoloca ~9 % de los apellidos. Prisma no expone
 * COLLATE NOCASE ni lower() en orderBy para SQLite, así que el alfabético se
 * resuelve en Node — sobre el conjunto completo, nunca sobre una página.
 */

/**
 * Compara dos compras por "Apellido Nombre".
 *
 * `sensitivity: 'base'` ignora mayúsculas y acentos, que es como busca una
 * persona: quien lee la hoja no distingue "Gómez" de "Gomez". Desempate por
 * `id` para que el orden sea estable entre recargas (dos "Pérez, Juan" no
 * pueden intercambiarse de lugar en dos impresiones de la misma lista).
 *
 * @param {{apellido?: string, nombre?: string, id: number}} a
 * @param {{apellido?: string, nombre?: string, id: number}} b
 * @returns {number} negativo si a va antes, positivo si va después
 */
function compararPorApellido(a, b) {
  const va = `${a.apellido || ''} ${a.nombre || ''}`;
  const vb = `${b.apellido || ''} ${b.nombre || ''}`;
  return va.localeCompare(vb, 'es', { sensitivity: 'base' }) || (a.id - b.id);
}

module.exports = { compararPorApellido };
