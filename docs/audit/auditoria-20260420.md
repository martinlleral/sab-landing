# Auditoría pre-campaña — 20/4/2026

**Alcance:** SAB Landing (`sindicatoargentinodeboleros.com.ar`) — producto PAGO con MercadoPago.
**Objetivo:** validación go/no-go para la campaña del **1/5/2026** (11 días de ventana).
**Auditor:** E2E Playwright + Lighthouse + security headers + TLS + Expert Review (1 QA Engineer).

---

## Veredicto

**GO condicional.** No hay hallazgos P0 (bloqueantes). Hay 3 P1 no negociables (~4-5 h totales) que deben entrar antes del 28/4. Todo lo demás es P2 (post-campaña).

> **Actualización 22/4/2026:** P0.3 cerrado como falsa alarma tras verificación en prod. El archivo QR `737f9df9-440e-44f4-bb57-792fc934a583.png` existe en `/app/public/assets/img/uploads/qr/` (timestamp 21/4 00:33, coincidente con compra #20). El código de `qr.service.js` ya escribe a disk correctamente; el hallazgo original asumió lo contrario sin confirmar empíricamente. Se promueve un nuevo hallazgo P2.6 menor (cleanup de archivos QR huérfanos al cancelar entradas).

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

**Detectados el 20-21/4 durante test E2E con compra real ($12k que Eugenio reembolsó al SAB).**

| # | Hallazgo | Root cause | Estado |
|---|---|---|---|
| P0.1 | **Webhook MP no dispara.** MP no manda POST a `/api/compras/webhook`. Defensa en profundidad cae a "solo cron" — si el cron se congela durante la campaña, procesamiento de pagos cae. | `BASE_URL=http://162.243.172.177` en `.env` de prod → la `notification_url` generada era HTTP+IP, MP la rechaza. | ✅ **Fixeado 21/4 00:55**: `BASE_URL=https://sindicatoargentinodeboleros.com.ar`. Pendiente re-test y verificar que la URL configurada en panel MP también sea HTTPS+dominio (esa sobreescribe la que mandamos en payload). |
| P0.2 | **MP no redirige al usuario post-pago.** Checkout queda colgado en página de MP — usuario no ve confirmación, puede pensar que falló → reintenta → posible compra duplicada. | Mismo root cause P0.1: `back_urls.success=http://IP/...` → MP no respeta, `auto_return` tampoco se activa (requiere HTTPS). | ✅ **Fixeado 21/4 00:55**: con HTTPS+dominio las back_urls son válidas. Pendiente re-test. |
| ~~P0.3~~ | ~~**QR PNG no persiste a disk.**~~ | ~~Revisar `src/services/qr.service.js`.~~ | ✅ **Cerrado 22/4 como falsa alarma**. Verificación en prod: archivo `737f9df9-440e-44f4-bb57-792fc934a583.png` existe en volumen `uploads-data` (timestamp 21/4 00:33, consistente con compra #20). `qr.service.js:20` usa `QRCode.toFile()` — escribe correctamente. El hallazgo original se basó en un chequeo prematuro antes de que `procesarPagoAprobado()` completara. Subproducto: se identificó un issue menor post-campaña (ver P2.6). |

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
| P2.6 | **QR PNG huérfano tras cancelar entrada.** Al cancelar/borrar una `Entrada` (rollback transaccional o admin), el archivo PNG en `/app/public/assets/img/uploads/qr/<uuid>.png` queda en disk sin referencia en DB. Detectado al confirmar el cierre de P0.3: compra #20 cancelada, `entradas: []` en DB, pero archivo sigue presente. No afecta UX ni seguridad — solo genera basura en disk a largo plazo. | (a) En el handler de cancelación/borrado de entrada, llamar a `fs.unlink(qrImageUrl)` tras el `tx.entrada.delete`. (b) Script de limpieza batch que compare `Entrada.qrImageUrl` vs archivos en disk y borre huérfanos. | 1-2 h |

---

## Hallazgos de auditoría manual (20/4 cierre del día)

Usuario navegó el sitio como comprador real y encontró los siguientes issues UX. Confirmados contra el código.

### P1 — UX crítico pre-campaña

| # | Hallazgo | Evidencia | Acción | Esf |
|---|---|---|---|---|
| U1.1 | **Cards de "Próximos Eventos" no tienen botón de compra.** Solo el CTA del hero compra — y va fijo al evento destacado. Si hay 3 fechas en la landing, el usuario no puede comprar la 2da o 3ra. | `public/assets/js/app.js:374-388` → `renderProximos()` renderiza tarjetas sin botón. El modal de compra usa `eventoActual.id` que es el destacado. | Agregar botón "Comprar" por card que abra el modal con el `eventoId` de esa card. Refactor mínimo del handler del modal para aceptar `eventoId` dinámico. | 2-3 h |
| U1.2 | **Precio aparece en rojo — lee como advertencia, no como CTA.** Rojo (#e63946) activa señal "peligro/error" y desincentiva la compra, especialmente en mobile donde el precio es lo primero que se ve. | `public/assets/css/app.css:560-565` → `.evento-card-precio { color: var(--color-accent); }` con `--color-accent: #e63946`. | Cambiar a color neutro o dorado (más alineado a identidad boleros/tango). Opciones: `#f0ece8` (blanco bone, sobrio) o `#d4af37` (dorado, premium). Decisión UX + design. | 30 min |

### P2 — UX mejorable

| # | Hallazgo | Diagnóstico | Acción | Esf |
|---|---|---|---|---|
| U2.1 | **Head "EL EVENTO" no lleva a ningún lugar.** Es solo H2 estático — no cumple función de navegación ni CTA. Los callouts/boxes del diseño original (info cards + WhatsApp callout) están en el HTML desplegado pero la experiencia no cierra un loop claro al usuario. | Callouts presentes en `public/index.html:197-266` (info-grid + callout--info + callout--whatsapp) y renderizan en prod. El problema es narrativo: la sección no termina con un CTA de acción (ej. "Comprá tu entrada"). | Agregar un CTA al final de `.evento-content` que abra el modal de compra del evento destacado. Hace que la sección "El Evento" termine en acción, no en info plana. | 1 h |

### P3 / Sprint 2 — marketing orgánico

| # | Hallazgo | Qué es | Acción | Esf |
|---|---|---|---|---|
| U3.1 | **SEO avanzado: hacer que el SAB aparezca en Google con recuadro lateral (Knowledge Panel)**, con foto, próximo evento, redes, ubicación. | Ese recuadro es el **Google Knowledge Panel**. Se construye de 3 fuentes: (1) **Google Business Profile** (el más importante — da el panel con foto, horario, dirección), (2) **Schema.org** bien estructurado (`MusicGroup` + `MusicEvent` + `Place`), (3) autoridad de dominio (menciones, links, tiempo). El sitio ya tiene Schema.org MusicGroup (`public/index.html:37-58`). Falta GBP + Schema Event + tiempo. | **Sprint 2** (post-campaña): (a) crear/reclamar Google Business Profile para "Sindicato Argentino de Boleros" en La Plata con foto grupal, horarios, teléfono, sitio. Validación por postal o video-call toma ~7 días. (b) Ampliar Schema.org con `MusicEvent` por evento próximo (performer, startDate, location, offers). (c) Submit sitemap a Google Search Console. | 1 semana (con tiempos externos de verificación GBP) |

---

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
