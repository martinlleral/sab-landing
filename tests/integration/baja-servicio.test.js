/**
 * Tests de integración — El Botón de baja de servicio (escalón 0).
 *
 * La norma (Disposición 954/2025, arts. 4 y 5): un link llamado «Botón de baja
 * de servicio», a la vista, sin registración previa ni otro trámite, y un código
 * de identificación por el mismo medio dentro de las 24 h.
 *
 * Cubre:
 *   A · La validación: nombre y mail obligatorios, el mail con forma de mail, el
 *       comentario opcional con tope de largo, y ningún campo admite `<` ni `>`.
 *       Lo que pasa, recortado (y el mail en minúscula).
 *   B · Pedir la baja (`POST /api/bajas`): 201 con un código con forma fija y
 *       único; el pedido queda guardado. Con datos inválidos, 400 con el campo
 *       que falla y NO se guarda nada (con su control).
 *   C · Los avisos: a la persona le llega el código y nada de lo que escribió (si
 *       no, el formulario sirve para mandar spam con la firma del sitio); a la
 *       coordinación, el pedido entero, a la dirección de BAJAS_AVISO_EMAIL. Sin
 *       esa variable no hay aviso a la coordinación (el panel lo lista igual). Si
 *       el mail falla, el pedido sigue guardado y sin marca. Con el tope diario
 *       alcanzado no sale ningún mail (con su control).
 *   D · El panel: lista los pedidos y deja marcarlos como hechos y desmarcarlos.
 *   E · Las páginas: /baja existe, con noindex hasta la salida; el link «Botón de
 *       baja de servicio» está al pie de /afiliate, de la vuelta, de la página de
 *       afiliadxs y de la portada (en la portada, oculto hasta la salida).
 *
 * Controllers directos con req/res mock. Uso local (dev.db):
 *   node tests/integration/baja-servicio.test.js
 * Exit codes: 0 = PASS, 1 = FAIL
 */

const fs = require('fs');
const path = require('path');
const prisma = require('../../src/utils/prisma');
const brevo = require('../../src/services/brevo.service');

const PUBLIC = path.join(__dirname, '../../public');
const SALIDA_ENV = 'AFILIACIONES_SALIDA';
const AVISO_ENV = 'BAJAS_AVISO_EMAIL';
const MARCA = '[TEST-BAJA]';
const DOMINIO = '@ejemplo.test';

let pass = 0;
let fail = 0;
function check(id, cond, msg) {
  if (cond) { pass += 1; console.log(`  ✅ ${id} ${msg}`); }
  else { fail += 1; console.log(`  ❌ ${id} ${msg}`); }
}

function mockRes() {
  return {
    statusCode: 200, body: null, headers: {}, archivo: null,
    status(c) { this.statusCode = c; return this; },
    json(p) { this.body = p; return this; },
    set(k, v) { this.headers[k] = v; return this; },
    sendFile(f) { this.archivo = f; return this; },
  };
}
async function call(handler, req = {}) {
  const res = mockRes();
  await handler({ params: {}, query: {}, body: {}, session: { usuario: { email: 'panel@ejemplo.test' } }, ...req }, res);
  return res;
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// Los mails, pisados: nada sale de la máquina.
const mails = { persona: [], coordinacion: [] };
let brevoCae = false;
brevo.enviarBajaRecibida = async (args) => {
  if (brevoCae) throw new Error('TEST: Brevo cae');
  mails.persona.push(args); return { mock: true };
};
brevo.enviarAvisoBaja = async (args) => {
  if (brevoCae) throw new Error('TEST: Brevo cae');
  mails.coordinacion.push(args); return { mock: true };
};

async function limpiar() {
  await prisma.bajaServicio.deleteMany({ where: { email: { endsWith: DOMINIO } } });
}

async function main() {
  console.log('\n═══ baja-servicio ═══');

  let service; let controller;
  try {
    service = require('../../src/services/bajas.service');
    controller = require('../../src/controllers/bajas.controller');
    if (!prisma.bajaServicio) throw new Error('el cliente de Prisma no tiene BajaServicio');
  } catch (e) {
    check('0', false, `faltan los módulos de la baja: ${e.message.split('\n')[0]}`);
    return;
  }
  const envSalida = process.env[SALIDA_ENV];
  const envAviso = process.env[AVISO_ENV];
  await limpiar();

  try {
    // ── A · La validación ────────────────────────────────────────────────────
    console.log('A · la validación');
    const ok = service.validar({ nombre: '  Ana   Ejemplo ', email: ' Ana@Ejemplo.TEST ', mensaje: '  me mudo  ' });
    check('A1', ok.ok && ok.datos.nombre === 'Ana Ejemplo' && ok.datos.email === 'ana@ejemplo.test' && ok.datos.mensaje === 'me mudo', 'lo válido pasa recortado y con el mail en minúscula');
    check('A2', service.validar({ nombre: 'Ana Ejemplo', email: 'ana@ejemplo.test' }).ok, 'el comentario es opcional');
    const sinNada = service.validar({});
    check('A3', !sinNada.ok && sinNada.campos.nombre && sinNada.campos.email, 'sin nombre ni mail: los dos campos marcados');
    check('A4', !service.validar({ nombre: 'Ana Ejemplo', email: 'ana.ejemplo.test' }).ok, 'un mail sin @ no pasa');
    check('A5', !service.validar({ nombre: 'Ana Ejemplo', email: 'ana@ejemplo' }).ok, 'un mail sin dominio con punto no pasa');
    const conSigno = service.validar({ nombre: '<b>Ana</b>', email: 'ana@ejemplo.test' });
    check('A6', !conSigno.ok && conSigno.campos.nombre && !conSigno.campos.email, 'el nombre no admite < ni > (y marca sólo ese campo)');
    check('A7', !service.validar({ nombre: 'Ana Ejemplo', email: 'ana@ejemplo.test', mensaje: 'hola <script>' }).ok, 'el comentario tampoco admite < ni >');
    check('A8', !service.validar({ nombre: 'Ana Ejemplo', email: 'ana@ejemplo.test', mensaje: 'x'.repeat(501) }).ok, 'un comentario de más de 500 letras no pasa');
    check('A9', service.validar({ nombre: 'Ana Ejemplo', email: 'ana@ejemplo.test', mensaje: 'x'.repeat(500) }).ok, 'uno de 500 justas, sí (control del tope)');
    check('A10', !service.validar({ nombre: 'A', email: 'ana@ejemplo.test' }).ok && !service.validar({ nombre: 'x'.repeat(121), email: 'ana@ejemplo.test' }).ok, 'un nombre de una letra o de más de 120 no pasa');

    // ── B · Pedir la baja ────────────────────────────────────────────────────
    console.log('B · pedir la baja');
    delete process.env[AVISO_ENV];
    const antes = await prisma.bajaServicio.count();
    const b1 = await call(controller.crear, { body: { nombre: `${MARCA} Ana Ejemplo`, email: `ana${DOMINIO}`, mensaje: 'me mudo' } });
    check('B1', b1.statusCode === 201 && /^BAJA-[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}$/.test(b1.body && b1.body.codigo), `201 con un código BAJA-XXXX-XXXX (${b1.statusCode} ${b1.body && b1.body.codigo})`);
    const guardada = b1.body && await prisma.bajaServicio.findUnique({ where: { codigo: b1.body.codigo } });
    check('B2', guardada && guardada.nombre === `${MARCA} Ana Ejemplo` && guardada.email === `ana${DOMINIO}` && guardada.mensaje === 'me mudo' && guardada.atendidaAt === null, 'el pedido queda guardado con lo que escribió, sin atender');
    check('B3', b1.body && !('nombre' in b1.body) && !('email' in b1.body) && !('id' in b1.body), 'la respuesta trae el código y la fecha, no los datos ni el id');
    const b2 = await call(controller.crear, { body: { nombre: `${MARCA} Ana Ejemplo`, email: `ana${DOMINIO}` } });
    check('B4', b2.statusCode === 201 && b2.body.codigo !== b1.body.codigo, 'el mismo pedido dos veces da dos códigos distintos (cada pedido tiene el suyo)');
    const codigos = new Set(Array.from({ length: 300 }, () => service.generarCodigo()));
    check('B5', codigos.size === 300, 'trescientos códigos seguidos, ninguno repetido');
    const conteoAntesInvalido = await prisma.bajaServicio.count();
    const b6 = await call(controller.crear, { body: { nombre: `${MARCA} <i>x</i>`, email: `mal${DOMINIO}` } });
    const conteoDespuesInvalido = await prisma.bajaServicio.count();
    check('B6', b6.statusCode === 400 && b6.body.code === 'BAJA_DATOS_INVALIDOS' && b6.body.campos && b6.body.campos.nombre, `inválido: 400 con el campo que falla (${b6.statusCode} ${b6.body && b6.body.code})`);
    check('B7', conteoDespuesInvalido === conteoAntesInvalido, 'inválido: no se guarda nada');
    check('B8', conteoAntesInvalido === antes + 2, 'control: los dos válidos sí se guardaron');
    const b9 = await call(controller.crear, { body: null });
    check('B9', b9.statusCode === 400, 'sin cuerpo: 400, no 500');

    // ── C · Los avisos ───────────────────────────────────────────────────────
    console.log('C · los avisos');
    await esperar(50); // los avisos de B corren en segundo plano: que terminen antes de mirar
    mails.persona.length = 0; mails.coordinacion.length = 0;
    // `ahora` lejos en el futuro: el tope cuenta sólo lo que siembra este test.
    const AHORA = new Date('2099-06-01T12:00:00-03:00');
    const nueva = (n, creada = AHORA) => prisma.bajaServicio.create({ data: {
      codigo: service.generarCodigo(), nombre: `${MARCA} Pedido ${n}`, email: `p${n}${DOMINIO}`, mensaje: `comentario ${n}`, createdAt: creada,
    } });

    process.env[AVISO_ENV] = 'coordinacion@ejemplo.test, otra@ejemplo.test';
    const c1 = await nueva(1);
    const r1 = await service.avisar(c1, { ahora: AHORA });
    const despues1 = await prisma.bajaServicio.findUnique({ where: { id: c1.id } });
    check('C1', r1.persona === 'enviado' && mails.persona.length === 1 && mails.persona[0].email === `p1${DOMINIO}` && mails.persona[0].codigo === c1.codigo, 'a la persona le llega su código');
    check('C2', mails.persona[0] && Object.keys(mails.persona[0]).sort().join(',') === 'codigo,email', 'a la persona NO le llega nada de lo que escribió (ni nombre ni comentario)');
    const htmlPersona = brevo._buildHtmlBajaRecibidaForTest({ codigo: c1.codigo });
    check('C3', htmlPersona.includes(c1.codigo) && !htmlPersona.includes('Pedido 1') && /no lo pediste/i.test(htmlPersona), 'el mail de la persona: el código y qué hacer si no lo pidió ella');
    check('C4', r1.coordinacion === 'enviado' && mails.coordinacion.length === 1 && mails.coordinacion[0].destinatarios.join(',') === 'coordinacion@ejemplo.test,otra@ejemplo.test', 'a la coordinación le llega el aviso, a cada dirección de la variable');
    const htmlCoord = brevo._buildHtmlAvisoBajaForTest({ baja: { ...c1, nombre: '<img src=x onerror=alert(1)>', mensaje: 'a & b' } });
    check('C5', htmlCoord.includes(c1.codigo) && htmlCoord.includes(`p1${DOMINIO}`) && !htmlCoord.includes('<img src=x') && htmlCoord.includes('&lt;img') && htmlCoord.includes('a &amp; b'), 'el aviso a la coordinación trae el pedido entero, escapado');
    check('C6', despues1.confirmacionEnviadaAt && despues1.avisoEnviadoAt, 'los dos mails quedan marcados como enviados');

    delete process.env[AVISO_ENV];
    mails.persona.length = 0; mails.coordinacion.length = 0;
    const c2 = await nueva(2);
    const r2 = await service.avisar(c2, { ahora: AHORA });
    const despues2 = await prisma.bajaServicio.findUnique({ where: { id: c2.id } });
    check('C7', r2.coordinacion === 'sin-destino' && mails.coordinacion.length === 0 && despues2.avisoEnviadoAt === null, 'sin BAJAS_AVISO_EMAIL no hay aviso a la coordinación (y no se marca)');
    check('C8', r2.persona === 'enviado' && mails.persona.length === 1, 'sin la variable, a la persona le llega igual');

    process.env[AVISO_ENV] = 'coordinacion@ejemplo.test';
    brevoCae = true;
    const c3 = await nueva(3);
    let r3; let tiro = null;
    try { r3 = await service.avisar(c3, { ahora: AHORA }); } catch (e) { tiro = e; }
    brevoCae = false;
    const despues3 = await prisma.bajaServicio.findUnique({ where: { id: c3.id } });
    check('C9', !tiro && r3.persona === 'fallo' && r3.coordinacion === 'fallo', 'si Brevo cae, avisar no tira: dice que falló');
    check('C10', despues3 && despues3.confirmacionEnviadaAt === null && despues3.avisoEnviadoAt === null, 'y el pedido sigue guardado, sin marcas');

    // El tope: con TOPE pedidos en las últimas 24 h, ningún mail más.
    const TOPE = service.TOPE_PEDIDOS_DIA;
    check('C11', Number.isInteger(TOPE) && TOPE >= 5 && TOPE <= 50, `hay un tope diario razonable (${TOPE})`);
    const yaHay = await prisma.bajaServicio.count({ where: { createdAt: { gt: new Date(AHORA.getTime() - 24 * 3600 * 1000), lte: AHORA } } });
    for (let i = yaHay; i < TOPE; i += 1) await nueva(100 + i);
    mails.persona.length = 0; mails.coordinacion.length = 0;
    const cTope = await nueva(999, new Date(AHORA.getTime() + 1000));
    const rTope = await service.avisar(cTope, { ahora: new Date(AHORA.getTime() + 1000) });
    check('C12', rTope.persona === 'omitido' && rTope.coordinacion === 'omitido' && mails.persona.length === 0 && mails.coordinacion.length === 0, `pasado el tope (${TOPE} en 24 h) no sale ningún mail`);
    // Control: el mismo pedido, un día y un poco después, cuando los de antes ya salieron de la ventana.
    const unDiaDespues = new Date(AHORA.getTime() + 25 * 3600 * 1000);
    const rCtrl = await service.avisar(cTope, { ahora: unDiaDespues });
    check('C13', rCtrl.persona === 'enviado' && mails.persona.length === 1, 'control: fuera de la ventana de 24 h, el mail sale');

    // ── D · El panel ─────────────────────────────────────────────────────────
    console.log('D · el panel');
    const lista = await call(controller.adminListar);
    const enLista = lista.body && lista.body.bajas && lista.body.bajas.find((x) => x.codigo === b1.body.codigo);
    check('D1', lista.statusCode === 200 && enLista && enLista.nombre && enLista.email && 'mensaje' in enLista && 'avisoEnviadoAt' in enLista, 'lista los pedidos con lo que hace falta para atenderlos');
    const id = enLista && enLista.id;
    const d2 = await call(controller.adminMarcar, { params: { id: String(id) }, body: { atendida: true } });
    const marcada = await prisma.bajaServicio.findUnique({ where: { id } });
    check('D2', d2.statusCode === 200 && marcada.atendidaAt && marcada.atendidaPor === 'panel@ejemplo.test', 'marcar como hecha guarda cuándo y quién');
    const d3 = await call(controller.adminMarcar, { params: { id: String(id) }, body: { atendida: false } });
    const desmarcada = await prisma.bajaServicio.findUnique({ where: { id } });
    check('D3', d3.statusCode === 200 && desmarcada.atendidaAt === null && desmarcada.atendidaPor === '', 'se puede desmarcar (un clic de más no queda)');
    const d4 = await call(controller.adminMarcar, { params: { id: '999999999' }, body: { atendida: true } });
    const d5 = await call(controller.adminMarcar, { params: { id: String(id) }, body: { atendida: 'sí' } });
    check('D4', d4.statusCode === 404 && d5.statusCode === 400, 'un id que no existe da 404; un valor que no es sí/no, 400');

    // ── E · Las páginas ──────────────────────────────────────────────────────
    console.log('E · las páginas');
    process.env[SALIDA_ENV] = '2099-01-01T00:00:00-03:00';
    const eAntes = await call(controller.pagina);
    process.env[SALIDA_ENV] = '2000-01-01T00:00:00-03:00';
    const eDespues = await call(controller.pagina);
    check('E1', eAntes.archivo && eAntes.archivo.endsWith(path.join('public', 'baja.html')) && fs.existsSync(eAntes.archivo), '/baja sirve public/baja.html');
    check('E2', /noindex/.test(eAntes.headers['X-Robots-Tag'] || '') && !eDespues.headers['X-Robots-Tag'], 'noindex antes de la salida y no después (control: la misma página, otra hora)');
    const htmlBaja = fs.readFileSync(path.join(PUBLIC, 'baja.html'), 'utf8');
    check('E3', /<form[^>]*id="baja-form"/.test(htmlBaja) && /autocomplete="name"/.test(htmlBaja) && /type="email"[^>]*autocomplete="email"|autocomplete="email"[^>]*type="email"/.test(htmlBaja), 'el formulario: nombre y mail con autocomplete y el tipo correcto');
    check('E4', /Botón de baja de servicio/.test(htmlBaja) && !/password|contraseña|iniciar sesión/i.test(htmlBaja), 'se llama como pide la norma y no pide registrarse');
    check('E5', /25\.326/.test(htmlBaja) && /Agencia de Acceso a la Información Pública/i.test(htmlBaja), 'el aviso de datos (Ley 25.326) está en la página');
    const linkBaja = /<a[^>]*href="\/baja"[^>]*>Botón de baja de servicio<\/a>/;
    for (const [n, archivo] of [['E6', 'afiliate.html'], ['E7', 'afiliate-gracias.html'], ['E8', path.join('afiliados', 'index.html')]]) {
      const html = fs.readFileSync(path.join(PUBLIC, archivo), 'utf8');
      const pie = (html.match(/<footer[\s\S]*?<\/footer>/) || [''])[0];
      check(n, linkBaja.test(pie), `al pie de ${archivo}: el link «Botón de baja de servicio» a /baja`);
    }
    const afiliate = fs.readFileSync(path.join(PUBLIC, 'afiliate.html'), 'utf8');
    const pieAfiliate = (afiliate.match(/<footer[\s\S]*?<\/footer>/) || [''])[0];
    check('E9', !/Darte de baja/.test(pieAfiliate), 'el pie de /afiliate ya no manda la baja al WhatsApp');
    const portada = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
    const piePortada = (portada.match(/<footer[\s\S]*?<\/footer>/) || [''])[0];
    const contenedor = (piePortada.match(/<[a-z]+[^>]*id="pie-baja"[^>]*>/) || [''])[0];
    check('E10', linkBaja.test(piePortada) && /\bhidden\b/.test(contenedor), 'al pie de la portada, el link está y viene oculto (lo muestra la salida)');
    const appJs = fs.readFileSync(path.join(PUBLIC, 'assets/js/app.js'), 'utf8');
    const rama = (appJs.match(/function aplicarAfiliaciones[\s\S]*?\n}\n/) || [''])[0];
    const ramaAbierta = rama.split(/\n\s*return;\n/)[0];
    check('E11', /getElementById\('pie-baja'\)[\s\S]*?\.hidden\s*=\s*false/.test(ramaAbierta) && !/pie-baja/.test(rama.split(/\n\s*return;\n/)[1] || ''), 'app.js lo muestra en la rama de afiliaciones abiertas (y sólo ahí)');
  } finally {
    if (envSalida === undefined) delete process.env[SALIDA_ENV]; else process.env[SALIDA_ENV] = envSalida;
    if (envAviso === undefined) delete process.env[AVISO_ENV]; else process.env[AVISO_ENV] = envAviso;
    await limpiar();
  }
}

main()
  .catch((e) => { fail += 1; console.error('💥', e); })
  .finally(async () => {
    await prisma.$disconnect();
    console.log(`\n${fail === 0 ? '✅' : '❌'} baja-servicio: ${pass} ok, ${fail} con falla`);
    process.exit(fail === 0 && pass > 0 ? 0 : 1);
  });
