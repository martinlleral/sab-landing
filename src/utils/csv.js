/**
 * Serialización de CSV para las descargas del backoffice.
 *
 * Existe como módulo propio y sin dependencias porque el proyecto no tiene (ni
 * quiere) una librería de planillas: 16 dependencias, ninguna de Excel, y ya
 * cerró 6 CVEs borrando un import. Un CSV bien escapado son 40 líneas de texto.
 *
 * Las tres decisiones que hay acá no son de estilo — cada una es la diferencia
 * entre un archivo que abre y uno que no:
 *
 * 1. **BOM UTF-8 al inicio.** Sin él, Excel abre el archivo con la codificación
 *    del sistema y "Martín Pérez" sale "MartÃ­n PÃ©rez". El BOM es el único
 *    modo de que un doble clic funcione, que es como lo va a abrir el operador.
 *
 * 2. **Punto y coma como separador.** Excel no usa una coma fija: usa el
 *    "separador de listas" del locale, y en es-AR ese separador es `;`. Un CSV
 *    con comas abierto de doble clic en un Excel en español mete las 16
 *    columnas dentro de la columna A. Google Sheets detecta el delimitador solo,
 *    así que `;` gana en el caso real (Excel argentino) sin perder el otro.
 *    Si algún día el destino cambia, se cambia acá y en ningún otro lado.
 *
 * 3. **Neutralización de fórmulas.** Los nombres, mails y teléfonos los escribe
 *    quien compra, en un formulario público. Un campo que empieza con `=`, `+`,
 *    `-` o `@` es una FÓRMULA para Excel, no un texto: `=1+1` da 2, y variantes
 *    peores llaman a servicios externos con el contenido de la planilla. Es CSV
 *    injection y el vector es exactamente este —dato de un tercero que termina
 *    en la planilla del administrador—. Se prefija con `'`, que Excel y Sheets
 *    leen como "esto es texto literal" y NO muestran en la celda: el teléfono
 *    `+5491122223333` se ve igual, pero ya no se evalúa.
 */

/** Separador de campos. Ver decisión 2 del encabezado. */
const SEPARADOR = ';';

/** Fin de línea CRLF (RFC 4180). Excel lo prefiere y ningún lector se queja. */
const FIN_DE_LINEA = '\r\n';

/** Marca de orden de bytes UTF-8. Ver decisión 1 del encabezado. */
const BOM = '\uFEFF';

/** Caracteres que convierten un campo en fórmula. Ver decisión 3. */
const ARRANQUE_DE_FORMULA = ['=', '+', '-', '@', '\t', '\r'];

/**
 * Convierte un valor a un campo CSV seguro.
 *
 * `null` y `undefined` van a cadena vacía a propósito: en una planilla, una
 * celda vacía se lee como "no hay dato", mientras que el texto "null" se lee
 * como un dato que dice "null".
 *
 * @param {*} valor
 * @returns {string} campo listo para concatenar
 */
function escaparCampo(valor) {
  let s = valor === null || valor === undefined ? '' : String(valor);

  // Primero neutralizar la fórmula, después comillar: al revés, el `'` quedaría
  // adentro de las comillas de escape y el campo tendría dos capas de prefijo.
  if (ARRANQUE_DE_FORMULA.includes(s.charAt(0))) s = `'${s}`;

  const necesitaComillas =
    s.includes(SEPARADOR) || s.includes('"') || s.includes('\n') || s.includes('\r');
  if (necesitaComillas) s = `"${s.replace(/"/g, '""')}"`;

  return s;
}

/**
 * Arma el CSV completo, con BOM.
 *
 * @param {string[]} encabezados - los nombres de columna, en orden
 * @param {Array<Array<*>>} filas - una fila por registro, en el mismo orden
 * @returns {string} el archivo entero, listo para mandar en el body
 */
function serializarCSV(encabezados, filas) {
  const lineas = [encabezados, ...filas].map((fila) => fila.map(escaparCampo).join(SEPARADOR));
  // Salto final: un archivo que termina en fin de línea es lo que espera un
  // lector de líneas, y ninguna planilla agrega una fila vacía por eso.
  return BOM + lineas.join(FIN_DE_LINEA) + FIN_DE_LINEA;
}

/**
 * Reduce un texto a un slug ASCII usable dentro de un nombre de archivo.
 *
 * El nombre de un evento puede traer acentos, comillas, barras y saltos de
 * línea, y todo eso viaja en el header `Content-Disposition`. Un `/` ahí es un
 * separador de ruta y unas comillas cierran el valor del header antes de tiempo:
 * sanear no es prolijidad, es no dejar que el nombre del evento escriba el
 * header.
 *
 * @param {string} texto
 * @returns {string} slug en minúsculas, solo [a-z0-9-]
 */
function slugArchivo(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')   // saca los acentos que NFD separó
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

module.exports = { SEPARADOR, FIN_DE_LINEA, BOM, escaparCampo, serializarCSV, slugArchivo };
