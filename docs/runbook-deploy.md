# Runbook de Deploy — Migración DigitalOcean SAB

**Versión:** 1.0 · 11/4/2026
**Objetivo:** Migrar el sitio de la cuenta DigitalOcean de Lucho Menez a una cuenta propia del SAB, con rotación completa de secrets y zero-downtime en el switch de DNS.

> Este runbook está pensado para ejecutar copy-paste. Cada bloque de comandos tiene el paso anterior como prerequisito. NO saltearse pasos de validación.

---

## Prerequisitos (gestión — hacer ANTES de ejecutar cualquier comando)

| # | Qué | Quién | Estado |
|---|---|---|---|
| P1 | Cuenta DigitalOcean creada con mail + tarjeta del SAB | Nati / Uri | ☐ |
| P2 | Clave SSH generada y agregada a la cuenta DO del SAB (`ssh-keygen -t ed25519 -C "sab-deploy"`) | Martín | ☐ |
| P3 | Contacto con Lucho → dump de la DB de producción (`prod.db`) + dump del volumen `uploads-data` | Martín ↔ Lucho | ☐ |
| P4 | Acceso al panel DNS de Cloudflare (cuenta o token API con permisos sobre `sindicatoargentinodeboleros.com.ar`) | Martín ↔ Lucho | ☐ |
| P5 | Acceso al panel de MercadoPago del SAB (para regenerar access token) | Nati / Uri | ☐ |
| P6 | Acceso al panel de Brevo del SAB (para regenerar API key + SMTP) | Nati / Uri → Lucho | ☐ |
| P7 | Decisión sobre el repo GitLab: mantener en cuenta de Lucho o transferir a cuenta SAB | Martín ↔ equipo | ☐ |

Si alguno de P1-P6 no está, **no arrancar el runbook**. Sin P7 se puede arrancar pero idealmente se resuelve primero.

---

## Fase 0 — Rotación de secrets (bloqueante, hacer ANTES del deploy)

> **Crítico:** el `.env.example` del repo tiene todos los secrets en texto plano (ver `memory/project_secrets_filtrados.md`). Rotarlos ANTES de llevar el nuevo `.env` a la nueva infra.

### 0.1 Generar nuevos valores

```bash
# SESSION_SECRET: random de 32 bytes
openssl rand -hex 32
# ADMIN_PASS: random legible de 20 caracteres
openssl rand -base64 15
```

### 0.2 Rotar en cada servicio

| Servicio | Dónde | Qué hacer |
|---|---|---|
| **MercadoPago** | https://www.mercadopago.com.ar/developers/panel → Tus integraciones → la app del SAB → Credenciales de producción | Clic "Regenerar" en Access Token y Public Key. Copiar los nuevos. El viejo queda invalidado automáticamente — la ticketera del droplet viejo dejará de procesar pagos. Coordinar con Nati para que esto ocurra en ventana baja (ej. jueves mañana). |
| **Brevo SMTP** | https://app.brevo.com → SMTP & API → SMTP keys | Borrar la key vieja (`<BREVO_SMTP_USER_VIEJO_YA_ROTADO>`). Crear una nueva → copiar `user` + `password`. |
| **Brevo API** | https://app.brevo.com → SMTP & API → API keys | Borrar la vieja (`<BREVO_API_KEY_VIEJA>`) si no se usa en código (verificar con `grep -r BREVO_API_KEY src/`). Si no se usa, no regenerar, solo borrar. |
| **Perfit** | https://app.myperfit.com → API | Borrar la vieja si no se usa (verificar con `grep -r PERFIT src/`). |
| **Admin backoffice** | `/backoffice/login.html` con las credenciales actuales (`<ADMIN_EMAIL_VIEJO>` / `<ADMIN_PASS_VIEJA>`) | Cambiar email a `admin@sindicatoargentinodeboleros.com.ar` y password a random 20 chars. Guardar en Bitwarden/1Password del SAB. |

### 0.3 Sanear el repo

```bash
cd sindicato-argentino-de-boleros

# Reemplazar el .env.example filtrado por la versión limpia
cp docs/env.example.clean .env.example

# Verificar que .env esté en .gitignore (crítico)
grep -E "^\.env$" .gitignore || echo ".env" >> .gitignore

# Commit
git add .env.example .gitignore
git commit -m "security: sanear .env.example y reforzar .gitignore"
git push
```

### 0.4 Purgar el historial git del `.env.example` viejo

> **Opcional pero recomendado.** Esto reescribe el historial del repo. Requiere coordinación si hay otros colaboradores. Si el repo se mantiene privado y cerrado, se puede posponer.

```bash
# Con BFG Repo-Cleaner (más fácil que git filter-branch)
# Descargar de https://rtyley.github.io/bfg-repo-cleaner/

java -jar bfg.jar --delete-files .env.example sindicato-argentino-de-boleros.git
cd sindicato-argentino-de-boleros.git
git reflog expire --expire=now --all && git gc --prune=now --aggressive
git push --force
```

### 0.5 Validar

```bash
# El .env.example no debe tener secrets reales
grep -E "APP_USR-|xkeysib-|sindicatoargen-|<ADMIN_PASS_VIEJA>|<ADMIN_PASS_VIEJA>" .env.example
# Debe devolver vacío
```

**Checkpoint:** todos los secrets rotados, nuevos valores guardados en gestor de contraseñas, `.env.example` limpio commiteado.

---

## Fase 1 — Crear droplet en cuenta DO del SAB

### 1.1 Crear droplet desde el panel DO

- https://cloud.digitalocean.com/droplets/new
- **Image:** Ubuntu 24.04 LTS x64
- **Size:** Basic → Regular → $6/mes (1 GB RAM / 1 vCPU / 25 GB SSD) ó $12/mes (2 GB / 1 vCPU / 50 GB) si queremos margen
- **Región:** `nyc3` ó `sfo3` (las más baratas). Alternativa regional: `São Paulo` si preferimos latencia AR, pero es más caro.
- **Authentication:** SSH key (la del paso P2). NO password.
- **Hostname:** `sab-prod-01`
- **Enable:** Backups semanales (+$1.2/mes, opcional pero MUY recomendable)

Anotar la **IP pública** que DO asigna. Vamos a llamarla `$NUEVA_IP` en el resto del runbook.

### 1.2 Hardening básico del droplet

```bash
# Conectar por SSH
ssh root@$NUEVA_IP

# Actualizar
apt update && apt upgrade -y

# Crear usuario no-root
adduser sab --disabled-password --gecos ""
usermod -aG sudo sab
mkdir -p /home/sab/.ssh
cp /root/.ssh/authorized_keys /home/sab/.ssh/
chown -R sab:sab /home/sab/.ssh
chmod 700 /home/sab/.ssh && chmod 600 /home/sab/.ssh/authorized_keys

# Desactivar login root por SSH y password auth
sed -i 's/^#*PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart ssh

# Firewall
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

# Fail2ban
apt install -y fail2ban
systemctl enable --now fail2ban
```

Desconectar y reconectar como `sab`:

```bash
exit
ssh sab@$NUEVA_IP
```

### 1.3 Instalar Docker + Docker Compose

```bash
# Docker oficial
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker sab
# Reconectar para que tome el grupo
exit
ssh sab@$NUEVA_IP

# Verificar
docker --version
docker compose version
```

---

## Fase 2 — Deploy del código en el droplet nuevo

### 2.1 Estructura de directorios

```bash
sudo mkdir -p /opt/sab/nginx
sudo chown -R sab:sab /opt/sab
cd /opt/sab
```

### 2.2 Copiar archivos desde local

Desde la máquina local de Martín (WSL):

```bash
cd "/mnt/c/Users/Lenovo/Desktop/ASESORÍA IT/SAB/Landing Page/sindicato-argentino-de-boleros"

scp docker-compose.prod.yml sab@$NUEVA_IP:/opt/sab/
scp nginx/app.conf              sab@$NUEVA_IP:/opt/sab/nginx/
```

### 2.3 Crear el `.env` en el servidor (secretos nuevos de Fase 0)

```bash
ssh sab@$NUEVA_IP
nano /opt/sab/.env
```

Pegar el contenido usando `docs/env.example.clean` como template, rellenando con los **valores rotados de Fase 0**. Guardar y:

```bash
chmod 600 /opt/sab/.env
```

### 2.4 Login al registry GitLab

```bash
# Desde el droplet
docker login registry.gitlab.com
# Usuario y password = token de GitLab con scope read_registry
```

> Si decidimos migrar el repo a GitHub o al SAB en GitLab (P7), este paso cambia. Para la primera migración, mantener el registry de Lucho es lo más rápido.

### 2.5 Levantar los servicios (sin SSL aún)

```bash
cd /opt/sab

# Comentar temporalmente las líneas del server 443 en nginx/app.conf
# porque todavía no tenemos certificados:
# Opción rápida: usar un app.conf mínimo SOLO con listen 80 → proxy_pass app:3000

docker compose -f docker-compose.prod.yml up -d app
# (solo app, sin nginx aún)
```

Verificar que la app corre:

```bash
docker compose -f docker-compose.prod.yml logs app --tail 50
# Debe mostrar: ▶ Ejecutando migraciones... / Iniciando servidor...
curl http://localhost:3000/
# Debe devolver HTML
```

### 2.6 Restaurar el dump de DB y uploads desde el droplet viejo (cuando lo tengamos)

```bash
# Copiar el dump al droplet nuevo
scp prod.db sab@$NUEVA_IP:/tmp/

# Cargar en el volumen Docker
docker cp /tmp/prod.db sab-app:/app/prisma/prod.db
docker restart sab-app
docker compose -f docker-compose.prod.yml logs app --tail 20

# Verificar eventos
curl http://localhost:3000/api/eventos/proximos
```

Para los uploads (flyers, fotos del slider):

```bash
# Copiar tarball de uploads
scp uploads-backup.tar.gz sab@$NUEVA_IP:/tmp/
ssh sab@$NUEVA_IP

# Restaurar en el volumen
docker run --rm -v sab_uploads-data:/target -v /tmp:/backup alpine \
  sh -c "cd /target && tar xzf /backup/uploads-backup.tar.gz"
```

### 2.7 Levantar Nginx + Certbot con SSL real

Antes de esto necesitamos el DNS apuntando al droplet nuevo (ver Fase 3). Como el DNS se cambia al final, lo que hacemos es:

1. Temporalmente apuntar el subdominio `nuevo.sindicatoargentinodeboleros.com.ar` → `$NUEVA_IP` (mientras que el principal sigue apuntando a Lucho).
2. Pedir certificados SSL con certbot en standalone mode.
3. Testear la app en el subdominio.
4. Cambiar el DNS principal.

```bash
# Desde el droplet
sudo apt install -y certbot

# Levantar solo la app (sin nginx) y liberar puerto 80 para certbot
docker compose -f docker-compose.prod.yml stop nginx 2>/dev/null || true

sudo certbot certonly --standalone \
  -d sindicatoargentinodeboleros.com.ar \
  -d www.sindicatoargentinodeboleros.com.ar \
  --email sindicatoargentinodeboleros@gmail.com \
  --agree-tos --non-interactive

# Copiar los certificados al volumen docker
sudo cp -rL /etc/letsencrypt/live /etc/letsencrypt/archive /etc/letsencrypt/renewal /opt/sab/letsencrypt/
```

> **Alternativa más simple:** saltar certbot standalone y usar el flujo `--webroot` del certbot del docker-compose.prod.yml. El gotcha es que requiere nginx corriendo con un stub server listening en 80, lo cual requiere DNS ya apuntado. El workaround es lo de arriba: certbot standalone primero, copiar certs al volumen, luego levantar nginx con certbot en modo renewal.

### 2.8 Levantar todo el stack

```bash
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml ps
# Debe mostrar 3 servicios healthy: app, nginx, certbot
```

---

## Fase 3 — DNS: switch del dominio

### 3.1 Preparación — bajar TTL

**2-6 horas antes** del switch, bajar el TTL de los registros `A` y `CNAME` en Cloudflare a **120 segundos** (el default de "Auto" es 300). Esto garantiza que, si hay que revertir, la propagación sea casi inmediata.

Cloudflare → DNS → Records → editar cada registro → TTL: `2 min`.

### 3.2 Validación previa al switch

Con el subdominio temporal (ej. `nuevo.sindicatoargentinodeboleros.com.ar` apuntando a `$NUEVA_IP`):

```bash
# Desde local
curl -I https://nuevo.sindicatoargentinodeboleros.com.ar/
# Debe devolver 200

# Smoke test: head, próximos eventos, waitlist count
curl -s https://nuevo.sindicatoargentinodeboleros.com.ar/ | grep -E "canonical|og:image" 
curl -s https://nuevo.sindicatoargentinodeboleros.com.ar/api/eventos/proximos
```

### 3.3 Cambiar el registro A principal

Cloudflare → DNS → Records:

| Antes | Después |
|---|---|
| `A sindicatoargentinodeboleros.com.ar → $IP_VIEJA` | `A sindicatoargentinodeboleros.com.ar → $NUEVA_IP` |
| `A www → $IP_VIEJA` | `A www → $NUEVA_IP` |

**Importante:** los registros `MX`, `TXT` (SPF/DKIM/DMARC), y cualquier otro subdominio que tenga la cuenta de correo del SAB **NO se tocan**. Solo los `A` del dominio raíz y `www`.

### 3.4 Validar propagación

```bash
dig +short sindicatoargentinodeboleros.com.ar
# Debe devolver $NUEVA_IP

# Cacheados: probar varios resolvers
dig +short @8.8.8.8 sindicatoargentinodeboleros.com.ar
dig +short @1.1.1.1 sindicatoargentinodeboleros.com.ar
```

Con TTL 120s, la propagación completa global es de ~5-10 minutos.

### 3.5 Smoke test en el dominio real

```bash
curl -I https://sindicatoargentinodeboleros.com.ar/
# HTTP/2 200
curl -I http://sindicatoargentinodeboleros.com.ar/
# HTTP/1.1 301 → https://...

# Browser: entrar a https://sindicatoargentinodeboleros.com.ar/ y validar:
# - Hero carga con foto
# - Próximos eventos muestra los 3 flyers
# - Waitlist count muestra número
# - Abrir modal de compra y probar seleccionar cantidad
```

### 3.6 Re-subir TTL

Una vez validado todo, subir el TTL de vuelta a `Auto` (1h) en Cloudflare para bajar costos de resolución DNS.

---

## Fase 4 — SPF / DKIM / DMARC (email)

> Esto **no depende del deploy del droplet**. Se puede hacer antes o después, pero es necesario para que los mails de confirmación de compra no caigan en spam.

### 4.1 SPF

Cloudflare → DNS → Add record:

```
Type:  TXT
Name:  @
Value: v=spf1 include:spf.brevo.com include:_spf.google.com -all
TTL:   Auto
```

> `include:spf.brevo.com` autoriza a Brevo a enviar mails en nombre del dominio. `include:_spf.google.com` es por si también se manda desde Gmail con la cuenta del SAB. El `-all` es hard fail (recomendado).

### 4.2 DKIM

- Entrar al panel Brevo del SAB.
- Senders & IP → Domains → Authenticate your domain
- Brevo te muestra 2 registros TXT (`dkim._domainkey` y `brevo._domainkey` según el dominio). Copiar los valores exactos.
- Cloudflare → DNS → Add record, por cada uno:
  ```
  Type:  TXT
  Name:  mail._domainkey       (o el que Brevo indique)
  Value: <lo que Brevo muestra>
  TTL:   Auto
  ```
- Volver al panel Brevo y clickear "Verify" — debe pasar a estado `Authenticated`.

### 4.3 DMARC

Empezar en modo suave (`p=none`) para observar, y subir a `quarantine` o `reject` después de 1-2 semanas.

```
Type:  TXT
Name:  _dmarc
Value: v=DMARC1; p=none; rua=mailto:sindicatoargentinodeboleros@gmail.com; ruf=mailto:sindicatoargentinodeboleros@gmail.com; fo=1
TTL:   Auto
```

### 4.4 Validar

```bash
# SPF
dig +short TXT sindicatoargentinodeboleros.com.ar | grep spf1

# DKIM
dig +short TXT mail._domainkey.sindicatoargentinodeboleros.com.ar

# DMARC
dig +short TXT _dmarc.sindicatoargentinodeboleros.com.ar
```

Herramientas online:
- https://mxtoolbox.com/spf.aspx
- https://mxtoolbox.com/dkim.aspx
- https://mxtoolbox.com/dmarc.aspx

Y lo más concluyente: enviarse un mail de prueba desde la app del SAB a una cuenta Gmail de uno mismo. Abrir el mail → "Mostrar original" → verificar `SPF: PASS`, `DKIM: PASS`, `DMARC: PASS`.

---

## Fase 5 — Cleanup

### 5.1 Monitoreo 48 horas

Dejar ambos droplets corriendo durante 48 horas. El viejo se queda "por si acaso". Si algo falla en el nuevo, revertir el registro A en Cloudflare (vuelve a propagarse en 2 min porque TTL bajo).

Durante las 48h, monitorear:
- `docker compose -f docker-compose.prod.yml logs -f` en el droplet nuevo
- Test de compra end-to-end (generar una entrada real y que llegue el mail con QR)
- Waitlist: chequear que el count sube en Supabase al agregar un email real

### 5.2 Apagar droplet viejo

Después de 48h sin problemas:

- Bajar un snapshot final del droplet viejo (DO → Droplet → Snapshots → Take Snapshot). Costo único de ~$0.05.
- Destruir el droplet viejo en la cuenta de Lucho.
- Lucho deja de pagar los $10/mes.

### 5.3 Actualizar GitLab CI

Editar variables del CI en GitLab → `lucianomenez/sindicato-argentino-de-boleros` → Settings → CI/CD → Variables:

| Variable | Valor nuevo |
|---|---|
| `SERVER_HOST` | `$NUEVA_IP` |
| `SERVER_USER` | `sab` |
| `SSH_PRIVATE_KEY` | Clave privada del paso P2 |

Hacer un push a `main` y verificar que el pipeline corre end-to-end.

### 5.4 Validaciones SEO/público

- Schema.org: https://search.google.com/test/rich-results → validar MusicGroup + MusicEvent
- Open Graph: https://www.opengraph.xyz/ → ver preview de `og:image` 1200×630
- SSL Labs: https://www.ssllabs.com/ssltest/analyze.html?d=sindicatoargentinodeboleros.com.ar → target A+
- Security Headers: https://securityheaders.com/?q=sindicatoargentinodeboleros.com.ar → target A
- Lighthouse mobile desde Chrome DevTools → meta 85+ en Performance, 100 en Best Practices y SEO
- Google Search Console → Add property → verificar ownership y enviar `sitemap.xml`

---

## Rollback (si algo explota)

### Rollback rápido de DNS (si el sitio no carga)

```bash
# En Cloudflare, editar el registro A:
# Volver a la IP vieja del droplet de Lucho
# Con TTL 120s, propaga en 2-3 min

# Mientras tanto, diagnosticar en el droplet nuevo:
ssh sab@$NUEVA_IP
docker compose -f /opt/sab/docker-compose.prod.yml logs --tail 100
```

### Rollback de MercadoPago (si rotación de tokens rompió pagos)

El token viejo ya está invalidado: no hay rollback a los tokens viejos. El fix es subir los nuevos al `.env` del droplet y reiniciar:

```bash
ssh sab@$NUEVA_IP
nano /opt/sab/.env   # corregir MP_ACCESS_TOKEN
docker compose -f /opt/sab/docker-compose.prod.yml restart app
```

### Rollback de DB (si un dump corrupto rompió la app)

```bash
ssh sab@$NUEVA_IP
docker cp /tmp/prod.db.backup sab-app:/app/prisma/prod.db
docker restart sab-app
```

Siempre tener `/tmp/prod.db.backup` como copia del dump antes de aplicar.

---

## Checklist de "done"

- [ ] Fase 0 completa: todos los secrets rotados, `.env.example` sanitizado, historial git purgado.
- [ ] Fase 1 completa: droplet nuevo con Docker, usuario `sab`, firewall activo.
- [ ] Fase 2 completa: app corre en el droplet nuevo con DB y uploads restaurados, SSL activo.
- [ ] Fase 3 completa: DNS apuntando a nueva IP, propagado, smoke test OK.
- [ ] Fase 4 completa: SPF/DKIM/DMARC configurados y validados con mail de prueba.
- [ ] Fase 5 completa: monitoreo 48h OK, droplet viejo apagado, CI apuntando al nuevo servidor, validaciones SEO OK.
- [ ] **Credenciales nuevas documentadas en gestor de contraseñas del SAB, no en .md ni en .env committed.**

---

*Runbook generado el 11/4/2026. Reproducible. Contacto para dudas de ejecución: Martín Lleral.*
