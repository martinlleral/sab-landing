const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
  // Chequear si ya existe CUALQUIER admin (rol=1), no por email hardcodeado.
  // Así no recreamos un admin débil si el operador rotó las credenciales.
  const existingAdmin = await prisma.usuario.findFirst({
    where: { rol: 1 },
  });

  if (!existingAdmin) {
    // Primer arranque: crear admin bootstrap SOLO si la DB está vacía.
    // ADMIN_EMAIL y ADMIN_PASS vienen del .env y hay que rotar la pass post-bootstrap.
    const bootstrapEmail = process.env.ADMIN_EMAIL || 'admin@localhost';
    const bootstrapPass = process.env.ADMIN_PASS || 'CAMBIAR_' + Date.now();
    const hashedPassword = await bcrypt.hash(bootstrapPass, 12);
    await prisma.usuario.create({
      data: {
        nombre: 'Admin',
        apellido: 'Sistema',
        email: bootstrapEmail,
        password: hashedPassword,
        rol: 1,
        activo: true,
      },
    });
    console.log(`✅ Admin bootstrap creado: ${bootstrapEmail} — rotar password YA`);
  } else {
    console.log(`ℹ️  Admin ya existe (${existingAdmin.email}), seed omitido.`);
  }

  const homeCount = await prisma.home.count();
  if (homeCount === 0) {
    await prisma.home.create({
      data: {
        slider1Url: '',
        slider2Url: '',
        slider3Url: '',
        textoEvento: '',
        youtubeUrl: '',
      },
    });
    console.log('✅ Registro Home inicial creado.');
  } else {
    console.log('ℹ️  Registro Home ya existe, omitiendo.');
  }
}

main()
  .catch((e) => {
    console.error('❌ Error en seed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
