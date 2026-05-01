/* ============================================
   BANDA TICKETERA — app.js
   ============================================ */

const API = {
  home: '/api/home',
  destacado: '/api/eventos/destacado',
  proximos: '/api/eventos/proximos',
  preferencia: '/api/compras/preferencia',
};

let eventoActual = null;
let eventosProximos = [];
let eventosDisponibles = [];

// Sanitización XSS — escapar HTML en datos del CMS
function esc(str) {
  if (!str) return '';
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// ============================================
// INIT
// ============================================
document.addEventListener('DOMContentLoaded', () => {
  checkPaymentReturn();
  loadAll();
});

async function loadAll() {
  await Promise.all([loadHome(), loadDestacado(), loadProximos()]);
  buildEventosDisponibles();
  wireModalCompra();
}

function buildEventosDisponibles() {
  const lista = [];
  if (eventoActual) lista.push(eventoActual);
  for (const ev of eventosProximos) {
    if (!lista.find((e) => e.id === ev.id)) lista.push(ev);
  }
  eventosDisponibles = lista;
}

// ============================================
// HOME DATA (slider, texto, video)
// ============================================
async function loadHome() {
  try {
    const data = await fetchJSON(API.home);

    const slides = ['slider1Url', 'slider2Url', 'slider3Url'].map((k) => data[k]).filter(Boolean);
    buildSlider(slides);

    const desc = document.getElementById('evento-descripcion');
    if (desc) {
      desc.textContent = data.textoEvento || '';
      desc.style.display = data.textoEvento ? '' : 'none';
    }
    // La sección "El Evento" (#descripcion) siempre se muestra — contiene ciclo,
    // viñetas, info cards, callouts y CTA. Solo el <p id="evento-descripcion">
    // se oculta si el campo "texto del evento" del backoffice está vacío.

    buildVideo(data.youtubeUrl);
    renderStats(data);
  } catch (e) {
    console.warn('loadHome error:', e.message);
  }
}

function renderStats(data) {
  // Formato de miles con punto (estándar es-AR): 20000 → "20.000"
  const fmt = (n) => Number(n || 0).toLocaleString('es-AR');

  const ediciones = data.totalEdiciones || 0;
  const shows = data.totalShows || 0;
  const personas = data.totalPersonas || 0;

  const $ed = document.getElementById('qs-stat-ediciones');
  if ($ed && ediciones > 0) $ed.textContent = ediciones;

  const $sh = document.getElementById('qs-stat-shows');
  if ($sh && shows > 0) $sh.textContent = `${shows}+`;

  const $pe = document.getElementById('qs-stat-personas');
  if ($pe && personas > 0) $pe.textContent = `+${fmt(personas)}`;

  const $trust = document.getElementById('trust-personas');
  if ($trust && personas > 0) $trust.textContent = `+${fmt(personas)} personas`;
}

function buildSlider(slides) {
  const inner = document.getElementById('carousel-inner');
  if (!inner) return;

  inner.innerHTML = '';

  if (!slides.length) {
    inner.innerHTML = `
      <div class="carousel-item active">
        <div class="slide-placeholder"></div>
      </div>`;
    return;
  }

  const SLIDER_ALTS = [
    'Sindicato Argentino de Boleros en vivo en el Patio del Konex, Buenos Aires',
    'Show grupal del Sindicato Argentino de Boleros en teatro',
    'Baile del ciclo Amor de Miércoles con luces de neón'
  ];

  slides.forEach((url, i) => {
    const item = document.createElement('div');
    item.className = `carousel-item${i === 0 ? ' active' : ''}`;
    const alt = SLIDER_ALTS[i] || 'Sindicato Argentino de Boleros en vivo';
    item.innerHTML = `<img class="slide-img" src="${esc(url)}" alt="${esc(alt)}" loading="${i === 0 ? 'eager' : 'lazy'}" fetchpriority="${i === 0 ? 'high' : 'auto'}">`;
    inner.appendChild(item);
  });
}

function buildVideo(youtubeUrl) {
  const container = document.getElementById('video-container');
  const section = document.getElementById('video');
  if (!container) return;

  if (!youtubeUrl) {
    if (section) section.style.display = 'none';
    return;
  }

  const videoId = extractYoutubeId(youtubeUrl);
  if (!videoId) {
    if (section) section.style.display = 'none';
    return;
  }

  if (section) section.style.display = '';

  // Lite embed: thumbnail + play btn; inserta iframe solo al hacer click
  const wrap = document.createElement('div');
  wrap.className = 'yt-lite';

  const img = document.createElement('img');
  img.className = 'yt-thumbnail-img';
  img.alt = 'Reproducir video';
  // Cascada de thumbs: maxresdefault (1280×720, ideal) → sddefault (640×480,
  // intermedio) → hqdefault (480×360, último recurso). Sin maxres el SD
  // queda mucho mejor en desktop que el HQ de 480px.
  const ytThumb = (res) => `https://img.youtube.com/vi/${videoId}/${res}.jpg`;
  img.src = ytThumb('maxresdefault');
  img.onload = () => {
    // Placeholder gris 120×90 devuelto como 200 cuando maxres no existe.
    if (img.naturalWidth <= 120) img.src = ytThumb('sddefault');
  };
  img.onerror = () => {
    // Si maxres falla (404), probar sd. Si sd también falla, cae a hq.
    if (img.src.endsWith('maxresdefault.jpg')) {
      img.src = ytThumb('sddefault');
    } else if (img.src.endsWith('sddefault.jpg')) {
      img.src = ytThumb('hqdefault');
    }
  };

  const btn = document.createElement('div');
  btn.className = 'yt-play-btn';
  btn.innerHTML = `<svg viewBox="0 0 68 48" width="68" height="48">
    <path d="M66.52 7.74c-.78-2.93-2.49-5.41-5.42-6.19C55.79.13 34 0 34 0S12.21.13 6.9 1.55c-2.93.78-4.63 3.26-5.42 6.19C.06 13.05 0 24 0 24s.06 10.95 1.48 16.26c.78 2.93 2.49 5.41 5.42 6.19C12.21 47.87 34 48 34 48s21.79-.13 27.1-1.55c2.93-.78 4.64-3.26 5.42-6.19C67.94 34.95 68 24 68 24s-.06-10.95-1.48-16.26z" fill="#ff0000"/>
    <path d="M45 24 27 14v20" fill="#fff"/>
  </svg>`;

  wrap.appendChild(img);
  wrap.appendChild(btn);

  wrap.addEventListener('click', () => {
    const iframeWrap = document.createElement('div');
    iframeWrap.className = 'video-wrapper';
    iframeWrap.innerHTML = `<iframe
      src="https://www.youtube.com/embed/${videoId}?autoplay=1&rel=0&modestbranding=1&playsinline=1&controls=1&fs=1&iv_load_policy=3&cc_load_policy=0&start=0&end=0"
      title="Video"
      frameborder="0"
      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
      allowfullscreen
      referrerpolicy="strict-origin-when-cross-origin">
    </iframe>`;
    container.innerHTML = '';
    container.appendChild(iframeWrap);
  });

  container.innerHTML = '';
  container.appendChild(wrap);
}

function extractYoutubeId(url) {
  const patterns = [
    /youtu\.be\/([^?&]+)/,
    /youtube\.com\/watch\?v=([^&]+)/,
    /youtube\.com\/embed\/([^?&]+)/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

// ============================================
// EVENTO DESTACADO
// ============================================
async function loadDestacado() {
  try {
    const evento = await fetchJSON(API.destacado);
    eventoActual = evento;
    renderDestacado(evento);
  } catch (e) {
    console.warn('Sin evento destacado:', e.message);
    renderDestacado(null);
  }
}

function renderDestacado(evento) {
  const elNombre = document.getElementById('hero-nombre');
  const elFecha = document.getElementById('hero-fecha');
  const elHora = document.getElementById('hero-hora');
  const elInvitado = document.getElementById('hero-invitado');
  const elInvitadoWrap = document.getElementById('hero-invitado-wrap');
  const btnComprar = document.getElementById('btn-comprar');

  const heroContent = document.getElementById('hero-content');

  if (!evento) {
    if (elNombre) elNombre.textContent = '';
    if (elFecha) elFecha.textContent = '';
    if (btnComprar) btnComprar.style.display = 'none';
    if (heroContent) heroContent.classList.add('loaded');
    return;
  }

  // Título: si el invitado aparece en el nombre, partimos en 2 líneas:
  //   "Amor de Miércoles con Leo García"
  //   →  Amor de Miércoles
  //      Invitado: <glow>Leo García</glow>
  // Cada línea en su propio <span class="hero-title-line"> con display:block
  // para que el salto sea explícito y no por word-wrap natural (pedido UX
  // del 21/4 tras ver el wrap roto en 3 líneas).
  if (elNombre) {
    if (evento.invitado && evento.nombre.includes(evento.invitado)) {
      const parts = evento.nombre.split(evento.invitado);
      // Quitar el " con " final del prefijo — ya no queda como conector
      const mainTitle = (parts[0] || '').replace(/\s+con\s*$/i, '').trim();
      const suffix = parts[1] || '';
      elNombre.innerHTML =
        '<span class="hero-title-line">' + esc(mainTitle) + '</span>' +
        '<span class="hero-title-line hero-title-guest">Invitado: <span class="hero-guest-highlight">' + esc(evento.invitado) + '</span>' + esc(suffix) + '</span>';
    } else {
      elNombre.textContent = evento.nombre;
    }
  }
  if (elFecha) elFecha.textContent = formatFecha(evento.fecha);
  if (elHora) elHora.textContent = evento.hora;
  // Ocultar "Invitado especial" si ya está en el título
  if (elInvitadoWrap) {
    const yaEnTitulo = evento.invitado && evento.nombre.includes(evento.invitado);
    elInvitadoWrap.style.display = (evento.invitado && !yaEnTitulo) ? '' : 'none';
  }
  if (elInvitado) elInvitado.textContent = evento.invitado || '';

  // Schema.org Event JSON-LD (rich snippets en Google).
  // Source of truth = tandaVigente (precio + availability). Si no hay tandaVigente,
  // caemos a la primera tanda del evento como referencia de precio y marcamos SoldOut.
  const schemaEl = document.getElementById('schema-event');
  const tandaVigente = evento.tandaVigente || null;
  const tandaRef = tandaVigente || (evento.tandas && evento.tandas[0]) || null;
  const soldOut = evento.estaAgotado || tandaVigente === null;
  if (schemaEl && evento.fecha && tandaRef) {
    const fechaISO = new Date(evento.fecha).toISOString().split('T')[0];
    const startDateTime = `${fechaISO}T${evento.hora || '21:00'}:00-03:00`;
    const schema = {
      '@context': 'https://schema.org',
      '@type': 'MusicEvent',
      'name': evento.nombre,
      'description': evento.descripcion || '',
      'startDate': startDateTime,
      'eventStatus': 'https://schema.org/EventScheduled',
      'eventAttendanceMode': 'https://schema.org/OfflineEventAttendanceMode',
      'location': {
        '@type': 'Place',
        'name': 'Espacio Doble T',
        'address': {
          '@type': 'PostalAddress',
          'streetAddress': 'Calle 23 N°565',
          'addressLocality': 'La Plata',
          'addressRegion': 'Buenos Aires',
          'addressCountry': 'AR'
        }
      },
      'performer': {
        '@type': 'MusicGroup',
        'name': 'Sindicato Argentino de Boleros'
      },
      'organizer': {
        '@type': 'Organization',
        'name': 'Sindicato Argentino de Boleros',
        'url': 'https://sindicatoargentinodeboleros.com.ar'
      },
      'offers': {
        '@type': 'Offer',
        'price': tandaRef.precio,
        'priceCurrency': 'ARS',
        'availability': soldOut ? 'https://schema.org/SoldOut' : 'https://schema.org/InStock',
        'url': 'https://sindicatoargentinodeboleros.com.ar',
        'validFrom': new Date().toISOString()
      },
      'image': evento.flyerUrl
        ? `https://sindicatoargentinodeboleros.com.ar${evento.flyerUrl}`
        : 'https://sindicatoargentinodeboleros.com.ar/assets/img/logo-sab.png'
    };
    if (evento.invitado) {
      schema.performer = [
        schema.performer,
        { '@type': 'MusicGroup', 'name': evento.invitado }
      ];
    }
    schemaEl.textContent = JSON.stringify(schema);
  }

  // Info cards en sección "El Evento"
  // La card "Cuándo" usa 2 líneas — día de la semana (ej. "Miércoles") arriba
  // y fecha corta sin año (ej. "29 de abril") debajo. La hora queda en su
  // línea como detail.
  // Precio mostrado = tandaVigente.precio. Si no hay tanda vigente, ocultamos
  // el precio (el evento no es vendible ahora).
  const precioMostrado = tandaVigente ? tandaVigente.precio : null;

  const infoDia = document.getElementById('info-dia');
  const infoFecha = document.getElementById('info-fecha');
  const infoHora = document.getElementById('info-hora');
  const infoPrecio = document.getElementById('info-precio');
  if (infoDia) infoDia.textContent = formatDiaSemana(evento.fecha);
  if (infoFecha) infoFecha.textContent = formatFechaCorta(evento.fecha);
  if (infoHora) infoHora.textContent = evento.hora + ' hs';
  if (infoPrecio) infoPrecio.textContent = precioMostrado ? `$${formatPrecio(precioMostrado)}` : '—';

  // Precio visible en hero
  const elPrecio = document.getElementById('hero-precio');
  const elPrecioWrap = document.getElementById('hero-precio-wrap');
  if (elPrecio && precioMostrado) {
    elPrecio.textContent = `$${formatPrecio(precioMostrado)}`;
  }
  if (elPrecioWrap) {
    elPrecioWrap.style.display = precioMostrado ? '' : 'none';
  }

  if (btnComprar) {
    // Orden: toggle manual → externo → sin tanda vigente → normal.
    // Externo va antes que "sin tanda" porque los eventos externos no usan tandas:
    // la venta vive en otro sitio (link de terceros).
    if (evento.estaAgotado) {
      btnComprar.textContent = 'AGOTADO';
      btnComprar.disabled = true;
    } else if (evento.esExterno && evento.linkExterno) {
      btnComprar.disabled = false;
      btnComprar.textContent = 'COMPRAR ENTRADAS';
      btnComprar.onclick = () => window.open(evento.linkExterno, '_blank');
    } else if (tandaVigente === null) {
      btnComprar.textContent = 'AGOTADO';
      btnComprar.disabled = true;
    } else {
      btnComprar.disabled = false;
      btnComprar.textContent = 'COMPRAR ENTRADAS';
    }
  }

  // La precarga del modal (nombre/fecha/flyer/precio) ahora la resuelve
  // el listener show.bs.modal en wireModalCompra() — se pobla al abrir,
  // no al cargar la página.

  // Fade-in del hero cuando todo está listo
  if (heroContent) {
    // Esperar un tick para asegurar que el DOM terminó de actualizar
    requestAnimationFrame(() => heroContent.classList.add('loaded'));
  }
}

// ============================================
// PRÓXIMOS EVENTOS
// ============================================
async function loadProximos() {
  try {
    const eventos = await fetchJSON(API.proximos);
    eventosProximos = eventos || [];
    renderProximos(eventosProximos);
  } catch (e) {
    console.warn('loadProximos error:', e.message);
    eventosProximos = [];
    renderProximos([]);
  }
}

function renderProximos(eventos) {
  const container = document.getElementById('proximos-container');
  if (!container) return;

  if (!eventos.length) {
    container.innerHTML = `<div class="no-eventos">No hay próximos eventos programados</div>`;
    return;
  }

  container.innerHTML = eventos.map((ev) => {
    const tv = ev.tandaVigente || null;
    const esExternoActivo = ev.esExterno && ev.linkExterno;
    // Eventos externos no usan tandas: la venta vive en un sitio de terceros.
    // Solo se marcan agotados cuando el admin lo pone a mano.
    const agotado = ev.estaAgotado || (!esExternoActivo && tv === null);
    const precioMostrado = tv ? tv.precio : null;
    const imgTag = ev.flyerUrl
      ? `<img src="${esc(ev.flyerUrl)}" alt="${esc(ev.nombre)}" class="evento-card-img">`
      : `<img src="/assets/img/event-default.jpg" alt="${esc(ev.nombre)}" class="evento-card-img evento-card-img--default">`;
    const overlay = agotado
      ? `<div class="evento-card-agotado-overlay" aria-hidden="true"><span>AGOTADO</span></div>`
      : '';
    const boton = agotado
      ? `<button type="button" class="btn-comprar-card" disabled aria-disabled="true">
           <i class="bi bi-x-circle me-1"></i> Agotado
         </button>`
      : `<button type="button" class="btn-comprar-card" data-bs-toggle="modal" data-bs-target="#modalCompra" data-evento-id="${ev.id}">
           <i class="bi bi-ticket-perforated me-1"></i> Comprar
         </button>`;
    const precioLinea = precioMostrado
      ? `<div class="evento-card-precio">$ ${formatPrecio(precioMostrado)}</div>`
      : '';
    return `
    <div class="col-md-4 mb-4">
      <div class="evento-card${agotado ? ' evento-card--agotado' : ''}">
        <div class="evento-card-img-wrap">
          ${imgTag}
          ${overlay}
        </div>
        <div class="evento-card-body">
          <div class="evento-card-nombre">${esc(ev.nombre)}</div>
          <div class="evento-card-fecha">📅 ${formatFecha(ev.fecha)} — ${esc(ev.hora)}</div>
          ${precioLinea}
          ${boton}
        </div>
      </div>
    </div>`;
  }).join('');
}

// ============================================
// MODAL DE COMPRA
// ============================================

// Wirea el listener show.bs.modal una sola vez tras loadAll. El evento
// relatedTarget expone el botón que disparó el modal — si trae data-evento-id,
// pre-seleccionamos ese evento; si no, cae al destacado (eventoActual).
function wireModalCompra() {
  const modalEl = document.getElementById('modalCompra');
  if (!modalEl || modalEl.dataset.wired === '1') return;
  modalEl.dataset.wired = '1';

  const select = document.getElementById('modal-evento-select');
  if (select) select.addEventListener('change', onEventoSeleccionadoChange);

  modalEl.addEventListener('show.bs.modal', (event) => {
    const trigger = event.relatedTarget;
    const rawId = trigger?.dataset?.eventoId;
    const idRequested = rawId ? Number(rawId) : (eventoActual ? eventoActual.id : null);
    populateModalEventoSelect(idRequested);
    onEventoSeleccionadoChange();
    // Reset del segundo campo de email — sino mantiene valor de compra anterior.
    const confirmEl = document.getElementById('modal-email-confirm');
    if (confirmEl) confirmEl.value = '';
    onEmailChange();
  });
}

// Feedback visual del match de emails. No bloquea inputs, solo informa al
// usuario en vivo si los dos campos coinciden o no.
function onEmailChange() {
  const email = (document.getElementById('modal-email')?.value || '').trim();
  const confirm = (document.getElementById('modal-email-confirm')?.value || '').trim();
  const hint = document.getElementById('modal-email-match');
  if (!hint) return;

  if (!email && !confirm) {
    hint.textContent = '';
    hint.style.color = '';
    return;
  }
  if (!confirm) {
    hint.textContent = '';
    return;
  }
  if (email.toLowerCase() === confirm.toLowerCase()) {
    hint.innerHTML = '<i class="bi bi-check-circle-fill"></i> Los emails coinciden';
    hint.style.color = '#48bb78';
  } else {
    hint.innerHTML = '<i class="bi bi-exclamation-triangle-fill"></i> Los emails no coinciden';
    hint.style.color = '#fc8181';
  }
}
window.onEmailChange = onEmailChange;

function populateModalEventoSelect(selectedId) {
  const select = document.getElementById('modal-evento-select');
  if (!select) return;
  if (!eventosDisponibles.length) {
    select.innerHTML = '<option value="">No hay eventos disponibles</option>';
    return;
  }
  // Solo el nombre en el option — la fecha/hora queda en la "reflex box"
  // debajo del select (#modal-evento-nombre + #modal-evento-fecha) para
  // no duplicar la misma info en el mismo modal.
  select.innerHTML = eventosDisponibles.map((ev) => {
    return `<option value="${ev.id}">${esc(ev.nombre)}</option>`;
  }).join('');
  if (selectedId != null) select.value = String(selectedId);
  // Si el id pedido ya no existe (ej. evento borrado entre render y click),
  // el browser deja la primera opción seleccionada — suficiente.
}

function getEventoSeleccionado() {
  const select = document.getElementById('modal-evento-select');
  const id = select ? Number(select.value) : null;
  if (!id) return null;
  return eventosDisponibles.find((ev) => ev.id === id) || null;
}

function onEventoSeleccionadoChange() {
  const ev = getEventoSeleccionado();
  const nombreEl = document.getElementById('modal-evento-nombre');
  const fechaEl = document.getElementById('modal-evento-fecha');
  const precioEl = document.getElementById('modal-precio-unit');
  const flyerWrap = document.getElementById('modal-flyer-wrap');
  const flyerImg = document.getElementById('modal-flyer');

  if (!ev) {
    if (nombreEl) nombreEl.textContent = '—';
    if (fechaEl) fechaEl.textContent = '—';
    if (precioEl) precioEl.value = 0;
    if (flyerWrap) flyerWrap.style.display = 'none';
    updateTotal();
    updateBtnPagarState(null);
    return;
  }

  if (nombreEl) nombreEl.textContent = ev.nombre;
  if (fechaEl) fechaEl.textContent = `${formatFecha(ev.fecha)} — ${ev.hora}`;
  // El precio del modal es el de la tanda vigente (la que el backend va a cobrar).
  // Si no hay vigente, queda en 0 y el botón queda disabled por updateBtnPagarState.
  if (precioEl) precioEl.value = (ev.tandaVigente && ev.tandaVigente.precio) || 0;
  if (flyerWrap && flyerImg) {
    if (ev.flyerUrl) {
      flyerImg.src = ev.flyerUrl;
      flyerWrap.style.display = 'block';
    } else {
      flyerWrap.style.display = 'none';
    }
  }
  updateTotal();
  updateBtnPagarState(ev);
}

// Ajusta el botón "VAMOS" del modal según el estado del evento seleccionado.
// 3 casos: externo (linkExterno) | agotado | normal. Antes esto vivía en el
// btn-comprar del hero; al unificar el CTA el modal es el único flujo.
function updateBtnPagarState(ev) {
  const btn = document.getElementById('btn-pagar');
  if (!btn) return;
  const label = btn.querySelector('.btn-pagar-label');

  // Limpiar estado previo
  btn.disabled = false;
  btn.onclick = null;

  if (!ev) {
    btn.disabled = true;
    if (label) label.textContent = 'VAMOS';
    return;
  }

  // Orden: toggle manual → externo → sin tanda vigente → normal.
  // Los eventos externos no usan tandas, por eso van antes del check de tanda vigente.
  if (ev.estaAgotado) {
    if (label) label.textContent = 'AGOTADO';
    btn.disabled = true;
    return;
  }

  if (ev.esExterno && ev.linkExterno) {
    if (label) label.textContent = 'VER ENTRADAS';
    btn.onclick = () => window.open(ev.linkExterno, '_blank', 'noopener');
    return;
  }

  if (!ev.tandaVigente) {
    if (label) label.textContent = 'AGOTADO';
    btn.disabled = true;
    return;
  }

  if (label) label.textContent = 'VAMOS';
  btn.onclick = () => handleComprar();
}

function updateTotal() {
  const cantSelect = document.getElementById('modal-cantidad');
  const precioInput = document.getElementById('modal-precio-unit');
  const totalEl = document.getElementById('modal-total');

  if (!cantSelect || !precioInput || !totalEl) return;

  const cant = parseInt(cantSelect.value) || 1;
  const precio = parseInt(precioInput.value) || 0;
  const total = cant * precio;
  totalEl.textContent = `$ ${formatPrecio(total)}`;
}

document.addEventListener('change', (e) => {
  if (e.target && e.target.id === 'modal-cantidad') {
    updateTotal();
  }
});

async function handleComprar() {
  const evento = getEventoSeleccionado();
  if (!evento) {
    showModalError('Seleccioná un evento antes de continuar.');
    return;
  }

  const nombre = document.getElementById('modal-nombre').value.trim();
  const apellido = document.getElementById('modal-apellido').value.trim();
  const email = document.getElementById('modal-email').value.trim();
  const emailConfirm = (document.getElementById('modal-email-confirm')?.value || '').trim();
  const telefono = document.getElementById('modal-telefono').value.trim();
  const cantidad = parseInt(document.getElementById('modal-cantidad').value);

  if (!nombre || !apellido || !email || !emailConfirm || !cantidad) {
    showModalError('Por favor completá todos los campos obligatorios.');
    return;
  }

  if (!isValidEmail(email)) {
    showModalError('Ingresá un email válido.');
    return;
  }

  if (email.toLowerCase() !== emailConfirm.toLowerCase()) {
    showModalError('Los emails no coinciden. Verificá que estén bien escritos.');
    return;
  }

  const btn = document.getElementById('btn-pagar');
  const spinner = document.getElementById('pagar-spinner');
  const errorEl = document.getElementById('modal-error');

  btn.disabled = true;
  if (spinner) spinner.style.display = 'inline-block';
  if (errorEl) errorEl.style.display = 'none';

  try {
    const result = await fetchJSON(API.preferencia, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventoId: evento.id,
        email,
        nombre,
        apellido,
        telefono,
        cantidad,
      }),
    });

    if (result.init_point) {
      window.location.href = result.init_point;
    } else {
      throw new Error('No se recibió link de pago');
    }
  } catch (err) {
    showModalError(err.message || 'Error al procesar el pago. Intentá de nuevo.');
    btn.disabled = false;
    if (spinner) spinner.style.display = 'none';
  }
}

function showModalError(msg) {
  const el = document.getElementById('modal-error');
  if (el) {
    el.textContent = msg;
    el.style.display = 'block';
  }
}

// ============================================
// RETORNO DESDE MERCADO PAGO
// ============================================
async function checkPaymentReturn() {
  const params = new URLSearchParams(window.location.search);
  const status = params.get('status');
  const preferenciaId = params.get('preference_id');

  if (!status) return;

  const mainContent = document.getElementById('main-content');
  const statusSection = document.getElementById('pago-status');

  if (mainContent) mainContent.style.display = 'none';
  if (statusSection) statusSection.style.display = 'flex';

  renderPaymentStatus(status, preferenciaId);

  // Si el pago fue aprobado, llamar al backend para procesar y enviar email
  if (status === 'approved' && preferenciaId) {
    try {
      await fetch(`/api/compras/check/${preferenciaId}`, { method: 'POST' });
    } catch (e) {
      console.warn('checkAndProcess error:', e.message);
    }
  }

  // Limpiar URL
  window.history.replaceState({}, document.title, '/');
}

function renderPaymentStatus(status, preferenciaId) {
  const container = document.getElementById('pago-status-content');
  if (!container) return;

  const states = {
    approved: {
      icon: '🎉',
      title: '¡Tu compra fue recibida!',
      color: '#48bb78',
      html: `
        <p class="pago-status-msg">
          ¡Muchas gracias por tu compra! Tu pago fue <strong>aprobado con éxito</strong>.
        </p>
        <div style="background:#0d2b1a;border:1px solid #2d5a27;border-radius:10px;padding:20px 24px;margin:20px 0;text-align:left;max-width:440px;margin-left:auto;margin-right:auto;">
          <div style="font-size:1rem;font-weight:700;color:#48bb78;margin-bottom:12px;">📧 ¿Qué pasa ahora?</div>
          <ul style="color:#ccc;font-size:.92rem;line-height:1.8;padding-left:20px;margin:0;">
            <li>En los <strong>próximos minutos</strong> vas a recibir un email con tus entradas y los códigos QR.</li>
            <li>Cada código QR es personal e intransferible.</li>
            <li>Presentá el QR en la puerta del evento desde tu celular o impreso.</li>
          </ul>
        </div>
        <div style="background:#1e1a0a;border:1px solid #6b4c00;border-radius:8px;padding:12px 16px;margin:0 auto 20px;max-width:440px;font-size:.85rem;color:#f6c90e;">
          ⚠️ <strong>¿No ves el email?</strong> Revisá tu carpeta de <strong>Correo no Deseado</strong> o <em>Spam</em>. A veces los correos automáticos caen ahí.
        </div>`,
    },
    pending: {
      icon: '⏳',
      title: 'Pago en proceso',
      color: '#f6c90e',
      html: `
        <p class="pago-status-msg">
          Tu pago está siendo procesado por Mercado Pago. Una vez confirmado, recibirás tus entradas por email.
        </p>
        <p style="color:#888;font-size:.85rem;">Esto puede demorar unos minutos. No es necesario que hagas nada más.</p>`,
    },
    rejected: {
      icon: '❌',
      title: 'Pago rechazado',
      color: '#fc8181',
      html: `
        <p class="pago-status-msg">
          No pudimos procesar tu pago. Podés intentarlo nuevamente con otro medio de pago.
        </p>
        <p style="color:#888;font-size:.85rem;">Si el problema persiste, contactanos.</p>`,
    },
  };

  const s = states[status] || states.pending;

  container.innerHTML = `
    <div class="pago-status-card">
      <div class="pago-status-icon">${s.icon}</div>
      <div class="pago-status-title" style="color:${s.color}">${s.title}</div>
      ${s.html}
      <a href="/" class="btn-comprar" style="text-decoration:none; display:inline-block; margin-top:8px;">
        VOLVER AL INICIO
      </a>
    </div>`;
}

// ============================================
// HELPERS
// ============================================
async function fetchJSON(url, options = {}) {
  const res = await fetch(url, options);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function formatFecha(fechaStr) {
  // Forzar UTC para evitar que el timezone local mueva el día
  const str = new Date(fechaStr).toLocaleDateString('es-AR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// Solo el día de la semana — ej. "Miércoles"
function formatDiaSemana(fechaStr) {
  const str = new Date(fechaStr).toLocaleDateString('es-AR', {
    weekday: 'long',
    timeZone: 'UTC',
  });
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// Fecha corta sin año — ej. "29 de abril"
function formatFechaCorta(fechaStr) {
  return new Date(fechaStr).toLocaleDateString('es-AR', {
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  });
}

function formatPrecio(valor) {
  return Number(valor).toLocaleString('es-AR');
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Exponer handleComprar globalmente para el onclick del botón
window.handleComprar = handleComprar;
window.updateTotal = updateTotal;
