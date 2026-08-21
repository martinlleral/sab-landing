const { v4: uuidv4 } = require('uuid');
const prisma = require('../utils/prisma');
const qrService = require('../services/qr.service');
const brevoService = require('../services/brevo.service');
const { getTandaVigente } = require('../services/tandas.service');
const {
  ESTADOS_MENU_OCUPADO, contarMenusOcupados, calcularMenusRestantes, menuVentaCerrada,
  calcularCorteMenu,
} = require('../services/precios.service');
const { compararPorApellido } = require('../utils/orden');

// Adjunta al evento la tandaVigente calculada + precio/stock derivados para el
// frontend público. No reemplaza los campos legacy del evento (ese cleanup es
// en Fase B); los suma al response para que el frontend pueda migrar sin
// downtime de lectura.
function adjuntarTandaVigente(evento) {
  const vigente = getTandaVigente(evento.tandas);
  return { ...evento, tandaVigente: vigente };
}

/**
 * Adjunta a cada evento el estado de su menú para el checkout público:
 *
 *   `menusRestantes` (S2) — cuántos menús quedan. null = SIN TOPE, que no es lo
 *      mismo que 0 (agotado); el checkout distingue los dos casos.
 *   `menuCerrado` (S3) — si ya pasó el corte horario del día del evento.
 *
 * Los dos se resuelven acá y no en el front a propósito: con el RELOJ DEL
 * SERVIDOR y con una sola definición de la regla. Que el navegador tenga la hora
 * mal es común; que la tenga mal el servidor que además valida la compra, no.
 * Igual es información que puede envejecer con el modal abierto — la garantía la
 * da el backend al crear la preferencia (`MENU_CORTE_PASADO`), esto es lo que
 * evita que la persona llegue hasta el botón de pagar.
 *
 * El cupo se resuelve en UNA query para toda la lista, no una por evento: la
 * portada puede traer hasta 50 eventos y un aggregate por cada uno serían 50
 * viajes a la base en el endpoint más caliente del sitio.
 *
 * El conteo usa `ESTADOS_MENU_OCUPADO` — la misma definición de "cupo tomado"
 * que la reserva atómica, para que el número que ve el comprador y el que aplica
 * el backend no puedan divergir.
 */
async function adjuntarEstadoMenu(eventos) {
  const conMenu = eventos.filter((e) => e.menuHabilitado);
  if (conMenu.length === 0) {
    return eventos.map((e) => ({ ...e, menusRestantes: null, menuCerrado: false }));
  }

  // La hora de corte es global (Home.menuCorteHora): una lectura para toda la lista.
  const home = await prisma.home.findFirst({ select: { menuCorteHora: true } });
  const corteHora = home?.menuCorteHora ?? null;
  const ahora = new Date();
  const estaCerrado = (ev) => {
    if (!ev.menuHabilitado) return false;
    try {
      return menuVentaCerrada(ev.fecha, corteHora, ahora);
    } catch (err) {
      // MENU_CORTE_INVALIDO: la config quedó rota (solo se llega editando la base
      // a mano, la whitelist del CMS no deja persistir basura). Se muestra cerrado
      // en vez de tumbar la portada entera: el checkout aplica el mismo criterio
      // y responde 400 con el motivo, así que las dos capas dicen lo mismo.
      console.error('[menu] menuCorteHora inválido en Home:', corteHora, err.code || err.message);
      return true;
    }
  };

  const conTope = conMenu.filter((e) => e.topeMenus !== null);
  let ocupados = new Map();
  if (conTope.length > 0) {
    const filas = await prisma.compra.groupBy({
      by: ['eventoId'],
      where: {
        eventoId: { in: conTope.map((e) => e.id) },
        mpEstado: { in: ESTADOS_MENU_OCUPADO },
      },
      _sum: { cantidadMenus: true },
    });
    ocupados = new Map(filas.map((f) => [f.eventoId, f._sum.cantidadMenus || 0]));
  }

  return eventos.map((e) => ({
    ...e,
    menusRestantes: (e.menuHabilitado && e.topeMenus !== null)
      ? calcularMenusRestantes(e.topeMenus, ocupados.get(e.id) || 0)
      : null,
    menuCerrado: estaCerrado(e),
  }));
}

// Threshold mínimo de `fecha` para que un evento siga visible en la portada:
// el evento debe seguir mostrándose durante todo el día calendario ART
// (Argentina, UTC-3) hasta las 00:00 ART del día siguiente. Las fechas se
// guardan a las 12:00 UTC del día del evento (parsearFechaLocal), así que el
// threshold es el mediodía UTC del día calendario ART actual.
function umbralVisibilidadART() {
  const ahora = new Date();
  const ahoraART = new Date(ahora.getTime() - 3 * 60 * 60 * 1000);
  const yyyy = ahoraART.getUTCFullYear();
  const mm = String(ahoraART.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(ahoraART.getUTCDate()).padStart(2, '0');
  return new Date(`${yyyy}-${mm}-${dd}T12:00:00.000Z`);
}

async function getDestacado(req, res) {
  try {
    const evento = await prisma.evento.findFirst({
      where: {
        esDestacado: true,
        estaPublicado: true,
        fecha: { gte: umbralVisibilidadART() },
      },
      include: { tandas: { orderBy: { orden: 'asc' } } },
    });
    if (!evento) return res.status(404).json({ error: 'No hay evento destacado' });
    const [conMenus] = await adjuntarEstadoMenu([adjuntarTandaVigente(evento)]);
    return res.json(conMenus);
  } catch (err) {
    console.error('Error en getDestacado:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

async function getProximos(req, res) {
  try {
    const eventos = await prisma.evento.findMany({
      where: {
        estaPublicado: true,
        fecha: { gte: umbralVisibilidadART() },
      },
      orderBy: { fecha: 'asc' },
      // La portada los muestra en un carrusel (cuántos se ven a la vez lo decide
      // el front con Home.eventosVisiblesPortada). Acá devolvemos todos los
      // publicados vigentes, con un tope de seguridad alto para no traer ilimitado.
      take: 50,
      include: { tandas: { orderBy: { orden: 'asc' } } },
    });
    return res.json(await adjuntarEstadoMenu(eventos.map(adjuntarTandaVigente)));
  } catch (err) {
    console.error('Error en getProximos:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

async function adminListar(req, res) {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const [eventos, total] = await Promise.all([
      prisma.evento.findMany({
        orderBy: { fecha: 'desc' },
        skip,
        take: limit,
        include: {
          _count: { select: { compras: true } },
          tandas: { orderBy: { orden: 'asc' } },
        },
      }),
      prisma.evento.count(),
    ]);

    return res.json({ eventos: eventos.map(adjuntarTandaVigente), total, page, totalPages: Math.ceil(total / limit) });
  } catch (err) {
    console.error('Error en adminListar eventos:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

async function adminListarPasados(req, res) {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const [eventos, total] = await Promise.all([
      prisma.evento.findMany({
        where: { fecha: { lt: new Date() } },
        orderBy: { fecha: 'desc' },
        skip,
        take: limit,
        include: {
          _count: { select: { compras: true } },
          tandas: { orderBy: { orden: 'asc' } },
        },
      }),
      prisma.evento.count({ where: { fecha: { lt: new Date() } } }),
    ]);

    return res.json({ eventos: eventos.map(adjuntarTandaVigente), total, page, totalPages: Math.ceil(total / limit) });
  } catch (err) {
    console.error('Error en adminListarPasados:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

async function adminGetById(req, res) {
  try {
    const id = parseInt(req.params.id);
    const evento = await prisma.evento.findUnique({
      where: { id },
      include: {
        compras: {
          orderBy: { createdAt: 'desc' },
          take: 50,
          include: { tanda: { select: { nombre: true, precio: true } } },
        },
        _count: { select: { compras: true } },
        tandas: { orderBy: { orden: 'asc' } },
      },
    });
    if (!evento) return res.status(404).json({ error: 'Evento no encontrado' });
    const [conMenus] = await adjuntarEstadoMenu([adjuntarTandaVigente(evento)]);
    return res.json(conMenus);
  } catch (err) {
    console.error('Error en adminGetById evento:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// Parsea una fecha en formato YYYY-MM-DD como mediodía UTC,
// para que al leerla en cualquier timezone (Argentina UTC-3 incluido) muestre el día correcto.
function parsearFechaLocal(fechaStr) {
  // Si ya viene con tiempo, devolverla tal cual
  if (typeof fechaStr === 'string' && fechaStr.includes('T')) return new Date(fechaStr);
  // Si es solo fecha YYYY-MM-DD, parsearla como mediodía UTC
  return new Date(fechaStr + 'T12:00:00.000Z');
}

// Campos override de los box "El Evento" en home pública. Si están vacíos,
// el frontend cae a lo derivado del evento o a los defaults de Home.
const BOX_OVERRIDE_FIELDS = [
  'boxDiaOverride', 'boxFechaOverride', 'boxHoraOverride',
  'boxLugarOverride', 'boxDireccionOverride', 'boxCiudadOverride',
  'boxPrecioOverride', 'boxEtiquetaEntradaOverride',
];

/**
 * Parsea el tope de menús del FormData del backoffice (Sprint 7, S2).
 *
 *   undefined  → el request no manda el campo: NO tocar lo guardado
 *   ''         → el operador lo vació: sin tope (null)
 *   entero ≥ 0 → ese tope
 *   basura     → NO tocar lo guardado (misma guarda que precioMenu en updateHome:
 *                un valor inválido no debe pisar un tope válido en silencio)
 *
 * Un tope de 0 es legítimo y distinto de null: "este evento no vende más menús".
 */
function parseTopeMenus(raw) {
  if (raw === undefined || raw === null) return undefined;
  const s = String(raw).trim();
  if (s === '') return null;
  if (!/^\d+$/.test(s)) return undefined;
  const n = parseInt(s, 10);
  return Number.isInteger(n) ? n : undefined;
}

async function adminCrear(req, res) {
  try {
    const {
      nombre, descripcion, fecha, hora, invitado,
      precioEntrada, cantidadDisponible,
      esDestacado, estaPublicado, estaAgotado, esExterno, linkExterno,
      menuHabilitado, topeMenus,
    } = req.body;

    if (!nombre || !descripcion || !fecha || !hora || !precioEntrada || !cantidadDisponible) {
      return res.status(400).json({ error: 'Faltan campos requeridos' });
    }

    const flyerUrl = req.file ? `/assets/img/uploads/eventos/${req.file.filename}` : '';
    const precioInt = parseInt(precioEntrada);
    const cupoInt = parseInt(cantidadDisponible);

    // Evento + Tanda "General" default atómicamente. La tanda es la fuente
    // de verdad de venta. Los campos precio/cupo del form se usan sólo
    // para poblar la tanda default — el Evento ya no los persiste.
    const dataEvento = {
      nombre,
      descripcion,
      fecha: parsearFechaLocal(fecha),
      hora,
      invitado: invitado || '',
      flyerUrl,
      esDestacado: esDestacado === 'true' || esDestacado === true,
      estaPublicado: estaPublicado === 'true' || estaPublicado === true,
      estaAgotado: estaAgotado === 'true' || estaAgotado === true,
      esExterno: esExterno === 'true' || esExterno === true,
      linkExterno: linkExterno || null,
      // Menú de la sede: el form de "Nuevo evento" trae el mismo toggle que el de
      // edición, así que se lee también acá. Sin esto, marcarlo al crear el evento
      // se perdía en silencio y había que volver a entrar a editarlo.
      menuHabilitado: menuHabilitado === 'true' || menuHabilitado === true,
      tandas: {
        create: [{
          nombre: 'General',
          precio: precioInt,
          orden: 1,
          activa: true,
          capacidad: cupoInt > 0 ? cupoInt : null,
          cantidadVendida: 0,
        }],
      },
    };
    // Tope de menús: mismo motivo que menuHabilitado — el form de "Nuevo evento"
    // trae el campo, y sin leerlo acá el tope cargado al crear se perdía.
    const topeCrear = parseTopeMenus(topeMenus);
    if (topeCrear !== undefined) dataEvento.topeMenus = topeCrear;

    for (const f of BOX_OVERRIDE_FIELDS) {
      if (req.body[f] !== undefined) dataEvento[f] = String(req.body[f]).trim();
    }

    const evento = await prisma.evento.create({
      data: dataEvento,
      include: { tandas: true },
    });

    return res.status(201).json(evento);
  } catch (err) {
    console.error('Error en adminCrear evento:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

async function adminEditar(req, res) {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.evento.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Evento no encontrado' });

    const {
      nombre, descripcion, fecha, hora, invitado,
      esDestacado, estaPublicado, estaAgotado, esExterno, linkExterno,
      menuHabilitado, topeMenus,
    } = req.body;

    const data = {};
    if (nombre !== undefined) data.nombre = nombre;
    if (descripcion !== undefined) data.descripcion = descripcion;
    if (fecha !== undefined) data.fecha = parsearFechaLocal(fecha);
    if (hora !== undefined) data.hora = hora;
    if (invitado !== undefined) data.invitado = invitado;
    if (esDestacado !== undefined) data.esDestacado = esDestacado === 'true' || esDestacado === true;
    if (estaPublicado !== undefined) data.estaPublicado = estaPublicado === 'true' || estaPublicado === true;
    if (estaAgotado !== undefined) data.estaAgotado = estaAgotado === 'true' || estaAgotado === true;
    if (esExterno !== undefined) data.esExterno = esExterno === 'true' || esExterno === true;
    if (linkExterno !== undefined) data.linkExterno = linkExterno || null;
    // Menú de la sede (Sprint 7): toggle por evento. Llega como string desde el
    // FormData del backoffice. El precio es global (Home.precioMenu); acá solo se
    // decide si ESTE evento lo ofrece. Apagarlo no toca las compras ya hechas.
    if (menuHabilitado !== undefined) {
      data.menuHabilitado = menuHabilitado === 'true' || menuHabilitado === true;
    }
    // Tope de menús (S2). Bajarlo por debajo de lo ya vendido no rompe nada: el
    // cupo restante se calcula con Math.max(0, ...) y simplemente queda en 0.
    const topeEditar = parseTopeMenus(topeMenus);
    if (topeEditar !== undefined) data.topeMenus = topeEditar;
    if (req.file) data.flyerUrl = `/assets/img/uploads/eventos/${req.file.filename}`;
    for (const f of BOX_OVERRIDE_FIELDS) {
      if (req.body[f] !== undefined) data[f] = String(req.body[f]).trim();
    }

    const evento = await prisma.evento.update({ where: { id }, data });
    return res.json(evento);
  } catch (err) {
    console.error('Error en adminEditar evento:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

async function adminEliminar(req, res) {
  try {
    const id = parseInt(req.params.id);

    // Eliminar entradas de todas las compras del evento
    const compras = await prisma.compra.findMany({ where: { eventoId: id }, select: { id: true } });
    const compraIds = compras.map(c => c.id);
    if (compraIds.length) {
      await prisma.entrada.deleteMany({ where: { compraId: { in: compraIds } } });
    }
    // Eliminar compras del evento
    await prisma.compra.deleteMany({ where: { eventoId: id } });
    // Eliminar evento
    await prisma.evento.delete({ where: { id } });

    return res.json({ ok: true });
  } catch (err) {
    console.error('Error en adminEliminar evento:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

async function adminEnviarInvitacion(req, res) {
  try {
    const eventoId = parseInt(req.params.id);
    const { email, nombre, apellido } = req.body;

    if (!email) return res.status(400).json({ error: 'Email requerido' });

    const evento = await prisma.evento.findUnique({
      where: { id: eventoId },
      include: { tandas: true },
    });
    if (!evento) return res.status(404).json({ error: 'Evento no encontrado' });

    const tandaVigente = getTandaVigente(evento.tandas);
    if (!tandaVigente) {
      return res.status(400).json({ error: 'El evento no tiene tanda vigente — no se pueden enviar invitaciones' });
    }

    const compra = await prisma.compra.create({
      data: {
        eventoId,
        tandaId: tandaVigente.id,
        email,
        nombre: nombre || 'Invitado',
        apellido: apellido || '',
        cantidadEntradas: 1,
        precioUnitario: 0,
        totalPagado: 0,
        mpEstado: 'approved',
        mpPreferenciaId: `inv-${Date.now()}`,
      },
    });

    // Las invitaciones consumen cupo de la tanda vigente (fuente de verdad única).
    await prisma.tanda.update({
      where: { id: tandaVigente.id },
      data: { cantidadVendida: { increment: 1 } },
    });

    const codigo = uuidv4();
    const qrImageUrl = await qrService.generarQR(codigo);
    const entrada = await prisma.entrada.create({
      data: { compraId: compra.id, codigoQR: codigo, qrImageUrl },
    });
    const qrBase64 = await qrService.generarQRBase64(codigo);

    try {
      // Timeout de 15s para envío de email
      await Promise.race([
        brevoService.enviarInvitacion({
          email,
          nombre: nombre || 'Invitado',
          evento,
          entrada: { ...entrada, qrBase64: qrBase64.split(',')[1] },
        }),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Email timeout (15s)')), 15000)
        )
      ]);
      console.log(`✅ Invitación enviada a ${email}`);
    } catch (mailErr) {
      console.error('❌ Error al enviar email invitación:', mailErr.message);
      // No crítico - la entrada ya fue creada
    }

    return res.status(201).json({ compra, entrada });
  } catch (err) {
    console.error('Error en adminEnviarInvitacion:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// Stats agregadas por evento. Calcula todo en BD (groupBy + aggregate) para
// que el backoffice no tenga que iterar sobre la página visible. Es la fuente
// de verdad para los boxes de "Vendidas / Invitaciones / Pendientes / Restante /
// Recaudado" del header del evento. Hasta que exista el dashboard de Uriel,
// estos números son la única herramienta para decidir, así que se devuelven
// completos y siempre coherentes con la BD.
async function adminEventoStats(req, res) {
  try {
    const eventoId = parseInt(req.params.id);
    if (!eventoId) return res.status(400).json({ error: 'ID inválido' });

    const evento = await prisma.evento.findUnique({
      where: { id: eventoId },
      include: { tandas: { orderBy: { orden: 'asc' } } },
    });
    if (!evento) return res.status(404).json({ error: 'Evento no encontrado' });

    const [vendidasAgg, invitacionesAgg, pendientesAgg, rechazadasAgg, canceladasAgg] = await Promise.all([
      prisma.compra.aggregate({
        where: { eventoId, mpEstado: 'approved', totalPagado: { gt: 0 } },
        _sum: { cantidadEntradas: true, totalPagado: true },
        _count: { _all: true },
      }),
      prisma.compra.aggregate({
        where: { eventoId, mpEstado: 'approved', totalPagado: 0 },
        _sum: { cantidadEntradas: true },
        _count: { _all: true },
      }),
      prisma.compra.aggregate({
        where: { eventoId, mpEstado: 'pending' },
        _sum: { cantidadEntradas: true },
        _count: { _all: true },
      }),
      prisma.compra.count({ where: { eventoId, mpEstado: 'rejected' } }),
      prisma.compra.count({ where: { eventoId, mpEstado: 'cancelled' } }),
    ]);

    const entradasVendidas = vendidasAgg._sum.cantidadEntradas || 0;
    const entradasInvitaciones = invitacionesAgg._sum.cantidadEntradas || 0;
    const entradasPendientes = pendientesAgg._sum.cantidadEntradas || 0;
    const recaudado = vendidasAgg._sum.totalPagado || 0;

    // Menú de la sede (Sprint 7). `totalPagado` incluye el menú, así que
    // `recaudado` viene inflado con plata que la coop le debe pagar a la sede. Se
    // lee de la compra (menuUnitario está congelado por compra) con los mismos
    // filtros que `vendidasAgg`, para que `recaudadoSab` cierre exacto.
    const menusRow = await prisma.$queryRaw`
      SELECT COALESCE(SUM(cantidadMenus * menuUnitario), 0) AS totalMenus,
             COALESCE(SUM(cantidadMenus), 0) AS cantidadMenus
      FROM Compra
      WHERE eventoId = ${eventoId} AND mpEstado = 'approved' AND totalPagado > 0
    `;
    const menusTotal = Number(menusRow[0]?.totalMenus || 0);
    const menusCantidad = Number(menusRow[0]?.cantidadMenus || 0);

    // Menús pendientes de pago: no están cocinados ni cobrados, pero la cocina
    // necesita saber que existen (el reporte de las 18 sale con lo aprobado).
    const menusPendientesRow = await prisma.$queryRaw`
      SELECT COALESCE(SUM(cantidadMenus), 0) AS cantidadMenus
      FROM Compra
      WHERE eventoId = ${eventoId} AND mpEstado = 'pending'
    `;
    const menusPendientes = Number(menusPendientesRow[0]?.cantidadMenus || 0);

    // Cupo del menú (S2). OJO: `menusCantidad` de arriba filtra `totalPagado > 0`
    // (deja afuera las invitaciones) porque sirve para la PLATA. El cupo es otra
    // pregunta — cuántos platos hay que cocinar — y se cuenta con la definición
    // única de `contarMenusOcupados`: aprobadas + pendientes, valgan lo que valgan.
    // Calcular el restante restando los números de arriba daría un cupo inflado.
    const menusOcupados = evento.topeMenus === null
      ? null
      : await contarMenusOcupados(prisma, eventoId);

    // Capacidad del evento: suma de capacidades de todas las tandas. Si alguna
    // tanda tiene capacidad null (sin límite), el total del evento es null (∞).
    const tandas = evento.tandas;
    let capacidadEvento = 0;
    let capacidadInfinita = false;
    for (const t of tandas) {
      if (t.capacidad === null) { capacidadInfinita = true; break; }
      capacidadEvento += t.capacidad;
    }
    const vendidaEvento = tandas.reduce((s, t) => s + t.cantidadVendida, 0);
    const restanteEvento = capacidadInfinita ? null : (capacidadEvento - vendidaEvento);

    // Tanda vigente (la que el público está comprando ahora). Puede no existir
    // si todas están agotadas o desactivadas.
    const vigente = getTandaVigente(tandas);
    const tandaVigente = vigente ? {
      id: vigente.id,
      nombre: vigente.nombre,
      precio: vigente.precio,
      capacidad: vigente.capacidad,
      vendida: vigente.cantidadVendida,
      restante: vigente.capacidad === null ? null : (vigente.capacidad - vigente.cantidadVendida),
    } : null;

    return res.json({
      compras: {
        total: vendidasAgg._count._all + invitacionesAgg._count._all + pendientesAgg._count._all + rechazadasAgg + canceladasAgg,
        vendidas: vendidasAgg._count._all,
        invitaciones: invitacionesAgg._count._all,
        pendientes: pendientesAgg._count._all,
        rechazadas: rechazadasAgg,
        canceladas: canceladasAgg,
      },
      entradas: {
        vendidas: entradasVendidas,
        invitaciones: entradasInvitaciones,
        pendientes: entradasPendientes,
        aprobadas: entradasVendidas + entradasInvitaciones,
      },
      // `recaudado` es todo lo cobrado por MP (incluye el menú de la sede, que es
      // lo que concilia contra MP). `recaudadoSab` es lo que le queda a la coop.
      recaudado,
      recaudadoSab: recaudado - menusTotal,
      menus: {
        cantidad: menusCantidad,
        total: menusTotal,
        pendientes: menusPendientes,
        // Cupo: null en los tres cuando el evento no tiene tope.
        tope: evento.topeMenus,
        ocupados: menusOcupados,
        restantes: calcularMenusRestantes(evento.topeMenus, menusOcupados),
      },
      capacidad: {
        evento: capacidadInfinita ? null : capacidadEvento,
        vendidaEvento,
        restanteEvento,
        tandaVigente,
      },
    });
  } catch (err) {
    console.error('Error en adminEventoStats:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * Lista de menús para la cocina de la sede (ítem 44, Sprint 7 · S4).
 *
 * ESTE ENDPOINT ALIMENTA EL CONTROL DE ENTREGA REAL. Por decisión de producto
 * del 16/8 no hay segundo QR: en la puerta se tilda la hoja impresa. Y desde el
 * hallazgo 📋 de R1, además, es lo único que hace verdadero al mail de
 * confirmación, que le promete al comprador "dá tu nombre y apellido — ya estás
 * en la lista". Por eso devuelve NOMBRES, no solo agregados: sin nombres, la
 * lista que el mail promete no existe.
 *
 * ⚠️ QUÉ CUENTA CADA NÚMERO. Hay tres conteos de menús en el sistema y NO son
 * intercambiables (es el desvío 3 de S2, que ya casi hace cocinar de menos):
 *
 *   - `adminEventoStats.menus.cantidad` mide **plata**: filtra `totalPagado > 0`,
 *     o sea deja afuera las invitaciones. Sirve para la contabilidad.
 *   - `adminEventoStats.menus.ocupados` mide **cupo**: aprobadas + pendientes,
 *     valga lo que valga la compra. Es lo que corta la venta en el checkout.
 *   - lo que devuelve ESTE endpoint mide **platos aprobados**: lo que hay que
 *     cocinar. Es la suma de las filas que se imprimen, y se calcula sumando
 *     esas mismas filas a propósito — así el total de la hoja no puede
 *     divergir de lo que la hoja lista, que es el criterio de éxito de S4.
 *
 * Hoy los tres coinciden casi siempre (una invitación no lleva menús y una
 * compra con menú tiene total > 0 porque el cupón no toca el menú), pero son
 * definiciones distintas. La que le importa a la cocina es la de los platos.
 *
 * PENDIENTES (criterio cerrado por S3, §5 del documento madre): no se ocultan
 * ni se suman al total. El corte de las 18:00 se evalúa al CREAR la compra, así
 * que quien pagó por Rapipago a las 17:55 compró en horario y su cupo ya está
 * reservado — pero nadie cobró todavía. Van advertidos aparte, con nombre, y
 * quien decide cocinar de más es la sede, no el software.
 */
async function adminEventoMenus(req, res) {
  try {
    const eventoId = parseInt(req.params.id);
    if (!eventoId) return res.status(400).json({ error: 'ID inválido' });

    const evento = await prisma.evento.findUnique({
      where: { id: eventoId },
      select: {
        id: true, nombre: true, fecha: true, hora: true,
        menuHabilitado: true, topeMenus: true,
      },
    });
    if (!evento) return res.status(404).json({ error: 'Evento no encontrado' });

    // Una sola query para las dos listas: `ESTADOS_MENU_OCUPADO` es la misma
    // definición de "compra viva" que usa la reserva del cupo. Reusarla es lo
    // que hace que valga el invariante `aprobados + pendientes === ocupados`:
    // la hoja de la cocina y el contador que corta la venta miran lo mismo.
    // Sin email ni teléfono: esta hoja va a la cocina y a la puerta, no a la
    // administración, y sale impresa de un sistema que guarda PII.
    const filas = await prisma.compra.findMany({
      where: {
        eventoId,
        cantidadMenus: { gt: 0 },
        mpEstado: { in: ESTADOS_MENU_OCUPADO },
      },
      select: {
        id: true, nombre: true, apellido: true,
        cantidadMenus: true, cantidadEntradas: true, mpEstado: true,
      },
    });

    const aprobadas = filas.filter((c) => c.mpEstado === 'approved').sort(compararPorApellido);
    const pendientes = filas.filter((c) => c.mpEstado === 'pending').sort(compararPorApellido);
    const sumarMenus = (arr) => arr.reduce((s, c) => s + (c.cantidadMenus || 0), 0);

    // Hora de emisión: la del SERVIDOR, no la del navegador que imprime. Es el
    // dato que le dice a la cocina si esta hoja es anterior o posterior al
    // corte, y comparar el corte contra un reloj que puede estar corrido sería
    // el mismo error que S3 sacó del front.
    const emitidoEn = new Date();
    const home = await prisma.home.findFirst({ select: { menuCorteHora: true } });
    const corteHora = home?.menuCorteHora ?? null;
    let corte = null;
    try {
      corte = corteHora && evento.menuHabilitado
        ? {
          hora: corteHora,
          instante: calcularCorteMenu(evento.fecha, corteHora).toISOString(),
          pasado: menuVentaCerrada(evento.fecha, corteHora, emitidoEn),
        }
        : null;
    } catch (err) {
      // MENU_CORTE_INVALIDO: config rota (solo se llega editando la base a
      // mano). La hoja se imprime igual —la cocina la necesita— pero sin
      // afirmar que la lista está cerrada, que es lo que no se puede sostener.
      console.error('[menu] menuCorteHora inválido en Home:', corteHora, err.code || err.message);
      corte = null;
    }

    return res.json({
      evento,
      emitidoEn: emitidoEn.toISOString(),
      corte,
      aprobadas,
      pendientes,
      totales: {
        // El número contra el que cocina la sede.
        menusAprobados: sumarMenus(aprobadas),
        comprasAprobadas: aprobadas.length,
        // Advertencia, no suma.
        menusPendientes: sumarMenus(pendientes),
        comprasPendientes: pendientes.length,
      },
    });
  } catch (err) {
    console.error('Error en adminEventoMenus:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// Stats globales del backoffice (dashboard). Mismo principio que el endpoint
// por evento: todo agregado en BD para que el dashboard no tenga que sumar
// sobre una página de 20 compras (el bug que motivó este endpoint).
async function adminStatsGlobal(req, res) {
  try {
    const [totalEventos, totalCompras, vendidasAgg, invitacionesAgg] = await Promise.all([
      prisma.evento.count(),
      prisma.compra.count(),
      prisma.compra.aggregate({
        where: { mpEstado: 'approved', totalPagado: { gt: 0 } },
        _sum: { cantidadEntradas: true, totalPagado: true },
        _count: { _all: true },
      }),
      prisma.compra.aggregate({
        where: { mpEstado: 'approved', totalPagado: 0 },
        _sum: { cantidadEntradas: true },
        _count: { _all: true },
      }),
    ]);

    // Menú de la sede (Sprint 7): la misma resta que en el resto de los reportes.
    // Sin esto, el KPI grande del dashboard suma como propia la plata de la sede.
    const menusRow = await prisma.$queryRaw`
      SELECT COALESCE(SUM(cantidadMenus * menuUnitario), 0) AS totalMenus,
             COALESCE(SUM(cantidadMenus), 0) AS cantidadMenus
      FROM Compra
      WHERE mpEstado = 'approved' AND totalPagado > 0
    `;
    const menusTotal = Number(menusRow[0]?.totalMenus || 0);
    const menusCantidad = Number(menusRow[0]?.cantidadMenus || 0);
    const recaudado = vendidasAgg._sum.totalPagado || 0;

    return res.json({
      totalEventos,
      totalCompras,
      comprasAprobadas: vendidasAgg._count._all + invitacionesAgg._count._all,
      entradasVendidas: vendidasAgg._sum.cantidadEntradas || 0,
      entradasInvitaciones: invitacionesAgg._sum.cantidadEntradas || 0,
      recaudado,
      recaudadoSab: recaudado - menusTotal,
      menus: { cantidad: menusCantidad, total: menusTotal },
    });
  } catch (err) {
    console.error('Error en adminStatsGlobal:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

async function adminListarInvitaciones(req, res) {
  try {
    const eventoId = parseInt(req.params.id);
    const invitaciones = await prisma.compra.findMany({
      where: { eventoId, totalPagado: 0, mpEstado: 'approved' },
      include: { entradas: { select: { id: true, codigoQR: true, qrImageUrl: true, validada: true, validadaAt: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return res.json(invitaciones);
  } catch (err) {
    console.error('Error en adminListarInvitaciones:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

module.exports = {
  getDestacado,
  getProximos,
  adminListar,
  adminListarPasados,
  adminGetById,
  adminCrear,
  adminEditar,
  adminEliminar,
  adminEnviarInvitacion,
  adminListarInvitaciones,
  adminEventoStats,
  adminEventoMenus,
  adminStatsGlobal,
};
