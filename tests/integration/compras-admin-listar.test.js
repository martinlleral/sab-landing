/**
 * Tests de integración — adminListar (compras.controller).
 *
 * Cubre los query params de filtrado y orden:
 *   - q (búsqueda por nombre/apellido/email)
 *   - validacion (pendiente / validada / vacío)
 *   - orderBy (nombre default / fecha / id / cantidad / total) + orderDir (asc / desc),
 *     incluida la whitelist: un campo o dirección inválidos caen al default en vez
 *     de llegar crudos al orderBy de Prisma.
 *
 * Uso local (con dev.db):
 *   node tests/integration/compras-admin-listar.test.js
 *
 * Exit codes: 0 = PASS, 1 = FAIL
 */

const prisma = require('../../src/utils/prisma');
const controller = require('../../src/controllers/compras.controller');

const TEST_PREFIX = 'compras-listar-test-';

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

function mockReq({ query = {} } = {}) {
  return { query };
}

async function call(handler, req) {
  const res = mockRes();
  await handler(req, res);
  return res;
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
      tandas: {
        create: [{ nombre: 'Tanda 1', precio: 10000, orden: 1, activa: true }],
      },
    },
    include: { tandas: true },
  });

  const baseCompra = (overrides) => ({
    eventoId: evento.id,
    tandaId: evento.tandas[0].id,
    cantidadEntradas: 2,
    precioUnitario: 10000,
    totalPagado: 20000,
    mpEstado: 'approved',
    ...overrides,
  });

  // 3 compras approved con apellidos en orden inverso (Zorrilla, Martinez, Acosta)
  // para verificar que el sort A-Z reordena.
  //
  // `cantidadEntradas` y `totalPagado` son DISTINTOS en las 4 compras a propósito:
  // sin eso no se puede afirmar nada sobre orderBy=cantidad|total. El orden por
  // cantidad (1 < 2 < 3 < 5) es además distinto del alfabético y del de creación,
  // así que un check que pase no puede estar pasando por casualidad.
  const compraZ = await prisma.compra.create({
    data: baseCompra({
      nombre: 'Zoe', apellido: 'Zorrilla', email: 'zoe@test.com',
      cantidadEntradas: 2, totalPagado: 20000,
    }),
  });
  const compraM = await prisma.compra.create({
    data: baseCompra({
      nombre: 'Mariano', apellido: 'Martinez', email: 'mariano@test.com',
      cantidadEntradas: 5, totalPagado: 50000,
    }),
  });
  const compraA = await prisma.compra.create({
    data: baseCompra({
      nombre: 'Ana', apellido: 'Acosta', email: 'ana@test.com',
      cantidadEntradas: 1, totalPagado: 10000,
    }),
  });

  // 1 compra rejected — debe excluirse del filtro validacion=pendiente/validada.
  const compraR = await prisma.compra.create({
    data: baseCompra({
      nombre: 'Roberto', apellido: 'Rechazado', email: 'rechazado@test.com',
      mpEstado: 'rejected',
      cantidadEntradas: 3, totalPagado: 30000,
    }),
  });

  // Dos apellidos que rompen el orden si se confía en la colación de SQLite:
  // en bytes "BENITEZ" (B=66) va antes que "Acosta" (c=99...) y "duarte" (d=100)
  // se va detrás de "Zorrilla" (Z=90). Con criterio humano van 2º y 4º.
  // En la base real esto afecta a ~9% de los apellidos (58 en mayúsculas, 123
  // en minúscula sobre 1995 compras).
  const compraMayus = await prisma.compra.create({
    data: baseCompra({
      nombre: 'Bruno', apellido: 'BENITEZ', email: 'benitez@test.com',
      cantidadEntradas: 4, totalPagado: 40000,
    }),
  });
  const compraMinus = await prisma.compra.create({
    data: baseCompra({
      nombre: 'delia', apellido: 'duarte', email: 'duarte@test.com',
      cantidadEntradas: 6, totalPagado: 60000,
    }),
  });

  // Entradas — la cantidad de cada compra coincide con su `cantidadEntradas`,
  // como en producción:
  //   compraZ: 2 entradas, ambas validadas → completamente validada
  //   compraM: 5 entradas, 1 validada y 4 sin validar → parcial = pendiente
  //   compraA: 1 entrada, sin validar → pendiente
  await prisma.entrada.createMany({
    data: [
      { compraId: compraZ.id, codigoQR: `qr-z-1-${Date.now()}`, qrImageUrl: '', validada: true,  validadaAt: new Date() },
      { compraId: compraZ.id, codigoQR: `qr-z-2-${Date.now()}`, qrImageUrl: '', validada: true,  validadaAt: new Date() },
      { compraId: compraM.id, codigoQR: `qr-m-1-${Date.now()}`, qrImageUrl: '', validada: true,  validadaAt: new Date() },
      { compraId: compraM.id, codigoQR: `qr-m-2-${Date.now()}`, qrImageUrl: '', validada: false },
      { compraId: compraM.id, codigoQR: `qr-m-3-${Date.now()}`, qrImageUrl: '', validada: false },
      { compraId: compraM.id, codigoQR: `qr-m-4-${Date.now()}`, qrImageUrl: '', validada: false },
      { compraId: compraM.id, codigoQR: `qr-m-5-${Date.now()}`, qrImageUrl: '', validada: false },
      { compraId: compraA.id, codigoQR: `qr-a-1-${Date.now()}`, qrImageUrl: '', validada: false },
    ],
  });

  return { evento, compraA, compraM, compraZ, compraR, compraMayus, compraMinus };
}

async function main() {
  await cleanup();

  const checks = [];

  try {
    const { evento, compraA, compraM, compraZ, compraR, compraMayus, compraMinus } = await setupFixture();

    // 1) Default (sin query): orderBy=nombre A-Z. Se incluyen las 4 compras del
    //    fixture ordenadas Acosta < Martinez < Rechazado < Zorrilla.
    const r1 = await call(controller.adminListar, mockReq({ query: { eventoId: evento.id } }));
    const apellidos = (r1.body?.compras || []).map((c) => c.apellido);
    checks.push({
      name: '🎯 Default → alfabético con criterio HUMANO: "BENITEZ" 2º y "duarte" 3º.\n        Con la colación binaria de SQLite irían 1º y último (compara bytes: B=66 < c=99, d=100 > Z=90)',
      pass: JSON.stringify(apellidos) === JSON.stringify(['Acosta', 'BENITEZ', 'duarte', 'Martinez', 'Rechazado', 'Zorrilla']),
      detail: `apellidos=${JSON.stringify(apellidos)}`,
    });

    // 2) orderBy=fecha → más recientes primero. compraR es la última creada
    //    del fixture → debe venir primera en desc.
    const r2 = await call(controller.adminListar, mockReq({ query: { eventoId: evento.id, orderBy: 'fecha' } }));
    const idsPorFecha = (r2.body?.compras || []).map((c) => c.id);
    checks.push({
      name: 'orderBy=fecha → más recientes primero',
      pass: idsPorFecha[0] === compraMinus.id,
      detail: `ids=${JSON.stringify(idsPorFecha)} esperaba_primero=${compraMinus.id}`,
    });

    // 3) q matchea por apellido (case-insensitive ASCII)
    const r3 = await call(controller.adminListar, mockReq({ query: { eventoId: evento.id, q: 'martinez' } }));
    const r3Apellidos = (r3.body?.compras || []).map((c) => c.apellido);
    checks.push({
      name: 'q="martinez" → matchea "Martinez" (case-insensitive)',
      pass: r3Apellidos.length === 1 && r3Apellidos[0] === 'Martinez',
      detail: `apellidos=${JSON.stringify(r3Apellidos)}`,
    });

    // 4) q matchea por nombre parcial
    const r4 = await call(controller.adminListar, mockReq({ query: { eventoId: evento.id, q: 'Ana' } }));
    const r4Nombres = (r4.body?.compras || []).map((c) => c.nombre);
    checks.push({
      name: 'q="Ana" → matchea por nombre parcial',
      pass: r4Nombres.includes('Ana'),
      detail: `nombres=${JSON.stringify(r4Nombres)}`,
    });

    // 5) q matchea por email
    const r5 = await call(controller.adminListar, mockReq({ query: { eventoId: evento.id, q: 'zoe@test' } }));
    const r5Emails = (r5.body?.compras || []).map((c) => c.email);
    checks.push({
      name: 'q="zoe@test" → matchea por email',
      pass: r5Emails.length === 1 && r5Emails[0] === 'zoe@test.com',
      detail: `emails=${JSON.stringify(r5Emails)}`,
    });

    // 6) validacion=pendiente → solo approved con al menos 1 entrada sin validar
    const r6 = await call(controller.adminListar, mockReq({ query: { eventoId: evento.id, validacion: 'pendiente' } }));
    const r6Apellidos = (r6.body?.compras || []).map((c) => c.apellido).sort();
    checks.push({
      name: 'validacion=pendiente → incluye Acosta (0/1) y Martinez (1/5), excluye Zorrilla (2/2) y Rechazado',
      pass: r6Apellidos.length === 2 && r6Apellidos[0] === 'Acosta' && r6Apellidos[1] === 'Martinez',
      detail: `apellidos=${JSON.stringify(r6Apellidos)}`,
    });

    // 7) validacion=validada → solo approved con todas las entradas validadas
    const r7 = await call(controller.adminListar, mockReq({ query: { eventoId: evento.id, validacion: 'validada' } }));
    const r7Apellidos = (r7.body?.compras || []).map((c) => c.apellido);
    checks.push({
      name: 'validacion=validada → solo Zorrilla (2/2 validadas)',
      pass: r7Apellidos.length === 1 && r7Apellidos[0] === 'Zorrilla',
      detail: `apellidos=${JSON.stringify(r7Apellidos)}`,
    });

    // 8) validacion fuerza mpEstado=approved (excluye rejected)
    const r8 = await call(controller.adminListar, mockReq({ query: { eventoId: evento.id, validacion: 'pendiente' } }));
    const r8Estados = new Set((r8.body?.compras || []).map((c) => c.mpEstado));
    checks.push({
      name: 'validacion=pendiente → todos approved (excluye rejected)',
      pass: r8Estados.size === 1 && r8Estados.has('approved'),
      detail: `estados=${JSON.stringify([...r8Estados])}`,
    });

    // 9) Response incluye `entradas` con id+validada para la pildora UI
    const r9 = await call(controller.adminListar, mockReq({ query: { eventoId: evento.id } }));
    const compraConEntradas = (r9.body?.compras || []).find((c) => c.id === compraM.id);
    const entradas = compraConEntradas?.entradas || [];
    const tieneCamposCorrectos = entradas.length === 5 &&
      entradas.every((e) => typeof e.id === 'number' && typeof e.validada === 'boolean');
    checks.push({
      name: 'Response include entradas {id, validada} para la pildora UI',
      pass: tieneCamposCorrectos,
      detail: `entradas=${JSON.stringify(entradas)}`,
    });

    // 10) q activo → page=1 y totalPages=1 (sin paginación)
    const r10 = await call(controller.adminListar, mockReq({ query: { eventoId: evento.id, q: 'a', page: 5 } }));
    checks.push({
      name: 'q activo → ignora paginación (page=1, totalPages=1)',
      pass: r10.body?.page === 1 && r10.body?.totalPages === 1,
      detail: `page=${r10.body?.page} totalPages=${r10.body?.totalPages}`,
    });

    // ============================================
    // Orden server-side de las 5 columnas ordenables (ítem 40).
    // Antes el backend solo sabía 'nombre' y 'fecha', y el frontend re-ordenaba
    // id/cantidad/total client-side sobre la página visible.
    // ============================================

    // 11) orderBy=total&orderDir=desc → mayor totalPagado primero (Martinez, 50000)
    const r11 = await call(controller.adminListar, mockReq({ query: { eventoId: evento.id, orderBy: 'total', orderDir: 'desc' } }));
    const r11Totales = (r11.body?.compras || []).map((c) => c.totalPagado);
    checks.push({
      name: 'orderBy=total&orderDir=desc → de mayor a menor',
      pass: JSON.stringify(r11Totales) === JSON.stringify([60000, 50000, 40000, 30000, 20000, 10000]),
      detail: `totales=${JSON.stringify(r11Totales)}`,
    });

    // 12) La dirección se respeta: el mismo campo al revés
    const r12 = await call(controller.adminListar, mockReq({ query: { eventoId: evento.id, orderBy: 'total', orderDir: 'asc' } }));
    const r12Totales = (r12.body?.compras || []).map((c) => c.totalPagado);
    checks.push({
      name: 'orderBy=total&orderDir=asc → de menor a mayor (la dirección se respeta)',
      pass: JSON.stringify(r12Totales) === JSON.stringify([10000, 20000, 30000, 40000, 50000, 60000]),
      detail: `totales=${JSON.stringify(r12Totales)}`,
    });

    // 13) orderBy=cantidad → orden distinto del alfabético y del de creación,
    //     así que un pass acá no puede ser casualidad.
    const r13 = await call(controller.adminListar, mockReq({ query: { eventoId: evento.id, orderBy: 'cantidad', orderDir: 'asc' } }));
    const r13Cantidades = (r13.body?.compras || []).map((c) => c.cantidadEntradas);
    checks.push({
      name: 'orderBy=cantidad&orderDir=asc → 1,2,3,4,5,6',
      pass: JSON.stringify(r13Cantidades) === JSON.stringify([1, 2, 3, 4, 5, 6]),
      detail: `cantidades=${JSON.stringify(r13Cantidades)}`,
    });

    // 14) orderBy=id&orderDir=desc → el id más alto primero (compraR, la última creada)
    const r14 = await call(controller.adminListar, mockReq({ query: { eventoId: evento.id, orderBy: 'id', orderDir: 'desc' } }));
    const r14Ids = (r14.body?.compras || []).map((c) => c.id);
    const r14Descendente = r14Ids.every((id, i) => i === 0 || r14Ids[i - 1] > id);
    checks.push({
      name: 'orderBy=id&orderDir=desc → ids descendentes',
      pass: r14Ids[0] === compraMinus.id && r14Descendente,
      detail: `ids=${JSON.stringify(r14Ids)} esperaba_primero=${compraMinus.id}`,
    });

    // 15) Whitelist: un campo que no está en el mapa cae al default (nombre A-Z),
    //     no rompe ni llega crudo al orderBy de Prisma.
    const r15 = await call(controller.adminListar, mockReq({ query: { eventoId: evento.id, orderBy: 'telefono; DROP TABLE' } }));
    const r15Apellidos = (r15.body?.compras || []).map((c) => c.apellido);
    checks.push({
      name: 'orderBy inválido → cae al default alfabético (whitelist)',
      pass: r15.statusCode === 200 &&
        JSON.stringify(r15Apellidos) === JSON.stringify(['Acosta', 'BENITEZ', 'duarte', 'Martinez', 'Rechazado', 'Zorrilla']),
      detail: `status=${r15.statusCode} apellidos=${JSON.stringify(r15Apellidos)}`,
    });

    // 16) orderDir inválido → default del campo (desc para fecha), sin romper
    const r16 = await call(controller.adminListar, mockReq({ query: { eventoId: evento.id, orderBy: 'fecha', orderDir: 'ASC; --' } }));
    const r16Ids = (r16.body?.compras || []).map((c) => c.id);
    checks.push({
      name: 'orderDir inválido → default del campo (fecha desc)',
      pass: r16.statusCode === 200 && r16Ids[0] === compraMinus.id,
      detail: `status=${r16.statusCode} ids=${JSON.stringify(r16Ids)}`,
    });

    // 17) Sin orderBy el comportamiento es el de siempre — los consumidores que no
    //     mandan el param (lector-qr con limit=500) no se enteraron del cambio.
    const r17 = await call(controller.adminListar, mockReq({ query: { eventoId: evento.id } }));
    const r17Apellidos = (r17.body?.compras || []).map((c) => c.apellido);
    checks.push({
      name: 'Sin orderBy → sigue siendo alfabético A-Z (compatibilidad hacia atrás)',
      pass: JSON.stringify(r17Apellidos) === JSON.stringify(['Acosta', 'BENITEZ', 'duarte', 'Martinez', 'Rechazado', 'Zorrilla']),
      detail: `apellidos=${JSON.stringify(r17Apellidos)}`,
    });

    // 18) El alfabético pagina en Node (no en la BD, porque el orden se calcula
    //     en JS). Verificar que las páginas no se pisan ni se saltean filas, y
    //     que total/totalPages siguen contando el conjunto entero.
    const paginas = [];
    for (let pg = 1; pg <= 3; pg++) {
      const r = await call(controller.adminListar, mockReq({ query: { eventoId: evento.id, limit: 2, page: pg } }));
      paginas.push(r.body);
    }
    const concatenado = paginas.flatMap((p) => (p?.compras || []).map((c) => c.apellido));
    const sinRepetir = new Set(concatenado).size === concatenado.length;
    checks.push({
      name: '🎯 Alfabético paginado en Node: 3 páginas de 2 reconstruyen la lista sin huecos ni repetidos',
      pass: JSON.stringify(concatenado) === JSON.stringify(['Acosta', 'BENITEZ', 'duarte', 'Martinez', 'Rechazado', 'Zorrilla']) &&
        sinRepetir && paginas[0]?.total === 6 && paginas[0]?.totalPages === 3,
      detail: `concatenado=${JSON.stringify(concatenado)} total=${paginas[0]?.total} totalPages=${paginas[0]?.totalPages}`,
    });

    // 19) Desc del alfabético: la lista exactamente al revés.
    const r19 = await call(controller.adminListar, mockReq({ query: { eventoId: evento.id, orderBy: 'nombre', orderDir: 'desc' } }));
    const r19Apellidos = (r19.body?.compras || []).map((c) => c.apellido);
    checks.push({
      name: 'orderBy=nombre&orderDir=desc → Z-A con el mismo criterio humano',
      pass: JSON.stringify(r19Apellidos) === JSON.stringify(['Zorrilla', 'Rechazado', 'Martinez', 'duarte', 'BENITEZ', 'Acosta']),
      detail: `apellidos=${JSON.stringify(r19Apellidos)}`,
    });

    // ============================================
    // REPORT
    // ============================================
    console.log('─'.repeat(72));
    console.log('Compras adminListar — Test de búsqueda + filtros + orden');
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
