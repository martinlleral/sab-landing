# SAB Landing

Landing page + ticketera propia + sistema de suscripciones para el **Sindicato Argentino de Boleros**, orquesta cooperativa de 21 músicos y músicas de La Plata, Argentina.

Sitio en producción: [sindicatoargentinodeboleros.com.ar](https://sindicatoargentinodeboleros.com.ar)
Instagram: [@sindicatoargentinodeboleros](https://www.instagram.com/sindicatoargentinodeboleros/)

---

## Qué hace esta aplicación

Es una landing con ticketera propia (sin Passline ni Eventbrite) que le permite al sindicato:

- Mostrar los shows próximos del ciclo **Amor de Miércoles** y giras externas
- Vender entradas online con QR único por entrada (sistema antifraude)
- Cobrar directo a la cuenta MercadoPago del SAB (sin comisiones intermedias: **ahorro estimado de $6-8M/año** vs. plataformas de ticketera externas)
- Enviar el QR al mail del comprador automáticamente
- Validar entradas en la puerta del show con cámara o ingreso manual
- Capturar contactos para un futuro sistema de socios (waitlist con encuesta de research)
- Gestionar eventos, flyers y contenido desde un backoffice propio

## Stack

| Capa | Tecnología |
|---|---|
| Runtime | Node.js 20 + Express 4 |
| ORM | Prisma 5 |
| Base de datos | SQLite (archivo local, sin servidor separado) |
| Frontend | HTML + Bootstrap 5.3 + JavaScript vanilla |
| Mails transaccionales | Gmail SMTP (o Brevo) |
| Pagos | MercadoPago SDK v2 |
| QR | `qrcode` (librería Node) |
| Auth | `express-session` + `bcryptjs` |
| Upload de imágenes | `multer` |
| Captura de research | Supabase (Postgres) para waitlist de socios |
| Reverse proxy / SSL | Nginx + Let's Encrypt |
| Contenedores | Docker + Docker Compose |
| Hosting | DigitalOcean droplet básico ($4/mes) |

## Correr en local

### Prerequisitos

- Docker Desktop con integración WSL2 (en Windows) o Docker nativo (Linux/Mac)

### Quick start

```bash
git clone git@github.com:martinlleral/sab-landing.git
cd sab-landing

cp .env.example .env
# Editar .env con credenciales locales de MercadoPago, SMTP, etc.

docker compose up -d
```

El sitio queda en [http://localhost:3000](http://localhost:3000).
El backoffice en [http://localhost:3000/backoffice/login.html](http://localhost:3000/backoffice/login.html).

Las credenciales del admin se generan la primera vez con las variables `ADMIN_EMAIL` y `ADMIN_PASS` del `.env` — rotarlas inmediatamente después del primer login.

## Estructura del proyecto

```
sab-landing/
├── src/
│   ├── server.js              entry point Express
│   ├── routes/                rutas API + backoffice HTML
│   ├── controllers/           lógica de cada endpoint
│   ├── services/              integraciones MercadoPago, Brevo, QR
│   ├── middleware/            auth, upload, validación
│   └── utils/                 helpers (Prisma client, etc.)
├── prisma/
│   ├── schema.prisma          modelo de datos
│   ├── seed.js                usuario admin bootstrap (ADMIN_EMAIL/ADMIN_PASS)
│   └── migrations/            historial de cambios del schema
├── public/
│   ├── index.html             landing page
│   ├── backoffice/            panel admin
│   └── assets/                CSS, JS, imágenes estáticas
├── nginx/
│   └── app.conf               reverse proxy config
├── docs/
│   ├── runbook-deploy.md      runbook completo de deploy (5 fases)
│   ├── TODO-deploy.md         deuda técnica catalogada por prioridad
│   ├── auditoria-playwright-*.md   auditorías de UX/A11y/performance
│   ├── env.example.clean      template de variables
│   └── audit/                 capturas de pantalla de auditorías
├── docker-compose.yml         build-en-servidor + healthcheck + mem limits
├── Dockerfile                 imagen Node + Prisma
├── entrypoint.sh              migrate + seed + start
└── .env.example               template (copiar a .env, NO commitear)
```

## Deploy a producción

Todo el proceso está documentado en [`docs/runbook-deploy.md`](docs/runbook-deploy.md). Cubre:

1. **Fase 0 — Rotación de secrets** (MP, Brevo, Gmail, admin)
2. **Fase 1 — Crear droplet + hardening** (SSH key only, UFW, fail2ban, Docker)
3. **Fase 2 — Deploy del código** (rsync, build, seed, datos iniciales)
4. **Fase 3 — SSL + dominio** (Cloudflare, nameservers, Let's Encrypt)
5. **Fase 4 — SPF/DKIM/DMARC** (mails no caen en spam)
6. **Fase 5 — Monitoreo + cleanup**

El runbook está pensado para ejecutar copy-paste sin pensar.

## Deuda técnica pendiente

Ver [`docs/TODO-deploy.md`](docs/TODO-deploy.md) para la lista completa catalogada por prioridad.

## Contribuir

Issues, pull requests y sugerencias son bienvenidas. Si sos parte de otra cooperativa musical argentina y querés adaptar este código para tu propia ticketera, abrí un issue y te damos una mano — para eso hacemos open source.

## Créditos

- **Sindicato Argentino de Boleros** — la orquesta cooperativa que inspira todo esto
- **Lucho Menez** — desarrollador original del stack y del sistema de ticketera
- **Martín Lleral** — mantenedor actual, auditorías, migración a infraestructura propia del SAB, sistema de suscripciones

## Licencia

MIT. Ver [`LICENSE`](LICENSE).

Esto significa que cualquiera puede usar, modificar y distribuir este código (incluso comercialmente), con la única condición de mantener el copyright notice del autor original. Si lo usás para otra cooperativa o proyecto cultural, mencionarnos es opcional pero bien recibido.
