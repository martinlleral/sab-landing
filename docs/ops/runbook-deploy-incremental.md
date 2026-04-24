# Runbook de deploy incremental — SAB Landing

**Versión:** 1.0 · 24/4/2026
**Propósito:** Flow estándar para deployar cambios post-migración inicial al droplet de producción. NO usar para la migración inicial — para eso está `docs/runbook-deploy.md`.

> Este runbook integra los aprendizajes del deploy del feature "Agotado manual" (ver `docs/WORKFLOW-LEARNINGS.md` secciones 2.5, 2.6, 2.7).

---

## Prerequisitos

- Acceso SSH al droplet vía `ssh sab-droplet` (alias en `~/.ssh/config`).
- Código commiteado y pusheado a `origin/main` en GitHub.
- Cambios validados en local con tests de integración (`docker exec sab-app node tests/integration/<test>.js`).

---

## Pre-flight checklist

Antes de empezar, identificar **qué tipo** de cambios incluye este deploy. El flow varía según el alcance:

| Tipo de cambio | Pasos extra |
|---|---|
| Solo backend (`src/`) | Flow estándar |
| Frontend estático (`public/assets/`) | Considerar purge CF post-deploy |
| Migration Prisma | **Fase extra** — aplicar migration ANTES de rebuild (ver sección "Migrations") |
| Dependencias (`package.json`) | Asegurarse de rsync-ear `package-lock.json` también |
| `docker-compose.yml` / Dockerfile | Probar en local primero con `-f docker-compose.prod.yml` override |

---

## Fase 1 — Backup pre-deploy

```bash
# Backup de la DB de prod antes de tocar nada
ssh sab-droplet "docker cp sab-app:/app/prisma/prod.db /tmp/prod-backup-$(date +%Y%m%d-%H%M).db"

# Bajar copia a local (defensa en profundidad)
mkdir -p backups
rsync -avz sab-droplet:/tmp/prod-backup-*.db backups/
```

**Checkpoint:** backup en `/tmp/` del droplet Y en `backups/` local.

---

## Fase 2 — Smoke test baseline

```bash
curl -sS https://sindicatoargentinodeboleros.com.ar/healthz
# Esperado: {"status":"ok","db":"up","uptime":<n>}

curl -sS https://sindicatoargentinodeboleros.com.ar/api/eventos/destacado | python3 -m json.tool
# Esperado: JSON con el evento destacado actual
```

Anotar el `uptime` — después del deploy debería resetearse a <60s.

---

## Fase 3 — Rsync del código

**Regla crítica** (aprendida el 24/4, sección 2.5 de WORKFLOW-LEARNINGS): rsync de archivos puntuales **debe usar `--relative`** o path destino COMPLETO, no "el directorio padre".

### Opción A — rsync dirigido con `--relative` (recomendado)

```bash
cd sindicato-argentino-de-boleros

# Los paths relativos se preservan en el destino
rsync -avz --relative \
  src/controllers/compras.controller.js \
  src/controllers/eventos.controller.js \
  public/backoffice/evento-detalle.html \
  public/assets/js/app.js \
  public/assets/css/app.css \
  prisma/schema.prisma \
  prisma/migrations/<FECHA>_<NOMBRE>/migration.sql \
  package.json package-lock.json \
  sab-droplet:/opt/sab/app/
```

### Opción B — rsync por directorio (si hay muchos archivos del mismo dir)

```bash
rsync -avz --exclude='*.db' --exclude='node_modules/' \
  src/ sab-droplet:/opt/sab/app/src/
rsync -avz public/ sab-droplet:/opt/sab/app/public/
```

### Validación post-rsync

**Antes de rebuild**, confirmar que los archivos llegaron al path correcto:

```bash
ssh sab-droplet "grep -c '<string_nuevo>' /opt/sab/app/src/controllers/<controller>.js"
# Debe devolver > 0

ssh sab-droplet "ls -la /opt/sab/app/public/assets/js/app.js"
# Fecha debe ser la del deploy, NO anterior
```

Si alguno falla, **parar acá** y diagnosticar antes de rebuildear.

---

## Fase 4 — Migrations (SI aplica)

**Aprendizaje del 24/4 (WORKFLOW-LEARNINGS 2.6):** el volumen `db-data:/app/prisma` tapa las migrations del container en runtime. El orden correcto cuando hay migration nueva es:

```bash
# 1. Copiar migration nueva al volumen ANTES de cualquier rebuild
ssh sab-droplet "docker cp /opt/sab/app/prisma/schema.prisma sab-app:/app/prisma/schema.prisma"
ssh sab-droplet "docker cp /opt/sab/app/prisma/migrations/<FECHA>_<NOMBRE> sab-app:/app/prisma/migrations/"

# 2. Aplicar la migration con Prisma tracking correcto
ssh sab-droplet "docker exec sab-app npx prisma migrate deploy"

# 3. Si migrate deploy dice "No pending migrations" pero la columna no existe,
#    aplicar el SQL manualmente (caso edge):
ssh sab-droplet "docker exec sab-app sh -c 'apk add --quiet sqlite && sqlite3 prisma/prod.db \"<SQL_MIGRATION>\"'"
```

**Verificación:**

```bash
ssh sab-droplet "docker exec sab-app sh -c 'sqlite3 prisma/prod.db \"PRAGMA table_info(<TABLA>);\" | grep <COLUMNA_NUEVA>'"
```

---

## Fase 5 — Rebuild + restart

```bash
ssh sab-droplet "cd /opt/sab/app && \
  docker compose build app && \
  docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --no-deps app"

# Esperar healthz
sleep 6
ssh sab-droplet "docker logs sab-app --tail 15"
# Debe mostrar:
#   ✅ Base de datos conectada
#   🚀 Servidor corriendo en http://localhost:3000
```

**Si el container entra en restart loop con `Error: P3009`:**

Esto significa que hubo una migration intentando aplicarse sobre una DB que ya la tenía. Ver procedimiento de recovery en `WORKFLOW-LEARNINGS.md` sección 2.6.

```bash
# Parar el loop
ssh sab-droplet "cd /opt/sab/app && docker compose stop app"

# Arreglar el registro en _prisma_migrations
ssh sab-droplet "echo \"UPDATE _prisma_migrations SET finished_at = started_at + 50, applied_steps_count = 1, logs = NULL, rolled_back_at = NULL WHERE migration_name = '<NOMBRE_MIGRACION>';\" > /tmp/fix-mig.sql"

ssh sab-droplet "docker run --rm -v app_db-data:/vol -v /tmp:/host alpine sh -c 'apk add --quiet sqlite && sqlite3 /vol/prod.db < /host/fix-mig.sql'"

# Arrancar
ssh sab-droplet "cd /opt/sab/app && docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --no-deps app"
```

---

## Fase 6 — Smoke test post-deploy

```bash
curl -sS https://sindicatoargentinodeboleros.com.ar/healthz
# Esperado: uptime < 60s (container recién reiniciado)

# Smoke test específico del feature deployado
curl -sS https://sindicatoargentinodeboleros.com.ar/api/eventos/destacado | python3 -m json.tool
# Verificar que los campos nuevos están en el response
```

**Para frontend estático** (aprendizaje del 24/4, WORKFLOW-LEARNINGS 2.7): verificar que CF no sirve cache stale:

```bash
curl -sI "https://sindicatoargentinodeboleros.com.ar/assets/js/app.js" | grep -iE "last-modified|cf-cache-status"
# last-modified debe reflejar la fecha del deploy
# cf-cache-status MISS o REVALIDATED es OK
# cf-cache-status HIT con last-modified vieja = CF stale → purgar manualmente
```

**Si CF sirve stale:**

- Cloudflare dashboard → zona del dominio → Caching → Configuration → Purge Everything (o Purge by URL para el asset específico).

**Validación visual final** (hacer al menos una):

- Abrir el sitio en un browser con hard-refresh (`Ctrl+Shift+R`).
- Entrar al backoffice y probar el feature manualmente.
- Si el cambio afecta la compra: ejecutar un checkout de prueba (sin llegar a pagar).

---

## Fase 7 — Cleanup

```bash
# Limpiar backups viejos del droplet (mantener los últimos 5)
ssh sab-droplet "ls -t /tmp/prod-backup-*.db | tail -n +6 | xargs -r rm -v"

# Los backups locales también (en `backups/`) — decidir política según criticidad
```

---

## Rollback

Si el deploy rompió algo y necesitás volver atrás rápido:

```bash
# 1. Restaurar DB del backup de Fase 1
ssh sab-droplet "docker cp /tmp/prod-backup-<FECHA>.db sab-app:/app/prisma/prod.db"
ssh sab-droplet "docker restart sab-app"

# 2. (Opcional) Revertir código a commit anterior
# Desde local:
git revert <HASH_DEL_COMMIT>
git push

# Después repetir Fase 3-6 con el commit revertido
```

**Para casos muy graves (container no arranca):**

- Verificar logs: `ssh sab-droplet "docker logs sab-app --tail 50"`
- Si es tema de migrations → seguir recovery de Fase 5.
- Si es tema de config/env → revisar `.env` del droplet sin tocar nada más: `ssh sab-droplet "sudo cat /opt/sab/app/.env"`.

---

## Checklist de "done"

- [ ] Backup tomado (droplet + local) antes de tocar nada.
- [ ] Smoke test baseline OK antes del rsync.
- [ ] Rsync verificado por grep remoto (archivos llegaron al path correcto).
- [ ] Migration aplicada al volumen ANTES de rebuild (si aplica).
- [ ] Rebuild + up -d exitosos, healthz responde OK.
- [ ] Smoke test post-deploy OK (endpoints afectados devuelven los cambios esperados).
- [ ] CF no sirve cache stale de estáticos (si el deploy tocó frontend).
- [ ] Validación visual manual en el browser (backoffice y/o home).

---

*Runbook generado el 24/4/2026 consolidando el flow del deploy "Agotado manual". Aprendizajes incorporados en `docs/WORKFLOW-LEARNINGS.md` secciones 2.5-2.7.*
