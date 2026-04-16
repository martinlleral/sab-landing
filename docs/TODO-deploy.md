# TODO — Deploy & Technical Debt

**Última actualización:** 16/4/2026 (post auditoría de integridad con 7 expertos)
**Estado general:** MVP en producción con hardening parcial. Auditoría del 16/4 identificó hallazgos adicionales en seguridad, resiliencia, documentación y portafolio.
**Score del proyecto (14/4, pre-hardening):** 5.8 / 10 promedio (SRE 5.5 · Security 4.8 · Tech Writer 7.0)

> Este archivo es la fuente de verdad de lo que queda pendiente. Actualizado con los hallazgos consolidados de la auditoría de expertos del 14/4/2026 (SRE senior + Application Security Engineer + Technical Writer + OSS advocate), más los cierres del 15/4/2026.
>
> **Ir tachando con `~~texto~~` + `✅ Hecho DD/MM` al cerrar cada ítem.**

## Progreso del 15/4 — 8 ítems cerrados

- **Bloque 1 (seguridad crítica):** ítem 1 (webhook MP con firma + validación monto/collector) · ítem 3 (endpoint `/status` eliminado por dead code)
- **Bloque 2 (resiliencia):** ítem 9 (graceful shutdown + `/healthz` con Prisma check + wiring de `MP_WEBHOOK_SECRET`/`MP_USER_ID` al container) · ítem 11 (RLS de Supabase verificado en vivo con 4 vectores — sin filtración — + fix de `search_path` en `waitlist_count`)
- **Bloque 3 (calidad del repo):** ítem 13 (fix `ADMIN_USER` → `ADMIN_EMAIL` en ambos `.env.example`) · ítem 14 (5 screenshots curadas + sección "Auditorías y research" en README) · ítem 15 (`CONTRIBUTING.md` + `docs/adaptacion.md` + 3 templates `.github/`) · ítem 16 (5 badges shield.io + diagrama Mermaid de arquitectura en README)

**Pendientes del Bloque 1 que requieren dependencias externas o entorno no disponible en la sesión autónoma:** ítem 2 (rotación de secrets externa) · ítem 4 (upgrade CVEs, requiere test real del flujo Brevo) · ítem 5 (rate limiting, requiere `npm install` local) · ítem 6 (auth hardening, `cookie.secure` espera HTTPS activo).

**Pendientes del Bloque 2 antes de la campaña del 1/5:** ítem 7 (backups automáticos) · ítem 8 (uptime monitoring) · ítem 10 (upgrade del droplet a 1 GB RAM) · sub-ítem 11b (checks de longitud en policy INSERT de `waitlist_socios` — pendiente de definir umbrales con Martín).

**Pendientes del Bloque 3 para portafolio:** ítem 12 (`CASE_STUDY.md` — requiere sesión dedicada con contexto completo cargado).

---

## 🔍 Auditoría de integridad — 16/4/2026

Panel de 7 expertos revisó el repo completo. **Hallazgos de seguridad e infraestructura documentados internamente** (se publican tachados una vez fixeados). Hallazgos de docs, portafolio y community listados abajo.

### ~~🔴 P0 — Seguridad pre-deploy (4 ítems, ~30 min)~~ ✅ Cerrado 16/4

Ítems 17-20 fixeados y pusheados en commit `8f0383e`. Cubrieron: bug en verificación de firma, validación en job de sync, fail-fast de config en producción, y config segura de reverse proxy HTTP-only.

---

### 🟡 P1 — Antes de la campaña del 1/5

#### 21. Badge de status: cambiar dirección temporal por dominio definitivo

**Experto:** OSS + Tech Writer · **Esfuerzo:** 2 min

- [ ] Actualizar link del badge en README al dominio definitivo cuando esté activo

---

#### 22. Agregar `ALLOWED_ORIGINS` a ambos `.env.example`

**Experto:** Tech Writer · **Esfuerzo:** 5 min

Variable usada en el código pero no documentada en los templates de env.

- [ ] Agregar `ALLOWED_ORIGINS=` con comentario a `.env.example` y `docs/env.example.clean`

---

#### 23-24. Ajustes de infraestructura (2 ítems)

Documentados internamente: ajuste de memory limits del container y ventana temporal del job de sincronización.

---

#### 25. Resolver link roto a `docs/auditoria-playwright-20260410.md`

**Experto:** Tech Writer · **Esfuerzo:** 10 min

README referencia este archivo pero no existe en el repo. Un click lleva a 404.

- [ ] Agregar el archivo al repo, o cambiar el link por texto tipo "reporte disponible bajo pedido" si fue excluido intencionalmente

---

#### 26. Declarar uso de AI en el README

**Experto:** AI Reviewer · **Severidad:** MEDIA · **Esfuerzo:** 10 min

Los commits dicen "Co-Authored-By: Claude" pero el README no lo menciona. Crea asimetría: quien revisa commits lo ve, quien lee README no. La industria en 2026 converge hacia declarar el uso de AI en la documentación principal.

- [ ] Agregar 3-4 líneas en README (sección "Historia del proyecto" o nueva "Metodología") tipo: "Las extensiones del Sprint 2 fueron desarrolladas usando Claude Code como co-autor técnico. Las decisiones de diseño, prioridades y research son de Martín; la ejecución de código y documentación técnica fueron producidos en pares humano-AI."

---

#### 27. Inconsistencias documentales menores (batch)

**Experto:** Tech Writer · **Severidad:** MEDIA · **Esfuerzo:** 15 min

- [ ] `docker-compose.prod.yml` referenciado en `docs/runbook-deploy.md` pero no existe — aclarar que se usa `docker-compose.yml` directamente
- [ ] SMTP_HOST default discrepante: compose dice `smtp.gmail.com`, config dice `smtp-relay.brevo.com` — unificar
- [ ] Número de screenshots: "27" en README y WORKFLOW-LEARNINGS vs "18" en otros docs — unificar a "27" (que es la realidad en `docs/audit/`)
- [ ] "5 fases" del runbook en README son en realidad 6 (Fase 0 a 5) — aclarar "6 fases (Fase 0 de prerequisites + 5 de ejecución)"
- [ ] `package.json` description dice "SPA" pero no es SPA, es server-rendered — cambiar a "Ticketera para banda de música"
- [ ] `adaptacion.md` no menciona `nginx/app.conf` (tiene `server_name` hardcodeado) ni `docker-compose.yml` (`container_name`) — agregar como puntos 13-14

---

### 🟢 P2 — Portafolio (sesión dedicada, ~4h)

#### 12 (enriched). CASE_STUDY.md — brief de la Recruiter UX/SD

**Experto:** Recruiter · **Severidad:** ALTA (portafolio) · **Esfuerzo:** 2-3h

La Recruiter dio un brief detallado. Estructura sugerida: TL;DR → Contexto y desafío → Mi rol → Proceso (Discovery, Research, Decision, Priorización, Handover) → Artefactos visuales (1-2) → Resultados medibles → Reflexión → Stack al final. Extensión: 1200-1800 palabras. Tono: narrativo + bullets + datos concretos.

3 frases gancho que deberían estar:
1. "Mi trabajo no fue construir la ticketera — fue diseñar la transferencia de un servicio crítico entre dos equipos sin interrumpir a 2.000 fans"
2. "El formulario de waitlist no es un campo de contacto — es un instrumento de research con 6 preguntas RFM"
3. "Documentar para el lector, no para uno mismo, es una decisión de diseño"

- [ ] Escribir CASE_STUDY.md con el brief de arriba
- [ ] Crear 1 artefacto visual (journey map del fan o service blueprint)
- [ ] Analizar datos reales de la waitlist (aunque sean N=15) con corte preliminar

---

### 🟢 P3 — Community y nice-to-have

#### 28. Video demo + FAQ + cuadro de costos

**Experto:** Gestora Cultural · **Severidad:** MEDIA · **Esfuerzo:** 1h

Lo que convencería a otra cooperativa de forkear: (a) video de 3-5 min mostrando flujo de compra E2E (no profesional, screencast), (b) FAQ de 10 preguntas frecuentes, (c) cuadro de costos mensuales estimados (server + dominio + MP comisión + mail), (d) sección "Esto NO es para vos si..." para filtrar cooperativas sin recursos técnicos.

- [ ] Video screencast del flujo completo (compra → mail con QR → validación en puerta)
- [ ] FAQ en README o doc separado
- [ ] Cuadro de costos en `docs/adaptacion.md`

---

#### 29. `CODE_OF_CONDUCT.md` + `good-first-issue` labels

**Experto:** OSS · **Severidad:** BAJA · **Esfuerzo:** 30 min

GitHub detecta automáticamente `CODE_OF_CONDUCT.md` y muestra un badge en la página del repo. Sin él, muestra "This project does not have a code of conduct". Contributor Covenant en español es el estándar.

- [ ] Crear `CODE_OF_CONDUCT.md` con Contributor Covenant en español
- [ ] Abrir 2-3 issues con label `good first issue` (ej: traducción al inglés, script de adaptación, tests básicos para /healthz)

---

#### 30. Reducir simetría del WORKFLOW-LEARNINGS

**Experto:** AI Reviewer · **Severidad:** BAJA · **Esfuerzo:** 20 min

La estructura perfecta (8 patrones, 5 anti-patterns, 4 decisiones, 19 preguntas) delata coautoría AI para ojos entrenados. Fusionar 2-3 patrones que se solapan (1.3 y 1.4 → "Saneamiento pre-publicación"), agregar 1-2 notas sueltas sin formato, reducir las 19 preguntas a 10-12 esenciales.

- [ ] Fusionar patrones solapados
- [ ] Agregar notas sueltas / reflexiones informales
- [ ] Podar preguntas redundantes

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

### ~~1. 🚨 Webhook MercadoPago sin verificación de firma — HALLAZGO CRÍTICO~~ ✅ Hecho 15/4

**Resuelto:** `src/controllers/compras.controller.js` ahora valida firma HMAC-SHA256 (fail-closed si `MP_WEBHOOK_SECRET` ausente), `pago.collector_id` contra `MP_USER_ID` y `pago.transaction_amount` contra `compra.totalPagado`. Verificado con 6 unit tests sobre `verifyMpSignature()` + 5 tests e2e del handler HTTP (sin secret → 503, sin firma → 401, firma válida → 200, amount mismatch → 400, collector mismatch → 403). Fallback cubierto por `syncPagosPendientes` cada 60s + polling cliente en `back_url`, por lo que rechazar sin secret no pierde compras.

**Pendiente externo:** coordinadora/tesorero del SAB deben activar "Clave secreta" en panel MP → Webhooks → cargar `MP_WEBHOOK_SECRET` + `MP_USER_ID` en `.env` del droplet + restart.

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

### ~~3. Endpoint `/api/compras/status/:preferenciaId` — enumeración sin auth~~ ✅ Hecho 15/4

**Resuelto:** borrado el endpoint completo. Auditoría del uso reveló que era dead code: la constante `API.status` en `public/assets/js/app.js` estaba definida pero nunca se invocaba en ninguna parte del frontend, y `checkPaymentReturn()` usa `POST /api/compras/check/:preferenciaId` (que devuelve solo `{status, compraId, entradas}` sin PII ni QR). Eliminado `getStatus` del controller + ruta en `compras.routes.js` + stub `API.status` del frontend + export del controller. Criterio: **superficie mínima de ataque** supera a "proteger con doble clave" cuando el endpoint no tiene consumidores. Si alguna vez se necesita, se recrea con auth de sesión o JWT firmado.

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
- [ ] Alerta por mail a Martín + coordinadora del SAB
- [ ] Bonus: webhook a Telegram bot para alertas inmediatas
- [ ] Post-SSL: monitor HTTPS con validación de cert expiración

---

### ~~9. Graceful shutdown + endpoint `/healthz` real~~ ✅ Hecho 15/4

**Resuelto:**

- **`GET /healthz` en `src/server.js`** — hace `prisma.$queryRaw\`SELECT 1\``. Si la consulta funciona responde `{status: 'ok', db: 'up', uptime: N}` con 200; si Prisma falla, loguea y devuelve 503 con `{status: 'error', db: 'down'}`. Registrado antes de `express.static` para que no se shadowee.

- **Graceful shutdown handler** — refactor del SIGTERM/SIGINT listener. Nuevo flujo: `clearInterval(syncPagosPendientes) → server.close() → prisma.$disconnect() → process.exit(0)`. Failsafe interno de 10s con `setTimeout().unref()` en caso de que algo se cuelgue. Previene cortar webhooks MP en vuelo durante `docker compose restart`.

- **`docker-compose.yml` — tres cambios al servicio app:**
  - `init: true` → tini como PID 1, propaga señales correctamente al proceso Node (sin esto, `docker stop` manda SIGKILL porque Node no captura SIGTERM cuando es PID 1)
  - `stop_grace_period: 30s` → le da al graceful shutdown hasta 30s antes del SIGKILL forzoso
  - Healthcheck: `wget /` → `wget -qO- /healthz` (uso GET explícito en vez de `--spider` para evitar HEAD, que Express no siempre resuelve sobre rutas `app.get()`)
  - `start_period: 40s → 60s` — margen extra para migraciones Prisma frías en el primer boot del container

- **Bonus: wiring de `MP_WEBHOOK_SECRET` + `MP_USER_ID` al container** — las dos env vars que agregamos en el commit del ítem 1 no estaban pasadas del host al container. Corregido con `${MP_WEBHOOK_SECRET:-}` y `${MP_USER_ID:-}`. Sin esto, el webhook seguiría rechazando todo después del deploy porque `config.mercadopago.webhookSecret` quedaría vacío.

**Tests verdes:**

- 2 unit tests del `/healthz` handler (Prisma OK → 200/status:ok/uptime numeric; Prisma fail → 503/db:down)
- 1 test e2e del shutdown handler con mock de `process.exit` (secuencia correcta: interval cleared → server closed → prisma disconnected → exit(0))
- Sintaxis de `server.js` con `node -c` → OK
- Estructura de `docker-compose.yml` validada con Python yaml (init/stop_grace/healthcheck/MP vars presentes)

**Importante para el próximo deploy:** el healthcheck nuevo depende de que `/healthz` responda. Como el endpoint consulta Prisma, si el container arranca con un schema roto o Prisma no conecta, el container nunca queda `healthy` y nginx no le pasa tráfico (por `depends_on: service_healthy`). Es el comportamiento correcto — prefiero un container unhealthy conocido que tráfico a un backend con DB rota — pero hay que validar el primer boot del próximo deploy con `docker compose logs -f sab-app` para confirmar que pasa el health check en ≤60s.

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

### ~~11. Verificar RLS de Supabase (waitlist)~~ ✅ Verificado 15/4 · sin incidente

**Resultado:** ningún SELECT desde anon devuelve PII. Los 4 vectores probados en vivo contra `https://ugvlzjbsulrkdjtapozn.supabase.co/rest/v1/waitlist_socios` con el anon key embebido en `public/index.html`:

| Vector | HTTP | Body / Headers | Estado |
|---|---|---|---|
| `GET /waitlist_socios?select=*&limit=5` | 200 | `[]` (RLS filtra todos los rows) | ✅ sin PII |
| `GET /waitlist_socios?select=email&limit=5` | 200 | `[]` | ✅ sin PII |
| `POST /rpc/waitlist_count` (RPC) | 200 | `21` | ✅ esperado |
| `HEAD /waitlist_socios` con `Prefer: count=exact` | 200 | `content-range: */0` | ✅ el count reportado es 0, no el real — RLS también bloquea enumeración por count |

**Policies actuales (confirmadas vía `pg_policies`):**

```
tablename         policyname                         roles            cmd     qual    with_check
waitlist_socios   Público puede registrarse          {anon}           INSERT  -       true
waitlist_socios   Solo autenticados pueden leer      {authenticated}  SELECT  true    -
```

`rowsecurity: true` sobre la tabla. `waitlist_count()` es `SECURITY DEFINER` y funciona.

**Conclusión:** el anon key embebido en el HTML **no filtra datos**. No hay incidente, no hay que rotar la key.

---

#### Hallazgos menores del advisor (2 WARN, NO bloqueantes, NO aplicados en esta sesión)

**a) ~~`function_search_path_mutable` — `waitlist_count`~~ ✅ Aplicado 15/4**

```sql
ALTER FUNCTION public.waitlist_count() SET search_path = public, pg_temp;
```

Confirmado en `pg_proc.proconfig`: `["search_path=public, pg_temp"]`. Advisor re-corrido, el WARN desapareció del listado. Test post-aplicación: `POST /rpc/waitlist_count` con anon key sigue devolviendo `21` (HTTP 200). Cero disrupción.

**b) `rls_policy_always_true` — policy INSERT de `waitlist_socios`**

La policy `Público puede registrarse` es `WITH CHECK (true)`, o sea **sin validación**. Cualquier anon puede insertar cualquier cosa (spam, payloads gigantes, emails inválidos). Mitigación propuesta por el advisor: agregar `CHECK` sobre longitud y formato de columnas.

→ **Más delicado.** Si el CHECK es muy estricto rompe inserts legítimos. Requiere conocer el schema real de `waitlist_socios` y decidir umbrales con vos (ej. `char_length(email) < 255`, `char_length(nombre) < 120`, `rango_pago IN (...)`). Podemos resolverlo en una sesión breve cuando quieras; para **spam real** conviene resolverlo **antes** de la campaña del 1/5, combinado con un rate limit a nivel nginx sobre `/rest/v1/waitlist_socios` (ítem 5 del Bloque 1).

**Comandos de lectura que corrí (reproducibles):**

```sql
SELECT schemaname, tablename, rowsecurity FROM pg_tables
  WHERE schemaname='public' AND tablename='waitlist_socios';

SELECT schemaname, tablename, policyname, roles, cmd, qual, with_check
  FROM pg_policies
  WHERE schemaname='public' AND tablename='waitlist_socios' ORDER BY policyname;

SELECT p.proname, p.prosecdef, pg_get_functiondef(p.oid)
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='waitlist_count';
```

---

## 🟢 Bloque 3 — Calidad del repo + portafolio IT

### 12. Crear `CASE_STUDY.md` en la raíz del repo (🌟 máximo ROI para portafolio)

**Severidad:** ALTA (para portafolio, no para producción) · **Experto:** Tech Writer + OSS · **Esfuerzo:** 2-3h

> **Insight clave del Technical Writer:** "El README está escrito desde la perspectiva del software, no del Service Designer que llegó a un sistema existente, lo auditó, lo mejoró y documentó el proceso. Un recruiter que busca UX Researcher abre README.md, ve 'Node 20 + Express + Prisma', confirma que no es dev full-stack y cierra la pestaña."

**Crear `CASE_STUDY.md`** (1500-2000 palabras) que cuente el proyecto desde la perspectiva de Service Design:

- **Problema del cliente:** 21 músicos de una cooperativa sin interlocutor único, dependencia tecnológica del desarrollador original
- **Descubrimiento:** reuniones con co-fundador, coordinadora e interlocutor operativo + panel de 7 expertos en la auditoría inicial
- **Decisiones de producto:** waitlist con encuesta RFM como instrumento de research (no "form"), criterios de corte para el sistema de socios
- **Trade-offs:** mantener stack legacy de Lucho vs. migrar a Astro desde cero (decisión justificada con ROI)
- **Handover como service blueprint:** el `runbook-deploy.md` reconceptualizado como artefacto de Service Design — documenta el flujo operacional de un servicio crítico entre stakeholders
- **Métricas:** 40 validaciones Playwright, 27 screenshots, $6-8M/año de ahorro estimado vs Passline
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

### ~~13. Fix del quick start del README (inconsistencias)~~ ✅ Hecho 15/4

**Resuelto:**

- [x] **`sab-landing/` vs `sindicato-argentino-de-boleros/`:** revisión del README reveló que la estructura (README.md:82) ya dice `sab-landing/` como root, consistente con el `git clone git@github.com:martinlleral/sab-landing.git` de la línea 65. Este ítem del TODO estaba desactualizado — el README ya había sido arreglado en alguna sesión previa. Nota: en disco local el working dir se llama `sindicato-argentino-de-boleros/` (nombre heredado del repo original de Lucho en GitLab), pero eso no afecta al usuario que clona del GitHub público.
- [x] **`ADMIN_USER` vs `ADMIN_EMAIL`:** bug real confirmado. `prisma/seed.js:16` lee `process.env.ADMIN_EMAIL`, `docker-compose.yml:24` pasa `ADMIN_EMAIL` al container, pero los dos `.env.example` (`/.env.example` y `docs/env.example.clean`) decían `ADMIN_USER`. Un usuario siguiendo el quick start literal quedaba con el admin bootstrap sin email configurado (fallback a `'admin@localhost'`). **Corregido** en ambos `.env.example` + comentario explicativo agregado sobre la coincidencia exacta de nombres.
- [ ] ~~Probar el quick start literal~~ — no ejecutable en sesión autónoma (requiere Docker running + red + credenciales MP válidas), pero la verificación estática cerró los dos bugs documentados. Sigue pendiente para la próxima sesión con Docker activo.

---

### ~~14. Embeber screenshots de `docs/audit/` inline en el README~~ ✅ Hecho 15/4

**Resuelto:** agregada sección `## Auditorías y research` al README entre "Deuda técnica pendiente" y "Contribuir". 5 imágenes curadas con una narrativa que cuenta distintos aspectos del trabajo:

1. **`prod-hero.png`** — producto final en producción (post deploy del 14/4)
2. **`mobile-full.png`** — responsive (breakpoints <400, 390, 768, 1440)
3. **`12-keyboard-focus.png`** — accesibilidad WCAG AA (tab order + focus-visible)
4. **`10-waitlist-success.png`** — waitlist como instrumento de research RFM (el ángulo UX/service design)
5. **`fix-proximos-eventos.png`** — evidencia de un fix concreto (before/after de "Próximos eventos")

Cada imagen con un alt descriptivo y un párrafo corto que explica qué evidencia aporta y la metodología. El reporte completo de la auditoría queda linkeado al inicio de la sección. Total embebido ~3 MB (prod-hero 376KB + mobile-full 1.1MB + keyboard-focus 1.1MB + waitlist-success 128KB + fix-proximos 346KB). Criterio: superficie mínima pero con impacto visual alto para un recruiter UX que abra el repo. **Verificado:** los 5 paths existen en `docs/audit/`.

---

### ~~15. Agregar `CONTRIBUTING.md` + issue templates + `docs/adaptacion.md`~~ ✅ Hecho 15/4

**Resuelto:** 5 archivos nuevos que completan el posicionamiento "forkeable por otras cooperativas":

1. **`CONTRIBUTING.md`** en la raíz (~90 líneas) — guía de contribución en español, con tipos de PR que encajan y los que no, cómo abrir issues, estilo de commits, tests (documenta la ausencia actual), código de conducta implícito y ético. Apunta a cooperativas y proyectos culturales pequeños como audiencia primaria, no a dev open source tradicional.

2. **`docs/adaptacion.md`** (~170 líneas) — checklist de 12 puntos **concretos con archivos y líneas exactos** para adaptar el fork a otra cooperativa:
   - Nombre del proyecto (package.json, README, LICENSE — con aclaración de mantener crédito a Lucho)
   - Título + descripción + og:* + twitter:*
   - Schema.org MusicGroup (SEO, con link al Rich Results Test)
   - Colores + tipografía (app.css)
   - Logo, favicon, og:image
   - Fotos del slider (con optimización a <300KB)
   - Variables de `.env` completas (incluyendo `MP_WEBHOOK_SECRET` + `MP_USER_ID` del commit del webhook)
   - Footer + redes sociales
   - Mapa Google Maps
   - Eventos del seed
   - MP + webhook (con pasos literales del panel)
   - Textos del mail de confirmación (`brevo.service.js`)
   - Sección final de **post-adaptación — qué validar antes de lanzar** (Lighthouse, Rich Results, OpenGraph preview, mobile test con 3 personas)
   - Incluye una sección "Antes de forkear — decisiones a tomar" con 5 preguntas gating que evitan que alguien forkee sin MP del proyecto, dominio, etc.

3. **`.github/ISSUE_TEMPLATE/bug_report.md`** — template estructurado para reportar bugs (contexto, pasos, entorno con commit/rama/URL, logs con aclaración de `<REDACTED>` para secrets, severidad).

4. **`.github/ISSUE_TEMPLATE/adaptar_a_mi_cooperativa.md`** — template específico para cooperativas que quieren forkear. Incluye el checklist de 12 puntos del `docs/adaptacion.md` como confirmación de progreso + preguntas sobre si tienen MP/dominio/servidor + opción "solo orientación" vs "implementación paga". El label `adaptar-a-mi-cooperativa` queda asociado.

5. **`.github/pull_request_template.md`** — checklist para PRs con: qué cambia (efecto, no diff), por qué, cómo se probó (unit/smoke/Playwright/prod), checklist de commit style + docs + secrets + env vars + tests del webhook, riesgo + reversibilidad, notas para el reviewer.

**Criterio:** estos archivos NO son boilerplate copiado — están escritos con la voz del repo (cálida pero concreta, en español latino) y apuntan específicamente a cooperativas musicales / proyectos culturales chicos. Un fork de Dependabot o una PR de "migrar a TypeScript" van a ser rechazados según `CONTRIBUTING.md`; una PR de rate limiting o traducción al portugués van a encajar. El objetivo no es atraer contribuciones al vacío sino filtrar las que sirven al posicionamiento del proyecto.

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

### ~~16. Badges + metadata OSS en el README~~ ✅ Hecho 15/4

**Resuelto:**

- [x] **5 badges shield.io al tope del README** — License MIT, Last commit, Top language, GitHub Stars, y un badge custom de "Status: in production" linkeado al droplet. Se renderizan dinámicamente desde la GitHub API (`martinlleral/sab-landing`) sin dependencias adicionales.
- [x] **Diagrama Mermaid de arquitectura** — Insertado dentro de la sección Stack, antes de "Correr en local". Flowchart LR con 8 nodos (User → Cloudflare → nginx → App → SQLite + Supabase + MP + Brevo) diferenciando servicios externos de internos con clases custom. Incluye dos flujos sincrónicos (JS directo del browser a Supabase) y tres asincrónicos (app → MP/Brevo/Supabase vía SDK/SMTP/REST). Acompañado de un párrafo que explica los **dos planos de datos**: SQLite para transaccional (control total) + Supabase para research/PII (escalable con RLS).
- [ ] ~~CHANGELOG.md formato Keep a Changelog~~ — opcional del ítem original, dejado para después (no es bloqueante, y el PLAN.md funciona como changelog informal del proyecto).

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

- [ ] **Gmail App Password** generado por la coordinadora del SAB desde la cuenta del sindicato
- [ ] **Rotación MP Access Token** desde panel MercadoPago del SAB (coordinadora/tesorero del SAB)
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

## Estado del droplet

Referencia operativa documentada internamente (no publicada por contener credenciales de acceso y topología de red).

---

## Referencias

- **Runbook de deploy completo:** `docs/runbook-deploy.md`
- **Auditoría Playwright técnica (10/4):** `docs/auditoria-playwright-20260410.md`
- **Auditoría de expertos post-deploy (14/4):** SRE senior + Application Security Engineer + Technical Writer + OSS advocate — resumen consolidado en este mismo archivo
- **Repositorio público:** https://github.com/martinlleral/sab-landing

---

*Este archivo debe revisarse al inicio de cada sesión de trabajo y actualizarse al cerrarla.*
