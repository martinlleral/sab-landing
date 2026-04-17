# Backups automáticos — Landing SAB

**Objetivo:** no perder compras, waitlist ni uploads si el droplet se corrompe o se elimina por error. Los backups van a un bucket remoto en Cloudflare R2, con retención de 7 días.

Este setup complementa el protocolo de **snapshot casera** que se corre antes de cada deploy (ver `PLAN.md` sección "Deploy del sprint de hardening"). La snapshot casera cubre el "vuelvo al estado anterior si el deploy rompió algo"; este backup diario cubre el "se rompió algo en cualquier momento, sin deploy reciente".

---

## Qué se respalda

Dos artefactos por día, timestampeados en UTC:

- `prod-YYYYMMDDTHHMMSSZ.db` — backup atómico de SQLite vía `sqlite3 ".backup"`. Contiene todas las tablas: usuarios, eventos, compras, entradas, home config. **No incluye sesiones** (DB separada `sessions.db`, recuperable con redeploy).
- `uploads-YYYYMMDDTHHMMSSZ.tgz` — tar del volumen Docker `app_uploads-data` (flyers, fotos del slider, QRs generados).

**Lo que NO se respalda:** código (vive en GitHub), `.env` (secretos rotables, si se pierden se regeneran), node_modules (se rehacen en el build), DBs de sesiones (el admin se reloguea y listo).

---

## Setup inicial — Cloudflare R2

R2 es el S3-compatible storage de Cloudflare. 10 GB gratis, sin egress fees. Con retención 7 días y un backup diario de ~10 MB, estamos muy por debajo del free tier para siempre.

### 1. Crear bucket R2

- Entrar a https://dash.cloudflare.com con la cuenta del SAB
- R2 Object Storage → Create bucket
- Name: `sab-backups`
- Location: "Automatic" (Cloudflare elige)
- Create bucket

### 2. Generar API credentials

- R2 Object Storage → Manage R2 API Tokens → Create API Token
- Token name: `sab-backups-write`
- Permissions: **Object Read & Write**
- Specify bucket(s): `sab-backups` (no dar acceso a todos los buckets)
- TTL: sin expiración (o 1 año si se prefiere rotar)
- Create API Token

**Guardar los 3 valores que muestra:**
- Access Key ID
- Secret Access Key
- Endpoint (tipo `https://<cuenta-id>.r2.cloudflarestorage.com`)

Estos valores **se muestran solo una vez**. Guardarlos en el gestor de contraseñas del SAB.

---

## Setup en el droplet

### 3. Instalar rclone

```bash
ssh sab@<IP_DROPLET>
curl https://rclone.org/install.sh | sudo bash
rclone version
```

### 4. Configurar el remote "r2"

```bash
rclone config
```

En el prompt interactivo, responder:

- `n` (new remote)
- Name: `r2`
- Storage: `s3` (luego elegir provider `Cloudflare R2`)
- access_key_id: `<pegar Access Key ID>`
- secret_access_key: `<pegar Secret Access Key>`
- region: `auto`
- endpoint: `<pegar Endpoint>`
- Resto: Enter (defaults)
- Confirm config: `y`
- Quit: `q`

Verificar:

```bash
rclone lsd r2:
# Debe listar: sab-backups

rclone lsf r2:sab-backups/
# Debe devolver vacío (no hay backups aún)
```

### 5. Instalar el script de backup

```bash
sudo mkdir -p /opt/sab/bin
sudo cp /opt/sab/app/scripts/backup.sh /opt/sab/bin/backup.sh
sudo chmod +x /opt/sab/bin/backup.sh
sudo chown sab:sab /opt/sab/bin/backup.sh
```

### 6. Test manual

```bash
sudo /opt/sab/bin/backup.sh
cat /var/log/sab-backup.log
# Debe mostrar: backup START / DB backup OK / uploads tar OK / R2 upload OK / backup OK

rclone lsf r2:sab-backups/
# Debe mostrar los 2 archivos recién subidos
```

### 7. Agendar cron diario

```bash
sudo tee /etc/cron.d/sab-backup > /dev/null <<'EOF'
# Backup diario del SAB — 04:00 UTC = 01:00 AR (hora baja de tráfico)
0 4 * * * sab /opt/sab/bin/backup.sh
EOF

sudo systemctl restart cron
```

Verificar que cron reconoce:

```bash
sudo crontab -u sab -l 2>/dev/null || true
cat /etc/cron.d/sab-backup
```

---

## Restaurar desde un backup

### Restaurar la DB

```bash
# Bajar el backup más reciente
rclone lsf r2:sab-backups/ | sort | tail -5
rclone copy r2:sab-backups/prod-<TS>.db /tmp/

# Detener la app (el healthcheck se va a poner unhealthy — normal)
cd /opt/sab/app
docker compose stop sab-app

# Copiar el dump al volumen del container
docker run --rm \
  -v app_db-data:/dst \
  -v /tmp:/src \
  alpine sh -c "cp /src/prod-<TS>.db /dst/prod.db"

# Reiniciar
docker compose up -d sab-app
docker compose logs sab-app --tail 30 | grep -i "base de datos"
```

### Restaurar uploads

```bash
rclone copy r2:sab-backups/uploads-<TS>.tgz /tmp/

docker run --rm \
  -v app_uploads-data:/dst \
  -v /tmp:/src \
  alpine sh -c "cd /dst && rm -rf ./* && tar xzf /src/uploads-<TS>.tgz -C ."
```

---

## Monitoreo

El script loguea a `/var/log/sab-backup.log`. Si un backup falla (SQLite, tar o upload), el script sale con exit code 1 y deja "FAIL" en el log.

Para alertarte de fallas, hay 2 opciones:

1. **Uptime Robot con keyword monitor sobre el log** — complejo, requiere exponer el log por HTTP.
2. **Mail en falla via cron `MAILTO`** — más simple:

```bash
# Editar /etc/cron.d/sab-backup agregando MAILTO arriba:
MAILTO="sindicatoargentinodeboleros@gmail.com"
0 4 * * * sab /opt/sab/bin/backup.sh 2>&1 | grep -i "FAIL" && echo "Backup SAB FAIL - revisar /var/log/sab-backup.log"
```

(Esto requiere `mailutils` o `ssmtp` configurado en el droplet. Si no está, la alerta queda silenciosa.)

**Alternativa simple:** chequear el log manualmente cada semana, o agregar el tail del log como keyword en Uptime Robot cuando esté configurado el monitoring (ítem 3 de Resiliencia).

---

## Troubleshooting

**"rclone: NoCredentialProviders"**
→ El config del remote no se guardó. Correr `rclone config file` para ver la ruta del config y verificar que exista.

**"docker: Error response from daemon: No such volume"**
→ El nombre del volumen cambió (ej. si se deployó con otro project-name). Ejecutar `docker volume ls | grep sab` y actualizar `DB_VOLUME` / `UPLOADS_VOLUME` en `/opt/sab/bin/backup.sh`.

**"sqlite3: database is locked"**
→ Muy raro con `.backup` (que usa un snapshot del WAL). Si pasa, es porque hay una escritura pesada en curso. El cron de las 04:00 UTC debería evitarlo; para correr manualmente, esperar unos minutos y reintentar.

**Objetos en R2 que no se borran con retention**
→ El `rclone delete --min-age 7d` solo borra si el objeto tiene metadata de fecha. Los primeros 7 días no va a borrar nada (esperado). Después de 7 días sí. Verificar con `rclone lsf r2:sab-backups/ --format "tps"`.
