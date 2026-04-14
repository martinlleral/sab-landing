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

    const { textoEvento, youtubeUrl } = req.body;
    const data = {};

    if (textoEvento !== undefined) data.textoEvento = textoEvento;
    if (youtubeUrl !== undefined) data.youtubeUrl = youtubeUrl;

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
