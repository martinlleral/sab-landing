# Auditoría pre-campaña — 20/4/2026

**Alcance:** SAB Landing (`sindicatoargentinodeboleros.com.ar`) — producto PAGO con MercadoPago.
**Objetivo:** validación go/no-go para la campaña del **1/5/2026** (11 días de ventana).
**Auditor:** E2E Playwright + Lighthouse + security headers + TLS + Expert Review (1 QA Engineer).

---

## Veredicto

**GO condicional.** No hay hallazgos P0 (bloqueantes). Hay 3 P1 no negociables (~4-5 h totales) que deben entrar antes del 28/4. Todo lo demás es P2 (post-campaña).

---

## Metodología

| Dimensión | Herramienta | Cobertura |
|---|---|---|
| Funcional E2E | Playwright 1.59 × 3 viewports (desktop 1440×900, mobile Pixel 7, tablet 820×1180) | 7 archivos de specs, 34 tests × 3 = 102 total, **98 passed / 4 skipped** |
| Accesibilidad | axe-core 4.11 WCAG 2.1 AA | Home + Backoffice login — **0 violaciones serious/critical** |
| Performance + BP + SEO | Lighthouse 13.1 | Desktop + mobile |
| Security headers | curl -I | Home + /api/admin + /backoffice/login |
| TLS | openssl s_client | Protocolos + cipher + cert chain |
| Rate limiting | `scripts/smoke-rate-limit.js` | POST /api/auth/login × 12 req |
| Expert review | Panel de 1 QA Engineer senior | Veredicto go/no-go + gaps de campaña |

Artefactos generados:

- `docs/audit/lh-desktop.report.html` + `.json`
- `docs/audit/lh-mobile.report.html` + `.json`
- `tests/e2e/specs/` — suite Playwright completa
- `playwright-report/` — resultado de la última corrida (no versionado)

---

## Matriz de prioridades

### P0 — bloqueantes (no-go si no se resuelven)

*Ninguno detectado.*

### P1 — pre-campaña (deben entrar antes del 28/4)

| # | Hallazgo | Acción | Esf | Razón |
|---|---|---|---|---|
| P1.1 | Mobile LCP 6 s / CLS 0.81 | `<link rel="preload" as="image">` para `slider1.jpg` + `width`/`height` o `aspect-ratio` en cards de eventos + reservar alto del slider con CSS | 3-4 h | 4G argentino + canal IG/WhatsApp: 6s LCP ≈ 25-35% bounce extra en cold visit. Afecta conversión de campaña. |
| P1.2 | `/backoffice/login.html` responde `cache-control: public, max-age=0` | Setear `Cache-Control: no-store` en handler de login y en respuestas autenticadas | 0.5 h | `max-age=0` permite que un proxy intermedio o el botón "atrás" del browser sirva el HTML cacheado tras logout. |
| P1.3 | Verificar cookie de sesión: `SameSite` + `Secure` + `HttpOnly` | Leer `src/config/session.js` (o equivalente) y confirmar. Si falta algo es P0 encubierto. | 0.5 h | Sin CSRF explícito, la defensa es SameSite+CORS. Si la cookie no tiene esos flags, hay ventana real de explotación. |
| P1.4 | Verificar que el fix de `isApiRequest()` cubre todos los endpoints admin | Agregar tests Playwright que chequeen `401 JSON` (no `302 HTML`) en al menos 3 endpoints `/api/admin/*` distintos sin sesión | 0.5 h | Bugs así suelen tener hermanos. Actualmente solo se cubre `/api/admin/compras`. |

### P2 — post-campaña (no bloquean, anotar en PLAN)

| # | Hallazgo | Acción | Esf |
|---|---|---|---|
| P2.1 | CSP desactivado explícitamente (`contentSecurityPolicy: false` en `src/server.js:20`) | Implementar con `report-only` durante 1 semana en staging, relevar violations reales (MP SDK + YouTube + Supabase + Bootstrap CDN), luego activar enforcing | 2-3 d |
| P2.2 | `Permissions-Policy` header ausente | One-liner en helmet: `permissionsPolicy({features: {camera:[], microphone:[], geolocation:[]}})` | 15 min |
| P2.3 | YouTube `maxresdefault.jpg` 404 silenciado por `onerror` → `hqdefault.jpg` | Cambiar `src` inicial a `hqdefault.jpg` directo, remover `onerror`. Ensucia console en demos. | 15 min |
| P2.4 | HSTS duplicado (origen + Cloudflare) | Remover el header del origen (helmet), dejar solo el de Cloudflare. Cosmético. | 5 min |
| P2.5 | Lighthouse BP desktop 77 — 3 deprecations en `/cdn-cgi/challenge-platform/` | No actionable (código de Cloudflare Bot Fight, no nuestro). Documentar. | — |

---

## Gaps de campaña (no estaban en la lista inicial — flagged por QA Engineer)

Cosas que **no son hallazgos de código** pero típicamente rompen campañas de este tipo:

1. **Test de carga del checkout MP.** Los 98 E2E pasan en serie. Con 50 compras concurrentes el 1/5 a las 20:00, SQLite + Prisma + `connect.sqlite3` para sesiones pueden serializar writes. **Acción:** correr `k6` o `artillery` con 30 RPS sobre `/api/checkout` antes del 28/4.
2. **Webhook MP end-to-end en producción real (no ngrok).** El patrón 3-caminos redundantes (webhook + polling cliente + cron 60s) solo funciona si los 3 están vivos. **Acción:** verificar el cron 60s corriendo en el droplet + hacer 1 compra real de prueba con el sandbox apuntando al dominio.
3. **Plan de rollback.** ¿Hay tag `v-pre-campaign` y comando documentado para volver atrás en <5 min si el deploy del 30/4 rompe checkout? **Acción:** crear `docs/ops/rollback.md` con los 3-4 comandos y probar el ensayo.
4. **Monitoreo post-deploy.** Sin Sentry/Logtail, los errores de pago de usuarios reales se pierden. **Acción mínima:** `console.error` → archivo + `tail -f` el día de la campaña + Uptime Kuma cada 5 min a `/healthz`.
5. **Bloqueante SMTP externo.** Si DO no destraba los ports 25/465/587 antes del 28/4, los emails de confirmación de waitlist no salen. **Acción:** implementar Brevo HTTP API **ya** — no esperar la respuesta del ticket.

---

## Lo que funciona bien

- **E2E 98/98 passed** en 3 viewports — cobertura sólida para detectar regresiones en merges futuros.
- **A11y WCAG 2.1 AA: 0 violaciones serious/critical** — iteración completa de color-contrast resuelta durante la auditoría.
- **TLS configurado correctamente** — 1.2+1.3 only, ECDSA cert, cipher modernos, Verification OK.
- **Rate limiting en profundidad** — Cloudflare Bot Fight bloquea en ~6 req, Express rate limiter como segunda capa.
- **Helmet activo** con buen set de headers por default (HSTS, XCO, XFO, Referrer, COOP/CORP).
- **Fail-fast MP tokens al boot** — previene deploys con credenciales malformadas.
- **Bug real del middleware `requireAdmin` detectado y fixeado** durante la auditoría — rutas admin API ahora devuelven `401 JSON` correctamente.

---

## Hallazgos fixeados durante la auditoría (ya aplicados)

| Commit | Contenido |
|---|---|
| `1d5f919` | Remover pestaña Compras placeholder + fail-fast MP tokens malformados |
| `b51a98d` | Suite Playwright cross-viewport + accesibilidad + SEO + smoke API |
| `e8048db` | Fixes WCAG AA (color-contrast) + fix real `auth.middleware` `isApiRequest()` + ajustes de selectores de tests |

---

## Próximos pasos sugeridos

1. **Hoy 20/4** — aplicar P1.2, P1.3, P1.4 (1.5 h total).
2. **21-22/4** — aplicar P1.1 (performance mobile, 3-4 h).
3. **23/4** — implementar Brevo HTTP API (workaround SMTP).
4. **24/4** — correr test de carga k6/artillery sobre checkout MP.
5. **27/4** — freeze de código. Ensayo de rollback.
6. **28/4** — ventana de observación final.
7. **30/4** — deploy definitivo + tag `v-pre-campaign`.
8. **1/5** — campaña. Monitoreo `tail -f` + Uptime Kuma.
9. **Post-campaña (mayo)** — P2.1 CSP, P2.2-2.4 cleanup.

---

**Documentación técnica de la auditoría:**
- Reportes Lighthouse: `docs/audit/lh-{desktop,mobile}.report.{html,json}`
- Suite E2E: `tests/e2e/specs/*.spec.js`
- Script de smoke rate limit: `scripts/smoke-rate-limit.js`
- Cómo correr: `README.md` → sección *Testing E2E*
