const prisma = require('../utils/prisma');

/**
 * Parsea la hora de corte de la venta de menús (Sprint 7, S3). Misma forma que
 * `parseTopeMenus` de eventos.controller.js, con los tres casos que importan:
 *
 *   undefined/ausente → el request no manda el campo: NO tocar lo guardado
 *   basura            → no pisar lo guardado (un "25:00" dejaría el corte en una
 *                       hora que no existe, y el checkout entero del menú se
 *                       caería con MENU_CORTE_INVALIDO)
 *   "HH:MM" válido    → ese horario
 *
 * La diferencia con `parseTopeMenus` está en el vacío: allá `''` significa "sin
 * tope" (el campo es nullable), acá NO hay un "sin corte" representable —
 * `menuCorteHora` es String NOT NULL con default. Y no hace falta: para vender
 * hasta el final del día se carga 23:59. Un `<input type="time">` se vacía de
 * más fácil de lo que se completa, así que vaciarlo no borra nada.
 */
function parseHoraCorte(raw) {
  if (raw === undefined || raw === null) return undefined;
  const s = String(raw).trim();
  if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(s)) return undefined;
  return s;
}

async function getHome(req, res) {
  try {
    const home = await prisma.home.findFirst();
    if (!home) return res.status(404).json({ error: 'No se encontró configuración de home' });
    return res.json(home);
  } catch (err) {
    console.error('Error en getHome:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

async function updateHome(req, res) {
  try {
    const home = await prisma.home.findFirst();
    if (!home) return res.status(404).json({ error: 'No se encontró configuración de home' });

    const {
      textoEvento, youtubeUrl, totalEdiciones, totalShows, totalPersonas,
      boxLugar, boxDireccion, boxCiudad, boxEtiquetaEntrada,
      eventosVisiblesPortada, mostrarCicloMiercoles,
      precioMenu, menuCorteHora,
    } = req.body;
    const data = {};

    if (textoEvento !== undefined) data.textoEvento = textoEvento;
    if (youtubeUrl !== undefined) data.youtubeUrl = youtubeUrl;
    if (boxLugar !== undefined) data.boxLugar = String(boxLugar).trim();
    if (boxDireccion !== undefined) data.boxDireccion = String(boxDireccion).trim();
    if (boxCiudad !== undefined) data.boxCiudad = String(boxCiudad).trim();
    if (boxEtiquetaEntrada !== undefined) data.boxEtiquetaEntrada = String(boxEtiquetaEntrada).trim();

    // Stats numéricos — parseInt + guardia contra NaN/negativos
    const parseStat = (v) => {
      const n = parseInt(v, 10);
      return Number.isFinite(n) && n >= 0 ? n : null;
    };
    if (totalEdiciones !== undefined) {
      const v = parseStat(totalEdiciones);
      if (v !== null) data.totalEdiciones = v;
    }
    if (totalShows !== undefined) {
      const v = parseStat(totalShows);
      if (v !== null) data.totalShows = v;
    }
    if (totalPersonas !== undefined) {
      const v = parseStat(totalPersonas);
      if (v !== null) data.totalPersonas = v;
    }
    // Eventos visibles en el carrusel: al menos 1 (0 no tiene sentido).
    if (eventosVisiblesPortada !== undefined) {
      const v = parseStat(eventosVisiblesPortada);
      if (v !== null && v >= 1) data.eventosVisiblesPortada = v;
    }
    // Precio global del menú de la sede (Sprint 7). Se persiste tal cual venga
    // (incluido 0, que apaga la venta de menú vía MENU_PRECIO_NO_CONFIGURADO —
    // es la forma de desactivarlo globalmente sin tocar cada evento). Cada Compra
    // congela su propio `menuUnitario`, así que cambiarlo acá NO reescribe las
    // compras ya hechas ni los reportes históricos.
    if (precioMenu !== undefined) {
      const v = parseStat(precioMenu);
      if (v !== null) data.precioMenu = v;
    }
    // Hora de cierre de la venta de menús (Sprint 7, S3). Es global como el
    // precio: Casa Metro cierra la cuenta a la misma hora todas las fechas. Que
    // sea editable evita tocar código si la cocina cambia el horario.
    const corte = parseHoraCorte(menuCorteHora);
    if (corte !== undefined) data.menuCorteHora = corte;
    // Toggle de la sección del ciclo Amor de Miércoles. Llega como string desde
    // el FormData del backoffice ('true'/'false'); aceptamos también booleano.
    if (mostrarCicloMiercoles !== undefined) {
      data.mostrarCicloMiercoles = mostrarCicloMiercoles === 'true' || mostrarCicloMiercoles === true;
    }

    if (req.files) {
      if (req.files.slider1 && req.files.slider1[0]) {
        data.slider1Url = `/assets/img/uploads/home/${req.files.slider1[0].filename}`;
      }
      if (req.files.slider2 && req.files.slider2[0]) {
        data.slider2Url = `/assets/img/uploads/home/${req.files.slider2[0].filename}`;
      }
      if (req.files.slider3 && req.files.slider3[0]) {
        data.slider3Url = `/assets/img/uploads/home/${req.files.slider3[0].filename}`;
      }
    }

    const updated = await prisma.home.update({ where: { id: home.id }, data });
    return res.json(updated);
  } catch (err) {
    console.error('Error en updateHome:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

module.exports = { getHome, updateHome };
