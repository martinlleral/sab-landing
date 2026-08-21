const crypto = require('crypto');
const prisma = require('../utils/prisma');
const config = require('../config');
const mpService = require('../services/mercadopago.service');
const brevoService = require('../services/brevo.service');
const qrService = require('../services/qr.service');
const { procesarPagoAprobado, revertirCompraAprobada } = require('../services/pagos.service');
const { getTandaVigente } = require('../services/tandas.service');
const { calcularTotalCompra, reservarCupon, validarCupon, OFFSET_ART_HORAS } = require('../services/precios.service');
const { compararPorApellido } = require('../utils/orden');
const { serializarCSV, slugArchivo } = require('../utils/csv');
// El módulo entero, además de los destructurados: las funciones del tope de menús
// se llaman como `precios.x()` para que los tests puedan monkey-patchear el
// pre-chequeo y simular una lectura vieja (patrón sin jest del proyecto, el mismo
// que usa pagos.service.js con `precios.liberarCupon`).
const precios = require('../services/precios.service');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Verifica la firma HMAC-SHA256 del webhook MP.
// Manifest: id:<data.id>;request-id:<x-request-id>;ts:<ts>;
// Docs: https://www.mercadopago.com.ar/developers/es/docs/your-integrations/notifications/webhooks
function verifyMpSignature(req, secret) {
  const sigHeader = req.headers['x-signature'];
  const requestId = req.headers['x-request-id'];
  if (!sigHeader || !requestId) return { valid: false, reason: 'missing_headers' };

  let ts, v1;
  for (const part of String(sigHeader).split(',')) {
    const [rawKey, rawVal] = part.split('=');
    if (!rawKey || !rawVal) continue;
    const key = rawKey.trim();
    const val = rawVal.trim();
    if (key === 'ts') ts = val;
    else if (key === 'v1') v1 = val;
  }
  if (!ts || !v1) return { valid: false, reason: 'malformed_signature' };

  const dataId = req.query['data.id'] || req.body?.data?.id;
  if (!dataId) return { valid: false, reason: 'missing_data_id' };

  const manifest = `id:${String(dataId)};request-id:${requestId};ts:${ts};`;
  const expected = crypto.createHmac('sha256', secret).update(manifest).digest('hex');

  let expectedBuf, v1Buf;
  try {
    expectedBuf = Buffer.from(expected, 'hex');
    v1Buf = Buffer.from(v1, 'hex');
  } catch {
    return { valid: false, reason: 'hex_decode' };
  }
  if (expectedBuf.length !== v1Buf.length) return { valid: false, reason: 'length_mismatch' };

  const ok = crypto.timingSafeEqual(expectedBuf, v1Buf);
  return { valid: ok, reason: ok ? 'ok' : 'hmac_mismatch' };
}

async function crearPreferencia(req, res) {
  try {
    const {
      eventoId, email, nombre, apellido, telefono, cantidad, tipoEntrada, cuponCodigo,
      cantidadMenus,
    } = req.body;

    if (!eventoId || !email || !nombre || !apellido || !cantidad) {
      return res.status(400).json({ error: 'Faltan campos requeridos' });
    }

    const evento = await prisma.evento.findUnique({
      where: { id: parseInt(eventoId) },
      include: { tandas: true },
    });
    if (!evento) return res.status(404).json({ error: 'Evento no encontrado' });
    if (!evento.estaPublicado) return res.status(400).json({ error: 'Evento no disponible' });
    if (evento.estaAgotado) return res.status(400).json({ error: 'Entradas agotadas para este evento' });

    const tandaVigente = getTandaVigente(evento.tandas);
    if (!tandaVigente) {
      return res.status(400).json({ error: 'Entradas no disponibles para este evento' });
    }

    // Stock de la tanda vigente. Si capacidad es null (sin límite), omitimos la validación.
    const cant = parseInt(cantidad);
    if (tandaVigente.capacidad !== null) {
      const disponibles = tandaVigente.capacidad - tandaVigente.cantidadVendida;
      if (disponibles < cant) {
        return res.status(400).json({ error: `Solo quedan ${disponibles} entradas disponibles` });
      }
    }

    // Menú de Casa Metro: cantidad propia, ortogonal a tipoEntrada. El precio es
    // global (Home.precioMenu) y la compra lo congela. El body puede no traer el
    // campo (checkout de un evento sin menú, o cliente viejo) → 0.
    const menusPedidos = cantidadMenus === undefined || cantidadMenus === null || cantidadMenus === ''
      ? 0
      : parseInt(cantidadMenus);
    let precioMenu = 0;
    let menusRestantes = null;
    // Corte horario (S3): la hora sale de la MISMA lectura de Home que el precio.
    // null = no se pudo leer la config → sin corte; el precio en 0 ya frena la
    // venta por MENU_PRECIO_NO_CONFIGURADO, así que no hace falta una segunda
    // guarda acá.
    let menuCorteHora = null;
    if (Number.isInteger(menusPedidos) && menusPedidos > 0) {
      const home = await prisma.home.findFirst({ select: { precioMenu: true, menuCorteHora: true } });
      precioMenu = home?.precioMenu ?? 0;
      menuCorteHora = home?.menuCorteHora ?? null;

      // Cupo de menús (S2). Pre-chequeo de cortesía: da un mensaje concreto
      // ("quedan 3 y pediste 5") antes de crear nada. Puede quedar viejo entre
      // esta lectura y la compra — la garantía real la da `reservarMenus` dentro
      // de la transacción, igual que validarCupon respecto de reservarCupon.
      if (evento.topeMenus !== null && evento.topeMenus !== undefined) {
        const ocupados = await precios.contarMenusOcupados(prisma, evento.id);
        menusRestantes = precios.calcularMenusRestantes(evento.topeMenus, ocupados);
      }
    }

    // Cálculo del total (aplica tipoEntrada, valida cupón si vino, valida las
    // reglas duras del menú y lo suma DESPUÉS del descuento). Errores del helper
    // traen .code para mapear a 400 con mensaje específico.
    let precioCalc;
    try {
      precioCalc = await calcularTotalCompra(tandaVigente, {
        tipoEntrada,
        cuponCodigo,
        cantidad: cant,
        cantidadMenus: menusPedidos,
        menuHabilitado: evento.menuHabilitado,
        precioMenu,
        menusRestantes,
        // DOBLE CAPA. El front oculta el select pasado el corte, pero alguien
        // pudo abrir la página a las 17:50 y pagar a las 18:05: la validación
        // que vale es esta, con el reloj del servidor.
        fechaEvento: evento.fecha,
        menuCorteHora,
      });
    } catch (err) {
      if (err.code) {
        const payload = { error: err.message, code: err.code };
        // El cupo viaja en el body para que el checkout pueda recortar el select
        // al número real sin pedir el evento de nuevo.
        if (err.menusRestantes !== undefined) payload.menusRestantes = err.menusRestantes;
        if (err.menuCorteHora !== undefined) payload.menuCorteHora = err.menuCorteHora;
        return res.status(400).json(payload);
      }
      throw err;
    }

    const totalPagado = precioCalc.totalPagado;

    // Tx atómica: si hay cupón, re-validamos dentro de la tx (defensa contra
    // cambios del admin entre cálculo y reserva), reservamos el uso, creamos
    // Compra y CuponUso. Si rompe el tope por race, el rollback deja todo intacto.
    let compra;
    try {
      compra = await prisma.$transaction(async (tx) => {
        if (precioCalc.cupon) {
          const cuponActual = await tx.cuponDescuento.findUnique({ where: { id: precioCalc.cupon.id } });
          validarCupon(cuponActual, tandaVigente.eventoId);
          await reservarCupon(tx, precioCalc.cupon.id);
        }

        const nueva = await tx.compra.create({
          data: {
            eventoId: evento.id,
            tandaId: tandaVigente.id,
            email,
            nombre,
            apellido,
            telefono: telefono || '',
            cantidadEntradas: cant,
            precioUnitario: tandaVigente.precio,
            tipoEntrada: precioCalc.tipoEntrada,
            excedenteUnitario: precioCalc.excedenteUnitario,
            cantidadMenus: precioCalc.cantidadMenus,
            menuUnitario: precioCalc.menuUnitario,
            totalPagado,
            mpEstado: 'pending',
          },
        });

        // Reserva atómica del cupo de menús (S2). Va DESPUÉS del create a
        // propósito: el aggregate de `reservarMenus` cuenta la compra recién
        // insertada, así que es "mutar y verificar después con rollback si se
        // pasó" — la misma forma que reservarCupon, sin contador que mantener.
        if (precioCalc.cantidadMenus > 0) {
          await precios.reservarMenus(tx, evento.id, evento.topeMenus);
        }

        if (precioCalc.cupon) {
          await tx.cuponUso.create({
            data: {
              cuponId: precioCalc.cupon.id,
              compraId: nueva.id,
              descuentoAplicado: precioCalc.descuentoUnitario * cant,
            },
          });
        }

        return nueva;
      });
    } catch (err) {
      if (err.code) return res.status(400).json({ error: err.message, code: err.code });
      throw err;
    }

    const preferencia = await mpService.crearPreferencia({
      titulo: `${evento.nombre} — ${cant} entrada(s)`,
      precio: precioCalc.precioUnitarioFinal,
      cantidad: cant,
      email,
      preferenciaId: String(compra.id),
      // El menú va como ítem APARTE de la preferencia, no sumado al precio de la
      // entrada: así el comprador ve las dos líneas en el checkout de MP y el
      // reporte de MP muestra la plata de Casa Metro diferenciada de la del SAB
      // (que es justo lo que pidió el operador). La suma de los ítems da
      // compra.totalPagado, que es lo que el webhook cruza contra
      // transaction_amount — si esto se desalinea, el webhook rechaza el pago.
      itemsExtra: precioCalc.cantidadMenus > 0
        ? [{
          title: `Menú Casa Metro — ${precioCalc.cantidadMenus} menú(s)`,
          unit_price: precioCalc.menuUnitario,
          quantity: precioCalc.cantidadMenus,
        }]
        : undefined,
    });

    await prisma.compra.update({
      where: { id: compra.id },
      data: { mpPreferenciaId: preferencia.id },
    });

    return res.json({
      init_point: preferencia.init_point,
      preferencia_id: preferencia.id,
      compra_id: compra.id,
    });
  } catch (err) {
    console.error('Error en crearPreferencia:', err);
    return res.status(500).json({ error: 'Error al crear la preferencia de pago' });
  }
}

async function webhook(req, res) {
  try {
    const secret = config.mercadopago.webhookSecret;

    // Fail-closed: sin secret configurado, rechazamos todo. Los 3 fallbacks
    // (checkAndProcess desde cliente + syncPagosPendientes cada 60s) igual
    // procesan las compras legítimas, así que cerrar el webhook no pierde ventas.
    if (!secret) {
      console.error(
        '[webhook MP] ERROR: MP_WEBHOOK_SECRET no configurado. ' +
        'Activar firma en panel MP del SAB → Webhooks → Configurar notificaciones.'
      );
      return res.status(503).json({ error: 'webhook_not_configured' });
    }

    const verification = verifyMpSignature(req, secret);
    if (!verification.valid) {
      const ip = req.headers['x-forwarded-for'] || req.ip;
      console.warn(`[webhook MP] WARN: firma inválida (${verification.reason}) desde IP ${ip}`);
      return res.status(401).json({ error: 'invalid_signature' });
    }

    const { type, data } = req.body;
    if (type !== 'payment' || !data || !data.id) {
      return res.sendStatus(200);
    }

    const pago = await mpService.consultarPago(data.id);
    if (!pago || pago.status !== 'approved') return res.sendStatus(200);

    // Validar que el pago corresponde al merchant SAB (si MP_USER_ID está configurado).
    // Previene que alguien reenvíe un webhook firmado de otra cuenta MP.
    const expectedCollector = config.mercadopago.userId;
    if (expectedCollector && String(pago.collector_id) !== String(expectedCollector)) {
      console.warn(
        `[webhook MP] WARN: collector_id mismatch ` +
        `(got ${pago.collector_id}, expected ${expectedCollector}) pago=${pago.id}`
      );
      return res.status(403).json({ error: 'collector_mismatch' });
    }

    const compraId = parseInt(pago.external_reference);
    if (!compraId) return res.sendStatus(200);

    // Cargar la compra para cruzar el monto. Si el monto no coincide, alguien
    // intentó pagar una fracción de una entrada y confirmar la compra completa.
    const compra = await prisma.compra.findUnique({
      where: { id: compraId },
      select: { id: true, totalPagado: true },
    });
    if (!compra) {
      console.warn(`[webhook MP] compra ${compraId} no encontrada (pago ${pago.id})`);
      return res.sendStatus(200);
    }

    const montoPagado = Number(pago.transaction_amount);
    const montoEsperado = Number(compra.totalPagado);
    if (!Number.isFinite(montoPagado) || montoPagado !== montoEsperado) {
      console.warn(
        `[webhook MP] WARN: amount mismatch compra=${compraId} ` +
        `pagado=${montoPagado} esperado=${montoEsperado} pago=${pago.id}`
      );
      return res.status(400).json({ error: 'amount_mismatch' });
    }

    await procesarPagoAprobado(compraId, pago.id);
    return res.sendStatus(200);
  } catch (err) {
    console.error('Error en webhook MP:', err);
    return res.sendStatus(500);
  }
}

async function checkAndProcess(req, res) {
  try {
    const { preferenciaId } = req.params;
    const compra = await prisma.compra.findFirst({
      where: { mpPreferenciaId: preferenciaId },
      include: { evento: true, entradas: true },
    });
    if (!compra) return res.status(404).json({ error: 'Compra no encontrada' });

    // Arma la respuesta de éxito con los códigos QR, para que la página post-pago
    // muestre la(s) entrada(s) en pantalla y el comprador NO dependa del mail (que
    // a veces cae en Promociones/Spam). La búsqueda es por mpPreferenciaId —token
    // largo no enumerable de MP—, así que devolver los codigoQR acá es seguro:
    // solo lo obtiene quien completó ESE checkout. Se re-consultan las entradas
    // (no se usa compra.entradas) por si se acaban de crear en procesarPagoAprobado.
    const responderConEntradas = async () => {
      const entradas = await prisma.entrada.findMany({
        where: { compraId: compra.id },
        select: { codigoQR: true },
        orderBy: { createdAt: 'asc' },
      });
      return {
        status: 'approved',
        compraId: compra.id,
        evento: { nombre: compra.evento.nombre, fecha: compra.evento.fecha, hora: compra.evento.hora },
        entradas: entradas.map((e) => ({ codigoQR: e.codigoQR })),
      };
    };

    // Si ya está aprobada, devolver directamente
    if (compra.mpEstado === 'approved') {
      return res.json(await responderConEntradas());
    }

    // Buscar pagos en MP para esta compra
    const pagos = await mpService.buscarPagoPorCompra(compra.id);
    const aprobado = pagos.find((p) => p.status === 'approved');

    if (aprobado) {
      await procesarPagoAprobado(compra.id, aprobado.id);
      console.log(`✅ checkAndProcess: Compra #${compra.id} procesada desde confirmación`);
      return res.json(await responderConEntradas());
    }

    return res.json({ status: compra.mpEstado, compraId: compra.id });
  } catch (err) {
    console.error('Error en checkAndProcess:', err);
    return res.status(500).json({ error: 'Error al verificar el pago' });
  }
}

/**
 * Estados de MP que el listado admite como filtro explícito.
 *
 * `refunded` no está: las devoluciones se ven bajo "Todos" pero no tienen su
 * propia opción en el select del backoffice. El export lo respeta igual (no
 * inventa un filtro que la pantalla no ofrece) y las incluye por la vía del
 * toggle "incluir todos los estados".
 */
const ESTADOS_VALIDOS = ['approved', 'pending', 'rejected', 'cancelled'];

/**
 * Traduce los query params de filtrado al `where` de Prisma.
 *
 * Vive como función propia porque la usan DOS endpoints que tienen que devolver
 * exactamente el mismo conjunto de compras: el listado paginado que el operador
 * ve en pantalla y el export que se baja desde esa misma pantalla. Si cada uno
 * armara su filtro, el día que uno cambie el CSV va a traer un conjunto distinto
 * del que la pantalla muestra — y el operador no tiene forma de saber cuál de
 * los dos miente. Es el mismo motivo por el que el orden alfabético se extrajo a
 * `utils/orden.js` en el ítem 44: un criterio compartido se escribe una vez.
 *
 * @param {object} query - `req.query`
 * @returns {{where: object, q: string}} el filtro y el término de búsqueda ya
 *   normalizado (el listado lo necesita aparte para decidir si pagina)
 */
function construirFiltroCompras(query) {
  const where = {};
  if (query.eventoId) where.eventoId = parseInt(query.eventoId);
  // Filtro server-side por estado MP. Antes el filtro era client-side sobre la
  // página de 20 visible, lo que daba conteos incoherentes ("33 aprobados en
  // total" vs "10 visibles cuando filtro Aprobados en página 1"). Ahora la
  // BD filtra y el total devuelto refleja el filtro.
  if (query.mpEstado && ESTADOS_VALIDOS.includes(query.mpEstado)) {
    where.mpEstado = query.mpEstado;
  }

  // Búsqueda libre por nombre/apellido/email del comprador. SQLite + Prisma
  // usa LIKE, case-insensitive para ASCII por default. Para acentos exactos,
  // un "Gomez" no matchea "Gómez" — mantenemos la solución simple porque el
  // caso típico es búsqueda parcial de apellido.
  const q = (query.q || '').trim();
  if (q) {
    where.OR = [
      { nombre: { contains: q } },
      { apellido: { contains: q } },
      { email: { contains: q } },
    ];
  }

  // Filtro de validación de entradas. Solo tiene sentido sobre compras
  // approved (las únicas que tienen QR generado), así que forzamos approved
  // si el filtro está activo aunque no venga mpEstado explícito.
  const validacion = query.validacion;
  if (validacion === 'pendiente') {
    where.mpEstado = 'approved';
    where.entradas = { some: { validada: false } };
  } else if (validacion === 'validada') {
    where.mpEstado = 'approved';
    // every: true requiere también `some: {}` para excluir compras sin
    // entradas generadas (every aplica vacuously sobre conjuntos vacíos).
    where.entradas = { some: {}, every: { validada: true } };
  }

  return { where, q };
}

async function adminListar(req, res) {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;
    const { where, q } = construirFiltroCompras(req.query);

    // Orden server-side de las 5 columnas ordenables de la tabla del backoffice.
    // Whitelist explícita: el nombre de columna viene del cliente y no puede
    // llegar crudo al orderBy de Prisma.
    //
    // Antes esto ordenaba solo por 'nombre' | 'fecha' y el frontend re-ordenaba
    // las otras 3 columnas client-side, sobre la página de 20 ya recibida: el
    // operador clickeaba "Total" y veía el mayor DE ESA PÁGINA, creyendo que era
    // el del evento. Ordenar es responsabilidad de la BD, que ve el conjunto.
    //
    // Desempate por `id`: varias compras pueden compartir el mismo createdAt al
    // milisegundo (importaciones, tests, ráfagas), y SQLite resuelve los empates
    // por rowid ascendente → dejaría la más nueva ABAJO. El id autoincremental
    // da un orden estable entre recargas.
    const ORDEN_CAMPOS = {
      nombre: (dir) => [{ apellido: dir }, { nombre: dir }],
      fecha: (dir) => [{ createdAt: dir }, { id: dir }],
      id: (dir) => [{ id: dir }],
      cantidad: (dir) => [{ cantidadEntradas: dir }, { id: 'desc' }],
      total: (dir) => [{ totalPagado: dir }, { id: 'desc' }],
    };
    // Default 'nombre' A-Z: es el uso en la puerta del evento (staff buscando a
    // alguien que llegó sin QR). Las columnas numéricas y la fecha arrancan desc,
    // que es lo que se espera al clickearlas por primera vez.
    const campoOrden = ORDEN_CAMPOS[req.query.orderBy] ? req.query.orderBy : 'nombre';
    const dirDefault = campoOrden === 'nombre' ? 'asc' : 'desc';
    const dirOrden = ['asc', 'desc'].includes(req.query.orderDir) ? req.query.orderDir : dirDefault;
    const orderBy = ORDEN_CAMPOS[campoOrden](dirOrden);

    // Cuando hay búsqueda activa, ignorar paginación y devolver hasta 200
    // resultados — el operador busca un nombre puntual en la puerta y la
    // paginación entorpece. Cinturón en 200 por seguridad de payload.
    const skipFinal = q ? 0 : skip;
    const takeFinal = q ? 200 : limit;

    const INCLUDE = {
      evento: { select: { nombre: true, fecha: true } },
      entradas: { select: { id: true, validada: true } },
    };

    let compras, total;

    if (campoOrden === 'nombre') {
      // SQLite ordena los textos con colación binaria: compara bytes, así que
      // "SANTORO" (S=83) cae antes que "Abad" (b=98) y "diaz" se va al final de
      // todo. Sobre la base real eso descoloca ~9% de los apellidos y desordena
      // la lista entera para un ojo humano — justo en la puerta del evento, que
      // es para lo que existe este orden.
      //
      // Prisma no expone COLLATE NOCASE ni lower() en orderBy para SQLite, así
      // que el alfabético se resuelve en Node sobre el CONJUNTO COMPLETO ya
      // filtrado (no sobre la página: eso era el bug del ítem 40) y después se
      // pagina. Se traen solo las 3 claves, no las filas enteras.
      const claves = await prisma.compra.findMany({
        where,
        select: { id: true, apellido: true, nombre: true },
      });

      // El comparador vive en utils/orden.js porque la lista de cocina (ítem 44)
      // tiene que ordenar exactamente igual: es el mismo operador buscando el
      // mismo apellido en dos pantallas distintas.
      claves.sort((a, b) => {
        const cmp = compararPorApellido(a, b);
        return dirOrden === 'asc' ? cmp : -cmp;
      });

      total = claves.length;
      const idsPagina = claves.slice(skipFinal, skipFinal + takeFinal).map((c) => c.id);
      const filas = await prisma.compra.findMany({
        where: { id: { in: idsPagina } },
        include: INCLUDE,
      });
      // findMany con `in` no respeta el orden de la lista: reordenar a mano.
      const porId = new Map(filas.map((f) => [f.id, f]));
      compras = idsPagina.map((id) => porId.get(id)).filter(Boolean);
    } else {
      // fecha, id, cantidad y total son numéricos o de fecha: ahí la colación no
      // interviene y SQLite ordena bien. Se paginan en la BD, como corresponde.
      [compras, total] = await Promise.all([
        prisma.compra.findMany({
          where,
          orderBy,
          skip: skipFinal,
          take: takeFinal,
          include: INCLUDE,
        }),
        prisma.compra.count({ where }),
      ]);
    }

    return res.json({
      compras,
      total,
      page: q ? 1 : page,
      totalPages: q ? 1 : Math.ceil(total / limit),
    });
  } catch (err) {
    console.error('Error en adminListar compras:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * ── Export CSV de compradores (ítem 42, S5) ──
 *
 * El operador lo pidió así: *"no tengo la posibilidad de bajar un Excel de toda
 * la lista de compradores"*. Figura como P1 desde la auditoría del 4/4 y estaba
 * anunciado en `docs/FAQS.md` como pendiente del Sprint 2: es lo que se venía
 * debiendo, no una novedad.
 *
 * ⚠️ ENDPOINT DEDICADO, NO EL PAGINADO. `adminListar` devuelve 20 filas por
 * página y topea en 200 cuando hay búsqueda. Un export que reusara eso bajaría
 * un archivo que PARECE completo y no lo está — el peor resultado posible,
 * porque nada en la planilla avisa que faltan filas. Es el mismo patrón que el
 * proyecto ya usa para las agregaciones del dashboard.
 *
 * QUÉ FILAS TRAE. Las mismas que la pantalla, vía `construirFiltroCompras`:
 * evento, estado, validación y búsqueda salen del mismo código, así que el CSV
 * no puede divergir del listado. Encima de eso, UNA regla propia del export:
 *
 *   - por defecto trae **solo aprobadas** (`estados` ausente), porque a la
 *     administración le sirve quién pagó, no quién abandonó el checkout;
 *   - `estados=todas` trae todo, devoluciones y pendientes incluidas;
 *   - y si el operador eligió un estado explícito en pantalla, ese GANA sobre
 *     las dos reglas anteriores. Un filtro elegido a mano es una decisión; el
 *     default solo llena el vacío cuando no hubo ninguna.
 *
 * EN QUÉ ORDEN. Siempre alfabético por apellido, con `compararPorApellido` —el
 * mismo criterio de la pantalla y de la hoja de la cocina, escrito una sola vez
 * en `utils/orden.js`—. No respeta el orden de la pantalla a propósito: una
 * planilla se reordena con un clic en Excel, y salir siempre igual hace que dos
 * descargas del mismo evento se puedan comparar renglón contra renglón.
 *
 * LA PLATA, DESGLOSADA. `totalPagado` incluye el menú, y la plata del menú es de
 * Casa Metro, no del SAB (eje E3 del sprint). Un CSV que mostrara solo el total
 * repetiría en la planilla de la administración el mismo error que S1a encontró
 * en el backoffice: leer la recaudación de la sede como recaudación propia. Por
 * eso van las tres columnas —menú, SAB y total— con la misma resta que usan los
 * reportes (`recaudadoSab = total - menús`), y por eso el precio del menú sale
 * de `menuUnitario`, congelado en la compra: leerlo del precio global de hoy
 * daría números viejos mal.
 *
 * PII. El archivo lleva mail y teléfono de gente real (Ley 25.326) y termina en
 * la carpeta de Descargas de quien lo baja. Por eso `eventoId` es obligatorio:
 * sin él, este endpoint sería un volcado de la base entera en un clic, y nadie
 * pidió eso. Si algún día hace falta el consolidado, se abre a propósito.
 */

/**
 * Fecha y hora en horario de Argentina, para leer dentro de la planilla.
 *
 * El servidor corre en UTC (contenedor sin `tzdata`), así que una compra de las
 * 22:30 del sábado se guarda como 01:30 del domingo. Escribir eso en una
 * planilla de administración corre las compras de la noche al día siguiente.
 *
 * Se resuelve con la aritmética que el proyecto ya usa (`OFFSET_ART_HORAS` en
 * `precios.service.js`: UTC−3 fijo, Argentina no tiene DST desde 2009) y NO con
 * `Intl` + nombre de zona IANA, que depende de que el contenedor traiga la base
 * de zonas horarias — algo que no se puede verificar desde acá y que fallaría en
 * producción, en silencio y con la fecha corrida.
 *
 * @param {Date} fecha
 * @returns {string} "DD/MM/AAAA HH:MM"
 */
function fechaHoraArgentina(fecha) {
  if (!fecha) return '';
  const d = new Date(fecha);
  if (Number.isNaN(d.getTime())) return '';
  const art = new Date(d.getTime() - OFFSET_ART_HORAS * 60 * 60 * 1000);
  const dd = String(art.getUTCDate()).padStart(2, '0');
  const mm = String(art.getUTCMonth() + 1).padStart(2, '0');
  const aaaa = art.getUTCFullYear();
  const hh = String(art.getUTCHours()).padStart(2, '0');
  const mi = String(art.getUTCMinutes()).padStart(2, '0');
  return `${dd}/${mm}/${aaaa} ${hh}:${mi}`;
}

/** Estados de MP en castellano, para que la planilla no diga "refunded". */
const ESTADO_LEGIBLE = {
  approved: 'Aprobada',
  pending: 'Pendiente',
  rejected: 'Rechazada',
  cancelled: 'Cancelada',
  refunded: 'Devuelta',
  charged_back: 'Contracargo',
};

/** Tipos de entrada en castellano. `aporte` es "A la Gorra" de cara al público. */
const TIPO_ENTRADA_LEGIBLE = {
  base: 'Base',
  aporte: 'A la Gorra',
};

/**
 * Los mismos estados, en plural: el nombre del archivo habla del CONJUNTO de
 * filas, no de una. `ESTADO_LEGIBLE` no sirve acá — "compradores-…-aprobada.csv"
 * se lee como si el archivo tuviera una sola.
 */
const ALCANCE_ARCHIVO = {
  approved: 'aprobadas',
  pending: 'pendientes',
  rejected: 'rechazadas',
  cancelled: 'canceladas',
  refunded: 'devueltas',
};

// Cómo se nombra el recorte en el pie de la planilla. El mapa de archivo
// (ALCANCE_ARCHIVO) produce slugs para el nombre del .csv; acá hace falta algo
// que una persona pueda leer dentro de la hoja.
const ALCANCE_LEGIBLE = {
  aprobadas: 'solo aprobadas',
  pendientes: 'solo pendientes',
  rechazadas: 'solo rechazadas',
  canceladas: 'solo canceladas',
  'todos-los-estados': 'todos los estados',
};

const COLUMNAS_EXPORT = [
  // El apellido va primero y el ID al final: la planilla se abre muchas veces en
  // un celular (viaja por WhatsApp), y ahí solo se ven las primeras columnas. El
  // ID es lo que menos le dice a quien cruza contra el padrón de afiliados.
  'Apellido',
  'Nombre',
  'Email',
  'Teléfono',
  'Entradas',
  'Tipo de entrada',
  'Menús',
  'Precio unitario menú',
  'Total menús (Casa Metro)',
  'Total SAB',
  'Total pagado',
  'Estado',
  'Entradas validadas',
  'Fecha de compra',
  'ID',
];

// ⚠️ SIN columna de códigos QR, a propósito (decisión del recorrido de la
// sesión V, 20/8). Esta planilla existe para cruzar compradores contra el
// padrón de afiliados, y para eso el código de la entrada no le sirve a nadie.
// Lo que sí hacía era viajar: el archivo se manda por WhatsApp (operador →
// coordinadora → tesorero) y los dos validadores aceptan códigos tipeados a
// mano, así que cualquiera con la planilla podía marcar como usada una entrada
// ajena. El dueño real llegaba a la puerta y la encontraba validada.
// El dato sigue estando en el backoffice, que es donde tiene sentido.

async function adminExportar(req, res) {
  try {
    const eventoId = parseInt(req.query.eventoId);
    if (!eventoId) return res.status(400).json({ error: 'Se requiere eventoId' });

    const evento = await prisma.evento.findUnique({
      where: { id: eventoId },
      select: { id: true, nombre: true, fecha: true },
    });
    if (!evento) return res.status(404).json({ error: 'Evento no encontrado' });

    const { where, q } = construirFiltroCompras(req.query);
    // Cinturón: `construirFiltroCompras` ya puso el eventoId, pero el export no
    // puede permitirse que un cambio futuro allá lo deje sin filtrar y baje la
    // base entera. Lo reafirma acá, donde está la regla de PII.
    where.eventoId = eventoId;

    // El default (solo aprobadas) se aplica únicamente si nadie decidió otra
    // cosa: un `mpEstado` explícito o el filtro de validación ya escribieron
    // `where.mpEstado`, y esa decisión manda sobre el default.
    const incluirTodos = req.query.estados === 'todas';
    if (!where.mpEstado && !incluirTodos) where.mpEstado = 'approved';

    const compras = await prisma.compra.findMany({
      where,
      select: {
        id: true, nombre: true, apellido: true, email: true, telefono: true,
        cantidadEntradas: true, tipoEntrada: true,
        cantidadMenus: true, menuUnitario: true, totalPagado: true,
        mpEstado: true, createdAt: true,
        // Sin `codigoQR`: la columna salió del CSV (ver COLUMNAS_EXPORT). Se
        // traen solo los `validada` para el contador "2/3".
        entradas: { select: { validada: true }, orderBy: { id: 'asc' } },
      },
    });

    compras.sort(compararPorApellido);

    const filas = compras.map((c) => {
      const menus = c.cantidadMenus || 0;
      const totalMenus = menus * (c.menuUnitario || 0);
      const validadas = c.entradas.filter((e) => e.validada).length;
      return [
        c.apellido,
        c.nombre,
        c.email,
        c.telefono,
        c.cantidadEntradas,
        TIPO_ENTRADA_LEGIBLE[c.tipoEntrada] || c.tipoEntrada,
        menus,
        c.menuUnitario || 0,
        totalMenus,
        (c.totalPagado || 0) - totalMenus,
        c.totalPagado || 0,
        ESTADO_LEGIBLE[c.mpEstado] || c.mpEstado,
        `${validadas}/${c.entradas.length}`,
        fechaHoraArgentina(c.createdAt),
        c.id,
      ];
    });

    // El nombre del archivo dice QUÉ trae. Sin eso, dos descargas del mismo
    // evento con filtros distintos quedan en Descargas como "compradores.csv" y
    // "compradores (1).csv", y no hay forma de saber cuál era cuál.
    const alcance = where.mpEstado ? (ALCANCE_ARCHIVO[where.mpEstado] || slugArchivo(where.mpEstado)) : 'todos-los-estados';
    const filtrado = (q || req.query.validacion) ? '-filtrado' : '';
    const sello = fechaHoraArgentina(new Date()).replace(/[/ :]/g, '').slice(0, 12);
    const nombreArchivo = `compradores-${slugArchivo(evento.nombre)}-${alcance}${filtrado}-${sello}.csv`;

    // ── Pie de la planilla: totales + identificación ──────────────────────
    //
    // Va al FINAL y nunca arriba. La fila 1 tiene que seguir siendo la de
    // encabezados: es lo que hace que el archivo abra en columnas de doble clic
    // y que Sheets lo reconozca como tabla. Un título arriba rompe justamente lo
    // único que hoy funciona perfecto.
    //
    // Sale del recorrido de la sesión V: el operador pidió identificación y
    // totales, y aclaró en la misma frase que NO quería adornos ("me parece bien
    // que sea sencillo"). Así que es una fila en blanco, una de totales y una de
    // procedencia — nada más. Quien abre el archivo tiene que poder decir de
    // quién es, de qué evento, qué recorte trae y cuánta plata suma, sin
    // preguntarle a nadie.
    const totalEntradas = filas.reduce((a, f) => a + (Number(f[4]) || 0), 0);
    const totalMenusVendidos = filas.reduce((a, f) => a + (Number(f[6]) || 0), 0);
    const sumaMenus = filas.reduce((a, f) => a + (Number(f[8]) || 0), 0);
    const sumaSab = filas.reduce((a, f) => a + (Number(f[9]) || 0), 0);
    const sumaPagado = filas.reduce((a, f) => a + (Number(f[10]) || 0), 0);

    const filaTotales = new Array(COLUMNAS_EXPORT.length).fill('');
    filaTotales[0] = `TOTALES (${filas.length} compra${filas.length === 1 ? '' : 's'})`;
    filaTotales[4] = totalEntradas;
    filaTotales[6] = totalMenusVendidos;
    filaTotales[8] = sumaMenus;
    filaTotales[9] = sumaSab;
    filaTotales[10] = sumaPagado;

    // La identificación va como pares etiqueta/valor, NO como una frase larga en
    // una sola celda. El motivo es de planilla, no de estilo: un texto largo en
    // la columna A ensancha la columna del apellido en cualquier visor que
    // autoajuste, y desacomoda la tabla entera para leer un dato que se consulta
    // una vez. Con la etiqueta corta en la primera columna y el valor en la de
    // los emails —que ya es la más ancha del archivo— ninguna columna cambia de
    // tamaño. (Hallazgo del recorrido, sesión V.)
    const COL_ETIQUETA = 0;                          // 'Apellido'
    const COL_VALOR = COLUMNAS_EXPORT.indexOf('Email');
    const filaPie = (etiqueta, valor) => {
      const f = new Array(COLUMNAS_EXPORT.length).fill('');
      f[COL_ETIQUETA] = etiqueta;
      f[COL_VALOR] = valor;
      return f;
    };

    const vacia = () => new Array(COLUMNAS_EXPORT.length).fill('');
    const filasConPie = [
      ...filas,
      vacia(),
      filaTotales,
      vacia(),
      filaPie('Planilla', 'Sindicato Argentino de Boleros'),
      filaPie('Evento', evento.nombre),
      filaPie('Incluye', `${ALCANCE_LEGIBLE[alcance] || alcance}${filtrado ? ' · con filtros de pantalla' : ''}`),
      filaPie('Generada', fechaHoraArgentina(new Date())),
    ];

    const csv = serializarCSV(COLUMNAS_EXPORT, filasConPie);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${nombreArchivo}"`);
    // Se lo damos también al navegador: `fetch` no ve `Content-Disposition` si
    // no está expuesto, y el front necesita el nombre para nombrar la descarga.
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, X-Filas-Export');
    // Cuántas filas trae, para que el front lo pueda decir en pantalla sin
    // tener que parsear el CSV que acaba de bajar.
    res.setHeader('X-Filas-Export', String(filas.length));
    return res.send(csv);
  } catch (err) {
    console.error('Error en adminExportar compras:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

async function adminGetById(req, res) {
  try {
    const id = parseInt(req.params.id);
    const compra = await prisma.compra.findUnique({
      where: { id },
      include: {
        evento: true,
        entradas: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!compra) return res.status(404).json({ error: 'Compra no encontrada' });
    return res.json(compra);
  } catch (err) {
    console.error('Error en adminGetById compra:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

async function adminEliminar(req, res) {
  try {
    const id = parseInt(req.params.id);
    const compra = await prisma.compra.findUnique({ where: { id } });
    if (!compra) return res.status(404).json({ error: 'Compra no encontrada' });

    if (compra.mpEstado === 'approved') {
      return res.status(400).json({ error: 'No se puede eliminar una compra aprobada' });
    }

    // Eliminar entradas asociadas primero
    await prisma.entrada.deleteMany({ where: { compraId: id } });
    // Eliminar la compra
    await prisma.compra.delete({ where: { id } });

    return res.json({ ok: true, message: 'Compra eliminada correctamente' });
  } catch (err) {
    console.error('Error en adminEliminar compra:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

async function adminEliminarPendientes(req, res) {
  try {
    const eventoId = parseInt(req.query.eventoId);
    if (!eventoId) return res.status(400).json({ error: 'Se requiere eventoId' });

    const pendientes = await prisma.compra.findMany({
      where: { eventoId, mpEstado: { not: 'approved' } },
      select: { id: true },
    });

    const ids = pendientes.map(c => c.id);
    if (!ids.length) return res.json({ ok: true, eliminadas: 0 });

    await prisma.entrada.deleteMany({ where: { compraId: { in: ids } } });
    const result = await prisma.compra.deleteMany({ where: { id: { in: ids } } });

    return res.json({ ok: true, eliminadas: result.count });
  } catch (err) {
    console.error('Error en adminEliminarPendientes:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// Reenvía el mail de confirmación de una compra aprobada. Permite override del
// destinatario (typo del comprador, mail alternativo). Si se cambia el email,
// se actualiza también en la BD para que futuros reenvíos vayan al correcto.
async function adminReenviarMail(req, res) {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });

    const compra = await prisma.compra.findUnique({
      where: { id },
      include: { evento: true, entradas: { orderBy: { createdAt: 'asc' } } },
    });
    if (!compra) return res.status(404).json({ error: 'Compra no encontrada' });

    if (compra.mpEstado !== 'approved') {
      return res.status(400).json({ error: 'Solo se puede reenviar mail de compras aprobadas' });
    }
    if (!compra.entradas.length) {
      return res.status(400).json({ error: 'La compra no tiene entradas generadas' });
    }

    const emailOverride = (req.body && typeof req.body.email === 'string') ? req.body.email.trim() : '';
    const emailDestino = emailOverride || compra.email;
    if (!EMAIL_REGEX.test(emailDestino)) {
      return res.status(400).json({ error: 'Email inválido' });
    }

    // Si el admin cambió el email, persistir el cambio para que futuros reenvíos
    // y referencias en el sistema apunten al mail correcto.
    const emailCambio = emailOverride && emailOverride.toLowerCase() !== compra.email.toLowerCase();
    if (emailCambio) {
      await prisma.compra.update({ where: { id }, data: { email: emailOverride } });
    }

    const entradasParaMail = [];
    for (const entrada of compra.entradas) {
      const qrBase64 = await qrService.generarQRBase64(entrada.codigoQR);
      entradasParaMail.push({ ...entrada, qrBase64: qrBase64.split(',')[1] });
    }

    const adminEmail = req.session?.usuario?.email || 'admin';
    console.log(`📧 [REENVIO] Admin=${adminEmail} compra=#${id} → ${emailDestino}${emailCambio ? ` (cambió de ${compra.email})` : ''}`);

    await brevoService.enviarConfirmacion({
      email: emailDestino,
      nombre: compra.nombre,
      evento: compra.evento,
      entradas: entradasParaMail,
      compra,
    });

    return res.json({
      ok: true,
      emailEnviado: emailDestino,
      emailActualizado: emailCambio,
      entradas: entradasParaMail.length,
    });
  } catch (err) {
    console.error('Error en adminReenviarMail:', err);
    return res.status(500).json({ error: 'Error al reenviar el mail: ' + err.message });
  }
}

// US-A: marca una compra aprobada como devuelta (refund manual desde el
// backoffice). Delega en revertirCompraAprobada, que hace la reversión atómica
// de estado + stock + cupón. Solo aplica a compras approved (400 si no).
async function adminDevolver(req, res) {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido', code: 'INVALID_ID' });

    const motivo = (req.body && typeof req.body.motivo === 'string') ? req.body.motivo.trim().slice(0, 500) : null;
    const revertidaPor = req.session?.usuario?.email || 'admin';

    const result = await revertirCompraAprobada(id, { revertidaPor, motivo });

    if (!result.ok) {
      if (result.code === 'NOT_FOUND') {
        return res.status(404).json({ error: 'Compra no encontrada', code: 'NOT_FOUND' });
      }
      return res.status(400).json({
        error: `Solo se puede devolver una compra aprobada (estado actual: ${result.estado})`,
        code: 'NOT_APPROVED',
        estado: result.estado,
      });
    }

    console.log(`↩️  [DEVOLUCION] Admin=${revertidaPor} compra=#${id} stock_devuelto=${result.stock_devuelto} cupon_liberado=${result.libero_cupon} entradas_ya_validadas=${result.entradas_ya_validadas}${motivo ? ` motivo="${motivo}"` : ''}`);

    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error('Error en adminDevolver:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

module.exports = { crearPreferencia, webhook, checkAndProcess, adminListar, adminExportar, adminGetById, adminEliminar, adminEliminarPendientes, adminReenviarMail, adminDevolver };
