#!/bin/bash
# Backup diario de DB + uploads hacia Cloudflare R2.
#
# Este script asume:
#   - Docker compose corriendo con volúmenes app_db-data y app_uploads-data
#   - rclone instalado en el host con un remote llamado "r2" ya configurado
#     (ver docs/backups.md para el setup paso a paso)
#   - Bucket R2 llamado "sab-backups" (cambiar BUCKET abajo si usás otro nombre)
#
# Corre desde cron (/etc/cron.d/sab-backup). Retención: 7 días local + 7 días
# remoto. Los logs van a /var/log/sab-backup.log con rotación manejada por
# logrotate del sistema (o agregar a sab-backup.logrotate si hace falta).
#
# ⚠️ HISTORIA QUE ESTE SCRIPT YA VIVIÓ (21/8/2026, encontrado al mirar el disco).
# Entre el 22/4 y el 21/8 el upload a R2 falló 122 días seguidos y NADIE se
# enteró. Dos causas encadenadas, las dos arregladas acá:
#
#   1. rclone empezó a hacer un CreateBucket implícito antes de subir, y el
#      token de R2 (con scope al bucket) devuelve 403. Se cierra con
#      `no_check_bucket = true` en el remote y con --s3-no-check-bucket acá,
#      para que el script no dependa de que el config del host esté bien.
#   2. La retención vivía DESPUÉS del upload, con `set -e` y un on_fail que
#      hacía `exit 1`. Un upload roto apagaba también la limpieza: se
#      acumularon 256 archivos (2 GB) y el disco llegó al 89 %.
#
# La lección que gobierna la forma de este script: **el paso que limpia no
# puede depender del paso que puede fallar.** La limpieza corre en un trap
# EXIT, así el disco se cuida incluso cuando el backup remoto se rompe.
#
# Y como el disco lleno ERA la única alarma (tardía y en la habitación
# equivocada), ahora el fallo deja un archivo centinela visible con `ls`.
#
# Uso manual (debugging):
#   sudo /opt/sab/bin/backup.sh
#
# Adaptación a otra cooperativa: cambiar BUCKET, REMOTE y los nombres de
# los volúmenes Docker si el project-name del compose es distinto.

set -e

BUCKET="sab-backups"
REMOTE="r2"
BACKUP_DIR="/opt/sab/backups/auto"
LOG_FILE="/var/log/sab-backup.log"
RETENTION_DAYS=7
# Centinela: existe SOLO cuando el último backup remoto falló. Es lo que hace
# visible la falla sin depender de que alguien lea un log de 27 KB.
ALERTA="/opt/sab/backups/ALERTA-BACKUP-REMOTO-FALLANDO.txt"
ESTADO="/opt/sab/backups/ESTADO.txt"
# rclone >= 1.7x intenta CreateBucket si no puede verificar que el bucket
# existe; el token de R2 no tiene ese permiso. Ver la nota del encabezado.
RCLONE_OPTS="--s3-no-check-bucket"

# Nombre de los volúmenes Docker — prefix "app_" porque el directorio
# del compose se llama "app". Cambiar si el proyecto usa otro nombre.
DB_VOLUME="app_db-data"
UPLOADS_VOLUME="app_uploads-data"

TS=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$BACKUP_DIR"

log() {
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $1" >> "$LOG_FILE"
}

on_fail() {
  log "FAIL: $1"
  # El centinela es la parte que le habla a una persona. El log ya existía y
  # nadie lo leyó durante 122 días.
  {
    echo "⚠️  EL BACKUP REMOTO ESTÁ FALLANDO"
    echo
    echo "Último intento: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "Falló en:       $1"
    echo
    echo "Los backups locales SÍ se están haciendo (en $BACKUP_DIR),"
    echo "pero NO están saliendo del droplet. Si el droplet se pierde, se"
    echo "pierde la base."
    echo
    echo "Diagnóstico:  rclone copy <archivo> $REMOTE:$BUCKET/ $RCLONE_OPTS -vv"
    echo "Detalle:      tail -30 $LOG_FILE"
  } > "$ALERTA" 2>/dev/null || true
  exit 1
}

# La retención corre SIEMPRE, incluso si el script muere por un upload roto.
# Ese acoplamiento es lo que llenó el disco: ver la nota del encabezado.
retencion() {
  find "$BACKUP_DIR" -type f -mtime +$RETENTION_DAYS -delete 2>/dev/null || true
  log "  retención local aplicada (>${RETENTION_DAYS}d) · quedan $(find "$BACKUP_DIR" -type f | wc -l) archivos · disco $(df -h / | awk 'NR==2{print $5}')"
}
trap retencion EXIT

log "backup START ts=$TS"

# --- 1. SQLite backup atómico ---
# La imagen node:20-alpine del app no tiene sqlite3 CLI. Usamos una alpine
# auxiliar que monta el volumen read-only y ejecuta sqlite3 ".backup".
docker run --rm \
  -v "$DB_VOLUME":/src:ro \
  -v "$BACKUP_DIR":/dst \
  alpine sh -c "apk add --no-cache sqlite >/dev/null 2>&1 && sqlite3 /src/prod.db \".backup /dst/prod-$TS.db\"" \
  || on_fail "sqlite .backup"

log "  DB backup OK ($(stat -c%s "$BACKUP_DIR/prod-$TS.db") bytes)"

# --- 2. Tar del volumen uploads ---
docker run --rm \
  -v "$UPLOADS_VOLUME":/src:ro \
  -v "$BACKUP_DIR":/dst \
  alpine tar czf "/dst/uploads-$TS.tgz" -C /src . \
  || on_fail "uploads tar"

log "  uploads tar OK ($(stat -c%s "$BACKUP_DIR/uploads-$TS.tgz") bytes)"

# --- 3. Upload a R2 ---
rclone copy "$BACKUP_DIR/prod-$TS.db" "$REMOTE:$BUCKET/" $RCLONE_OPTS \
  || on_fail "rclone DB upload"
rclone copy "$BACKUP_DIR/uploads-$TS.tgz" "$REMOTE:$BUCKET/" $RCLONE_OPTS \
  || on_fail "rclone uploads upload"

log "  R2 upload OK"
# Salió bien: se levanta el centinela y se deja el estado por escrito.
rm -f "$ALERTA"
{
  echo "Último backup remoto OK: $(date -u +%Y-%m-%dT%H:%M:%SZ)  (ts=$TS)"
  echo "Objetos en R2:           $(rclone size "$REMOTE:$BUCKET" $RCLONE_OPTS 2>/dev/null | head -2 | tr '\n' ' ')"
} > "$ESTADO" 2>/dev/null || true

# --- 4. Retention local: la hace el trap EXIT (ver arriba), para que también
#        corra cuando el upload falla. No se repite acá a propósito. ---

# --- 5. Retention remota: borrar objetos más viejos que RETENTION_DAYS ---
rclone delete "$REMOTE:$BUCKET/" --min-age "${RETENTION_DAYS}d" --include "prod-*.db" $RCLONE_OPTS 2>/dev/null || true
rclone delete "$REMOTE:$BUCKET/" --min-age "${RETENTION_DAYS}d" --include "uploads-*.tgz" $RCLONE_OPTS 2>/dev/null || true

log "backup OK ts=$TS"
