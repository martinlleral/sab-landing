const prisma = require('../utils/prisma');

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

    const { textoEvento, youtubeUrl, totalEdiciones, totalShows, totalPersonas } = req.body;
    const data = {};

    if (textoEvento !== undefined) data.textoEvento = textoEvento;
    if (youtubeUrl !== undefined) data.youtubeUrl = youtubeUrl;

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
