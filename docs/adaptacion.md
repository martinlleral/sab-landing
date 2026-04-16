# Adaptar este código a otra cooperativa

Esta guía asume que sos parte de una orquesta, banda, ensamble, coro o colectivo musical cooperativo, y querés usar este código como base para tu propia ticketera + landing + waitlist. Si sos parte de otro tipo de proyecto cultural (cine, teatro, editorial, feria) también funciona — hay que cambiar un poco más de copy, pero la arquitectura aplica.

El código está hecho para **reemplazar plataformas como Passline o Eventbrite** en ciclos recurrentes pequeños (hasta ~100 entradas por show, sin necesidad de backoffice de 200 roles). Si tu escala es mayor, probablemente necesitás algo más robusto.

## Antes de forkear — decisiones a tomar

1. **¿Ya tenés MercadoPago del proyecto?** Si no, abrí cuenta **a nombre del colectivo**, no a nombre de un socio individual. Esa cuenta va a recibir la plata de las entradas.
2. **¿Tenés dominio propio?** Podés usar `.com.ar` (NIC.ar), `.com`, `.org`, lo que sea. Si no tenés, se puede usar un subdominio de Cloudflare Pages o Vercel gratis, pero para vender entradas recomiendo un dominio propio.
3. **¿Tenés cuenta Gmail o Brevo del colectivo?** Para los mails de confirmación de compra con los QR. No uses tu cuenta personal.
4. **¿Tenés un servidor / DigitalOcean / VPS?** El stack corre en un droplet de USD 4/mes. Si no querés administrar un server, podés migrar el front a Cloudflare Pages y el backend a un PaaS como Railway o Fly.io — va a requerir adaptaciones al deploy.
5. **¿Quién va a ser el admin del backoffice?** Una sola persona con poder de decisión operativa. No 20 músicos.

Si contestás "sí" a 1, 2, 3 y 5, podés forkear. El servidor (punto 4) es el más negociable.

---

## Checklist de adaptación — 12 puntos concretos

Cada punto indica el archivo y el qué cambiar. Hacelo de arriba abajo, **commiteá después de cada uno** para que puedas revertir si algo rompe.

### 1. Nombre del proyecto

**Archivos:**

- `package.json:2` → cambiar `"name": "banda-ticketera"` por el slug de tu proyecto (ej: `"orquesta-rosario-ticketera"`)
- `README.md:1` → `# SAB Landing` → el título del tuyo
- `LICENSE` → reemplazar `"Sindicato Argentino de Boleros"` y `"Martín Lleral"` por la entidad legal de tu proyecto. **Dejá la mención a Luciano Menez en los créditos** — el código original es suyo, y la MIT License lo exige.

### 2. Título + descripción de la página

**Archivo:** `public/index.html`

- `<title>` → cambiá el título del sitio
- `<meta name="description">` → descripción en 1-2 líneas
- `<meta property="og:title">`, `og:description`, `og:url`, `og:image` → metadatos de preview para WhatsApp/Facebook
- `<meta name="twitter:title">`, `twitter:description`, `twitter:image` → Twitter Card
- **Todos los textos del body** — hero, "Quiénes somos", footer, waitlist. Cambialos para tu proyecto. Usá `grep -n "Sindicato\|boleros\|SAB\|Amor de Miércoles"` para encontrar ocurrencias.

### 3. Schema.org MusicGroup (SEO importante)

**Archivo:** `public/index.html`, buscá `<script type="application/ld+json">` (hay dos: uno estático para el grupo, uno dinámico para el evento destacado).

El primero tiene un `@type: MusicGroup` con:

- `"name"` — nombre del proyecto
- `"foundingLocation"` — ciudad donde se formaron
- `"sameAs"` — array de URLs a tus perfiles (Instagram, Spotify, YouTube, Bandcamp)
- `"genre"` — género musical

El segundo (`id="schema-event"`) se rellena dinámicamente desde la DB con el evento destacado — no hace falta tocarlo si usás el backoffice para cargar eventos.

**Validación después del cambio:** [Google Rich Results Test](https://search.google.com/test/rich-results) con la URL de tu landing.

### 4. Colores + tipografía

**Archivo:** `public/assets/css/app.css`

- Paleta actual: fondo oscuro `#0a0a0a`, texto `#e8e8e8`, acento carmín `#c33149` + carmín claro `#e0566a`, dorado `#d4af37`. Todo en el top del archivo como variables CSS `--color-*`.
- Tipografía actual: Playfair Display (serif para títulos) + Inter (sans para cuerpo), cargadas desde Google Fonts en `public/index.html`.
- Si cambiás la paleta, chequeá contraste en [webaim.org/resources/contrastchecker](https://webaim.org/resources/contrastchecker/) — buscá WCAG AA mínimo (4.5:1 para texto normal, 3:1 para texto grande).

### 5. Logo, favicon, og:image

**Archivos en `public/assets/img/`:**

- `logo-sab.png` → reemplazá por tu logo (PNG transparente, ~500×500px)
- Favicon (usado en el `<link rel="icon">` de index.html) → reemplazá con el tuyo
- `og-image.jpg` → 1200×630px, con el logo + un slogan. Se usa en previews de WhatsApp/Facebook/Twitter.

Las referencias a los paths están en `public/index.html` — `grep -n "logo-sab\|og-image"`.

### 6. Fotos del slider del hero

**Archivos en `public/assets/img/`:**

- `slider1.png`, `slider2.png`, `slider3.png` → 3 fotos horizontales (idealmente 1920×1080 o 1600×900) de tu proyecto en vivo
- `sab-grupal.jpg` → foto grupal para "Quiénes somos"
- `event-default.jpg` → fallback para eventos sin flyer propio (usa overlay "PRÓXIMAMENTE")

**Optimización:** antes de commitear, bajar cada imagen a <300KB con [squoosh.app](https://squoosh.app) o `cwebp -q 80`. El sitio actual arranca en FCP 452ms gracias a esto.

### 7. Configuración de `.env` — variables del backend

**Archivo:** `.env` (copiar de `.env.example`, NO commitear)

- `BASE_URL` → tu dominio en producción (ej: `https://orquesta.ar`)
- `MP_ACCESS_TOKEN` + `MP_PUBLIC_KEY` → panel MP del proyecto → Tus integraciones → Credenciales de producción
- `MP_WEBHOOK_SECRET` → panel MP → Webhooks → Configurar → Clave secreta (activar la firma del webhook). **Sin esto, el webhook rechaza todo.**
- `MP_USER_ID` → panel MP → Tu perfil → User ID (número)
- `SMTP_USER` + `SMTP_PASS` → Gmail App Password o credencial Brevo
- `EMAIL_FROM` → mail del proyecto, no personal
- `ADMIN_EMAIL` + `ADMIN_PASS` → credencial bootstrap del admin, rotar después del primer login
- `SESSION_SECRET` → generar con `openssl rand -hex 32`

### 8. Redes sociales + links del footer

**Archivo:** `public/index.html`, buscá la sección `<footer>`.

Cambiá los `<a href="https://www.instagram.com/..." >` a tus perfiles reales. También el link a Spotify, YouTube, Bandcamp si los tenés. **Quitá los que no aplican** — un footer con links rotos baja la confianza.

### 9. Mapa de ubicación + dirección

**Archivo:** `public/index.html`, buscá `google.com/maps` o `<iframe src="https://www.google.com/maps`.

- Cambiá el `<iframe>` con el embed de Google Maps de tu lugar habitual de show. En Google Maps → Compartir → Insertar un mapa → copiar el iframe.
- Cambiá el texto con la dirección escrita (calle, número, ciudad, referencia).

Si el proyecto no tiene un lugar fijo, podés quitar la sección entera o reemplazarla por un texto tipo "Shows en distintas salas — seguinos en Instagram para fechas y ubicaciones".

### 10. Eventos de ejemplo en el seed

**Archivo:** `prisma/seed.js`

El seed crea eventos de ejemplo que se ven en dev. Cambiá los nombres, fechas y precios por los tuyos, o vaciá el array si preferís cargar todo desde el backoffice post-deploy.

### 11. Credenciales MP + webhook → coordinar con MercadoPago

1. Panel MP del proyecto → Tus integraciones → **Crear aplicación** → tipo "Checkout Pro"
2. Copiar `Access Token` y `Public Key` al `.env`
3. Panel MP → Webhooks → Configurar notificaciones:
   - URL de notificación: `https://tudominio.com/api/compras/webhook`
   - Eventos: **Payments**
   - Activar "Clave secreta" → copiar el valor a `MP_WEBHOOK_SECRET`
4. Copiar tu `User ID` (panel MP → arriba a la derecha, número largo) al `MP_USER_ID`

**Testear el webhook:** Panel MP → Webhooks → Simulación → hacer un POST de prueba. Debería devolver 200 si la firma es válida, 401 si es inválida.

### 12. Textos del mail de confirmación + copy del evento

**Archivos:**

- `src/services/brevo.service.js` → el HTML template del mail que se envía con las entradas. Cambiá el asunto, el saludo, el footer, los links.
- `public/index.html` — textos de los CTA, copy de la sección "Sumate" (waitlist), labels del formulario de compra, mensajes de estado post-pago (approved/pending/rejected).

**Tono recomendado:** cálido pero concreto. "Ya estás adentro, nos vemos el viernes" > "Su compra ha sido procesada exitosamente".

---

### 13. Nginx config — dominio del reverse proxy

**Archivo:** `nginx/app.conf`

- `server_name _` → cambiar a tu dominio (ej: `server_name orquesta.ar www.orquesta.ar;`)
- Cuando tengas SSL, renombrar `nginx/app-ssl.conf` a `nginx/app.conf` y ajustar los paths de los certificados Let's Encrypt al nuevo dominio

### 14. Docker Compose — nombre del container y memory limits

**Archivo:** `docker-compose.yml`

- `container_name: sab-app` → cambiá a algo con el nombre de tu proyecto (ej: `orquesta-app`)
- `container_name: sab-nginx` → idem (ej: `orquesta-nginx`)
- Ajustar `memory` limits si tu droplet tiene más o menos RAM que 512MB

---

## Post-adaptación — qué validar antes de lanzar

1. **Flujo end-to-end en staging:** crear preferencia → pagar con cuenta de test de MP → recibir mail → validar QR en la puerta (el backoffice tiene lector de QR).
2. **Mobile:** abrir el sitio en el celular de 3 personas distintas antes de publicarlo. Es más importante que cualquier auditoría técnica.
3. **Lighthouse:** DevTools → Lighthouse → Performance/Accessibility/Best Practices/SEO. Buscá ≥90 en todas, especialmente Accessibility.
4. **Rich Results Test:** [search.google.com/test/rich-results](https://search.google.com/test/rich-results) con tu URL. Debería detectar MusicGroup y MusicEvent.
5. **OpenGraph:** [opengraph.xyz](https://www.opengraph.xyz/) para ver cómo se ve el preview en WhatsApp.
6. **Waitlist:** probar desde un celular, con tildes, nombres largos, emails válidos e inválidos. Confirmar que los datos llegan a Supabase.
7. **Mail de confirmación:** comprar una entrada real de prueba. Verificar que el mail no cae en spam. Si cae, configurá SPF/DKIM/DMARC — ver `docs/runbook-deploy.md`.

---

## ¿Necesitás ayuda?

Abrí un [issue](https://github.com/martinlleral/sab-landing/issues/new) con el label `adaptar-a-mi-cooperativa` contando tu proyecto, y coordinamos. No cobramos por orientar el fork — para eso hacemos open source, y para eso Lucho compartió el código original.

Si tu caso es más complejo y necesitás implementación, también podemos hablar — pero los forks simples los solemos dar una mano gratis, como mentoreo abierto.
