# TODO — Deploy & Technical Debt

**Última actualización:** 14/4/2026 (tras deploy inicial a DO)
**Estado general:** MVP funcional en producción · faltan conectar servicios externos + hardening de resiliencia

> Este archivo es la fuente de verdad de lo que queda pendiente en el proyecto.
> Orden por prioridad. Ir tachando con `~~texto~~` + `✅ Hecho DD/MM` al cerrar cada ítem.

---

## 🔴 Prioridad ALTA — bloqueantes antes de abrir el dominio público

### 1. Rotación de secrets (Fase 0 del runbook-deploy.md)

Los secrets viejos están filtrados en `.env.example` del repo (MP, Brevo, Perfit, admin) y tienen que rotarse en cada panel. El droplet nuevo YA no los usa (usa placeholders), pero los viejos siguen siendo válidos hasta que alguien los invalide.

- [ ] Regenerar `MP_ACCESS_TOKEN` y `MP_PUBLIC_KEY` en panel MercadoPago del SAB
- [ ] Borrar key SMTP vieja de Brevo (`<BREVO_SMTP_USER_VIEJO_YA_ROTADO>`)
- [ ] Borrar API key de Brevo (`<BREVO_API_KEY_VIEJA>`)
- [ ] Borrar API key de Perfit (o confirmar que ya no se usa con `grep -r PERFIT src/`)
- [ ] Reemplazar `.env.example` del repo por `docs/env.example.clean`
- [ ] Opcional: purgar historial git con BFG Repo-Cleaner

### 2. Configurar servicios de producción reales

- [ ] `MP_ACCESS_TOKEN` real en `/opt/sab/app/.env` → restart container → la ticketera procesa pagos
- [ ] `MP_PUBLIC_KEY` real (misma fuente)
- [ ] **Gmail App Password** generado desde cuenta `sindicatoargentinodeboleros@gmail.com`
  - Entrar a https://myaccount.google.com/security
  - Activar 2-step verification si no está
  - App passwords → crear "SAB Landing SMTP"
  - Copiar los 16 caracteres → meter en `.env` como `SMTP_PASS`
- [ ] Cambiar `SMTP_HOST=smtp.gmail.com` (ya puesto por default en compose)
- [ ] Verificar que los mails con QR salen: hacer 1 compra de prueba y chequear la bandeja

### 3. Control del código — inicializar git + repo remoto

- [ ] Decidir: repo personal de Martín (recomendado) vs. cuenta nueva del SAB
- [ ] Crear repo `sab-landing` en `github.com/martinlleral` (público, MIT license)
- [ ] Agregar README con contexto del SAB y link a este TODO
- [ ] `git init` en `/opt/sab/app/` del droplet **o** clonar fresco desde GitHub
- [ ] Primer commit con el estado actual post-deploy
- [ ] Agregar a Nati/Tebi como colaboradores del repo
- [ ] A futuro: workflow git → rsync o CI/CD en lugar de rsync manual

### 4. SSL + Dominio (Fase 3 del runbook-deploy.md)

Hasta que esto no esté, el sitio solo responde en `http://162.243.172.177` (inseguro, feo en los mails).

- [ ] Crear cuenta Cloudflare nueva del SAB con `sindicatoargentinodeboleros@gmail.com`
- [ ] Agregar el dominio a la zona nueva → obtener los 2 nameservers asignados
- [ ] Pedir a **Lucho** cambio de nameservers en NIC.ar (5 min, 1 acción puntual)
- [ ] Esperar propagación (2-4h típico)
- [ ] Configurar registros A + CNAME + MX + TXT en la Cloudflare nueva
- [ ] Pedir certs SSL con Let's Encrypt (certbot standalone o DNS challenge)
- [ ] Agregar servicio `certbot` al `docker-compose.yml` con volumes compartidos
- [ ] Actualizar `nginx/app.conf` con bloque HTTPS + redirect HTTP → HTTPS
- [ ] Sacar `http://162.243.172.177` de `ALLOWED_ORIGINS` (solo dominio)
- [ ] Cambiar `BASE_URL` a `https://sindicatoargentinodeboleros.com.ar`

### 5. Transferencia legal del dominio en NIC.ar

- [ ] Conversar con Lucho sobre transferir titularidad antes del vencimiento (5/8/2026)
- [ ] Crear cuenta NIC.ar del SAB (con CUIT de la cooperativa o de un cofundador)
- [ ] Trámite de cambio de titularidad (días a semanas)

---

## 🟡 Prioridad MEDIA — resolver en próximos sprints

### 6. Backups automáticos del `prod.db` + uploads

Hoy si el droplet se pierde, perdemos todo lo que no esté en Supabase.

- [ ] Script de backup: `sqlite3 prod.db ".backup /tmp/backup.db"` + `tar -czf uploads.tgz /app/public/assets/img/uploads`
- [ ] Subir a un bucket: Supabase Storage (gratis 1 GB) o Cloudflare R2 (gratis 10 GB)
- [ ] Cron dentro del container: 1 vez por día, retention 30 días
- [ ] Probar restore desde backup en un container limpio

### 7. Uptime monitoring externo

- [ ] Cuenta gratis en **Uptime Robot** (https://uptimerobot.com)
- [ ] Monitor HTTP cada 5 min a `https://sindicatoargentinodeboleros.com.ar/`
- [ ] Monitor API cada 5 min a `/api/eventos/destacado`
- [ ] Notificación por mail a Martín + Nati si cae
- [ ] Opcional: integración con Telegram bot para alertas más rápidas

### 8. Observabilidad básica

- [ ] Status page pública (Uptime Robot la da gratis con el plan free)
- [ ] Logs centralizados: considerar `loki` + `grafana` gratis en otro proyecto del SAB o en el mismo droplet si hay recursos
- [ ] Métricas del droplet: DO Monitoring ya activado, revisar el panel DO 1x/semana

### 9. Secrets management

Hoy los secrets viven en texto plano en `/opt/sab/app/.env` (chmod 600).

- [ ] Evaluar pasar a **Doppler** (plan gratis) o **Infisical** (self-hosted)
- [ ] Alternativa lite: script que carga secrets desde un gestor externo (Bitwarden CLI, 1Password CLI) al momento del deploy
- [ ] Acceso compartido con Nati al gestor de passwords del SAB

### 10. CI/CD

Hoy el deploy es `rsync` + `docker compose build` manual.

- [ ] GitHub Actions workflow: on push a `main` → SSH al droplet → git pull → docker compose up
- [ ] Runner seguro (secrets desde GitHub, clave SSH del deploy-bot diferente a la de Martín)
- [ ] Staging environment opcional: un segundo droplet $4/mes que reciba los cambios antes que prod

---

## 🟢 Prioridad BAJA — limpieza cosmética

- [ ] Borrar `/etc/ssh/sshd_config.d/50-cloud-init.conf` y `60-cloudimg-settings.conf` del droplet (redundantes con mi `00-sab-hardening.conf`)
- [ ] Sacar o actualizar `docker-compose.prod.yml` del repo (usa el registry de Lucho, ya no lo usamos)
- [ ] Sacar o adaptar `.gitlab-ci.yml` (pipeline de Lucho, no corre más)
- [ ] Commit los fixes de `server.js`, `seed.js`, `docker-compose.yml`, `.dockerignore` al repo
- [ ] Documentar en README del repo el flujo de deploy actual
- [ ] Agregar un `docs/ARCHITECTURE.md` con diagrama de componentes (landing + supabase + MP + brevo/gmail + DO droplet)

---

## 🔧 Mejoras futuras (no son deuda, son features)

- [ ] Sorteo entre la waitlist (feature del horizonte)
- [ ] Dashboard de suscriptores (Sprint 2)
- [ ] Mails automáticos recordatorio 48h antes del show
- [ ] Export CSV de compradores para MailerLite/Perfit
- [ ] Integración SPF/DKIM/DMARC con dominio propio (Sprint 3)
- [ ] Lighthouse audit final con scores reales post-deploy
- [ ] Schema.org JSON-LD dinámico validado en Google Rich Results Test

---

## Estado actual del droplet (referencia)

```
IP pública:       162.243.172.177
Hostname:         sab-prod
Region:           NYC1
OS:               Ubuntu 24.04.3 LTS
Specs:            1 vCPU / 512 MB RAM (+1 GB swap) / 10 GB SSD
Docker:           29.4.0
Docker Compose:   5.1.2
SSH access:       sab@162.243.172.177 con key ed25519 (martinlleral@gmail.com)
Sudo:             NOPASSWD para sab
Firewall:         UFW (22, 80, 443)
Fail2ban:         activo
Code:             /opt/sab/app/
.env:             /opt/sab/app/.env (chmod 600)
Containers:       sab-app (healthy) + sab-nginx
Mem limits:       app 400M, nginx 50M
Logging:          json-file, max-size 10m, max-file 3
```

---

## Qué NO es deuda (está bien así)

- Credenciales admin bootstrap via env vars (seed corregido)
- CORS configurable por `ALLOWED_ORIGINS`
- Healthcheck + dependencia nginx→app
- SQLite como DB (suficiente para el volumen actual, migrar a Postgres cuando pasemos de ~100 compras/día)
- Ubicación del datacenter NY (aceptable hasta que latencia sea un problema medible)
- Ausencia de Redis para sessions (express-session con SQLite alcanza)
- `ALLOWED_ORIGINS=http://162.243.172.177` ← aceptable TEMPORAL hasta que tengamos HTTPS

---

*Este archivo debe revisarse al inicio de cada sesión de trabajo y actualizarse al cerrarla.*
