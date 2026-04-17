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
  exit 1
}

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
rclone copy "$BACKUP_DIR/prod-$TS.db" "$REMOTE:$BUCKET/" \
  || on_fail "rclone DB upload"
rclone copy "$BACKUP_DIR/uploads-$TS.tgz" "$REMOTE:$BUCKET/" \
  || on_fail "rclone uploads upload"

log "  R2 upload OK"

# --- 4. Retention local: borrar archivos más viejos que RETENTION_DAYS ---
find "$BACKUP_DIR" -type f -mtime +$RETENTION_DAYS -delete

# --- 5. Retention remota: borrar objetos más viejos que RETENTION_DAYS ---
rclone delete "$REMOTE:$BUCKET/" --min-age "${RETENTION_DAYS}d" --include "prod-*.db" 2>/dev/null || true
rclone delete "$REMOTE:$BUCKET/" --min-age "${RETENTION_DAYS}d" --include "uploads-*.tgz" 2>/dev/null || true

log "backup OK ts=$TS"
