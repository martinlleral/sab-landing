# Runbook de rollback — campaña 1/5/2026

**Objetivo:** volver al último deploy estable en **menos de 5 minutos** si algo rompe el día de la campaña (imposibilidad de comprar, dashboard caído, etc).

**Pre-requisito crítico:** tener el tag `v-pre-campaign` creado ANTES del deploy del 30/4.

---

## Pre-campaña (hacer el 29/4 al final del día)

### 1. Verificar que el estado actual de `main` es el que se quiere como "punto de seguridad"

```bash
cd "/mnt/c/Users/Lenovo/Desktop/ASESORÍA IT/SAB/Landing Page/sindicato-argentino-de-boleros"
git status
git log --oneline -5
```

Todo debería estar committeado y pusheado. Si hay cambios sin commit, no seguir — decidir primero si van o quedan afuera.

### 2. Crear el tag anotado

```bash
git tag -a v-pre-campaign -m "Estado estable pre-campaña 1/5/2026. Rollback target."
git push origin v-pre-campaign
```

### 3. Anotar también el SHA del contenedor docker actual en producción

```bash
ssh sab@162.243.172.177 'docker inspect sab-app --format "{{.Image}}"'
# Output esperado: sha256:abcdef...
```

Guardar el SHA en este doc (abajo de la línea "### SHA del contenedor estable"):

```
### SHA del contenedor estable
sha256:XXXXX (anotado el 29/4/2026 21:00)
```

Esto es un cinturón de seguridad por si `git` está lento para re-buildear: podemos volver al contenedor anterior sin rebuild.

### 4. Ensayo de rollback (simulacro, crítico)

**Hacer un simulacro antes del día D.** Abrir una segunda terminal y ejecutar la secuencia real de rollback apuntando al droplet, cronometrando:

```bash
# Tiempo de referencia objetivo: <5 min desde el comando 1 al healthz OK
```

Si el ensayo toma más de 5 minutos, algo está mal documentado o lento — ajustar.

---

## Rollback en caliente (durante la campaña)

### Escenario A: deploy nuevo rompió algo, queremos volver a `v-pre-campaign`

**Pre-check (15 segundos):**

```bash
# ¿Qué tan roto está?
curl -sI https://sindicatoargentinodeboleros.com.ar/healthz | head -3
curl -s https://sindicatoargentinodeboleros.com.ar/healthz | head -1
```

Si `/healthz` devuelve `{"status":"ok","db":"up"}`, el sitio está vivo — probablemente es un bug puntual, no hace falta rollback total. Investigar logs primero:

```bash
ssh sab@162.243.172.177 'docker logs --tail 100 sab-app'
```

Si el sitio está caído o el bug es en checkout (venta bloqueada) → rollback completo.

**Rollback completo (target: <5 min):**

```bash
# 1. SSH al droplet
ssh sab@162.243.172.177

# 2. Ir al directorio de deploy
cd /opt/sab/app

# 3. Guardar el estado actual por si necesitamos diagnosticar después
git branch rollback-from-$(date +%Y%m%d-%H%M%S) HEAD || true

# 4. Traer tags y checkout del tag seguro
git fetch --tags
git checkout v-pre-campaign

# 5. Rebuild + restart
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build app

# 6. Verificar healthz
sleep 10
curl -sI http://localhost:3000/healthz && echo "OK app local"
```

Desde local:

```bash
# 7. Verificar desde afuera (Cloudflare + SSL)
curl -sI https://sindicatoargentinodeboleros.com.ar/healthz
curl -s https://sindicatoargentinodeboleros.com.ar/healthz
# Esperado: HTTP/2 200 + {"status":"ok","db":"up"}

# 8. Smoke test funcional mínimo
curl -s https://sindicatoargentinodeboleros.com.ar/api/eventos/proximos | head -1
```

### Escenario B: el git pull/build falla o es muy lento → volver al contenedor anterior

Si por alguna razón el rebuild tarda o falla, se puede bajar la imagen anterior del contenedor sin git:

```bash
ssh sab@162.243.172.177
cd /opt/sab/app

# Listar imágenes anteriores
docker images app-app --format "{{.ID}} {{.CreatedSince}}"

# Tagear la imagen actual por si acaso
docker tag app-app:latest app-app:broken-$(date +%s)

# Correr directamente la imagen vieja (SHA del pre-check, guardado arriba)
docker tag sha256:XXXXX app-app:latest
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d app
```

### Escenario C: DB corrupta (improbable pero posible)

Si el deploy aplicó una migración de Prisma que rompió datos:

```bash
ssh sab@162.243.172.177

# Último backup del día (ver docs/backups.md para hora exacta)
ls -lth /opt/sab/backups/*.db | head -5

# Restore
docker compose -f /opt/sab/app/docker-compose.yml -f /opt/sab/app/docker-compose.prod.yml stop app
cp /opt/sab/backups/prod-YYYYMMDD-HHMM.db /opt/sab/data/prod.db
docker compose -f /opt/sab/app/docker-compose.yml -f /opt/sab/app/docker-compose.prod.yml up -d app
```

**Atención:** esto rehace el estado a la hora del backup. Las compras/waitlists posteriores al backup se pierden. Úsese solo si la alternativa es pérdida total.

### Escenario D: rollback total, sitio completamente caído

Si nada de lo anterior levanta el sitio, la última milla es apagar el servidor nuevo y volver a Cloudflare apuntando al backend de emergencia (si existe). A fecha 20/4/2026 **no hay backend de emergencia configurado** — este escenario requiere intervención manual en Cloudflare DNS. Si ocurre:

1. Avisar por WhatsApp al coordinador del SAB inmediatamente.
2. Activar página de mantenimiento estática en Cloudflare Pages Functions (TODO: preparar esta página antes del 29/4 como plan Z).
3. Diagnosticar sin presión.

---

## Post-rollback

Una vez el sitio está de vuelta:

1. **Comunicar** en el canal interno que se ejecutó rollback (hora + escenario).
2. **Congelar merges** a `main` hasta entender la causa raíz del problema.
3. **Investigar** con calma sobre la branch `rollback-from-YYYYMMDD-HHMMSS` que guardamos en el paso 3 del escenario A.
4. **Post-mortem breve** dentro de las 24h (aunque sea 10 líneas): qué rompió, por qué no lo detectamos en tests, qué cambiamos para la próxima.

---

## SHA del contenedor estable

*(completar el 29/4/2026 al cerrar el día)*

```
sha256:_______________________________________________
Anotado el: __/__/2026 __:__
Por: Martín Lleral
```

---

## Contactos de emergencia

- **Coordinadora SAB:** (número en gestor privado, no en repo)
- **Martín Lleral (dev):** 221 xxx-xxxx
- **Proveedor infra (DigitalOcean):** https://cloudsupport.digitalocean.com/ (24/7 para cuentas con soporte basic o mejor)
- **Proveedor CDN (Cloudflare):** https://dash.cloudflare.com/?to=/:account/support

---

*Versión 1.0 — 20/4/2026. Ensayar antes de usar.*
