/**
 * Tests de integración — export CSV de compradores (ítem 42, S5).
 *
 * Cubre las tres cosas que pueden salir mal sin que nadie se entere:
 *
 *   1. Que el CSV traiga MENOS filas de las que hay. El listado pagina de a 20
 *      y topea en 200 con búsqueda; un export que arrastrara ese límite bajaría
 *      un archivo que parece completo. El fixture tiene 25 compras aprobadas a
 *      propósito: más que la página del listado, para que un export paginado no
 *      pueda pasar este check por casualidad.
 *   2. Que el CSV traiga OTRAS filas que la pantalla. Los filtros salen de
 *      `construirFiltroCompras`, compartida con `adminListar`, y hay un check
 *      que compara los dos endpoints fila por fila.
 *   3. Que la planilla ejecute lo que escribió un comprador (CSV injection) o
 *      que la plata de Casa Metro se lea como plata del SAB.
 *
 * Los checks entran por el HANDLER, que es por donde entra el request — no por
 * el serializador puro. Es el hallazgo de R1: un check unitario puede probar la
 * regla correcta por una capa a la que el usuario nunca llega.
 *
 * Uso local (con dev.db):
 *   node tests/integration/compras-export.test.js
 *
 * Exit codes: 0 = PASS, 1 = FAIL
 */

const prisma = require('../../src/utils/prisma');
const controller = require('../../src/controllers/compras.controller');
const { SEPARADOR, BOM } = require('../../src/utils/csv');

const TEST_PREFIX = 'compras-export-test-';

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    send(payload) { this.body = payload; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
  };
}

async function call(handler, query) {
  const res = mockRes();
  await handler({ query }, res);
  return res;
}

/** Parsea el CSV respetando comillas, para poder afirmar sobre celdas y no sobre substrings. */
function parsearCSV(texto) {
  const sinBom = texto.startsWith(BOM) ? texto.slice(BOM.length) : texto;
  const filas = [];
  let fila = [];
  let campo = '';
  let enComillas = false;
  for (let i = 0; i < sinBom.length; i++) {
    const ch = sinBom[i];
    if (enComillas) {
      if (ch === '"' && sinBom[i + 1] === '"') { campo += '"'; i++; }
      else if (ch === '"') enComillas = false;
      else campo += ch;
    } else if (ch === '"') enComillas = true;
    else if (ch === SEPARADOR) { fila.push(campo); campo = ''; }
    else if (ch === '\r' && sinBom[i + 1] === '\n') {
      fila.push(campo); filas.push(fila); fila = []; campo = ''; i++;
    } else campo += ch;
  }
  if (campo !== '' || fila.length) { fila.push(campo); filas.push(fila); }
  return filas;
}

async function cleanup() {
  const eventos = await prisma.evento.findMany({
    where: { nombre: { startsWith: TEST_PREFIX } },
    select: { id: true },
  });
  const eventoIds = eventos.map((e) => e.id);
  if (!eventoIds.length) return;

  const compras = await prisma.compra.findMany({
    where: { eventoId: { in: eventoIds } },
    select: { id: true },
  });
  const compraIds = compras.map((c) => c.id);

  await prisma.entrada.deleteMany({ where: { compraId: { in: compraIds } } });
  await prisma.compra.deleteMany({ where: { id: { in: compraIds } } });
  await prisma.tanda.deleteMany({ where: { eventoId: { in: eventoIds } } });
  await prisma.evento.deleteMany({ where: { id: { in: eventoIds } } });
}

async function setupFixture() {
  const evento = await prisma.evento.create({
    data: {
      nombre: `${TEST_PREFIX}${Date.now()}`,
      descripcion: 'test',
      fecha: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      hora: '21:00',
      estaPublicado: true,
      menuHabilitado: true,
      tandas: { create: [{ nombre: 'Tanda 1', precio: 15000, orden: 1, activa: true }] },
    },
    include: { tandas: true },
  });

  const base = (o) => ({
    eventoId: evento.id,
    tandaId: evento.tandas[0].id,
    cantidadEntradas: 1,
    precioUnitario: 15000,
    totalPagado: 15000,
    mpEstado: 'approved',
    telefono: '',
    ...o,
  });

  // 22 de relleno: con las 3 con nombre propio suman 25 aprobadas, MÁS que la
  // página de 20 del listado. Si el export
  // reusara la paginación, este fixture lo delata.
  const relleno = [];
  for (let i = 0; i < 22; i++) {
    relleno.push(await prisma.compra.create({
      data: base({
        nombre: `Relleno${i}`,
        apellido: `Relleno${String(i).padStart(2, '0')}`,
        email: `relleno${i}@test.com`,
      }),
    }));
  }

  // Compra CON MENÚ: el desglose de la plata se verifica contra esta.
  // 2 entradas × 15000 + 3 menús × 8000 = 54000, de los cuales 24000 son de
  // Casa Metro y 30000 del SAB.
  const conMenu = await prisma.compra.create({
    data: base({
      nombre: 'Uriel', apellido: 'Conmenu', email: 'conmenu@test.com',
      telefono: '+5492211234567',
      cantidadEntradas: 2, cantidadMenus: 3, menuUnitario: 8000,
      totalPagado: 54000,
    }),
  });

  // Compra de las 22:30 de un SÁBADO hora argentina, que en UTC es la 01:30 del
  // DOMINGO. Es un fixture sintético a propósito: sin él, el check de la fecha
  // solo se pondría en rojo si la suite corriera entre las 21:00 y las 00:00
  // ART — o sea que casi siempre pasaría con el offset roto. El día tiene que
  // ser distinto en ART y en UTC para que el check pruebe algo.
  const nocturna = await prisma.compra.create({
    data: base({
      nombre: 'Nora', apellido: 'Nocturna', email: 'nocturna@test.com',
      createdAt: new Date('2026-08-16T01:30:00.000Z'),
    }),
  });

  // Comprador hostil: el nombre es una fórmula de Excel y el apellido tiene el
  // separador adentro. Los dos vienen de un formulario público.
  const hostil = await prisma.compra.create({
    data: base({
      nombre: '=1+1',
      apellido: 'Aatacante; con separador',
      email: 'hostil@test.com',
      telefono: '@SUM(A1:A9)',
    }),
  });

  // Estados no aprobados: cada uno prueba una rama del toggle.
  const pendiente = await prisma.compra.create({
    data: base({ nombre: 'Pedro', apellido: 'Pendiente', email: 'pendiente@test.com', mpEstado: 'pending' }),
  });
  const devuelta = await prisma.compra.create({
    data: base({ nombre: 'Dolores', apellido: 'Devuelta', email: 'devuelta@test.com', mpEstado: 'refunded' }),
  });
  const rechazada = await prisma.compra.create({
    data: base({ nombre: 'Raul', apellido: 'Rechazada', email: 'rechazada@test.com', mpEstado: 'rejected' }),
  });

  // Entradas: la de `conMenu` tiene 2 (1 validada), la hostil 1 sin validar.
  const t = Date.now();
  await prisma.entrada.createMany({
    data: [
      { compraId: conMenu.id, codigoQR: `qr-cm-1-${t}`, qrImageUrl: '', validada: true, validadaAt: new Date() },
      { compraId: conMenu.id, codigoQR: `qr-cm-2-${t}`, qrImageUrl: '', validada: false },
      { compraId: hostil.id, codigoQR: `qr-h-1-${t}`, qrImageUrl: '', validada: false },
    ],
  });

  return { evento, relleno, conMenu, hostil, nocturna, pendiente, devuelta, rechazada };
}

async function main() {
  await cleanup();
  const checks = [];

  try {
    const fx = await setupFixture();
    const { evento } = fx;
    const COL = {}; // nombre de columna → índice, resuelto del encabezado real

    // ────────────────────────────────────────────────────────────────
    // 1) Default: solo aprobadas, con el conjunto COMPLETO
    // ────────────────────────────────────────────────────────────────
    const r1 = await call(controller.adminExportar, { eventoId: evento.id });
    const csv1 = parsearCSV(r1.body || '');
    (csv1[0] || []).forEach((h, i) => { COL[h] = i; });
    // El CSV termina con un pie de 3 filas (vacía + TOTALES + procedencia), que
    // NO son compras. Todo lo que mide compras tiene que descontarlo, y el pie
    // se verifica aparte más abajo.
    const sinPie = (filas) => {
      const i = filas.findIndex((f) => String(f[0] || '').startsWith('TOTALES'));
      return i === -1 ? filas : filas.slice(0, Math.max(0, i - 1));
    };
    const pieDe = (filas) => {
      const i = filas.findIndex((f) => String(f[0] || '').startsWith('TOTALES'));
      return i === -1 ? { totales: null, origen: null } : { totales: filas[i], origen: filas[i + 1] || null };
    };

    const cuerpo1 = sinPie(csv1.slice(1));

    // 22 de relleno + conMenu + hostil + nocturna = 25 aprobadas. Las 3 no aprobadas, fuera.
    checks.push({
      name: '🎯 Trae el conjunto COMPLETO, no la página de 20 del listado (25 filas aprobadas)',
      pass: cuerpo1.length === 25,
      detail: `filas=${cuerpo1.length} esperaba=25`,
    });

    const estados1 = new Set(cuerpo1.map((f) => f[COL['Estado']]));
    checks.push({
      name: 'Default (sin `estados`) → solo aprobadas: sin pendientes, devueltas ni rechazadas',
      pass: estados1.size === 1 && estados1.has('Aprobada'),
      detail: `estados=${JSON.stringify([...estados1])}`,
    });

    checks.push({
      name: 'Arranca con BOM UTF-8 (sin él, Excel abre "Martín" como "MartÃ­n")',
      pass: typeof r1.body === 'string' && r1.body.startsWith(BOM),
      detail: `primerCodigo=U+${(r1.body || ' ').codePointAt(0).toString(16).toUpperCase()}`,
    });

    checks.push({
      name: 'Content-Disposition: attachment con nombre fechado y .csv',
      pass: /^attachment; filename=".*\.csv"$/.test(r1.headers['content-disposition'] || '') &&
            /\d{8}/.test(r1.headers['content-disposition'] || ''),
      detail: `header=${r1.headers['content-disposition']}`,
    });

    checks.push({
      name: 'Content-Type text/csv; charset=utf-8',
      pass: (r1.headers['content-type'] || '').includes('text/csv'),
      detail: `header=${r1.headers['content-type']}`,
    });

    // ────────────────────────────────────────────────────────────────
    // 2) Orden alfabético con criterio humano, el mismo de la pantalla
    // ────────────────────────────────────────────────────────────────
    const apellidos1 = cuerpo1.map((f) => f[COL['Apellido']]);
    const ordenados = [...apellidos1].sort((a, b) => a.localeCompare(b, 'es', { sensitivity: 'base' }));
    checks.push({
      name: 'Sale alfabético por apellido (mismo criterio que la pantalla y la hoja de cocina)',
      pass: JSON.stringify(apellidos1) === JSON.stringify(ordenados),
      detail: `primeros=${JSON.stringify(apellidos1.slice(0, 3))}`,
    });

    // ────────────────────────────────────────────────────────────────
    // 3) CSV injection: lo que escribió el comprador no se ejecuta
    // ────────────────────────────────────────────────────────────────
    const filaHostil = cuerpo1.find((f) => f[COL['Email']] === 'hostil@test.com');
    checks.push({
      name: '🔒 El nombre "=1+1" viaja neutralizado (Excel lo mostraría como 2 si no)',
      pass: !!filaHostil && filaHostil[COL['Nombre']] === "'=1+1",
      detail: `nombre=${JSON.stringify(filaHostil && filaHostil[COL['Nombre']])}`,
    });
    checks.push({
      name: '🔒 El teléfono "@SUM(A1:A9)" viaja neutralizado',
      pass: !!filaHostil && filaHostil[COL['Teléfono']] === "'@SUM(A1:A9)",
      detail: `telefono=${JSON.stringify(filaHostil && filaHostil[COL['Teléfono']])}`,
    });
    checks.push({
      name: 'Un apellido con ";" adentro no parte la fila en dos columnas',
      pass: !!filaHostil && filaHostil[COL['Apellido']] === 'Aatacante; con separador' &&
            filaHostil.length === csv1[0].length,
      detail: `apellido=${JSON.stringify(filaHostil && filaHostil[COL['Apellido']])} columnas=${filaHostil && filaHostil.length}/${csv1[0].length}`,
    });

    // ────────────────────────────────────────────────────────────────
    // 4) La plata de Casa Metro, separada de la del SAB (eje E3)
    // ────────────────────────────────────────────────────────────────
    const filaMenu = cuerpo1.find((f) => f[COL['Email']] === 'conmenu@test.com');
    const okPlata = !!filaMenu &&
      filaMenu[COL['Menús']] === '3' &&
      filaMenu[COL['Precio unitario menú']] === '8000' &&
      filaMenu[COL['Total menús (Casa Metro)']] === '24000' &&
      filaMenu[COL['Total SAB']] === '30000' &&
      filaMenu[COL['Total pagado']] === '54000';
    checks.push({
      name: '🎯 La plata sale desglosada: 3 menús × $8.000 = $24.000 de Casa Metro y $30.000 del SAB, sobre $54.000 pagados',
      pass: okPlata,
      detail: filaMenu
        ? `menus=${filaMenu[COL['Menús']]} unit=${filaMenu[COL['Precio unitario menú']]} casaMetro=${filaMenu[COL['Total menús (Casa Metro)']]} sab=${filaMenu[COL['Total SAB']]} total=${filaMenu[COL['Total pagado']]}`
        : 'fila no encontrada',
    });
    checks.push({
      name: 'El precio del menú sale de `menuUnitario` congelado en la compra, no del precio global de hoy',
      pass: !!filaMenu && filaMenu[COL['Precio unitario menú']] === '8000',
      detail: `unitario=${filaMenu && filaMenu[COL['Precio unitario menú']]} (Home.precioMenu de hoy es otro)`,
    });
    // Invariante contable de toda fila: SAB + Casa Metro === total pagado.
    const cuadranTodas = cuerpo1.every(
      (f) => Number(f[COL['Total SAB']]) + Number(f[COL['Total menús (Casa Metro)']]) === Number(f[COL['Total pagado']])
    );
    checks.push({
      name: 'En TODAS las filas: Total SAB + Total menús === Total pagado',
      pass: cuadranTodas,
      detail: `filas verificadas=${cuerpo1.length}`,
    });

    // ────────────────────────────────────────────────────────────────
    // 5) Columnas restantes con dato real
    // ────────────────────────────────────────────────────────────────
    // Candado de la decisión del recorrido (sesión V, 20/8): la planilla NO
    // lleva los códigos de las entradas. Va como check y no como comentario
    // porque el dato es fácil de "devolver" sin querer: el include de Prisma
    // sigue trayendo las entradas para el contador "1/2", así que agregar la
    // columna de vuelta es una línea. Si alguien la agrega, esto se pone rojo.
    const cabecerasQR = Object.keys(COL).filter((c) => /qr|código|codigo/i.test(c));
    checks.push({
      name: 'La planilla NO expone los códigos QR de las entradas (viaja por WhatsApp)',
      pass: cabecerasQR.length === 0
        && !cuerpo1.some((f) => f.some((celda) => /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(String(celda)))),
      detail: `cabeceras sospechosas=${JSON.stringify(cabecerasQR)}`,
    });
    // ── El pie de la planilla (hallazgos 🟡 del recorrido de la sesión V) ──
    const pie1 = pieDe(csv1.slice(1));
    const sumaCol = (idx) => cuerpo1.reduce((a, f) => a + (Number(f[idx]) || 0), 0);
    checks.push({
      name: 'La planilla cierra con una fila TOTALES y sus sumas cuadran con el cuerpo',
      pass: !!pie1.totales
        && Number(pie1.totales[COL['Total pagado']]) === sumaCol(COL['Total pagado'])
        && Number(pie1.totales[COL['Total SAB']]) === sumaCol(COL['Total SAB'])
        && Number(pie1.totales[COL['Total menús (Casa Metro)']]) === sumaCol(COL['Total menús (Casa Metro)'])
        && Number(pie1.totales[COL['Entradas']]) === sumaCol(COL['Entradas']),
      detail: pie1.totales ? `totales=${JSON.stringify([pie1.totales[COL['Entradas']], pie1.totales[COL['Total pagado']]])}` : 'sin fila TOTALES',
    });
    checks.push({
      name: 'La planilla dice de quién es, de qué evento y qué recorte trae',
      pass: !!pie1.origen && /Sindicato Argentino de Boleros/.test(pie1.origen[0]) && /aprobadas|estados/.test(pie1.origen[0]),
      detail: pie1.origen ? String(pie1.origen[0]).slice(0, 90) : 'sin fila de procedencia',
    });
    checks.push({
      name: 'El encabezado sigue siendo la PRIMERA fila (abre en columnas de doble clic)',
      pass: csv1[0][0] === 'Apellido' && csv1[0][csv1[0].length - 1] === 'ID',
      detail: `primera=${csv1[0][0]} última=${csv1[0][csv1[0].length - 1]}`,
    });

    checks.push({
      name: 'Entradas validadas se lee "1/2" (la compra con menú tiene 1 de 2 validadas)',
      pass: !!filaMenu && filaMenu[COL['Entradas validadas']] === '1/2',
      detail: `validadas=${filaMenu && filaMenu[COL['Entradas validadas']]}`,
    });
    checks.push({
      name: 'La fecha sale en hora de Argentina, formato DD/MM/AAAA HH:MM',
      pass: !!filaMenu && /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/.test(filaMenu[COL['Fecha de compra']]),
      detail: `fecha=${filaMenu && filaMenu[COL['Fecha de compra']]}`,
    });

    // La compra nocturna: guardada 2026-08-16T01:30Z (domingo en UTC), tiene que
    // leerse "15/08/2026 22:30" — sábado a la noche, que es cuando la persona
    // efectivamente compró y el día en que la administración la va a buscar.
    // El valor está escrito literal a propósito: si se derivara con la misma
    // resta que hace el código, el check pasaría también con el código roto.
    const filaNocturna = cuerpo1.find((f) => f[COL['Email']] === 'nocturna@test.com');
    checks.push({
      name: '🎯 La fecha NO sale corrida por UTC: la compra de las 22:30 del sábado no aparece el domingo',
      pass: !!filaNocturna && filaNocturna[COL['Fecha de compra']] === '15/08/2026 22:30',
      detail: `csv=${filaNocturna && filaNocturna[COL['Fecha de compra']]} esperaba="15/08/2026 22:30"`,
    });

    // ────────────────────────────────────────────────────────────────
    // 6) El toggle de estados
    // ────────────────────────────────────────────────────────────────
    const r6 = await call(controller.adminExportar, { eventoId: evento.id, estados: 'todas' });
    const cuerpo6 = sinPie(parsearCSV(r6.body || '').slice(1));
    const estados6 = new Set(cuerpo6.map((f) => f[COL['Estado']]));
    checks.push({
      name: 'estados=todas → suma pendientes, devueltas y rechazadas (28 filas)',
      pass: cuerpo6.length === 28 && estados6.has('Pendiente') && estados6.has('Devuelta') && estados6.has('Rechazada'),
      detail: `filas=${cuerpo6.length} estados=${JSON.stringify([...estados6].sort())}`,
    });

    // Una devolución tiene que ser legible como tal en la planilla: 'refunded'
    // no le dice nada a quien lleva la contabilidad.
    checks.push({
      name: 'Los estados salen en castellano ("Devuelta", no "refunded")',
      pass: !estados6.has('refunded') && estados6.has('Devuelta'),
      detail: `estados=${JSON.stringify([...estados6].sort())}`,
    });

    // ────────────────────────────────────────────────────────────────
    // 7) El filtro explícito de pantalla GANA sobre el default
    // ────────────────────────────────────────────────────────────────
    const r7 = await call(controller.adminExportar, { eventoId: evento.id, mpEstado: 'pending' });
    const cuerpo7 = sinPie(parsearCSV(r7.body || '').slice(1));
    checks.push({
      name: '🎯 mpEstado=pending en pantalla GANA sobre el default de aprobadas (1 fila, Pendiente)',
      pass: cuerpo7.length === 1 && cuerpo7[0][COL['Estado']] === 'Pendiente',
      detail: `filas=${cuerpo7.length} estado=${cuerpo7[0] && cuerpo7[0][COL['Estado']]}`,
    });

    // ────────────────────────────────────────────────────────────────
    // 8) Mismo conjunto que la pantalla — el check que ata los dos endpoints
    // ────────────────────────────────────────────────────────────────
    const rListado = await call(controller.adminListar, { eventoId: evento.id, q: 'relleno' });
    const rExport = await call(controller.adminExportar, { eventoId: evento.id, q: 'relleno', estados: 'todas' });
    const idsListado = (rListado.body?.compras || []).map((c) => String(c.id)).sort();
    const idsExport = sinPie(parsearCSV(rExport.body || '').slice(1)).map((f) => f[COL['ID']]).sort();
    checks.push({
      name: '🎯 Con la MISMA búsqueda, el CSV y el listado devuelven exactamente las mismas compras',
      pass: idsListado.length === 22 && JSON.stringify(idsListado) === JSON.stringify(idsExport),
      detail: `listado=${idsListado.length} export=${idsExport.length} iguales=${JSON.stringify(idsListado) === JSON.stringify(idsExport)}`,
    });

    const rVal = await call(controller.adminExportar, { eventoId: evento.id, validacion: 'pendiente' });
    const cuerpoVal = sinPie(parsearCSV(rVal.body || '').slice(1));
    checks.push({
      name: 'validacion=pendiente → solo las aprobadas con alguna entrada sin validar (conMenu + hostil)',
      pass: cuerpoVal.length === 2 &&
            cuerpoVal.every((f) => f[COL['Estado']] === 'Aprobada'),
      detail: `filas=${cuerpoVal.length} apellidos=${JSON.stringify(cuerpoVal.map((f) => f[COL['Apellido']]))}`,
    });

    // ────────────────────────────────────────────────────────────────
    // 9) PII: sin evento no hay volcado de la base entera
    // ────────────────────────────────────────────────────────────────
    const r9 = await call(controller.adminExportar, {});
    checks.push({
      name: '🔒 Sin eventoId → 400. El endpoint no puede volcar la PII de toda la base en un clic',
      pass: r9.statusCode === 400,
      detail: `status=${r9.statusCode} body=${JSON.stringify(r9.body)}`,
    });
    const r9b = await call(controller.adminExportar, { eventoId: 99999999 });
    checks.push({
      name: 'Evento inexistente → 404',
      pass: r9b.statusCode === 404,
      detail: `status=${r9b.statusCode}`,
    });

    // ────────────────────────────────────────────────────────────────
    // REPORT
    // ────────────────────────────────────────────────────────────────
    console.log('─'.repeat(72));
    console.log('Compras adminExportar — Export CSV de compradores (ítem 42)');
    console.log('─'.repeat(72));
    for (const c of checks) {
      console.log(`${c.pass ? '✅' : '❌'} ${c.name}`);
      console.log(`   ${c.detail}`);
    }
    console.log('─'.repeat(72));

    const failed = checks.filter((c) => !c.pass);
    if (failed.length > 0) {
      console.log(`\n❌ FAIL — ${failed.length}/${checks.length} checks fallaron`);
      process.exitCode = 1;
    } else {
      console.log(`\n✅ PASS — ${checks.length}/${checks.length} checks OK`);
      process.exitCode = 0;
    }
  } catch (err) {
    console.error('❌ ERROR INESPERADO:', err.message);
    console.error(err.stack);
    process.exitCode = 1;
  } finally {
    try { await cleanup(); } catch (e) { console.error('WARN cleanup:', e.message); }
    await prisma.$disconnect();
    process.exit(process.exitCode || 0);
  }
}

main();
