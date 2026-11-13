/**
 * La salida de las afiliaciones: el único lugar donde vive la fecha.
 *
 * Hasta ese instante la portada muestra lo de antes (la lista de espera y el
 * «Sumate» del menú); desde ese instante, lo nuevo («Afiliate» y /afiliate). Lo
 * decide el SERVIDOR (`GET /api/home` responde `afiliacionesAbiertas`), así que
 * no importan ni el reloj del celular de quien mira ni la zona horaria del
 * servidor: es un instante, con su offset.
 *
 * `AFILIACIONES_SALIDA` (ISO 8601 con offset) lo pisa sin tocar código: sirve
 * para la QA y para correr la salida con un reinicio del contenedor, sin deploy.
 * Si la variable está mal escrita se ignora y vale la fecha de abajo: una
 * variable rota no puede dejar la página abierta antes de tiempo ni cerrada
 * para siempre. La reusa el botón flotante.
 */

const SALIDA_POR_DEFECTO = '2026-11-15T00:00:00-03:00';

let avisado = false;

function salida() {
  const raw = process.env.AFILIACIONES_SALIDA;
  if (raw) {
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) return d;
    if (!avisado) {
      console.warn(`WARN: AFILIACIONES_SALIDA no es una fecha («${raw}»): vale ${SALIDA_POR_DEFECTO}`);
      avisado = true;
    }
  }
  return new Date(SALIDA_POR_DEFECTO);
}

function abiertas(ahora = new Date()) {
  return ahora.getTime() >= salida().getTime();
}

module.exports = { SALIDA_POR_DEFECTO, salida, abiertas };
