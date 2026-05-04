// Dashboard de Reportes (ítem 5 Sprint 3). Todos los endpoints agregan en BD
// — nada de filtrar/sumar client-side sobre paginado (ver
// memoria insight_filtros_paginados_client_side.md). El controller existente
// adminEventoStats / adminStatsGlobal sigue siendo la fuente para la vista
// operativa; estos endpoints suman series temporales, comparativas y KPIs
// nuevos (A la Gorra, validación QR, cupones, cadencia).
//
// Timezone: Prisma + SQLite almacena DateTime como INTEGER en ms (Unix epoch).
// Para agrupar por día/hora local AR se convierte con
// `datetime(col / 1000, 'unixepoch', '-3 hours')`. AR es UTC-3 sin DST, así
// que el offset es estable.

const { Prisma } = require('@prisma/client');
const prisma = require('../utils/prisma');
const supabaseService = require('../services/supabase.service');

const TZ_OFFSET_SQL = "'unixepoch', '-3 hours'"; // AR

function parseEventoId(req) {
  const raw = req.query.eventoId;
  if (raw === undefined || raw === null || raw === '' || raw === 'all') return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseDateRange(req) {
  const desdeRaw = req.query.desde;
  const hastaRaw = req.query.hasta;
  let desde = null, hasta = null;
  if (desdeRaw) {
    const d = new Date(desdeRaw);
    if (!Number.isNaN(d.getTime())) desde = d;
  }
  if (hastaRaw) {
    const d = new Date(hastaRaw);
    if (!Number.isNaN(d.getTime())) {
      // El usuario pasa una fecha sola → tomamos el final de ese día (23:59:59.999)
      // para que un rango "1/5 → 1/5" incluya todo ese día.
      d.setHours(23, 59, 59, 999);
      hasta = d;
    }
  }
  return { desde, hasta };
}

function dateFilter(desde, hasta) {
  if (!desde && !hasta) return undefined;
  const obj = {};
  if (desde) obj.gte = desde;
  if (hasta) obj.lte = hasta;
  return obj;
}

// 1. RESUMEN — totales globales o filtrados por evento/fecha. Mismo principio
// que adminStatsGlobal pero con KPIs A la Gorra + asistencia QR + filtros.
async function resumen(req, res) {
  try {
    const eventoId = parseEventoId(req);
    const { desde, hasta } = parseDateRange(req);
    const created = dateFilter(desde, hasta);

    const whereBase = {};
    if (eventoId) whereBase.eventoId = eventoId;
    if (created) whereBase.createdAt = created;

    const [
      totalEventos,
      totalCompras,
      vendidasAgg,
      invitacionesAgg,
      pendientesAgg,
      aporteAgg,
    ] = await Promise.all([
      prisma.evento.count(eventoId ? { where: { id: eventoId } } : undefined),
      prisma.compra.count({ where: whereBase }),
      prisma.compra.aggregate({
        where: { ...whereBase, mpEstado: 'approved', totalPagado: { gt: 0 } },
        _sum: { cantidadEntradas: true, totalPagado: true },
        _count: { _all: true },
      }),
      prisma.compra.aggregate({
        where: { ...whereBase, mpEstado: 'approved', totalPagado: 0 },
        _sum: { cantidadEntradas: true },
        _count: { _all: true },
      }),
      prisma.compra.aggregate({
        where: { ...whereBase, mpEstado: 'pending' },
        _sum: { cantidadEntradas: true },
        _count: { _all: true },
      }),
      prisma.compra.aggregate({
        where: { ...whereBase, mpEstado: 'approved', tipoEntrada: 'aporte' },
        _sum: { cantidadEntradas: true, totalPagado: true, excedenteUnitario: true },
        _count: { _all: true },
      }),
    ]);

    // Aporte extra: excedenteUnitario × cantidadEntradas. Como el _sum solo da
    // SUM(excedenteUnitario), hay que recalcular por compra. Lo hacemos con un
    // findMany acotado a las compras de aporte (que son pocas) o con $queryRaw.
    // Preferimos $queryRaw para no traer las filas en JS.
    const aporteExtraRow = await prisma.$queryRaw`
      SELECT COALESCE(SUM(excedenteUnitario * cantidadEntradas), 0) AS aporteExtra
      FROM Compra
      WHERE mpEstado = 'approved'
        AND tipoEntrada = 'aporte'
        ${eventoId ? Prisma.sql`AND eventoId = ${eventoId}` : Prisma.empty}
        ${desde ? Prisma.sql`AND createdAt >= ${desde}` : Prisma.empty}
        ${hasta ? Prisma.sql`AND createdAt <= ${hasta}` : Prisma.empty}
    `;
    const aporteExtra = Number(aporteExtraRow[0]?.aporteExtra || 0);

    const recaudadoTotal = vendidasAgg._sum.totalPagado || 0;
    const recaudadoBase = recaudadoTotal - aporteExtra;

    // Asistencia: entradas validadas / entradas con compra approved (vendidas + invitaciones).
    const asistenciaRow = await prisma.$queryRaw`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN e.validada THEN 1 ELSE 0 END) AS validadas
      FROM Entrada e
      INNER JOIN Compra c ON c.id = e.compraId
      WHERE c.mpEstado = 'approved'
        ${eventoId ? Prisma.sql`AND c.eventoId = ${eventoId}` : Prisma.empty}
        ${desde ? Prisma.sql`AND c.createdAt >= ${desde}` : Prisma.empty}
        ${hasta ? Prisma.sql`AND c.createdAt <= ${hasta}` : Prisma.empty}
    `;
    const totalEntradasAprobadas = Number(asistenciaRow[0]?.total || 0);
    const validadas = Number(asistenciaRow[0]?.validadas || 0);
    const asistenciaPct = totalEntradasAprobadas > 0
      ? Math.round((validadas / totalEntradasAprobadas) * 1000) / 10
      : null;

    return res.json({
      totalEventos,
      totalCompras,
      compras: {
        vendidas: vendidasAgg._count._all,
        invitaciones: invitacionesAgg._count._all,
        pendientes: pendientesAgg._count._all,
        conAporte: aporteAgg._count._all,
      },
      entradas: {
        vendidas: vendidasAgg._sum.cantidadEntradas || 0,
        invitaciones: invitacionesAgg._sum.cantidadEntradas || 0,
        pendientes: pendientesAgg._sum.cantidadEntradas || 0,
        validadas,
      },
      recaudado: {
        total: recaudadoTotal,
        base: recaudadoBase,
        aporteExtra,
      },
      asistenciaPct,
      filtros: {
        eventoId,
        desde: desde ? desde.toISOString() : null,
        hasta: hasta ? hasta.toISOString() : null,
      },
    });
  } catch (err) {
    console.error('Error en dashboard.resumen:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// 2. VENTAS-TIMELINE — serie temporal por día u hora con compras, entradas y
// recaudado (incluye recaudadoAcumulado). Solo cuenta approved con plata.
async function ventasTimeline(req, res) {
  try {
    const eventoId = parseEventoId(req);
    const { desde, hasta } = parseDateRange(req);
    const granularidad = req.query.granularidad === 'hora' ? 'hora' : 'dia';
    const formato = granularidad === 'hora' ? '%Y-%m-%d %H:00' : '%Y-%m-%d';

    // strftime con offset AR. Prisma.raw inyecta SQL crudo (no parametrizado);
    // los inputs son literales nuestros validados, no input del usuario.
    // c.createdAt viene como INTEGER ms; dividimos por 1000 para unixepoch.
    const formatSql = Prisma.raw(`strftime('${formato}', datetime(c.createdAt / 1000, ${TZ_OFFSET_SQL}))`);

    const rows = await prisma.$queryRaw`
      SELECT
        ${formatSql} AS periodo,
        COUNT(*) AS compras,
        SUM(c.cantidadEntradas) AS entradas,
        SUM(c.totalPagado) AS recaudado
      FROM Compra c
      WHERE c.mpEstado = 'approved'
        AND c.totalPagado > 0
        ${eventoId ? Prisma.sql`AND c.eventoId = ${eventoId}` : Prisma.empty}
        ${desde ? Prisma.sql`AND c.createdAt >= ${desde}` : Prisma.empty}
        ${hasta ? Prisma.sql`AND c.createdAt <= ${hasta}` : Prisma.empty}
      GROUP BY periodo
      ORDER BY periodo ASC
    `;

    let acum = 0;
    const data = rows.map((r) => {
      const recaudado = Number(r.recaudado || 0);
      acum += recaudado;
      return {
        periodo: r.periodo,
        compras: Number(r.compras || 0),
        entradas: Number(r.entradas || 0),
        recaudado,
        recaudadoAcumulado: acum,
      };
    });

    return res.json({
      granularidad,
      data,
      filtros: { eventoId, desde, hasta },
    });
  } catch (err) {
    console.error('Error en dashboard.ventasTimeline:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// 3. DISTRIBUCION-TANDAS — por tanda de un evento: vendidas, invitaciones,
// recaudado, capacidad y % ocupación. Para gráfico de barras del drill-down.
async function distribucionTandas(req, res) {
  try {
    const eventoId = parseInt(req.params.id);
    if (!eventoId) return res.status(400).json({ error: 'ID inválido' });

    const evento = await prisma.evento.findUnique({
      where: { id: eventoId },
      include: { tandas: { orderBy: { orden: 'asc' } } },
    });
    if (!evento) return res.status(404).json({ error: 'Evento no encontrado' });

    // Una sola query agrega por tanda; después la mergeamos con la lista de tandas.
    const aggs = await prisma.compra.groupBy({
      by: ['tandaId'],
      where: { eventoId, mpEstado: 'approved' },
      _sum: { cantidadEntradas: true, totalPagado: true },
      _count: { _all: true },
    });
    const aggsByTanda = new Map(aggs.map((a) => [a.tandaId, a]));

    // Invitaciones (totalPagado=0) — segunda groupBy porque no podemos
    // distinguir vendidas vs invitaciones en una sola pasada con groupBy.
    const invs = await prisma.compra.groupBy({
      by: ['tandaId'],
      where: { eventoId, mpEstado: 'approved', totalPagado: 0 },
      _sum: { cantidadEntradas: true },
      _count: { _all: true },
    });
    const invsByTanda = new Map(invs.map((i) => [i.tandaId, i]));

    const data = evento.tandas.map((t) => {
      const total = aggsByTanda.get(t.id);
      const inv = invsByTanda.get(t.id);
      const entradasTotalAprobadas = total?._sum.cantidadEntradas || 0;
      const entradasInv = inv?._sum.cantidadEntradas || 0;
      const entradasVendidas = entradasTotalAprobadas - entradasInv;
      const recaudado = total?._sum.totalPagado || 0;
      const pctOcupacion = t.capacidad
        ? Math.round((t.cantidadVendida / t.capacidad) * 1000) / 10
        : null;
      return {
        tandaId: t.id,
        nombre: t.nombre,
        orden: t.orden,
        precio: t.precio,
        capacidad: t.capacidad,
        cantidadVendida: t.cantidadVendida,
        vendidas: entradasVendidas,
        invitaciones: entradasInv,
        recaudado,
        pctOcupacion,
        porcentajeAporte: t.porcentajeAporte,
      };
    });

    return res.json({ eventoId, evento: { id: evento.id, nombre: evento.nombre, fecha: evento.fecha }, tandas: data });
  } catch (err) {
    console.error('Error en dashboard.distribucionTandas:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// 4. COMPARATIVA-EVENTOS — vista cross con un row por evento. Útil para
// barras horizontales y tabla sortable. Incluye aporteExtra para mostrar
// quién está captando más donaciones.
async function comparativaEventos(req, res) {
  try {
    const { desde, hasta } = parseDateRange(req);

    const eventos = await prisma.evento.findMany({
      orderBy: { fecha: 'desc' },
      include: { tandas: { select: { capacidad: true, cantidadVendida: true } } },
    });

    if (eventos.length === 0) return res.json({ eventos: [] });

    const eventoIds = eventos.map((e) => e.id);

    // Una sola pasada agregada por eventoId (vendidas con plata).
    const vendidas = await prisma.compra.groupBy({
      by: ['eventoId'],
      where: {
        eventoId: { in: eventoIds },
        mpEstado: 'approved',
        totalPagado: { gt: 0 },
        ...(desde || hasta ? { createdAt: dateFilter(desde, hasta) } : {}),
      },
      _sum: { cantidadEntradas: true, totalPagado: true },
      _count: { _all: true },
    });
    const vendByEvento = new Map(vendidas.map((v) => [v.eventoId, v]));

    const invs = await prisma.compra.groupBy({
      by: ['eventoId'],
      where: {
        eventoId: { in: eventoIds },
        mpEstado: 'approved',
        totalPagado: 0,
        ...(desde || hasta ? { createdAt: dateFilter(desde, hasta) } : {}),
      },
      _sum: { cantidadEntradas: true },
      _count: { _all: true },
    });
    const invByEvento = new Map(invs.map((i) => [i.eventoId, i]));

    // Aporte extra por evento (excedenteUnitario × cantidadEntradas).
    const aporteRows = await prisma.$queryRaw`
      SELECT eventoId, COALESCE(SUM(excedenteUnitario * cantidadEntradas), 0) AS aporteExtra
      FROM Compra
      WHERE mpEstado = 'approved' AND tipoEntrada = 'aporte'
        AND eventoId IN (${Prisma.join(eventoIds)})
        ${desde ? Prisma.sql`AND createdAt >= ${desde}` : Prisma.empty}
        ${hasta ? Prisma.sql`AND createdAt <= ${hasta}` : Prisma.empty}
      GROUP BY eventoId
    `;
    const aporteByEvento = new Map(aporteRows.map((r) => [Number(r.eventoId), Number(r.aporteExtra)]));

    const data = eventos.map((ev) => {
      const v = vendByEvento.get(ev.id);
      const i = invByEvento.get(ev.id);
      let capacidad = 0;
      let capacidadInf = false;
      for (const t of ev.tandas) {
        if (t.capacidad === null) { capacidadInf = true; break; }
        capacidad += t.capacidad;
      }
      const totalEntradas = (v?._sum.cantidadEntradas || 0) + (i?._sum.cantidadEntradas || 0);
      const pctOcupacion = capacidadInf || capacidad === 0
        ? null
        : Math.round((totalEntradas / capacidad) * 1000) / 10;
      return {
        eventoId: ev.id,
        nombre: ev.nombre,
        fecha: ev.fecha,
        esExterno: ev.esExterno,
        estaPublicado: ev.estaPublicado,
        vendidas: v?._sum.cantidadEntradas || 0,
        invitaciones: i?._sum.cantidadEntradas || 0,
        comprasVendidas: v?._count._all || 0,
        comprasInvitaciones: i?._count._all || 0,
        recaudado: v?._sum.totalPagado || 0,
        aporteExtra: aporteByEvento.get(ev.id) || 0,
        capacidad: capacidadInf ? null : capacidad,
        pctOcupacion,
      };
    });

    return res.json({ eventos: data });
  } catch (err) {
    console.error('Error en dashboard.comparativaEventos:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// 5. APORTE-EXTRA — KPI dedicado del A la Gorra (US 3 del Sprint 3 ítem 2).
// Total de excedente captado, % de conversión (cuántos eligen aporte vs base
// cuando la tanda lo ofrece), breakdown por evento.
async function aporteExtra(req, res) {
  try {
    const eventoId = parseEventoId(req);

    // Total de excedente.
    const totalRow = await prisma.$queryRaw`
      SELECT COALESCE(SUM(excedenteUnitario * cantidadEntradas), 0) AS aporteExtra
      FROM Compra
      WHERE mpEstado = 'approved' AND tipoEntrada = 'aporte'
        ${eventoId ? Prisma.sql`AND eventoId = ${eventoId}` : Prisma.empty}
    `;
    const totalAporteExtra = Number(totalRow[0]?.aporteExtra || 0);

    // Para % conversión: contar compras que ELIGIERON aporte vs base SOLO en
    // tandas que ofrecían aporte (porcentajeAporte > 0). Compras de tandas
    // que no ofrecían aporte no son "denominador" porque no había opción.
    const conversionRow = await prisma.$queryRaw`
      SELECT
        SUM(CASE WHEN c.tipoEntrada = 'aporte' THEN 1 ELSE 0 END) AS conAporte,
        SUM(CASE WHEN c.tipoEntrada = 'base' THEN 1 ELSE 0 END) AS conBase
      FROM Compra c
      INNER JOIN Tanda t ON t.id = c.tandaId
      WHERE c.mpEstado = 'approved'
        AND c.totalPagado > 0
        AND t.porcentajeAporte > 0
        ${eventoId ? Prisma.sql`AND c.eventoId = ${eventoId}` : Prisma.empty}
    `;
    const conAporte = Number(conversionRow[0]?.conAporte || 0);
    const conBase = Number(conversionRow[0]?.conBase || 0);
    const denom = conAporte + conBase;
    const pctConversion = denom > 0 ? Math.round((conAporte / denom) * 1000) / 10 : null;

    // Breakdown por evento (siempre, aunque venga eventoId — útil para gráfico).
    const breakdown = await prisma.$queryRaw`
      SELECT
        c.eventoId AS eventoId,
        e.nombre AS nombre,
        COALESCE(SUM(c.excedenteUnitario * c.cantidadEntradas), 0) AS aporteExtra,
        SUM(CASE WHEN c.tipoEntrada = 'aporte' THEN 1 ELSE 0 END) AS comprasAporte
      FROM Compra c
      INNER JOIN Evento e ON e.id = c.eventoId
      WHERE c.mpEstado = 'approved' AND c.tipoEntrada = 'aporte'
      GROUP BY c.eventoId, e.nombre
      ORDER BY aporteExtra DESC
    `;

    return res.json({
      totalAporteExtra,
      comprasConAporte: conAporte,
      comprasBase: conBase,
      pctConversion,
      breakdownPorEvento: breakdown.map((b) => ({
        eventoId: Number(b.eventoId),
        nombre: b.nombre,
        aporteExtra: Number(b.aporteExtra),
        comprasAporte: Number(b.comprasAporte),
      })),
    });
  } catch (err) {
    console.error('Error en dashboard.aporteExtra:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// 6. CADENCIA-TANDAS — por tanda del evento: cuándo abrió la venta (primera
// compra approved), cuándo se cerró (última compra approved si está agotada,
// null si no), cuántos días estuvo abierta. Aproximación: si la tanda llegó
// a su tope la "fechaAgotada" es la última compra; no es 100% preciso si
// hubo cancelaciones intermedias, pero es buena guía operativa.
async function cadenciaTandas(req, res) {
  try {
    const eventoId = parseInt(req.params.id);
    if (!eventoId) return res.status(400).json({ error: 'ID inválido' });

    const evento = await prisma.evento.findUnique({
      where: { id: eventoId },
      include: { tandas: { orderBy: { orden: 'asc' } } },
    });
    if (!evento) return res.status(404).json({ error: 'Evento no encontrado' });

    const aggs = await prisma.compra.groupBy({
      by: ['tandaId'],
      where: { eventoId, mpEstado: 'approved' },
      _min: { createdAt: true },
      _max: { createdAt: true },
      _count: { _all: true },
    });
    const aggsByTanda = new Map(aggs.map((a) => [a.tandaId, a]));

    const data = evento.tandas.map((t) => {
      const a = aggsByTanda.get(t.id);
      const primeraCompra = a?._min.createdAt || null;
      const ultimaCompra = a?._max.createdAt || null;
      const agotada = t.capacidad !== null && t.cantidadVendida >= t.capacidad;
      const fechaAgotada = agotada ? ultimaCompra : null;
      let diasParaAgotar = null;
      if (fechaAgotada && primeraCompra) {
        const ms = fechaAgotada.getTime() - primeraCompra.getTime();
        diasParaAgotar = Math.max(1, Math.ceil(ms / (24 * 60 * 60 * 1000)));
      }
      return {
        tandaId: t.id,
        nombre: t.nombre,
        orden: t.orden,
        capacidad: t.capacidad,
        cantidadVendida: t.cantidadVendida,
        primeraCompra,
        ultimaCompra,
        fechaAgotada,
        diasParaAgotar,
        agotada,
      };
    });

    return res.json({ eventoId, tandas: data });
  } catch (err) {
    console.error('Error en dashboard.cadenciaTandas:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// 7. VALIDACION-QR — % de asistencia real vs entradas válidas. Útil
// post-evento para saber cuántos no-shows tuviste. Incluye breakdown por evento
// para detectar patrones (ej: eventos con invitaciones masivas suelen no asistir).
async function validacionQR(req, res) {
  try {
    const eventoId = parseEventoId(req);

    const totalRow = await prisma.$queryRaw`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN e.validada THEN 1 ELSE 0 END) AS validadas
      FROM Entrada e
      INNER JOIN Compra c ON c.id = e.compraId
      WHERE c.mpEstado = 'approved'
        ${eventoId ? Prisma.sql`AND c.eventoId = ${eventoId}` : Prisma.empty}
    `;
    const total = Number(totalRow[0]?.total || 0);
    const validadas = Number(totalRow[0]?.validadas || 0);
    const asistenciaPct = total > 0 ? Math.round((validadas / total) * 1000) / 10 : null;

    const breakdown = await prisma.$queryRaw`
      SELECT
        c.eventoId AS eventoId,
        ev.nombre AS nombre,
        ev.fecha AS fecha,
        COUNT(*) AS total,
        SUM(CASE WHEN e.validada THEN 1 ELSE 0 END) AS validadas
      FROM Entrada e
      INNER JOIN Compra c ON c.id = e.compraId
      INNER JOIN Evento ev ON ev.id = c.eventoId
      WHERE c.mpEstado = 'approved'
      GROUP BY c.eventoId, ev.nombre, ev.fecha
      ORDER BY ev.fecha DESC
    `;

    return res.json({
      total,
      validadas,
      asistenciaPct,
      breakdownPorEvento: breakdown.map((b) => {
        const t = Number(b.total);
        const v = Number(b.validadas);
        return {
          eventoId: Number(b.eventoId),
          nombre: b.nombre,
          fecha: b.fecha,
          total: t,
          validadas: v,
          asistenciaPct: t > 0 ? Math.round((v / t) * 1000) / 10 : null,
        };
      }),
    });
  } catch (err) {
    console.error('Error en dashboard.validacionQR:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// 8. TOP-CUPONES — top N cupones por descuento aplicado total. Devuelve
// código, evento, usos, descuento total y % de tope agotado. El cierre de
// loop del ítem 1 (cupones): saber cuáles funcionaron.
async function topCupones(req, res) {
  try {
    const limitRaw = parseInt(req.query.limit, 10);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 && limitRaw <= 50 ? limitRaw : 3;

    const aggs = await prisma.cuponUso.groupBy({
      by: ['cuponId'],
      _sum: { descuentoAplicado: true },
      _count: { _all: true },
      orderBy: { _sum: { descuentoAplicado: 'desc' } },
      take: limit,
    });
    if (aggs.length === 0) return res.json({ cupones: [] });

    const cuponIds = aggs.map((a) => a.cuponId);
    const cupones = await prisma.cuponDescuento.findMany({
      where: { id: { in: cuponIds } },
      include: { evento: { select: { id: true, nombre: true } } },
    });
    const cuponesMap = new Map(cupones.map((c) => [c.id, c]));

    const data = aggs.map((a) => {
      const c = cuponesMap.get(a.cuponId);
      const usos = a._count._all;
      const pctTopeUsado = c?.topeUsos && c.topeUsos > 0
        ? Math.round((usos / c.topeUsos) * 1000) / 10
        : null;
      return {
        cuponId: a.cuponId,
        codigo: c?.codigo || '—',
        tipo: c?.tipo,
        valor: c?.valor,
        eventoId: c?.eventoId,
        eventoNombre: c?.evento?.nombre || '—',
        usos,
        topeUsos: c?.topeUsos || null,
        pctTopeUsado,
        descuentoTotal: a._sum.descuentoAplicado || 0,
        activo: c?.activo,
        validoHasta: c?.validoHasta || null,
      };
    });

    return res.json({ cupones: data });
  } catch (err) {
    console.error('Error en dashboard.topCupones:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// 9. WAITLIST — KPIs de la lista de espera (`waitlist_socios` en Supabase).
// Cuando exista el sistema de Suscripciones reales esto pasa a leer de la
// tabla local; el shape de respuesta queda fijo para no romper el frontend.
//
// Devuelve:
//   - total / hoy / semana
//   - porDia: serie temporal últimos 30 días
//   - porHoraHoy: distribución por hora si hubo inscripciones hoy
//   - porIntereses: cuántos quieren cada beneficio (early access, descuentos,
//     backstage, comunidad)
//   - porRelacion: distribución por "relación con el SAB"
//   - porFuente: distribución por fuente (landing, redes, etc.)
async function waitlist(req, res) {
  try {
    if (!supabaseService.isConfigured()) {
      return res.json({
        disponible: false,
        motivo: 'Supabase no está configurado en el servidor (faltan SUPABASE_URL y SUPABASE_KEY).',
      });
    }

    let registros;
    try {
      registros = await supabaseService.fetchWaitlist();
    } catch (err) {
      console.error('Error en supabase.fetchWaitlist:', err.message);
      return res.json({
        disponible: false,
        motivo: 'No se pudo conectar con Supabase. Reintentar en unos minutos.',
      });
    }

    const total = registros.length;

    // Determinar "hoy" y "semana" en hora local AR (UTC-3). createdAt en
    // Supabase suele venir como ISO string.
    const ahora = new Date();
    const hoyAR = new Date(ahora.getTime() - 3 * 60 * 60 * 1000); // shift to AR
    const yyyymmddHoy = hoyAR.toISOString().slice(0, 10);
    const semanaCutoff = new Date(ahora.getTime() - 7 * 24 * 60 * 60 * 1000);
    const treintaDiasCutoff = new Date(ahora.getTime() - 30 * 24 * 60 * 60 * 1000);

    let hoy = 0;
    let semana = 0;
    const porDia = new Map();        // { 'YYYY-MM-DD': n }
    const porHoraHoy = new Map();    // { 0..23: n }
    const porRelacion = new Map();
    const porFuente = new Map();
    const porIntereses = {
      early_access: 0,
      descuentos: 0,
      backstage: 0,
      comunidad: 0,
    };

    for (const r of registros) {
      const created = r.created_at ? new Date(r.created_at) : null;
      if (created && !Number.isNaN(created.getTime())) {
        const createdAR = new Date(created.getTime() - 3 * 60 * 60 * 1000);
        const ymd = createdAR.toISOString().slice(0, 10);
        if (ymd === yyyymmddHoy) {
          hoy += 1;
          const hora = createdAR.getUTCHours();
          porHoraHoy.set(hora, (porHoraHoy.get(hora) || 0) + 1);
        }
        if (created >= semanaCutoff) semana += 1;
        if (created >= treintaDiasCutoff) {
          porDia.set(ymd, (porDia.get(ymd) || 0) + 1);
        }
      }
      if (r.relacion) porRelacion.set(r.relacion, (porRelacion.get(r.relacion) || 0) + 1);
      if (r.fuente) porFuente.set(r.fuente, (porFuente.get(r.fuente) || 0) + 1);
      if (r.quiere_early_access) porIntereses.early_access += 1;
      if (r.quiere_descuentos) porIntereses.descuentos += 1;
      if (r.quiere_backstage) porIntereses.backstage += 1;
      if (r.quiere_comunidad) porIntereses.comunidad += 1;
    }

    return res.json({
      disponible: true,
      total,
      hoy,
      semana,
      porDia: [...porDia.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([fecha, n]) => ({ fecha, n })),
      porHoraHoy: [...porHoraHoy.entries()].sort(([a], [b]) => a - b).map(([hora, n]) => ({ hora, n })),
      porIntereses,
      porRelacion: Object.fromEntries(porRelacion),
      porFuente: Object.fromEntries(porFuente),
    });
  } catch (err) {
    console.error('Error en dashboard.waitlist:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

module.exports = {
  resumen,
  ventasTimeline,
  distribucionTandas,
  comparativaEventos,
  aporteExtra,
  cadenciaTandas,
  validacionQR,
  topCupones,
  waitlist,
};
