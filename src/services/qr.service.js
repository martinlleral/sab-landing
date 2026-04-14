const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');

const QR_DIR = path.join(__dirname, '../../public/assets/img/uploads/qr');

function ensureQrDir() {
  if (!fs.existsSync(QR_DIR)) {
    fs.mkdirSync(QR_DIR, { recursive: true });
  }
}

async function generarQR(codigo) {
  ensureQrDir();

  const filename = `${codigo}.png`;
  const filepath = path.join(QR_DIR, filename);
  const publicUrl = `/assets/img/uploads/qr/${filename}`;

  await QRCode.toFile(filepath, codigo, {
    type: 'png',
    width: 300,
    margin: 2,
    color: {
      dark: '#000000',
      light: '#ffffff',
    },
  });

  return publicUrl;
}

async function generarQRBase64(codigo) {
  return QRCode.toDataURL(codigo, {
    type: 'png',
    width: 300,
    margin: 2,
  });
}

module.exports = { generarQR, generarQRBase64 };
