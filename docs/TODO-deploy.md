# TODO — Deploy & Technical Debt

**Última actualización:** 14/4/2026 (tras auditoría de 3 expertos post-deploy)
**Estado general:** MVP funcional en producción con hallazgos de seguridad críticos identificados.
**Score del proyecto:** 5.8 / 10 promedio (SRE 5.5 · Security 4.8 · Tech Writer 7.0)

> Este archivo es la fuente de verdad de lo que queda pendiente. Actualizado con los hallazgos consolidados de la auditoría de expertos del 14/4/2026 (SRE senior + Application Security Engineer + Technical Writer + OSS advocate).
>
> **Ir tachando con `~~texto~~` + `✅ Hecho DD/MM` al cerrar cada ítem.**

---

## 🚨 Resumen ejecutivo — 3 bloques de acción

### 🔴 Bloque 1 — Seguridad crítica (antes de procesar $1 real)
6 hallazgos (secciones 1-6). **Esfuerzo estimado: 4-5 horas**.
No arrancar ventas públicas sin esto resuelto.

### 🟡 Bloque 2 — Resiliencia operativa (antes de campaña del 1/5)
5 hallazgos (secciones 7-11). **Esfuerzo estimado: 2-3 horas**.
Necesario antes de tráfico real sostenido.

### 🟢 Bloque 3 — Calidad del repo + portafolio
5 hallazgos (secciones 12-16). **Esfuerzo estimado: 4-5 horas**.
Mejora el repo como recurso reutilizable y como caso de portafolio IT.

Los bloques 1 y 2 son **prioridad deploy**. El bloque 3 es **prioridad portafolio**. Vale la pena hacer los 3, en el orden sugerido.

---

## 🔴 Bloque 1 — Seguridad crítica (bloqueante de ingresos reales)

### 1. 🚨 Webhook MercadoPago sin verificación de firma — HALLAZGO CRÍTICO

**Severidad:** CRÍTICA · **Experto:** Application Security · **Esfuerzo:** 1h

**Problema:** `src/controllers/compras.controller.js` acepta cualquier POST a `/api/compras/webhook` sin verificar la firma `x-signature` que MercadoPago envía. El flujo vulnerable:

1. Atacante crea una compra `pending` con su propio email
2. Atacante envía POST al webhook con `{type: 'payment', data: {id: <payment_id_aprobado_conocido>}}`
3. El código consulta MP por ese ID, confirma que está aprobado, matchea el `external_reference`
4. **Sistema genera entradas QR y envía al atacante sin cobrar nada**

Peor: no valida que `pago.collector_id` sea el merchant del SAB. Los payment IDs de MP son enumerables. Con el código público en GitHub, cualquiera con 30 minutos puede escribir el exploit.

**Fix:**

```js
// src/controllers/compras.controller.js
const crypto = require('crypto');

function verifyMpSignature(req, secret) {
  const sig = req.headers['x-signature'] || '';
  const reqId = req.headers['x-request-id'] || '';
  const ts = /ts=([^,]+)/.exec(sig)?.[1];
  const v1 = /v1=([^,]+)/.exec(sig)?.[1];
  const dataId = req.query['data.id'] || req.body?.data?.id;
  if (!ts || !v1 || !dataId) return false;
  const manifest = `id:${dataId};request-id:${reqId};ts:${ts};`;
  const hmac = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(v1));
}

// En el handler del webhook:
if (!verifyMpSignature(req, process.env.MP_WEBHOOK_SECRET)) {
  return res.status(401).json({ error: 'invalid signature' });
}
// + validar pago.collector_id === process.env.MP_USER_ID
// + validar pago.transaction_amount === compra.totalPagado
```

Requiere:
- Generar "Secret Key" en el panel de MP del SAB → panel MP → Webhooks → activar firma
- Agregar `MP_WEBHOOK_SECRET` y `MP_USER_ID` al `.env` del droplet
- Restart del container

**Impacto real:** regalar entradas del SAB gratis a cualquiera con acceso al código (que ahora es público).

---

### 2. Rotación de secrets viejos en MP / Brevo / Perfit

**Severidad:** CRÍTICA · **Experto:** Security · **Esfuerzo:** 30 min (depende de acceso)

Los tokens viejos que estuvieron en `.env.example` siguen activos en sus paneles hasta que alguien los rote. Impactos:

- **MP Access Token viejo:** permite crear preferencias a nombre del SAB, consultar PII de compradores, refundar pagos aprobados, ver balance, retirar a cuenta bancaria vinculada.
- **Brevo API key + SMTP viejos:** enviar mails desde `sindicatoargentinodeboleros@gmail.com` (phishing masivo, quema de reputación del sender).
- **Admin `<ADMIN_EMAIL_VIEJO>` / `<ADMIN_PASS_VIEJA>`:** si queda en algún backup o droplet viejo, login directo al backoffice.

**Acciones:**

- [ ] MercadoPago → panel → Tus integraciones → Credenciales → Regenerar Access Token y Public Key
- [ ] Brevo → SMTP & API → Borrar la key vieja, crear una nueva
- [ ] Brevo → API keys → Borrar la vieja (si no se usa en código, solo borrar, no regenerar)
- [ ] Perfit → API → Borrar la vieja si no se usa (verificar con `grep -r PERFIT src/`)
- [ ] Verificar en logs de MP/Brevo que no haya actividad anómala en los últimos 7 días

---

### 3. Endpoint `/api/compras/status/:preferenciaId` — enumeración sin auth

**Severidad:** CRÍTICA · **Experto:** Security · **Esfuerzo:** 1h

Cualquiera que conozca o adivine un `mpPreferenciaId` puede hacer `GET` y recibir: email, nombre, apellido, monto pagado, **códigos QR de las entradas**. Aunque los IDs de MP son strings largos random, el endpoint debería exigir un segundo factor o un token firmado.

**Fix opcional A (simple):** email + preferenciaId como doble clave.

**Fix opcional B (mejor):** generar un `access_token` firmado con JWT cuando se crea la preferencia, incluirlo en el `back_url` de MP y exigirlo en `/status`.

---

### 4. Supply chain: 16 CVEs (2 críticas, 7 highs)

**Severidad:** CRÍTICA · **Experto:** Security · **Esfuerzo:** 2-3h

`npm audit --omit=dev` reporta:

- `tar <=7.5.10` (critical) — 6 advisories: hardlink path traversal, symlink poisoning. Viene vía `@getbrevo/brevo` → `request` (deprecated)
- `tough-cookie <4.1.3` (moderate) — prototype pollution
- `brace-expansion <1.1.13` (moderate) — DoS por memoria
- `@getbrevo/brevo ^2.0.0` — arrastra toda la cadena deprecada
- `multer ^1.4.5-lts.1` — EOL desde enero 2025, CVEs de DoS conocidos
- `mercadopago ^2.0.6` — confirmar contra latest 2.x

**Acciones:**

- [ ] `npm audit fix --force` en una rama nueva
- [ ] Migrar `@getbrevo/brevo` a v5.x (breaking change, ajustar servicio)
- [ ] Migrar `multer` a v2.x
- [ ] Actualizar `mercadopago` al último 2.x
- [ ] Verificar que el flujo Brevo sigue funcionando localmente
- [ ] Regenerar `package-lock.json` y `npm audit --omit=dev` debe devolver 0 highs/criticals como gate de deploy

---

### 5. Sin rate limiting en rutas críticas

**Severidad:** ALTA · **Experto:** Security + SRE · **Esfuerzo:** 30 min

- `/api/auth/login` → bruteforce del admin posible. Con bcrypt cost 10 y sin lockout, un diccionario de 10k passwords se prueba en minutos si el atacante paraleliza.
- `/api/compras/preferencia` → bot llena la tabla de compras pending, consume cuota de API MP, ensucia el cron de sync
- Waitlist de Supabase → spam ilimitado si RLS no lo mitiga

**Fix:**

```js
// server.js
const rateLimit = require('express-rate-limit');

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/auth/login', loginLimiter);

const comprasLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
});
app.use('/api/compras/preferencia', comprasLimiter);
```

Complementario en nginx (`nginx/app.conf`):

```nginx
limit_req_zone $binary_remote_addr zone=api:10m rate=10r/s;
limit_req_zone $binary_remote_addr zone=waitlist:10m rate=2r/s;
```

---

### 6. Auth hardening

**Severidad:** ALTA · **Experto:** Security · **Esfuerzo:** 1h total

Múltiples gaps pequeños que juntos son importantes:

- [ ] `req.session.regenerate()` tras login exitoso (previene session fixation)
- [ ] `cookie.secure` — cambiar de `false` hardcodeado a `process.env.NODE_ENV === 'production'`
- [ ] `bcrypt` cost de 10 → 12 (aceptable ~250ms para un login admin)
- [ ] Lockout temporal después de 5 intentos fallidos (si se usa `express-rate-limit` con `max: 5` cubre esto)

```js
// auth.controller.js — post bcrypt.compare OK:
req.session.regenerate((err) => {
  if (err) return res.status(500).json({ error: 'session error' });
  req.session.usuario = { id, nombre, apellido, email, rol };
  req.session.save(() => res.json({ ok: true, usuario: req.session.usuario }));
});

// server.js cookie config:
cookie: {
  secure: process.env.NODE_ENV === 'production',
  httpOnly: true,
  sameSite: 'lax',
  maxAge: 24 * 60 * 60 * 1000,
}
```

---

## 🟡 Bloque 2 — Resiliencia operativa (antes de campaña del 1/5)

### 7. Backups automáticos del `prod.db` + uploads

**Severidad:** CRÍTICA (upgraded de media) · **Experto:** SRE · **Esfuerzo:** 1h

El droplet de USD 4 no tiene backups nativos activados. Si el disco se corrompe, el droplet se destruye por error, o un `migrate deploy` rompe el schema, **se pierden compras, waitlist y credenciales admin**.

**Script propuesto** (`/opt/sab/bin/backup.sh`):

```bash
#!/bin/bash
set -e
TS=$(date -u +%Y%m%dT%H%M%SZ)
BACKUP_DIR=/opt/sab/backups
mkdir -p $BACKUP_DIR

# DB
docker exec sab-app sqlite3 /app/prisma/prod.db ".backup /tmp/prod-$TS.db"
docker cp sab-app:/tmp/prod-$TS.db $BACKUP_DIR/

# Uploads
docker run --rm -v sab_uploads-data:/src -v $BACKUP_DIR:/dst alpine \
  tar czf /dst/uploads-$TS.tgz -C /src .

# Upload a Cloudflare R2 (gratis 10 GB) o Supabase Storage (1 GB)
rclone copy $BACKUP_DIR/ r2:sab-backups/ --min-age 1m

# Retention 7 días
find $BACKUP_DIR -type f -mtime +7 -delete
```

Cron (`/etc/cron.d/sab-backup`):

```
0 4 * * * sab /opt/sab/bin/backup.sh >> /var/log/sab-backup.log 2>&1
```

- [ ] Crear cuenta R2 o bucket Supabase Storage
- [ ] Instalar `rclone` + configurar credenciales
- [ ] Script + cron
- [ ] Primer test manual + validar que el backup se restaura en una DB limpia

---

### 8. Uptime monitoring externo + alerting

**Severidad:** CRÍTICA (upgraded de media) · **Experto:** SRE · **Esfuerzo:** 30 min

Hoy si el sitio cae, nadie se entera. El SAB procesa pagos reales. Un outage de 6 horas en día de venta de entradas es plata perdida + daño reputacional.

**Fix mínimo viable (gratis):**

- [ ] Cuenta en Uptime Robot (https://uptimerobot.com) — plan gratis: 50 monitors, 5 min interval
- [ ] Monitor HTTP a `/` con expected content "Sindicato Argentino de Boleros"
- [ ] Monitor HTTP a `/api/eventos/proximos` con expected 200 + JSON válido
- [ ] Alerta por mail a Martín + Nati
- [ ] Bonus: webhook a Telegram bot para alertas inmediatas
- [ ] Post-SSL: monitor HTTPS con validación de cert expiración

---

### 9. Graceful shutdown + endpoint `/healthz` real

**Severidad:** ALTA · **Experto:** SRE · **Esfuerzo:** 30 min

**Problema A:** el `entrypoint.sh` hace `exec node src/server.js` pero el código Node probablemente no registra handlers SIGTERM. Al `docker compose restart` se cortan conexiones HTTP en vuelo y transacciones a MP a mitad de webhook.

**Problema B:** el healthcheck actual (`wget /`) valida que Node vive, no que la app funciona. Si Prisma pierde el file handle del SQLite o el pool de sesiones se satura, el healthcheck pasa igual.

**Fix combinado:**

```js
// src/server.js
app.get('/healthz', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ok', db: 'up', uptime: process.uptime() });
  } catch (e) {
    res.status(503).json({ status: 'error', db: 'down' });
  }
});

const server = app.listen(PORT);

const shutdown = async (sig) => {
  console.log(`[${sig}] draining connections`);
  server.close(() => process.exit(0));
  await prisma.$disconnect();
  setTimeout(() => process.exit(1), 10000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
```

```yaml
# docker-compose.yml
app:
  # ...
  init: true
  stop_grace_period: 30s
  healthcheck:
    test: ["CMD", "wget", "-qO-", "http://localhost:3000/healthz"]
    interval: 15s
    timeout: 3s
    retries: 3
    start_period: 60s  # subir de 40s a 60s para migraciones Prisma frías
```

Bonus: para reducir downtime en deploy, usar `docker compose up -d --no-deps app` en lugar de `restart` (crea el container nuevo antes de matar el viejo, ~1s de gap en vez de 5-15s).

---

### 10. Upgrade del droplet a USD 6/mes (1 GB RAM)

**Severidad:** ALTA · **Experto:** SRE · **Esfuerzo:** 10 min (1 click en DO)

**Cálculo real:** 458 MB usable − 400 MB app − 50 MB nginx = **8 MB para el kernel, journald, Docker daemon, sshd, fail2ban**. El uso actual (21 MB / 400 MB) es engañoso porque todavía no hay tráfico real ni sessions acumuladas.

**Acción:** subir el droplet a USD 6 (1 GB RAM) antes de la campaña del 1/5. Es 1 click en DO, sin downtime significativo.

**Ajustes de compose complementarios mientras tanto (costo 0):**

```yaml
app:
  deploy:
    resources:
      limits:
        memory: 300M  # bajar de 400M
nginx:
  deploy:
    resources:
      limits:
        memory: 32M  # bajar de 50M
```

---

### 11. Verificar RLS de Supabase (waitlist)

**Severidad:** ALTA · **Experto:** Security · **Esfuerzo:** 30 min

El `index.html` tiene el `anon key` de Supabase embebido en JavaScript. Esto es **esperable** en Supabase, pero solo si las policies RLS son estrictas. Si el role `anon` puede hacer `SELECT * FROM waitlist_socios`, toda la PII de la waitlist (nombres, emails, rango de pago declarado, ubicación) es **pública**.

**Acciones:**

- [ ] Verificar desde la consola de Supabase (proyecto `ugvlzjbsulrkdjtapozn`) que las policies de `waitlist_socios` son:
  - `anon` rol: solo `INSERT` permitido, con un `CHECK` que limite length de campos
  - `authenticated` rol: `SELECT` permitido solo a usuarios autorizados
- [ ] Verificar que el RPC `waitlist_count` es `SECURITY DEFINER` con `SET search_path = public, pg_temp`
- [ ] Probar desde curl: `GET waitlist_socios` con el anon key debería devolver `[]` o error
- [ ] Si el anon puede `SELECT`, es incidente: rotar anon key en Supabase y actualizar el `.env`

---

## 🟢 Bloque 3 — Calidad del repo + portafolio IT

### 12. Crear `CASE_STUDY.md` en la raíz del repo (🌟 máximo ROI para portafolio)

**Severidad:** ALTA (para portafolio, no para producción) · **Experto:** Tech Writer + OSS · **Esfuerzo:** 2-3h

> **Insight clave del Technical Writer:** "El README está escrito desde la perspectiva del software, no del Service Designer que llegó a un sistema existente, lo auditó, lo mejoró y documentó el proceso. Un recruiter que busca UX Researcher abre README.md, ve 'Node 20 + Express + Prisma', confirma que no es dev full-stack y cierra la pestaña."

**Crear `CASE_STUDY.md`** (1500-2000 palabras) que cuente el proyecto desde la perspectiva de Service Design:

- **Problema del cliente:** 21 músicos de una cooperativa sin interlocutor único, dependencia tecnológica del desarrollador original
- **Descubrimiento:** reuniones con Euge, Nati, Tebi + panel de 7 expertos en la auditoría inicial
- **Decisiones de producto:** waitlist con encuesta RFM como instrumento de research (no "form"), criterios de corte para el sistema de socios
- **Trade-offs:** mantener stack legacy de Lucho vs. migrar a Astro desde cero (decisión justificada con ROI)
- **Handover como service blueprint:** el `runbook-deploy.md` reconceptualizado como artefacto de Service Design — documenta el flujo operacional de un servicio crítico entre stakeholders
- **Métricas:** 40 validaciones Playwright, 18 screenshots, $6-8M/año de ahorro estimado vs Passline
- **Post-mortem del Sprint 2:** qué salió bien, qué salió mal, qué aprendimos

Este archivo **es** lo que va en CV, LinkedIn y entrevistas — NO el README técnico.

**Bonus complementario:** crear `docs/research/waitlist-rfm-method.md` con las 6 preguntas, sus hipótesis, la conexión con el framework RFM (Recency-Frequency-Monetary), y las decisiones de producto que se van a tomar con cada variable.

**⚠️ Nota importante sobre cuándo hacer esto:** el CASE_STUDY hay que escribirlo con contexto completo. Requiere retomar:

- Memorias persistentes del proyecto SAB en `~/.claude/projects/-mnt-c-Users-Lenovo-Desktop-ASESOR-A-IT-SAB-Landing-Page/memory/`
- Documentos de `Asesoría IT/SAB/` (transcripción de reuniones, auditorías, propuesta comercial, horizonte de mejoras, referencias de membresía)
- El caso de estudio público de Martín en GitHub del SAB (perfil UX)
- Perfil profesional completo de Martín (CLAUDE.md global)

**No hacerlo al final de una sesión cansada.** Merece su propia sesión con setup de contexto adecuado. El insight del Tech Writer es de alto ROI pero se ejecuta mal si no hay contexto cargado.

---

### 13. Fix del quick start del README (inconsistencias)

**Severidad:** MEDIA · **Experto:** Tech Writer · **Esfuerzo:** 15 min

- [ ] `git clone git@github.com:martinlleral/sab-landing.git` clona en carpeta `sab-landing`, pero la estructura del proyecto en el README muestra `sindicato-argentino-de-boleros/` como root. **Unificar a uno de los dos.**
- [ ] `.env.example` menciona `ADMIN_USER` pero el código del seed usa `ADMIN_EMAIL`. **Cambiar a `ADMIN_EMAIL` para consistencia.**
- [ ] Probar el quick start literal en una carpeta vacía antes de mergear cualquier update del README. **Regla de oro:** si el quick start no pasa `fresh clone → docker compose up`, el README miente.

---

### 14. Embeber screenshots de `docs/audit/` inline en el README

**Severidad:** MEDIA · **Experto:** Tech Writer · **Esfuerzo:** 30 min

> **Insight del Tech Writer:** "La carpeta `docs/audit/` es oro enterrado. Hay 27 screenshots de auditoría Playwright — desktop, mobile, tablet, antes/después de fixes, focus de teclado — que **son** la evidencia concreta del trabajo de Martín, y el README ni los menciona salvo con un link plano. Un recruiter UX miraría esos before/after con los ojos bien abiertos."

**Acciones:**

- [ ] Agregar sección "Auditorías y research" al final del README
- [ ] Embeber 3-5 imágenes clave con `![alt](docs/audit/...)`:
  - `prod-full.png` o `desktop-full.png` — screenshot del producto final
  - `fix-proximos-eventos.png` (before/after del fallback event-default)
  - `12-keyboard-focus.png` (evidencia de accessibility)
  - `mobile-full.png` (responsive)
  - `10-waitlist-success.png` (flujo completo del waitlist)
- [ ] Una frase corta por imagen explicando qué muestra y la metodología

---

### 15. Agregar `CONTRIBUTING.md` + issue templates + `docs/adaptacion.md`

**Severidad:** MEDIA · **Experto:** Tech Writer + OSS · **Esfuerzo:** 1h

**Problema:** el repo se posiciona como "forkeable por otras cooperativas" pero no hay guía concreta de cómo hacerlo. Ejercicio mental: soy Orquesta Cooperativa de Mendoza. Clono el repo. ¿Qué encuentro hardcodeado?
- Nombre del sindicato en `<title>`
- Fotos, colores, dominios
- Schema.org MusicGroup
- Textos en `public/index.html`
- Referencias a "Amor de Miércoles"
- Credenciales MP apuntando a una cuenta específica

**Acciones:**

- [ ] `CONTRIBUTING.md` de ~30 líneas en español explicando: cómo abrir issues, formato de PR, cómo correr tests (no hay pero documentar la ausencia), código de conducta implícito
- [ ] `.github/ISSUE_TEMPLATE/bug_report.md`
- [ ] `.github/ISSUE_TEMPLATE/adaptar_a_mi_cooperativa.md` (caso de uso específico del proyecto)
- [ ] `.github/pull_request_template.md`
- [ ] `docs/adaptacion.md` con checklist de 12 puntos a tocar para forkear:
  1. Nombre del proyecto en `package.json`, README, LICENSE
  2. Textos y títulos en `public/index.html`
  3. Schema.org MusicGroup (nombre, sameAs, foundingLocation)
  4. Colores y tipografía en `public/assets/css/app.css`
  5. Logo, favicon, og:image
  6. Dominio del `BASE_URL` en `.env`
  7. Credenciales MP nuevas del otro cooperativa
  8. Redes sociales en footer
  9. Mapa de ubicación + dirección
  10. Ciclo y eventos de ejemplo en seed
  11. Fotos del slider en `public/assets/img/`
  12. Textos del mail de confirmación en `src/services/brevo.service.js`

---

### 16. Badges + metadata OSS en el README

**Severidad:** BAJA · **Experto:** Tech Writer · **Esfuerzo:** 20 min

- [ ] Badges shield.io al tope del README: license MIT, last commit, GitHub stars/forks, language
- [ ] Architecture diagram simple (Mermaid embebido en el README): landing → nginx → app → SQLite + Supabase + MP + Brevo
- [ ] Opcional: `CHANGELOG.md` con formato [Keep a Changelog](https://keepachangelog.com)

---

## 🟢 Cosméticos de baja prioridad (para cuando sobre tiempo)

- [ ] Borrar `/etc/ssh/sshd_config.d/50-cloud-init.conf` y `60-cloudimg-settings.conf` del droplet (redundantes con `00-sab-hardening.conf`, no tóxicos)
- [ ] Config `sudo NOPASSWD` más restrictiva: solo `docker`, `systemctl restart nginx`, `certbot`, `apt` — todo lo demás pide password
- [ ] Structured logging (pino o winston) con formato JSON para integración futura con Loki/ELK
- [ ] CI/CD automatizado: GitHub Actions con workflow `deploy.yml` que sincronice al droplet via SSH
- [ ] Secrets management con Doppler o Infisical (reemplazar `.env` en disco)
- [ ] Commit del fix `server.js` + `seed.js` al repo (ya están en el droplet pero también en GitHub tras el commit `74d21f2`)

---

## 🔧 TODOs estructurales (no son deuda, son decisiones estratégicas)

- [ ] **Decisión repo:** seguimos en GitHub personal de Martín o creamos uno del SAB cuando tengan personería jurídica
- [ ] **Transferencia titularidad del dominio** en NIC.ar antes del vencimiento 5/8/2026
- [ ] **CI/CD:** hoy deployamos con rsync + docker compose manual. Cuando el proyecto madure, convendría automatizar
- [ ] **Staging environment:** un segundo droplet $4/mes que reciba cambios antes que prod

---

## 📡 Pendientes externos (no dependen de trabajo técnico, solo de coordinación)

- [ ] **Gmail App Password** generado por Nati/Tebi desde la cuenta `sindicatoargentinodeboleros@gmail.com` (mensaje listo para mandar en el portapapeles de Martín)
- [ ] **Rotación MP Access Token** desde panel MercadoPago del SAB (Nati/Uri)
- [ ] **Lucho cambia los nameservers** en NIC.ar a la cuenta Cloudflare nueva del SAB (mensaje ya preparado en sesiones anteriores)
- [ ] **Cloudflare account** del SAB con el mail `sindicatoargentinodeboleros@gmail.com`
- [ ] **Transferencia de titularidad del dominio** — conversación con Lucho aprovechando la fecha de vencimiento

---

## ✅ Qué NO es deuda (está bien así)

Según los expertos, estas decisiones son correctas y no hay que tocarlas:

- Credenciales admin bootstrap via env vars (seed idempotente corregido)
- CORS configurable por `ALLOWED_ORIGINS` (buen patrón)
- Healthcheck + dependencia `nginx → service_healthy` (buena práctica)
- SQLite como DB (suficiente para el volumen actual)
- Ubicación del datacenter NYC1 (aceptable hasta que latencia sea un problema medible)
- Ausencia de Redis para sessions (express-session con SQLite alcanza para este tamaño)
- MIT License con copyright dual (Lucho + Martín/SAB) — formato correcto, GitHub lo reconoce
- Runbook de deploy con Fase 0 de rotación de secrets como bloqueante (madurez de seguridad)
- Créditos a Lucho en README (ética y tono impecables según el Tech Writer)

---

## Estado actual del droplet (referencia)

```
IP pública:       162.243.172.177
Hostname:         sab-prod
Region:           NYC1
OS:               Ubuntu 24.04.3 LTS
Specs:            1 vCPU / 512 MB RAM (+1 GB swap) / 10 GB SSD / USD 4/mes
Docker:           29.4.0
Docker Compose:   5.1.2
SSH access:       sab@162.243.172.177 con key ed25519 (martinlleral@gmail.com)
Sudo:             NOPASSWD para sab
Firewall:         UFW (22, 80, 443)
Fail2ban:         activo
Code:             /opt/sab/app/
.env:             /opt/sab/app/.env (chmod 600)
Containers:       sab-app (healthy) + sab-nginx
Mem limits:       app 400M, nginx 50M (ajustar post-upgrade a 300M/32M)
Logging:          json-file, max-size 10m, max-file 3
```

---

## Referencias

- **Runbook de deploy completo:** `docs/runbook-deploy.md`
- **Auditoría Playwright técnica (10/4):** `docs/auditoria-playwright-20260410.md`
- **Auditoría de expertos post-deploy (14/4):** SRE senior + Application Security Engineer + Technical Writer + OSS advocate — resumen consolidado en este mismo archivo
- **Repositorio público:** https://github.com/martinlleral/sab-landing

---

*Este archivo debe revisarse al inicio de cada sesión de trabajo y actualizarse al cerrarla.*
