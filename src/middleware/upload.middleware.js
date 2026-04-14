const multer = require('multer');
const path = require('path');
const fs = require('fs');
const config = require('../config');

function createStorage(subdir) {
  const dest = path.join(__dirname, '../../public/assets/img/uploads', subdir);
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });

  return multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, dest),
    filename: (_req, file, cb) => {
      const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
      cb(null, unique + path.extname(file.originalname));
    },
  });
}

function fileFilter(_req, file, cb) {
  if (config.uploadLimits.allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Tipo de archivo no permitido. Solo JPG, PNG y WEBP.'), false);
  }
}

const uploadEvento = multer({
  storage: createStorage('eventos'),
  fileFilter,
  limits: { fileSize: config.uploadLimits.fileSize },
}).single('flyer');

const uploadHome = multer({
  storage: createStorage('home'),
  fileFilter,
  limits: { fileSize: config.uploadLimits.fileSize },
}).fields([
  { name: 'slider1', maxCount: 1 },
  { name: 'slider2', maxCount: 1 },
  { name: 'slider3', maxCount: 1 },
]);

module.exports = { uploadEvento, uploadHome };
