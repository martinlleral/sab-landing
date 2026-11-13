const path = require('path');
const { abiertas } = require('../config/afiliaciones');

/**
 * /afiliate y /afiliate/gracias (escalón 0).
 *
 * Las dos existen desde el deploy, antes de la salida: la vuelta desde MP tiene
 * que estar para la prueba real, y el deploy se verifica mirándolas. Mientras
 * tanto ningún link lleva a ellas y no se indexan. Desde la salida, /afiliate sí
 * se indexa; la vuelta, nunca (no tiene nada que buscar).
 *
 * Los archivos no están en una carpeta con el mismo nombre que la ruta: si
 * estuvieran, express.static respondería primero con un 301 a «/afiliate/».
 */
const PAGINA = path.join(__dirname, '../../public/afiliate.html');
const GRACIAS = path.join(__dirname, '../../public/afiliate-gracias.html');

function pagina(_req, res) {
  if (!abiertas()) res.set('X-Robots-Tag', 'noindex, nofollow');
  return res.sendFile(PAGINA);
}

function gracias(_req, res) {
  res.set('X-Robots-Tag', 'noindex, nofollow');
  return res.sendFile(GRACIAS);
}

module.exports = { pagina, gracias };
