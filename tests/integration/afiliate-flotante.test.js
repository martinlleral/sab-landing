/**
 * Tests — El botón flotante «Afiliate» de la portada (escalón 0, la invitación).
 *
 * La regla vive en public/assets/js/afiliate-flotante.js, que corre en el
 * navegador y también se puede cargar desde Node: así se prueba sin DOM.
 *
 * Cubre:
 *   A · Cuándo se ve: sólo con las afiliaciones abiertas (lo dice /api/home) y
 *       después de pasar el hero; nunca con el modal de compra abierto, con la
 *       sección de afiliación a la vista, en pantallas de menos de 480 px de alto
 *       ni si ya lo cerraron o lo tocaron. Cada condición, con su control.
 *   B · La memoria: cerrarlo lo esconde 30 días (y a los 30 vuelve); tocarlo, en
 *       esa visita; si el navegador no deja guardar, sólo en esa visita (y nunca
 *       rompe). Nunca vuelve achicado: no hay un estado «minimizado».
 *   C · El HTML de la portada: el botón viene oculto, es un link a
 *       /afiliate?origen=flotante, el de cerrar es un <button> con nombre, va
 *       antes del de WhatsApp (el foco pasa a ése al cerrar) y app.js lo arranca
 *       sólo en la rama de afiliaciones abiertas.
 *
 * Uso: node tests/integration/afiliate-flotante.test.js
 * Exit codes: 0 = PASS, 1 = FAIL
 */

const fs = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, '../../public');
const DIA = 24 * 3600 * 1000;

let pass = 0;
let fail = 0;
function check(id, cond, msg) {
  if (cond) { pass += 1; console.log(`  ✅ ${id} ${msg}`); }
  else { fail += 1; console.log(`  ❌ ${id} ${msg}`); }
}

// Un almacenamiento de mentira, como localStorage.
function almacen() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => m.delete(k), _m: m };
}
// Uno que no deja guardar (Safari privado viejo, cookies bloqueadas).
const roto = { getItem: () => { throw new Error('SecurityError'); }, setItem: () => { throw new Error('QuotaExceededError'); } };

function main() {
  console.log('\n═══ afiliate-flotante ═══');
  let fl;
  try {
    fl = require('../../public/assets/js/afiliate-flotante.js');
    if (typeof fl.debeVerse !== 'function' || typeof fl.crearMemoria !== 'function') throw new Error('no exporta debeVerse y crearMemoria');
  } catch (e) {
    check('0', false, `falta el módulo del botón flotante: ${e.message.split('\n')[0]}`);
    return;
  }

  // ── A · Cuándo se ve ─────────────────────────────────────────────────────
  console.log('A · cuándo se ve');
  const base = { abiertas: true, descartado: false, pasoElHero: true, modalAbierto: false, seccionAVista: false, altoVentana: 844 };
  check('A1', fl.debeVerse(base) === true, 'control: abiertas, pasado el hero, sin modal ni sección, 844 px de alto → se ve');
  check('A2', fl.debeVerse({ ...base, abiertas: false }) === false, 'antes de la salida, no');
  check('A3', fl.debeVerse({ ...base, abiertas: undefined }) === false, 'si /api/home no dijo nada, no (sólo con un true explícito)');
  check('A4', fl.debeVerse({ ...base, pasoElHero: false }) === false, 'sin pasar el hero, no (nunca al cargar)');
  check('A5', fl.debeVerse({ ...base, modalAbierto: true }) === false, 'con el modal de compra abierto, no');
  check('A6', fl.debeVerse({ ...base, seccionAVista: true }) === false, 'con la sección de afiliación a la vista, no');
  check('A7', fl.debeVerse({ ...base, altoVentana: 479 }) === false && fl.debeVerse({ ...base, altoVentana: 480 }) === true, 'en menos de 480 px de alto, no; en 480, sí (el borde)');
  check('A8', fl.debeVerse({ ...base, descartado: true }) === false, 'si ya lo cerraron o lo tocaron, no');

  // ── B · La memoria ───────────────────────────────────────────────────────
  console.log('B · la memoria');
  let t = Date.UTC(2026, 10, 20, 15, 0, 0);
  const reloj = () => t;
  const local = almacen(); const sesion = almacen();
  let m = fl.crearMemoria(local, sesion, reloj);
  check('B1', m.descartado() === false, 'de entrada no está descartado');
  m.cerrar();
  check('B2', m.descartado() === true, 'cerrado: no vuelve en esta visita');
  // Otra visita (una página nueva, la misma memoria del navegador).
  t += 29 * DIA;
  m = fl.crearMemoria(local, almacen(), reloj);
  check('B3', m.descartado() === true, 'cerrado: a los 29 días, en otra visita, sigue sin volver');
  t += 1 * DIA + 1000;
  m = fl.crearMemoria(local, almacen(), reloj);
  check('B4', m.descartado() === false, 'a los 30 días vuelve (control del plazo)');

  const local2 = almacen(); const sesion2 = almacen();
  m = fl.crearMemoria(local2, sesion2, reloj);
  m.tocar();
  check('B5', m.descartado() === true, 'tocado: no vuelve en esta visita');
  check('B6', fl.crearMemoria(local2, sesion2, reloj).descartado() === true, 'tocado: tampoco al volver atrás en la misma pestaña');
  check('B7', fl.crearMemoria(local2, almacen(), reloj).descartado() === false, 'tocado: en otra visita vuelve (no se guardó por 30 días)');

  let tiro = null; let m3;
  try {
    m3 = fl.crearMemoria(roto, roto, reloj);
    check('B8', m3.descartado() === false, 'sin almacenamiento: de entrada se ve');
    m3.cerrar();
    check('B9', m3.descartado() === true, 'sin almacenamiento: cerrado, se oculta en esa visita');
    check('B10', fl.crearMemoria(roto, roto, reloj).descartado() === false, 'sin almacenamiento: en otra visita vuelve (no hay dónde recordarlo)');
  } catch (e) { tiro = e; }
  check('B11', tiro === null, `un almacenamiento que tira errores no rompe nada${tiro ? ` (${tiro.message})` : ''}`);
  check('B12', fl.crearMemoria(null, null, reloj).descartado() === false, 'sin localStorage ni sessionStorage (null), tampoco');
  const local4 = almacen(); local4.setItem(fl.CLAVE_CERRADO, 'cualquier cosa');
  check('B13', fl.crearMemoria(local4, almacen(), reloj).descartado() === false, 'un valor guardado que no es una fecha se ignora');
  check('B14', !Object.keys(fl).some((k) => /minimi|achic|reduc/i.test(k)), 'no hay un estado «minimizado»: cerrado es cerrado');

  // ── C · El HTML de la portada ────────────────────────────────────────────
  console.log('C · el HTML de la portada');
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  const raiz = (html.match(/<div[^>]*id="afiliate-flotante"[^>]*>[\s\S]*?<\/div>/) || [''])[0];
  const apertura = (raiz.match(/<div[^>]*>/) || [''])[0];
  check('C1', raiz && /\bhidden\b/.test(apertura), 'el botón está en la portada y viene oculto (sin JS o antes de la salida, no se ve)');
  check('C2', /<a[^>]*class="[^"]*afl-pill[^"]*"[^>]*href="\/afiliate\?origen=flotante"[^>]*>\s*Afiliate\s*<\/a>/.test(raiz) || /<a[^>]*href="\/afiliate\?origen=flotante"[^>]*class="[^"]*afl-pill[^"]*"[^>]*>\s*Afiliate\s*<\/a>/.test(raiz), 'es un link «Afiliate» a /afiliate?origen=flotante');
  check('C3', /<button[^>]*type="button"[^>]*aria-label="Cerrar invitación a afiliarse"/.test(raiz), 'cerrar es un <button> con el nombre «Cerrar invitación a afiliarse»');
  const iFlot = html.indexOf('id="afiliate-flotante"'); const iWa = html.indexOf('class="whatsapp-float"');
  check('C4', iFlot > 0 && iWa > iFlot, 'va antes del de WhatsApp en el HTML (al cerrar, el foco pasa a ése)');
  check('C5', /<script[^>]*src="\/assets\/js\/afiliate-flotante\.js"/.test(html), 'la portada carga el script del botón');
  const appJs = fs.readFileSync(path.join(PUBLIC, 'assets/js/app.js'), 'utf8');
  const rama = (appJs.match(/function aplicarAfiliaciones[\s\S]*?\n}\n/) || [''])[0];
  const [ramaAbierta, ramaCerrada = ''] = rama.split(/\n\s*return;\n/);
  check('C6', /sabFlotante/.test(ramaAbierta) && !/sabFlotante/.test(ramaCerrada), 'app.js lo arranca sólo en la rama de afiliaciones abiertas');
  const estilo = (html.match(/<style>[^<]*\.afl\b[\s\S]*?<\/style>/) || [''])[0];
  check('C7', /prefers-reduced-motion/.test(estilo) && /z-index:\s*10[0-4]\d/.test(estilo), 'el estilo respeta «reducir movimiento» y queda por debajo del modal (z-index < 1050)');
}

try { main(); } catch (e) { fail += 1; console.error('💥', e); }
console.log(`\n${fail === 0 ? '✅' : '❌'} afiliate-flotante: ${pass} ok, ${fail} con falla`);
process.exit(fail === 0 && pass > 0 ? 0 : 1);
