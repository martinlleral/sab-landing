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

**Archivo:** `nginx/app.conf` (HTTP-only, default) y `nginx/app-ssl.conf` (producción con SSL)

- `server_name _` en `app.conf` → cambiar a tu dominio (ej: `server_name orquesta.ar www.orquesta.ar;`)
- `server_name sindicatoargentinodeboleros.com.ar ...` en `app-ssl.conf` → cambiar ambas ocurrencias a tu dominio

**Sobre el `set_real_ip_from` y `real_ip_header CF-Connecting-IP`:** solo sirve si usás Cloudflare como proxy. Si **no** usás Cloudflare (ej. ponés el droplet con IP directa sin CDN), podés quitar el bloque entero — son ~25 líneas al inicio de cada archivo. Sin eso, `$remote_addr` va a ser la IP real del visitante directamente, que es lo correcto sin proxy intermedio.

### 14. Docker Compose — nombre del container y memory limits

**Archivo:** `docker-compose.yml`

- `container_name: sab-app` → cambiá a algo con el nombre de tu proyecto (ej: `orquesta-app`)
- `container_name: sab-nginx` → idem (ej: `orquesta-nginx`)
- Ajustar `memory` limits si tu droplet tiene más o menos RAM que 512MB

---

## SSL en producción — Cloudflare Origin Certificate (recomendado)

El repo trae `docker-compose.yml` (HTTP-only, funciona out-of-the-box para dev local) + `docker-compose.prod.yml` (override opt-in para producción con SSL). Así podés clonar y correr `docker compose up -d` sin configurar nada de certificados, y cuando quieras activar HTTPS usás ambos archivos.

**Requiere:**
- Cuenta Cloudflare con el dominio activo (plan Free alcanza)
- Cloudflare proxy activado sobre el registro A del dominio (ícono naranja, no gris)

**Pasos:**

1. **Generar el Origin Certificate en Cloudflare:**
   - Panel Cloudflare → SSL/TLS → Origin Server → **Create Certificate**
   - Type: **ECC** (más moderno, rápido; RSA también sirve si preferís compatibilidad amplia)
   - Validez: **15 years** (cuanto más largo, menos mantenimiento — es un cert de uso interno CF↔droplet, no de cara al público)
   - Hostnames: `tudominio.com` y `*.tudominio.com`
   - Create → Cloudflare te muestra dos bloques: **Origin Certificate** y **Private key**. **Se muestran una sola vez.** Copiá ambos.

2. **Instalar los certificados en el droplet:**

   ```bash
   ssh usuario@tu.droplet
   sudo mkdir -p /etc/ssl/cloudflare
   sudo chown $USER:$USER /etc/ssl/cloudflare

   nano /etc/ssl/cloudflare/cert.pem
   # (pegar el contenido del "Origin Certificate")
   # Ctrl+O → Enter → Ctrl+X

   nano /etc/ssl/cloudflare/key.pem
   # (pegar el contenido del "Private Key")
   # Ctrl+O → Enter → Ctrl+X

   chmod 644 /etc/ssl/cloudflare/cert.pem
   chmod 600 /etc/ssl/cloudflare/key.pem

   # Verificar que el cert es válido
   openssl x509 -in /etc/ssl/cloudflare/cert.pem -noout -subject -issuer -dates
   # Esperado: issuer=...CloudFlare Origin... notAfter=<fecha 15 años en el futuro>
   ```

3. **Arrancar el stack con SSL:**

   ```bash
   cd /opt/sab/app    # o donde tengas el código
   docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
   ```

   El override hace 3 cosas:
   - Abre puerto 443
   - Monta `app-ssl.conf` en vez de `app.conf` (redirect HTTP→HTTPS + bloque SSL)
   - Monta el directorio `/etc/ssl/cloudflare` en el container nginx (read-only)

4. **Cambiar el SSL mode de Cloudflare a "Full (strict)":**
   - Panel Cloudflare → SSL/TLS → Overview → **Full (strict)**
   - Con strict, Cloudflare valida el Origin Certificate contra su propia CA antes de proxear. Si el cert no es válido (o venció), CF devuelve 526. Protección máxima.

5. **Validar end-to-end:**

   ```bash
   # Desde afuera, tiene que dar HTTP/2 200:
   curl -I https://tudominio.com/

   # El redirect HTTP→HTTPS:
   curl -I http://tudominio.com/        # debería dar 301 Moved Permanently

   # El cert que muestra el dominio es el Universal SSL de Cloudflare (Let's Encrypt):
   echo | openssl s_client -connect tudominio.com:443 -servername tudominio.com 2>/dev/null | openssl x509 -noout -issuer
   # issuer=Let's Encrypt
   ```

**Alternativa: Let's Encrypt con certbot.** Si no querés usar Cloudflare (o querés un cert emitido por una CA pública, visible desde afuera), podés correr certbot en el droplet. Requiere puerto 80 abierto al mundo para el challenge ACME, y renovación automática cada 90 días. Los paths de `ssl_certificate` en `app-ssl.conf` se cambian a `/etc/letsencrypt/live/tudominio.com/fullchain.pem` y `privkey.pem`. No está cubierto en este repo; ver [docs de certbot](https://certbot.eff.org/).

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
