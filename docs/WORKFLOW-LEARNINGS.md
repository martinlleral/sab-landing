# Workflow Learnings — SAB Landing

**Última actualización:** 15/4/2026
**Propósito:** Aprendizajes técnicos y metodológicos destilados del proyecto SAB Landing, transferibles a otros proyectos similares (landing + ticketera + migración de infraestructura + repos abiertos). Pensado para futuras sesiones y para otros proyectos del mismo tipo.

---

## 1. Patrones que funcionaron

### 1.1 Runbook-as-code

**Qué es:** escribir el proceso de deploy como un archivo Markdown con comandos copy-paste, no como documentación narrativa. Cada fase es atómica, tiene checkpoints explícitos, y se puede ejecutar literal sin pensar.

**Por qué funciona:**
- Es reproducible por cualquier persona (incluido vos en 6 meses cuando te olvides de todo).
- El proceso queda versionado en git, así que si cambia, el diff muestra qué cambió y por qué.
- Sirve como contrato para el cliente ("esto es lo que hicimos").
- Es un artefacto de Service Design reutilizable — transferir un servicio crítico entre stakeholders sin interrumpir al usuario final es literalmente un service blueprint operativo.

**Ejemplo concreto en este proyecto:** `docs/runbook-deploy.md` con 5 fases numeradas (rotación de secrets + crear droplet + deploy + DNS + monitoreo) + checkpoints por fase + rollback explícito.

**Replicabilidad:** cualquier proyecto con deploy manual merece un runbook. Incluso si después automatizás con CI/CD, el runbook es la spec de lo que el CI debe hacer.

---

### 1.2 Auditoría escalonada (técnica primero, experta después)

**Qué es:** antes de hacer auditorías con expertos (humanos reales o subagentes LLM), hacer auditorías técnicas automatizadas con herramientas precisas.

**Orden sugerido:**
1. **Auditoría técnica con Playwright** (E2E + visual + performance + a11y básica). Encuentra bugs funcionales, problemas de render, issues de accesibilidad mecánica.
2. **Auditoría con subagentes expertos especializados** (SRE, Security, Tech Writer, etc.). Encuentra decisiones arquitectónicas, gaps conceptuales, deuda técnica oculta.

**Por qué funciona:**
- Los expertos son caros en tiempo y context — no conviene gastarlos en bugs que Playwright ya encuentra.
- Los bugs técnicos descubiertos por Playwright muchas veces ocultan bugs conceptuales más grandes. Fixearlos primero expone los reales.
- La auditoría experta se beneficia de tener un sistema "funcionalmente correcto" al momento del análisis, no uno roto.

**Ejemplo concreto:** en este proyecto, Playwright encontró el bug del `relacion NOT NULL` en waitlist y el CORS 500 en el droplet nuevo. Los 3 expertos del 14/4 se enfocaron en decisiones más profundas (webhook MP sin firma, rate limiting, créditos a Lucho) porque los bugs mecánicos ya estaban cerrados.

---

### 1.3 Git reset fresh antes de hacer público

**Qué es:** cuando un repo pasa de privado/legacy a público, hacer `rm -rf .git && git init` en vez de pushear el historial completo al nuevo remote.

**Por qué funciona:**
- El historial viejo puede tener secrets filtrados en commits intermedios que BFG o `git filter-branch` no siempre limpian del todo.
- Te da oportunidad de escribir un "Initial commit" con mensaje descriptivo del estado actual, en vez de arrastrar 100 commits WIP.
- Reduce el tamaño del repo (menos objetos git).
- Simplifica el blame: todo el código arranca "a tu nombre" para casos donde el historial legacy no es relevante.

**Cuándo NO hacerlo:**
- Si el historial tiene valor forense o de attribution (ej: muchos contributors que quieren mantener su commit history).
- Si hay tags de releases que importan.
- Si el proyecto tiene PRs abiertos o branches paralelas activas.

**Ejemplo concreto:** en este proyecto, el repo venía de un clone del GitLab de Lucho con commits que incluían el `.env.example` con secrets. Reset fresh + primer commit limpio + saneo manual de referencias históricas en docs evitó que los secrets llegaran a GitHub público.

---

### 1.4 Saneamiento con búsqueda exhaustiva pre-push

**Qué es:** antes de hacer un `git push` a un repo público (o cambiar visibilidad de privado a público), correr búsquedas explícitas de patrones de secrets conocidos sobre el `git diff --cached`.

**Cómo:**
```bash
SECRETS=(
  "APP_USR-<prefijo_conocido>"
  "xkeysib-<prefijo_conocido>"
  "sk_live_"
  "github_pat_"
  "ghp_"
  "admin@<dominio_sensible>"
  "<password_conocida>"
  # ...etc
)
for s in "${SECRETS[@]}"; do
  if git diff --cached | grep -q "$s"; then
    echo "⚠️  LEAK: $s"
  fi
done
```

**Por qué funciona:**
- Los `.gitignore` son necesarios pero no suficientes. Los secrets también pueden estar **mencionados** en documentación histórica (runbooks, TODOs, auditorías), no solo en archivos `.env`.
- Forzar una lista explícita de patrones obliga a pensar qué secrets existen en el proyecto y cuáles se pueden ver.
- En este proyecto, la búsqueda cazó 4 referencias en docs (`docs/runbook-deploy.md`, `docs/TODO-deploy.md`, `docs/auditoria-playwright-20260410.md`) y 1 en `public/backoffice/login.html` (placeholder del input) que no habrían sido detectadas por el `.gitignore`.

**Complemento:** después del push, reemplazar las menciones históricas por placeholders tipo `<SECRET_YA_ROTADO>` o `<ADMIN_PASS_VIEJA>`. Preserva la legibilidad del contexto sin exponer los valores reales.

---

### 1.5 Prepara todo lo que puedas sin bloqueantes externos

**Qué es:** cuando un proceso tiene dependencias externas (tercero, cuenta que no existe todavía, credencial que no llegó), **seguir adelante con todo lo preparable** en vez de bloquearse esperando.

**Ejemplo concreto en este proyecto:**
- Esperando: cuenta DigitalOcean del SAB, cuenta PayPal, acceso de Lucho a DNS.
- Mientras tanto hicimos: runbook completo, `.env.example` limpio, plan de DNS, mensaje para cada stakeholder, doc de rotación de secrets, auditoría Playwright.

Cuando las dependencias destrababan (en varias sesiones), cada paso era de 10-30 min porque ya estaba todo preparado. La sesión del deploy real duró ~3 horas en total y no hubo improvisación.

**Por qué funciona:**
- Separa "trabajo técnico" (bajo tu control) de "gestión humana" (no tu control).
- Reduce el costo cognitivo cuando llega la dependencia: no tenés que recordar todo el plan, solo ejecutarlo.
- Mantiene el flow del proyecto cuando hay semanas muertas esperando respuestas.

---

### 1.6 Tres bloques de prioridad en deploy: Seguridad → Resiliencia → Portafolio

**Qué es:** cuando el deploy está hecho pero hay mucha deuda técnica, priorizar en este orden:

1. **Seguridad crítica** (antes de procesar $1 real): webhooks con firma, rotación de secrets, rate limit, supply chain CVEs, auth hardening.
2. **Resiliencia operativa** (antes de tráfico sostenido): backups, uptime monitoring, graceful shutdown, upgrade de recursos, verificación de DB policies.
3. **Calidad del repo y portafolio** (para la percepción profesional y reutilización): README, créditos, CONTRIBUTING, badges, case study.

**Por qué funciona:**
- El orden es de "impacto al negocio" → "impacto a la continuidad" → "impacto a la percepción". Si saltás al 3 antes de cerrar el 1, el riesgo es que el sitio sea bonito pero se rompa en producción.
- Dentro de cada bloque, usar el consejo de los expertos especializados (SRE, Security, Tech Writer) para priorizar los top 5 hallazgos.
- El bloque 3 es el que más suma al portafolio IT del mantenedor, pero sin el 1 y 2 resueltos, es cosmético.

---

### 1.7 Reconciliar trabajo colaborativo heredado con honestidad ética

**Qué es:** cuando tomás un proyecto creado por otra persona y lo extendés, reconocer la autoría original en README y LICENSE con desglose específico de contribuciones.

**Cómo hacerlo bien (aprendizaje del SAB):**
1. En la descripción inicial del README, mencionar el origen: "Basado en el trabajo original de X, extendido por Y."
2. Crear una sección "Historia del proyecto" con timeline honesto: "En [año], X hizo [qué]. En [año], Y tomó el proyecto para [qué]."
3. En los créditos, desglosar qué hizo cada uno con bullets específicos. Mucho mejor que un "Thanks to X" genérico.
4. En el LICENSE, copyright compartido con fechas y roles:
   ```
   Copyright (c) YYYY X (código original)
   Copyright (c) YYYY Y (mantenimiento, extensiones, etc.)
   ```
5. Si el repo original no tenía LICENSE explícita, republicar bajo la nueva LICENSE es una zona grisácea legalmente — lo correcto es avisar al autor original como cortesía, aunque no sea técnicamente obligatorio.

**Tono importante:** celebratorio del trabajo previo, no culposo ni confrontativo. La frase "La mayor parte del código de este repositorio es obra de X. Sin ese primer esfuerzo, nada de lo que vino después habría existido." comunica reconocimiento genuino sin minimizarte a vos.

**Por qué importa:**
- Ética elemental: darle crédito a quien lo hizo.
- Legal: protege de disputas de propiedad intelectual.
- Profesional: un maintainer que reconoce contribuciones previas con humildad concreta se lee como "maduro" para reclutadores y colegas.
- Comunitario: alinea con el espíritu cooperativo del proyecto (si aplica).

---

### 1.8 Documentación en capas para distintos lectores

**Qué es:** tener múltiples documentos en el proyecto, cada uno optimizado para un tipo de lector diferente.

**Capas usadas en este proyecto:**

| Documento | Audiencia | Propósito |
|---|---|---|
| `README.md` | Desarrollador que encuentra el repo | Contexto, stack, quick start, créditos |
| `docs/runbook-deploy.md` | Operador que necesita reproducir el deploy | Comandos copy-paste, checkpoints, rollback |
| `docs/TODO-deploy.md` | Mantenedor del proyecto (vos mismo en 3 meses) | Deuda técnica priorizada, criterios de done |
| `docs/auditoria-playwright-*.md` | Portafolio + auditor externo | Evidencia del proceso de validación |
| `docs/WORKFLOW-LEARNINGS.md` (este) | Mantenedor + futuros proyectos similares | Patterns reutilizables, anti-patterns |
| `CASE_STUDY.md` (pendiente) | Reclutador / cliente potencial / stakeholder no técnico | Narrativa del proyecto desde Service Design |
| `PLAN.md` (fuera del repo) | Sesión de trabajo viva | Estado actual + próximos pasos + decisiones activas |

**Por qué funciona:**
- Cada lector encuentra el documento que necesita sin tener que filtrar ruido.
- Los documentos técnicos (`runbook`, `TODO`) no tienen que ser "lindos", pueden ser crudos y accionables.
- Los documentos de comunicación (`README`, `CASE_STUDY`) pueden tener storytelling sin preocuparse por ser reproducibles.
- El `PLAN.md` fuera del repo es sesión-vivo y no contamina la historia git con cambios de estado que no son del código.

---

## 2. Anti-patterns identificados (cosas que NO volvamos a hacer)

### 2.1 Commitear `.env.example` con secrets reales

**Problema:** el `.env.example` del repo original del SAB tenía los tokens reales de MercadoPago, Brevo, Perfit y credenciales admin en texto plano. Un `.env.example` se supone que es un *template* sin valores reales, pero en la práctica muchos devs lo usan como "archivo con mis credenciales" al principio del proyecto y después no lo renombran.

**Fix para futuro:**
- `.env.example` siempre con placeholders del tipo `REPLACE_WITH_<SERVICE>_TOKEN` o `<valor_ejemplo>`.
- Agregar al `.gitignore` un chequeo pre-commit que busque patrones de secrets en `.env.example` y rechaze.
- Para proyectos en producción, usar un secrets manager (Doppler, Infisical, Vault) desde el día 1, así no hay ningún `.env` con valores reales en el filesystem del dev.

### 2.2 Webhooks de proveedores de pago sin verificación de firma

**Problema:** el endpoint `/api/compras/webhook` aceptaba cualquier POST sin verificar la firma que MercadoPago envía. Detectado por el Security Engineer en la auditoría del 14/4, **después** del deploy.

**Fix para futuro:**
- **Template de seguridad** para cualquier integración con provider de pagos: verificación de firma HMAC + validación de `collector_id`/`merchant_id` + validación de `transaction_amount` contra la DB + idempotencia en `procesarPago`.
- Tests unitarios del webhook con payloads forjados para confirmar que el rechazo funciona.
- Documentar en el runbook la activación del "Secret Key" del provider en Fase 0.

### 2.3 Endpoints GET de recursos sensibles sin auth ni token firmado

**Problema:** `/api/compras/status/:preferenciaId` permitía que cualquiera que supiera o adivinara un ID pudiera ver PII y códigos QR. Los IDs de MP son random largos, pero "difícil de adivinar" no es un control de seguridad.

**Fix para futuro:**
- Todo endpoint que exponga PII o recursos sensibles debe requerir: (a) auth session activa, o (b) un token firmado con JWT/HMAC que incluya el ID del recurso + timestamp + expiración, o (c) un segundo factor como el email del comprador.
- Nunca confiar en "los IDs son difíciles de adivinar" como protección.

### 2.4 Seed de DB con credenciales hardcodeadas

**Problema:** `prisma/seed.js` original creaba un admin con email `admin@banda.com` y password `admin123`. Cuando rotamos las credenciales manualmente en el droplet, el seed volvía a crear el admin débil en el siguiente restart del container.

**Fix para futuro:**
- Seeds idempotentes que chequeen por **existencia** del recurso (ej: "existe algún admin con rol 1"), no por valores específicos (ej: "existe admin con email X").
- Usar variables de entorno (`ADMIN_EMAIL`, `ADMIN_PASS`) para credenciales bootstrap, con fallback a valores imposibles de adivinar (ej: `'CAMBIAR_' + Date.now()`).
- Documentar explícitamente en el README que las credenciales bootstrap deben rotarse inmediatamente después del primer login.

### 2.5 Auto-bombo en commits y README

**Problema:** fácil caer en escribir commits y README que adjudican todo el trabajo a quien hace el último push, sin reconocer contribuciones previas.

**Fix para futuro:**
- Antes de hacer público un repo que heredó código de otro autor, revisar explícitamente el README y LICENSE para confirmar que la autoría está reconocida con precisión.
- Hacer un pass "éticamente conservador" sobre los créditos: cuando dudes, dar más crédito al autor original.
- En los commits propios, usar mensajes que reflejen qué hiciste específicamente (ej: "fix: CORS header for new IP", no "project deployed").

---

## 3. Decisiones estratégicas validadas

Estas son decisiones que tomamos en este proyecto y que funcionaron. Replicar en proyectos similares salvo que haya razones concretas para no hacerlo.

### 3.1 Mantener el stack existente en vez de migrar a Astro

**Contexto:** la opción era (a) mantener el stack de Lucho (Node + Express + Prisma + SQLite + Bootstrap) o (b) migrar a un stack moderno (Astro + Cloudflare Pages + Supabase).

**Decisión:** mantener (a) con extensiones.

**Por qué funcionó:**
- Riesgo más bajo: el stack ya estaba probado y tenía toda la ticketera integrada.
- Costo más bajo: ~60 horas de extensión vs. ~200 horas de reescritura.
- Tiempo de deploy más rápido: 2 semanas vs. 2-3 meses.
- Compatible con los secrets existentes y la cuenta MP sin reconfiguración.

**Cuándo NO elegir esto:**
- Si el stack heredado tiene vulnerabilidades estructurales que no se pueden fixear sin reescribir.
- Si el rendimiento es inaceptable y no se puede optimizar.
- Si el autor original pide explícitamente que su código no sea extendido.

### 3.2 Supabase para waitlist (antes del sistema completo de socios)

**Contexto:** el SAB quería un sistema de socios, pero la validación de demanda todavía no estaba hecha.

**Decisión:** implementar solo la captura (waitlist) con encuesta RFM en Supabase, antes de construir el sistema completo de socios.

**Por qué funcionó:**
- Validó demanda real antes de invertir en el sistema completo.
- Capturó datos de research que van a guiar las decisiones de precio/beneficios del sistema final.
- Supabase tiene free tier generoso y RLS para proteger PII sin mantener un servidor propio.
- Separación de responsabilidades: la waitlist vive en Supabase, el sistema de socios futuro va a vivir en la DB principal del droplet.

### 3.3 Reset fresh del git antes de publicar

Ya explicado en 1.3. Valió la pena el trabajo extra de reescribir la historia.

### 3.4 Repo público con MIT License

**Contexto:** la opción era (a) repo privado hasta que el proyecto esté "terminado", o (b) repo público desde el primer commit con MIT.

**Decisión:** (b) público con MIT.

**Por qué funcionó:**
- El código no tiene secretos competitivos reales (los secrets viven en `.env`, no en el código).
- Alineado con el espíritu cooperativista del cliente (SAB).
- Sirve como caso de portafolio para el mantenedor.
- Permite que otras cooperativas musicales lo adapten en el futuro.
- Si algo se pone sensible, se puede volver privado con 1 click.

**Cuándo NO elegir esto:**
- Si el proyecto tiene IP propia del cliente (algoritmos patentables, datos competitivos).
- Si el cliente explícitamente pide privacidad.
- Si hay acuerdos de NDA o contratos que lo prohíben.

---

## 4. Métricas del proyecto (para referencia futura)

| Métrica | Valor |
|---|---|
| Tiempo total del Sprint 1 (análisis + auditoría + fixes + waitlist + docs) | ~30 horas |
| Tiempo total del Sprint 2 (migración + deploy + repo + auditorías) | ~20 horas |
| Archivos en el repo al cierre de Sprint 2 | 97 |
| Líneas de código + docs | 14.154 |
| Auditorías realizadas (Playwright + expertos) | 4 (1 panel inicial + 1 Sprint 1 + 1 Playwright + 1 post-deploy) |
| Bugs críticos encontrados y fixeados en vivo | 3 (seed recreando admin, CORS 500, `relacion NOT NULL` en waitlist) |
| Bugs críticos encontrados post-deploy (no fixeados todavía) | 1 (webhook MP sin firma) |
| CVEs de supply chain detectados | 16 (2 críticas, 7 highs) |
| Screenshots de auditoría generados | 27 |
| Hallazgos consolidados en el TODO post-auditoría | 16 (6 security + 5 resiliencia + 5 portafolio) |
| Score general del proyecto al cierre Sprint 2 | 5.8 / 10 |

---

## 5. Herramientas y skills usadas con alto valor

- **Playwright MCP** — auditoría E2E con screenshots, validación de rendering, tests de interacción, verificación de landmarks a11y. Usada para la auditoría técnica del 10/4.
- **Supabase MCP** — migraciones y queries directas contra la DB de waitlist, sin tener que clonar schemas localmente.
- **Python + paramiko** — deploy remoto SSH sin sshpass ni tools extras. Útil cuando no se puede instalar sshpass por apt (requiere sudo) y se necesita automatizar un primer contacto con un server nuevo.
- **`docker compose` con `healthcheck + mem_limit + logging rotation`** — el trío mínimo para Docker en producción en servers chicos.
- **`rsync` + `docker cp`** — deploy manual low-tech que funciona perfecto para proyectos chicos/medianos sin CI/CD.
- **`openssl rand -hex 32`** — generar SESSION_SECRET y similares en un comando.
- **`expert-review` skill (subagentes paralelos)** — auditoría multi-perspectiva en 15-20 min cuando un solo experto no alcanza.
- **`canvas-design` skill (pendiente para CASE_STUDY)** — para generar PDFs diseñados del proyecto al momento de armar el portafolio.
- **`frontend-design` skill** — usada en el Sprint 1 para diseñar la waitlist con calidad producción.
- **`iconv -f UTF-8 -t UTF-16LE`** — copiar texto al portapapeles de Windows desde WSL sin corromper emojis/tildes/ñ.

---

## 6. Preguntas para cualquier proyecto similar futuro

Antes de arrancar un proyecto parecido (landing + ticketera + cliente cooperativa o pequeña org), respondé estas preguntas:

### Sobre el stack
1. ¿Heredamos código o empezamos de cero?
2. Si heredamos, ¿el autor original está accesible para preguntas?
3. ¿El stack heredado tiene vulnerabilidades estructurales?
4. ¿Hay alguna razón técnica fuerte para migrar a un stack moderno o es mejor mantener y extender?

### Sobre el cliente
5. ¿Quién es el interlocutor único con poder de decisión? (Evitar reuniones con 20 stakeholders simultáneos.)
6. ¿El cliente tiene cuenta propia en los servicios críticos (MP, dominio, cloud)?
7. ¿Hay algún stakeholder que tenga acceso crítico que no es reemplazable (ej: el dev original con el dominio a su nombre)?
8. ¿El cliente entiende que el proyecto va a requerir trabajo suyo (crear cuentas, aprobar cambios), no solo trabajo del dev?

### Sobre la seguridad
9. ¿El proyecto procesa pagos reales? → auditoría de security obligatoria antes del go-live.
10. ¿El proyecto maneja PII? → verificar cumplimiento con ley de protección de datos local (en Argentina, Ley 25.326).
11. ¿Hay secrets filtrados en el repo heredado? → saneo + rotación como Fase 0 del runbook.
12. ¿Hay webhooks de terceros? → verificar que tengan verificación de firma, no importa lo "chico" que sea el proyecto.

### Sobre la infraestructura
13. ¿El cliente puede pagar infraestructura cloud en USD? Si no, ¿hay alternativas regionales con pago en moneda local?
14. ¿Cuánta RAM/CPU necesita el proyecto realmente? Casi siempre se sobredimensiona.
15. ¿Hay un plan de backups definido? Si no hay presupuesto para backups manageados, ¿hay un cron + upload a storage gratis?
16. ¿Hay un plan de monitoreo? Aunque sea Uptime Robot gratis con alerta por mail.

### Sobre el portafolio del dev
17. ¿El proyecto va a ser usado como caso de estudio? Si sí, desde el día 1 tomar notas de decisiones, screenshots de antes/después, métricas concretas.
18. ¿El código va a ser público? Si sí, considerar `git init` fresh y escribir README desde la perspectiva del lector objetivo (no solo del dev).
19. ¿Hay trabajo previo de otra persona que reconocer? Planear desde el inicio cómo dar crédito sin minimizarse.

---

## 7. Reflexiones finales

Este proyecto pasó por múltiples capas de complejidad simultánea: código legacy heredado de otro dev, migración de infraestructura, primer deploy en producción del mantenedor actual, auditorías con expertos, publicación como open source con dilemas éticos de atribución, y un cliente (cooperativa) con dinámicas particulares de decisión colectiva.

**Lo que hizo que funcionara:**

1. **Separar claramente los frentes de trabajo**: seguridad, resiliencia, portafolio, gestión de stakeholders, documentación. Cada uno con su propio TODO y su propio flujo.
2. **No tratar de hacer todo en cada sesión**: priorizar "qué es bloqueante" vs "qué es mejora". Los bloqueantes primero, siempre.
3. **Documentar para el yo futuro**: TODOs, runbooks, learnings, memorias. Todo con la regla de "si leo esto en 3 meses sin contexto, ¿puedo retomar?".
4. **Reconocer el trabajo ajeno con honestidad**: tanto técnica (el código de Lucho) como metodológica (los aportes del cliente, de los subagentes expertos, etc.). La humildad concreta se lee bien por todos lados.
5. **Pedir ayuda a expertos especializados cuando corresponde**: los 3 expertos del 14/4 encontraron un bug crítico (webhook MP sin firma) que ninguna auditoría anterior detectó. Pagar el costo de context/tiempo vale la pena.
6. **Cerrar sesiones largas con "gracefull shutdown"**: actualizar PLAN, memoria, próximos pasos, mensaje de cierre. La continuidad entre sesiones es la diferencia entre un proyecto que avanza y uno que se empantana.

**Lo que replicaría:**
- Runbook as code desde el día 1.
- Playwright + expert-review como dupla de auditoría.
- Git reset fresh antes de hacer público.
- Tres bloques de prioridad (seguridad → resiliencia → portafolio).
- Documentación en capas para distintos lectores.

**Lo que no volvería a hacer:**
- Confiar en `.gitignore` como único control de filtrado de secrets. Sumar siempre búsqueda exhaustiva pre-push.
- Asumir que un webhook "no es tan importante" y dejarlo sin verificación de firma.
- Hacer decisiones técnicas al final de una sesión cansada. Esas decisiones merecen contexto fresco.

---

*Este documento se va actualizando a medida que aprendemos cosas nuevas en el proyecto o en otros similares. Si algo de acá queda obsoleto, actualizarlo o marcarlo como "deprecated" con fecha.*
