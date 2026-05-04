/**
 * Tests de integración — Dashboard de Reportes (Sprint 3 ítem 5).
 *
 * Llama al controller con req/res mock. No mockea Prisma — usa dev.db real
 * y limpia con prefijo `dashboard-test-` (mismo patrón que los otros tests
 * de integración).
 *
 * Cubre los 8 endpoints sin waitlist:
 *  - resumen (sin filtro y filtrado por evento)
 *  - ventasTimeline (granularidad día y hora)
 *  - distribucionTandas
 *  - comparativaEventos
 *  - aporteExtra (incluye % conversión + breakdown)
 *  - cadenciaTandas (caso agotada y no agotada)
 *  - validacionQR (% asistencia + breakdown)
 *  - topCupones (orden por descuento total)
 *
 * Uso local:
 *   node tests/integration/dashboard-stats.test.js
 */

const prisma = require('../../src/utils/prisma');
const dashboard = require('../../src/controllers/dashboard.controller');
const supabaseService = require('../../src/services/supabase.service');

const TEST_PREFIX = 'dashboard-test-';

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

function mockReq({ query = {}, params = {} } = {}) {
  return { query, params };
}

async function call(handler, reqOpts = {}) {
  const res = mockRes();
  await handler(mockReq(reqOpts), res);
  return res;
}

async function cleanup() {
  const eventos = await prisma.evento.findMany({
    where: { nombre: { startsWith: TEST_PREFIX } },
    select: { id: true },
  });
  const eventoIds = eventos.map((e) => e.id);
  if (eventoIds.length === 0) return;

  const cupones = await prisma.cuponDescuento.findMany({
    where: { eventoId: { in: eventoIds } },
    select: { id: true },
  });
  const cuponIds = cupones.map((c) => c.id);

  const compras = await prisma.compra.findMany({
    where: { eventoId: { in: eventoIds } },
    select: { id: true },
  });
  const compraIds = compras.map((c) => c.id);

  await prisma.cuponUso.deleteMany({ where: { cuponId: { in: cuponIds } } });
  await prisma.cuponDescuento.deleteMany({ where: { id: { in: cuponIds } } });
  await prisma.entrada.deleteMany({ where: { compraId: { in: compraIds } } });
  await prisma.compra.deleteMany({ where: { id: { in: compraIds } } });
  await prisma.tanda.deleteMany({ where: { eventoId: { in: eventoIds } } });
  await prisma.evento.deleteMany({ where: { id: { in: eventoIds } } });
}

// ============================================
// SETUP — fixture compartido para todos los blocks
// ============================================
async function setupFixture() {
  // Evento A: 2 tandas. T1 sin aporte (capacidad=10), T2 con aporte (capacidad=2 → agotada).
  const evA = await prisma.evento.create({
    data: {
      nombre: `${TEST_PREFIX}EventoA-${Date.now()}`,
      descripcion: 'Test A',
      fecha: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      hora: '21:00',
      estaPublicado: true,
      tandas: {
        create: [
          { nombre: 'T1', precio: 10000, orden: 1, activa: true, capacidad: 10, cantidadVendida: 4, porcentajeAporte: 0 },
          { nombre: 'T2', precio: 10000, orden: 2, activa: true, capacidad: 2, cantidadVendida: 2, porcentajeAporte: 20 },
        ],
      },
    },
    include: { tandas: { orderBy: { orden: 'asc' } } },
  });
  const [t1, t2] = evA.tandas;

  // Evento B: 1 tanda con capacidad infinita.
  const evB = await prisma.evento.create({
    data: {
      nombre: `${TEST_PREFIX}EventoB-${Date.now()}`,
      descripcion: 'Test B',
      fecha: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
      hora: '21:00',
      estaPublicado: true,
      tandas: {
        create: [
          { nombre: 'TB', precio: 5000, orden: 1, activa: true, capacidad: null, cantidadVendida: 1, porcentajeAporte: 0 },
        ],
      },
    },
    include: { tandas: true },
  });
  const tb = evB.tandas[0];

  // Compras evento A.
  const baseDate = new Date();
  baseDate.setHours(15, 0, 0, 0);
  const yesterday = new Date(baseDate.getTime() - 24 * 60 * 60 * 1000);
  const twoDaysAgo = new Date(baseDate.getTime() - 2 * 24 * 60 * 60 * 1000);

  // Compra 1: T1 approved con plata (10000) — base, hoy 15:00
  const c1 = await prisma.compra.create({
    data: {
      eventoId: evA.id, tandaId: t1.id, email: 'c1@t.invalid', nombre: 'C1', apellido: 'T',
      cantidadEntradas: 1, precioUnitario: 10000, totalPagado: 10000,
      tipoEntrada: 'base', mpEstado: 'approved', createdAt: baseDate,
      entradas: { create: [{ codigoQR: `qr-${TEST_PREFIX}c1`, qrImageUrl: '', validada: true, validadaAt: new Date() }] },
    },
  });

  // Compra 2: T1 approved con plata (10000) — base, ayer
  const c2 = await prisma.compra.create({
    data: {
      eventoId: evA.id, tandaId: t1.id, email: 'c2@t.invalid', nombre: 'C2', apellido: 'T',
      cantidadEntradas: 1, precioUnitario: 10000, totalPagado: 10000,
      tipoEntrada: 'base', mpEstado: 'approved', createdAt: yesterday,
      entradas: { create: [{ codigoQR: `qr-${TEST_PREFIX}c2`, qrImageUrl: '', validada: true, validadaAt: new Date() }] },
    },
  });

  // Compra 3: T1 INVITACION (2 entradas, totalPagado=0) — anteayer
  const c3 = await prisma.compra.create({
    data: {
      eventoId: evA.id, tandaId: t1.id, email: 'c3@t.invalid', nombre: 'C3', apellido: 'T',
      cantidadEntradas: 2, precioUnitario: 0, totalPagado: 0,
      tipoEntrada: 'base', mpEstado: 'approved', createdAt: twoDaysAgo,
      entradas: { create: [
        { codigoQR: `qr-${TEST_PREFIX}c3a`, qrImageUrl: '', validada: false },
        { codigoQR: `qr-${TEST_PREFIX}c3b`, qrImageUrl: '', validada: false },
      ] },
    },
  });

  // Compra 4: T1 pending (no entra en vendidas, sí en pendientes)
  const c4 = await prisma.compra.create({
    data: {
      eventoId: evA.id, tandaId: t1.id, email: 'c4@t.invalid', nombre: 'C4', apellido: 'T',
      cantidadEntradas: 1, precioUnitario: 10000, totalPagado: 10000,
      tipoEntrada: 'base', mpEstado: 'pending', createdAt: baseDate,
    },
  });

  // Compra 5: T2 approved APORTE — primera de T2 (cronológicamente)
  const t2First = new Date(baseDate.getTime() - 5 * 24 * 60 * 60 * 1000);
  const c5 = await prisma.compra.create({
    data: {
      eventoId: evA.id, tandaId: t2.id, email: 'c5@t.invalid', nombre: 'C5', apellido: 'T',
      cantidadEntradas: 1, precioUnitario: 12000, totalPagado: 12000,
      tipoEntrada: 'aporte', excedenteUnitario: 2000,
      mpEstado: 'approved', createdAt: t2First,
      entradas: { create: [{ codigoQR: `qr-${TEST_PREFIX}c5`, qrImageUrl: '', validada: true, validadaAt: new Date() }] },
    },
  });

  // Compra 6: T2 approved BASE — última de T2 (es la que "agotó" la tanda)
  const t2Last = new Date(baseDate.getTime() - 1 * 24 * 60 * 60 * 1000);
  const c6 = await prisma.compra.create({
    data: {
      eventoId: evA.id, tandaId: t2.id, email: 'c6@t.invalid', nombre: 'C6', apellido: 'T',
      cantidadEntradas: 1, precioUnitario: 10000, totalPagado: 10000,
      tipoEntrada: 'base', mpEstado: 'approved', createdAt: t2Last,
      entradas: { create: [{ codigoQR: `qr-${TEST_PREFIX}c6`, qrImageUrl: '', validada: false }] },
    },
  });

  // Compra 7: Evento B
  const c7 = await prisma.compra.create({
    data: {
      eventoId: evB.id, tandaId: tb.id, email: 'c7@t.invalid', nombre: 'C7', apellido: 'T',
      cantidadEntradas: 1, precioUnitario: 5000, totalPagado: 5000,
      tipoEntrada: 'base', mpEstado: 'approved', createdAt: baseDate,
      entradas: { create: [{ codigoQR: `qr-${TEST_PREFIX}c7`, qrImageUrl: '', validada: false }] },
    },
  });

  // Cupones: AMIGOS25 (1 uso, $2500) + VIP50 (2 usos, $5000 c/u → total $10000)
  const cupAmigos = await prisma.cuponDescuento.create({
    data: {
      eventoId: evA.id, codigo: `${TEST_PREFIX}AMIGOS25`, tipo: 'porcentaje', valor: 25,
      topeUsos: 10, usosActuales: 1, activo: true,
    },
  });
  await prisma.cuponUso.create({ data: { cuponId: cupAmigos.id, compraId: c1.id, descuentoAplicado: 2500 } });

  const cupVip = await prisma.cuponDescuento.create({
    data: {
      eventoId: evA.id, codigo: `${TEST_PREFIX}VIP50`, tipo: 'monto', valor: 5000,
      topeUsos: 5, usosActuales: 2, activo: true,
    },
  });
  await prisma.cuponUso.create({ data: { cuponId: cupVip.id, compraId: c2.id, descuentoAplicado: 5000 } });
  await prisma.cuponUso.create({ data: { cuponId: cupVip.id, compraId: c6.id, descuentoAplicado: 5000 } });

  return { evA, evB, t1, t2, tb, c1, c2, c3, c4, c5, c6, c7, cupAmigos, cupVip };
}

// ============================================
// MAIN
// ============================================
async function main() {
  const checks = [];
  function check(name, cond, detail) {
    if (cond) {
      checks.push({ name, ok: true });
    } else {
      checks.push({ name, ok: false, detail });
    }
  }

  try {
    await cleanup();
    const f = await setupFixture();

    // ============================================
    // BLOQUE 1 — RESUMEN sin filtro
    // ============================================
    {
      const r = await call(dashboard.resumen);
      check('resumen: status 200', r.statusCode === 200, r.statusCode);
      const b = r.body;
      check('resumen: totalEventos >= 2', b.totalEventos >= 2, b.totalEventos);
      check('resumen: compras.vendidas incluye 5 nuestras', b.compras.vendidas >= 5);
      check('resumen: compras.invitaciones incluye 1 nuestra', b.compras.invitaciones >= 1);
      check('resumen: compras.pendientes incluye 1 nuestra', b.compras.pendientes >= 1);
      check('resumen: compras.conAporte incluye 1 nuestra', b.compras.conAporte >= 1);
      check('resumen: aporteExtra >= 2000', b.recaudado.aporteExtra >= 2000, b.recaudado.aporteExtra);
      check('resumen: recaudado.base = total - aporteExtra', b.recaudado.base === b.recaudado.total - b.recaudado.aporteExtra);
      check('resumen: asistenciaPct entre 0 y 100', b.asistenciaPct === null || (b.asistenciaPct >= 0 && b.asistenciaPct <= 100));
    }

    // ============================================
    // BLOQUE 2 — RESUMEN filtrado por eventoId=A
    // ============================================
    {
      const r = await call(dashboard.resumen, { query: { eventoId: String(f.evA.id) } });
      const b = r.body;
      check('resumen evA: totalEventos = 1', b.totalEventos === 1, b.totalEventos);
      check('resumen evA: compras.vendidas = 4', b.compras.vendidas === 4, b.compras.vendidas);
      check('resumen evA: compras.invitaciones = 1', b.compras.invitaciones === 1, b.compras.invitaciones);
      check('resumen evA: entradas.vendidas = 4', b.entradas.vendidas === 4, b.entradas.vendidas);
      check('resumen evA: entradas.invitaciones = 2', b.entradas.invitaciones === 2, b.entradas.invitaciones);
      check('resumen evA: aporteExtra = 2000', b.recaudado.aporteExtra === 2000, b.recaudado.aporteExtra);
      check('resumen evA: total = 42000', b.recaudado.total === 42000, b.recaudado.total);
      check('resumen evA: base = 40000', b.recaudado.base === 40000, b.recaudado.base);
      // Asistencia evA: 6 entradas approved, 3 validadas → 50%
      check('resumen evA: asistenciaPct = 50', b.asistenciaPct === 50, b.asistenciaPct);
    }

    // ============================================
    // BLOQUE 3 — VENTAS TIMELINE (día) filtrado por evA
    // ============================================
    {
      const r = await call(dashboard.ventasTimeline, { query: { eventoId: String(f.evA.id), granularidad: 'dia' } });
      const b = r.body;
      check('timeline día evA: status 200', r.statusCode === 200);
      check('timeline día evA: granularidad = dia', b.granularidad === 'dia');
      check('timeline día evA: data array no vacío', Array.isArray(b.data) && b.data.length > 0, b.data?.length);
      // Suma de recaudado = 42000 (vendidas con plata: 10000+10000+12000+10000)
      const suma = b.data.reduce((s, x) => s + x.recaudado, 0);
      check('timeline día evA: suma recaudado = 42000', suma === 42000, suma);
      // Acumulado debe ser monótono creciente
      let prev = -1;
      let monoton = true;
      for (const row of b.data) { if (row.recaudadoAcumulado < prev) { monoton = false; break; } prev = row.recaudadoAcumulado; }
      check('timeline día evA: recaudadoAcumulado monótono creciente', monoton);
      // Último acumulado = suma total
      check('timeline día evA: último acumulado = suma', b.data[b.data.length - 1].recaudadoAcumulado === suma);
    }

    // ============================================
    // BLOQUE 4 — VENTAS TIMELINE (hora)
    // ============================================
    {
      const r = await call(dashboard.ventasTimeline, { query: { eventoId: String(f.evA.id), granularidad: 'hora' } });
      const b = r.body;
      check('timeline hora: granularidad = hora', b.granularidad === 'hora');
      // El periodo en hora debe contener ":00" al final
      const todosTienenHora = b.data.every((x) => /:\d\d$/.test(x.periodo));
      check('timeline hora: todos los periodos terminan en HH:00', todosTienenHora, b.data.map((x) => x.periodo));
    }

    // ============================================
    // BLOQUE 5 — DISTRIBUCION TANDAS para evA
    // ============================================
    {
      const r = await call(dashboard.distribucionTandas, { params: { id: String(f.evA.id) } });
      const b = r.body;
      check('distribucionTandas: status 200', r.statusCode === 200);
      check('distribucionTandas: 2 tandas', b.tandas.length === 2, b.tandas.length);
      const tandasByNombre = Object.fromEntries(b.tandas.map((t) => [t.nombre, t]));
      // T1: 2 vendidas + 2 invitaciones, recaudado=20000
      check('distribucionTandas T1: vendidas = 2', tandasByNombre.T1.vendidas === 2, tandasByNombre.T1.vendidas);
      check('distribucionTandas T1: invitaciones = 2', tandasByNombre.T1.invitaciones === 2);
      check('distribucionTandas T1: recaudado = 20000', tandasByNombre.T1.recaudado === 20000);
      check('distribucionTandas T1: pctOcupacion = 40', tandasByNombre.T1.pctOcupacion === 40);
      // T2: 2 vendidas, 0 invitaciones, recaudado=22000 (12000+10000)
      check('distribucionTandas T2: vendidas = 2', tandasByNombre.T2.vendidas === 2);
      check('distribucionTandas T2: invitaciones = 0', tandasByNombre.T2.invitaciones === 0);
      check('distribucionTandas T2: recaudado = 22000', tandasByNombre.T2.recaudado === 22000);
      check('distribucionTandas T2: pctOcupacion = 100', tandasByNombre.T2.pctOcupacion === 100);
    }

    // ============================================
    // BLOQUE 6 — DISTRIBUCION TANDAS evento inexistente
    // ============================================
    {
      const r = await call(dashboard.distribucionTandas, { params: { id: '999999' } });
      check('distribucionTandas inexistente: 404', r.statusCode === 404, r.statusCode);
    }

    // ============================================
    // BLOQUE 7 — COMPARATIVA EVENTOS
    // ============================================
    {
      const r = await call(dashboard.comparativaEventos);
      const b = r.body;
      check('comparativa: status 200', r.statusCode === 200);
      const evARow = b.eventos.find((e) => e.eventoId === f.evA.id);
      const evBRow = b.eventos.find((e) => e.eventoId === f.evB.id);
      check('comparativa: encuentra evA', !!evARow);
      check('comparativa: encuentra evB', !!evBRow);
      check('comparativa evA: vendidas = 4', evARow.vendidas === 4, evARow.vendidas);
      check('comparativa evA: invitaciones = 2', evARow.invitaciones === 2);
      check('comparativa evA: recaudado = 42000', evARow.recaudado === 42000);
      check('comparativa evA: aporteExtra = 2000', evARow.aporteExtra === 2000);
      check('comparativa evA: capacidad = 12', evARow.capacidad === 12, evARow.capacidad);
      // pctOcupacion = (4 vendidas + 2 invitaciones) / 12 = 50%
      check('comparativa evA: pctOcupacion = 50', evARow.pctOcupacion === 50, evARow.pctOcupacion);
      // evB tiene capacidad infinita (null tanda) → capacidad null
      check('comparativa evB: capacidad = null', evBRow.capacidad === null);
      check('comparativa evB: pctOcupacion = null', evBRow.pctOcupacion === null);
    }

    // ============================================
    // BLOQUE 8 — APORTE EXTRA sin filtro
    // ============================================
    {
      const r = await call(dashboard.aporteExtra);
      const b = r.body;
      check('aporteExtra: status 200', r.statusCode === 200);
      check('aporteExtra: total >= 2000', b.totalAporteExtra >= 2000, b.totalAporteExtra);
      // En T2 (con aporte): 1 con aporte (c5), 1 base (c6) → conversión 50%
      // (puede haber más datos preexistentes, así que solo chequeamos que tenga sentido)
      check('aporteExtra: pctConversion entre 0 y 100', b.pctConversion === null || (b.pctConversion >= 0 && b.pctConversion <= 100));
      check('aporteExtra: breakdownPorEvento es array', Array.isArray(b.breakdownPorEvento));
      const evARow = b.breakdownPorEvento.find((x) => x.eventoId === f.evA.id);
      check('aporteExtra: breakdown evA aporteExtra = 2000', evARow?.aporteExtra === 2000);
      check('aporteExtra: breakdown evA comprasAporte = 1', evARow?.comprasAporte === 1);
    }

    // ============================================
    // BLOQUE 9 — APORTE EXTRA filtrado por evA
    // ============================================
    {
      const r = await call(dashboard.aporteExtra, { query: { eventoId: String(f.evA.id) } });
      const b = r.body;
      check('aporteExtra evA: total = 2000', b.totalAporteExtra === 2000, b.totalAporteExtra);
      check('aporteExtra evA: comprasConAporte = 1', b.comprasConAporte === 1);
      check('aporteExtra evA: comprasBase = 1', b.comprasBase === 1);
      check('aporteExtra evA: pctConversion = 50', b.pctConversion === 50, b.pctConversion);
    }

    // ============================================
    // BLOQUE 10 — CADENCIA TANDAS para evA
    // ============================================
    {
      const r = await call(dashboard.cadenciaTandas, { params: { id: String(f.evA.id) } });
      const b = r.body;
      check('cadencia: status 200', r.statusCode === 200);
      const byNombre = Object.fromEntries(b.tandas.map((t) => [t.nombre, t]));
      // T1: cantidadVendida=4, capacidad=10 → no agotada
      check('cadencia T1: agotada=false', byNombre.T1.agotada === false);
      check('cadencia T1: fechaAgotada=null', byNombre.T1.fechaAgotada === null);
      check('cadencia T1: primeraCompra existe', byNombre.T1.primeraCompra !== null);
      // T2: cantidadVendida=2, capacidad=2 → agotada
      check('cadencia T2: agotada=true', byNombre.T2.agotada === true, byNombre.T2);
      check('cadencia T2: fechaAgotada existe', byNombre.T2.fechaAgotada !== null);
      // T2 abrió 5 días antes de baseDate, cerró 1 día antes → 4 días
      check('cadencia T2: diasParaAgotar >= 4', byNombre.T2.diasParaAgotar >= 4 && byNombre.T2.diasParaAgotar <= 5, byNombre.T2.diasParaAgotar);
    }

    // ============================================
    // BLOQUE 11 — VALIDACION QR
    // ============================================
    {
      const r = await call(dashboard.validacionQR, { query: { eventoId: String(f.evA.id) } });
      const b = r.body;
      check('validacionQR evA: status 200', r.statusCode === 200);
      // 6 entradas approved (4 vendidas + 2 invit), 3 validadas (c1, c2, c5)
      check('validacionQR evA: total = 6', b.total === 6, b.total);
      check('validacionQR evA: validadas = 3', b.validadas === 3, b.validadas);
      check('validacionQR evA: asistenciaPct = 50', b.asistenciaPct === 50, b.asistenciaPct);
      check('validacionQR: breakdownPorEvento incluye evA', b.breakdownPorEvento.some((x) => x.eventoId === f.evA.id));
    }

    // ============================================
    // BLOQUE 12 — TOP CUPONES
    // ============================================
    {
      const r = await call(dashboard.topCupones, { query: { limit: '10' } });
      const b = r.body;
      check('topCupones: status 200', r.statusCode === 200);
      const ourCupones = b.cupones.filter((c) => c.codigo.startsWith(TEST_PREFIX));
      check('topCupones: encuentra los 2 nuestros', ourCupones.length === 2, ourCupones.length);
      // VIP50 (10000) debería estar antes que AMIGOS25 (2500)
      const vipIdx = ourCupones.findIndex((c) => c.codigo.endsWith('VIP50'));
      const amigosIdx = ourCupones.findIndex((c) => c.codigo.endsWith('AMIGOS25'));
      check('topCupones: VIP50 antes que AMIGOS25', vipIdx < amigosIdx, { vipIdx, amigosIdx });
      const vip = ourCupones[vipIdx];
      check('topCupones VIP: descuentoTotal = 10000', vip.descuentoTotal === 10000);
      check('topCupones VIP: usos = 2', vip.usos === 2);
      check('topCupones VIP: pctTopeUsado = 40 (2/5)', vip.pctTopeUsado === 40, vip.pctTopeUsado);
      const amigos = ourCupones[amigosIdx];
      check('topCupones AMIGOS: descuentoTotal = 2500', amigos.descuentoTotal === 2500);
      check('topCupones AMIGOS: pctTopeUsado = 10 (1/10)', amigos.pctTopeUsado === 10);
    }

    // ============================================
    // BLOQUE 13 — TOP CUPONES con limit=1
    // ============================================
    {
      const r = await call(dashboard.topCupones, { query: { limit: '1' } });
      const b = r.body;
      check('topCupones limit=1: 1 cupón', b.cupones.length === 1, b.cupones.length);
    }

    // ============================================
    // BLOQUE 13.5 — WAITLIST (con mock de supabaseService)
    // ============================================
    {
      // Mock con monkey-patch CommonJS (mismo patrón que mpService en compras-cupones).
      const originalIsConfigured = supabaseService.isConfigured;
      const originalFetchWaitlist = supabaseService.fetchWaitlist;
      try {
        supabaseService.isConfigured = () => true;
        const ahora = new Date();
        const hace2dias = new Date(ahora.getTime() - 2 * 24 * 60 * 60 * 1000);
        const hace10dias = new Date(ahora.getTime() - 10 * 24 * 60 * 60 * 1000);
        const hoyTemp = new Date(ahora.getTime() - 60 * 1000); // hace 1 min — siempre "hoy AR" salvo justo a las 00:00
        supabaseService.fetchWaitlist = async () => ([
          { id: 1, nombre: 'A', email: 'a@x', relacion: 'simpatizante', fuente: 'landing',
            quiere_early_access: true, quiere_descuentos: true, quiere_backstage: false, quiere_comunidad: true,
            created_at: hoyTemp.toISOString() },
          { id: 2, nombre: 'B', email: 'b@x', relacion: 'músico', fuente: 'landing',
            quiere_early_access: false, quiere_descuentos: true, quiere_backstage: true, quiere_comunidad: true,
            created_at: hace2dias.toISOString() },
          { id: 3, nombre: 'C', email: 'c@x', relacion: 'simpatizante', fuente: 'redes',
            quiere_early_access: true, quiere_descuentos: false, quiere_backstage: false, quiere_comunidad: false,
            created_at: hace10dias.toISOString() },
        ]);

        const r = await call(dashboard.waitlist);
        const b = r.body;
        check('waitlist: status 200', r.statusCode === 200);
        check('waitlist: disponible=true', b.disponible === true);
        check('waitlist: total = 3', b.total === 3, b.total);
        check('waitlist: hoy >= 1', b.hoy >= 1, b.hoy);
        check('waitlist: semana >= 2', b.semana >= 2, b.semana);
        check('waitlist: porDia tiene al menos 2 entradas (hoy y hace 2 días)', b.porDia.length >= 2, b.porDia.length);
        check('waitlist: porIntereses.early_access = 2', b.porIntereses.early_access === 2);
        check('waitlist: porIntereses.descuentos = 2', b.porIntereses.descuentos === 2);
        check('waitlist: porIntereses.backstage = 1', b.porIntereses.backstage === 1);
        check('waitlist: porIntereses.comunidad = 2', b.porIntereses.comunidad === 2);
        check('waitlist: porRelacion.simpatizante = 2', b.porRelacion.simpatizante === 2);
        check('waitlist: porFuente.landing = 2', b.porFuente.landing === 2);
      } finally {
        supabaseService.isConfigured = originalIsConfigured;
        supabaseService.fetchWaitlist = originalFetchWaitlist;
      }
    }

    // ============================================
    // BLOQUE 13.6 — WAITLIST sin Supabase configurado
    // ============================================
    {
      const originalIsConfigured = supabaseService.isConfigured;
      try {
        supabaseService.isConfigured = () => false;
        const r = await call(dashboard.waitlist);
        check('waitlist sin config: status 200 (no rompe)', r.statusCode === 200);
        check('waitlist sin config: disponible=false', r.body.disponible === false);
        check('waitlist sin config: motivo presente', typeof r.body.motivo === 'string');
      } finally {
        supabaseService.isConfigured = originalIsConfigured;
      }
    }

    // ============================================
    // BLOQUE 14 — RESUMEN con filtro de fechas (sólo "hoy")
    // ============================================
    {
      const hoy = new Date();
      const desde = new Date(hoy);
      desde.setHours(0, 0, 0, 0);
      const hasta = new Date(hoy);
      hasta.setHours(23, 59, 59, 999);
      const r = await call(dashboard.resumen, {
        query: {
          eventoId: String(f.evA.id),
          desde: desde.toISOString().split('T')[0],
          hasta: hasta.toISOString().split('T')[0],
        },
      });
      const b = r.body;
      // Solo c1 (hoy 15:00) entra → vendidas = 1
      check('resumen filtro hoy evA: compras.vendidas = 1', b.compras.vendidas === 1, b.compras.vendidas);
      check('resumen filtro hoy evA: total = 10000', b.recaudado.total === 10000, b.recaudado.total);
    }

    // ============================================
    // RESULTADO
    // ============================================
    const failed = checks.filter((c) => !c.ok);
    const passed = checks.length - failed.length;
    console.log('');
    console.log('========================================');
    console.log(`Tests Dashboard: ${passed}/${checks.length} OK`);
    console.log('========================================');
    if (failed.length) {
      console.log('');
      console.log('FALLAS:');
      for (const f of failed) {
        console.log(`  ✗ ${f.name}`);
        if (f.detail !== undefined) console.log(`    detalle:`, f.detail);
      }
      process.exitCode = 1;
    } else {
      console.log('Todos los checks verdes ✓');
    }
  } catch (err) {
    console.error('ERROR EN TESTS:', err);
    process.exitCode = 1;
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }
}

main();
