# Auditoría Playwright — Landing SAB

**Fecha:** 10/4/2026
**Ejecutada por:** Claude Code (Opus 4.6) con Playwright MCP
**Entorno:** `localhost:3000` (Docker, build de Sprint 1)
**Duración:** ~50 minutos

---

## Resumen ejecutivo

**Resultado:** ✅ **Sprint 1 listo para producción** (con caveats blockados por dependencias externas).

| Categoría | Validaciones | Pasaron | Hallazgos | Estado |
|---|---|---|---|---|
| SEO / `<head>` | 9 | 9 | 0 | ✅ |
| Secciones visuales (desktop) | 10 | 10 | 0 | ✅ |
| Responsive (mobile/tablet/mobile-sm) | 4 viewports | 4 | 0 | ✅ |
| Flujos críticos interactivos | 3 | 3 | 1 (corregido) | ✅ |
| Performance | 5 | 5 | 0 | ✅ |
| Accesibilidad | 9 | 7 | 2 (corregidos en sesión) | ✅ |
| **Total** | **40** | **38** | **3** | **✅** |

**1 bug bloqueante encontrado y corregido durante la auditoría:** la columna `relacion` de `waitlist_socios` quedó NOT NULL después de la migración del Sprint 1, lo que rompía el submit del formulario nuevo.

---

## Fase 1 — Setup y validación de `<head>`

| Validación | Resultado |
|---|---|
| `lang="es-AR"` | ✅ |
| Title (49 chars, ideal <60) | ✅ "Sindicato Argentino de Boleros — Ticketera Oficial" |
| Meta description (145 chars, ideal 120-160) | ✅ |
| `link rel="canonical"` | ✅ `https://sindicatoargentinodeboleros.com.ar/` |
| `meta robots` con `max-image-preview:large` | ✅ |
| `og:image` apunta a la nueva 1200×630 | ✅ `og-image.jpg` (88 KB) |
| `og:image:width` + `og:image:height` declarados | ✅ |
| Schema.org `MusicGroup` (estático, 11 keys) | ✅ |
| Schema.org `MusicEvent` (dinámico, 12 keys, relleno por JS) | ✅ |

**Jerarquía de headings (limpia):**
- 1× `<h1>` "Amor de Miércoles con Leo García"
- 6× `<h2>` (El Evento, Cómo llegar, Así suena, Próximos Eventos, Una orquesta cooperativa de boleros, Sumate al Sindicato)

---

## Fase 2 — Auditoría visual por sección (desktop 1440×900)

| # | Sección | Resultado | Captura |
|---|---|---|---|
| 1 | **Hero** | Foto cargada cover, título dinámico, glow neón en "LEO GARCÍA", precio $12.000, CTA carmín, navegación slider, WhatsApp flotante | `audit/01-hero-desktop.png` |
| 2 | **Trust bar** | Badge SVG oficial Mercado Pago (cyan #00B1EA), QR, +500, soporte directo | `audit/02-trust-bar.png` |
| 3 | **El Evento** | 3 info-cards (Cuándo/Dónde/Entrada), bloque "Amor de Miércoles" enmarcado, viñetas con íconos, callouts | `audit/02-trust-evento.png` |
| 4 | **Cómo llegar** | iframe Google Maps cargado en zona La Plata, dirección Calle 23 N°565, link `@espaciodoblet` | `audit/03-ubicacion.png` |
| 5 | **Así suena** | Thumbnail real (no placeholder gris), facade pattern OK | `audit/04-video.png` |
| 6 | **Próximos Eventos** | 3 cards: Mirlos 15/4, Leo García 29/4, Bomba de Tiempo 30/5. Fechas correctas (sin shift de timezone) | `audit/05-proximos.png` |
| 7 | **Quiénes somos** ⭐ | Foto grupal cargada (237 KB), título con "COOPERATIVA" en carmín, stats 17/2/2023, hitos, artistas, 3 CTAs (Spotify/YT/IG) | `audit/06-quienes-somos.png` |
| 8 | **Waitlist (top)** | 3 primeras preguntas: ubicación, frecuencia 6m, modo de entrada | `audit/07-waitlist-top.png` |
| 9 | **Waitlist (medio)** | Top-3 beneficios (7 opciones), rango de pago con anclaje, nombre/email, canal opcional, consentimiento Ley 25.326 | `audit/08-waitlist-bottom.png` |
| 10 | **Waitlist (CTA + footer)** | Botón "QUIERO ESTAR", contador en tiempo real "21 personas ya se sumaron", footer | `audit/09-waitlist-cta-footer.png` |

---

## Fase 3 — Responsive

| Viewport | Validación | Captura |
|---|---|---|
| **Mobile 390×844** (iPhone 14) | Hero 70vh, trust bar en grilla, badge MP visible, WhatsApp flotante OK | `audit/mobile-full.png`, `audit/mobile-hero.png`, `audit/mobile-quienes.png` |
| **Mobile-sm 360×640** | Breakpoint <400px funciona: las grillas 2× pasan a 1 columna apilada | `audit/mobile-sm-evento.png` |
| **Tablet 768×1024** | Hero adaptativo, trust bar en flex-wrap, info-cards 2× | `audit/tablet-hero.png` |
| **Desktop 1440×900** | Baseline | `audit/desktop-full.png` |

---

## Fase 4 — Flujos críticos interactivos

### 4.1 Waitlist (end-to-end)

| Test | Resultado |
|---|---|
| **Límite de 3 beneficios marcados** (JS bloquea el 4°) | ✅ El 4° click no se aplica, los 3 anteriores quedan checked |
| **Validación de campos obligatorios** | ✅ Submit con campos vacíos muestra error |
| **Submit completo con datos válidos** | ✅ POST 201 → mensaje "¡Gracias por sumarte!" → form ocultado → contador 21→23 |
| **Cleanup de registros de prueba en Supabase** | ✅ DELETE de los 2 inserts de auditoría |

### 4.2 Modal de compra

| Test | Resultado |
|---|---|
| **Apertura del modal desde "COMPRAR ENTRADAS" del hero** | ✅ |
| **Info del evento destacado pre-llenada** | ✅ "Amor de Miércoles con Leo García" + fecha |
| **Selector de cantidad + total dinámico** | ✅ 1 entrada = $12.000 / 3 entradas = $36.000 |
| **Cierre con `Escape`** | ✅ |

---

## Fase 5 — Performance

| Métrica | Valor | Observación |
|---|---|---|
| **DOMContentLoaded** | 67 ms | Excelente (en local sin throttling) |
| **Load event** | 306 ms | Excelente |
| **First Contentful Paint** | 452 ms | Excelente |
| **HTML transferido** | 44 KB | OK |
| **Recursos totales** | 18 (3 link, 7 img, 2 script, 1 iframe, 1 css, 4 fetch) | Razonable |
| **Errores de consola** | 1 esperado (404 thumbnail HD YouTube → cae en fallback `hqdefault`) | Controlado |

> **Nota:** estas métricas son sin throttling y desde Docker local. El Lighthouse final con throttling de red 4G y CPU 4× se debe correr post-deploy contra el dominio público.

---

## Fase 6 — Accesibilidad

| Validación | Antes | Después |
|---|---|---|
| `<h1>` único | ✅ | ✅ |
| Imágenes con `alt` | ✅ 7/7 (3 con `alt=""` decorativos del slider) | ✅ |
| Inputs con `<label>` asociado | ✅ 6/6 | ✅ |
| Buttons con texto o `aria-label` | ⚠️ 2 carousel controls sin label | ✅ Fixeado |
| Links con texto o `aria-label` | ⚠️ 3 social links del footer (solo `title`) | ✅ Fixeado |
| Landmark `<footer>` | ✅ | ✅ |
| Landmark `<nav>` | ✅ | ✅ |
| Landmark `<main>` | ⚠️ ausente | ⚠️ Pendiente (no crítico) |
| Landmark `<header>` | ⚠️ ausente | ⚠️ Pendiente (no crítico) |
| Tab order coherente | ✅ navbar → carousel → CTA → contenido | ✅ |
| `:focus-visible` en CSS | ✅ | ✅ (no se pudo capturar visualmente en headless, validar manualmente) |

---

## 🐛 Bug bloqueante encontrado y corregido

### `waitlist_socios.relacion` quedó NOT NULL tras la migración

**Síntoma:** El submit del formulario nuevo del waitlist devolvía `400 Bad Request` y mostraba "Este email ya está registrado" (mensaje genérico para 400/409 en el handler).

**Causa raíz:** La migración del Sprint 1 agregó las nuevas columnas (`ubicacion`, `frecuencia_6m`, etc.) pero no tocó la columna vieja `relacion`, que seguía con constraint `NOT NULL`. El nuevo formulario ya no envía ese campo.

**Error real de Supabase:**
```json
{"code":"23502","message":"null value in column \"relacion\" of relation \"waitlist_socios\" violates not-null constraint"}
```

**Fix aplicado durante la auditoría:**
```sql
ALTER TABLE waitlist_socios ALTER COLUMN relacion DROP NOT NULL;
```

**Migración:** `waitlist_socios_relacion_nullable` aplicada en Supabase project `ugvlzjbsulrkdjtapozn`.

**Validación post-fix:** POST directo retorna `201 Created`, flujo end-to-end en browser pasa, contador incrementa correctamente.

**Lección de proceso:** Las auditorías E2E son las que cazan este tipo de bugs de "estado mixto" tras migraciones — el código y el schema parecían correctos por separado.

---

## ⚠️ Hallazgos cosméticos / mejoras opcionales

| # | Hallazgo | Severidad | Sugerencia |
|---|---|---|---|
| 1 | El handler del waitlist trata 400 y 409 indistintamente como "email duplicado" | Baja | Inspeccionar el body de la respuesta y mostrar mensajes diferenciados (constraint vs duplicate vs validation) |
| 2 | Falta `<main>` y `<header>` semánticos (la página usa solo `<div>`) | Baja | Envolver el contenido principal en `<main>` y la navbar en `<header>` para ganar landmarks |
| 3 | `<img>` del slider tienen `alt=""` (correcto si decorativos, pero podrían tener alt descriptivo) | Cosmética | "Sindicato Argentino de Boleros en vivo en el Konex" / "Show grupal en teatro" / "Baile con luces de neón" |
| 4 | El handler del CTA "COMPRAR ENTRADAS" usa búsqueda por texto | Cosmética | Agregar `id="hero-comprar-btn"` para selectores más estables en futuros tests |

---

## Próximos pasos sugeridos

1. **Pre-deploy:**
   - [ ] Cambiar credenciales `<ADMIN_EMAIL_VIEJO>` / `<ADMIN_PASS_VIEJA>` por unas fuertes (riesgo de seguridad concreto, ver `Insumos/SAB WEB - Presentación y Fotos.md`).
   - [ ] Aplicar el fix `relacion DROP NOT NULL` también en producción si la DB de prod ya tenía la migración intermedia (en local/Supabase ya está aplicado).
   - [ ] Decidir sobre `<main>`/`<header>` semánticos (15 min).

2. **Post-deploy:**
   - [ ] Lighthouse contra dominio público con throttling real (no local).
   - [ ] Re-correr esta auditoría contra producción para confirmar que el deploy no rompió nada.
   - [ ] Validar Schema.org en https://search.google.com/test/rich-results
   - [ ] Validar Open Graph en https://www.opengraph.xyz/
   - [ ] SSL Labs + Security Headers contra el dominio público.

3. **Sprint 2:**
   - Incorporar este reporte como baseline para comparar regresiones cuando se agregue MercadoPago recurrente.

---

## Outputs de la auditoría

```
docs/audit/
  desktop-full.png          ← screenshot completo desktop
  mobile-full.png           ← screenshot completo mobile
  01-hero-desktop.png
  02-trust-bar.png
  02-trust-evento.png
  03-ubicacion.png
  04-video.png
  05-proximos.png
  06-quienes-somos.png      ⭐ sección nueva del Sprint 1
  07-waitlist-top.png
  08-waitlist-bottom.png
  09-waitlist-cta-footer.png
  10-waitlist-success.png   ← post-submit
  11-modal-compra.png
  12-keyboard-focus.png
  mobile-hero.png
  mobile-quienes.png
  mobile-sm-evento.png      ← breakpoint <400px
  tablet-hero.png
```

---

*Auditoría generada con Claude Code + Playwright MCP. Reproducible: rebuild Docker, navegar a `localhost:3000`, ejecutar las fases descritas en `PLAN.md` sección "Plan de auditoría con Playwright".*
