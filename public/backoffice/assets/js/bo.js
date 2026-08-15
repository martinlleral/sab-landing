/* ============================================
   BACKOFFICE SHARED UTILS — bo.js
   ============================================ */

// ============================================
// FETCH HELPER
// ============================================
async function boFetch(url, options = {}) {
  const defaults = { credentials: 'include' };
  const res = await fetch(url, { ...defaults, ...options });

  if (res.status === 401) {
    window.location.href = '/backoffice/login.html';
    throw new Error('No autenticado');
  }

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ============================================
// AUTH
// ============================================
async function handleLogout() {
  try {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
  } catch (e) { /* ignore */ }
  window.location.href = '/backoffice/login.html';
}

async function loadCurrentUser() {
  try {
    const data = await boFetch('/api/auth/me');
    const el = document.getElementById('topbar-user');
    if (el && data.usuario) {
      el.textContent = `${data.usuario.nombre} ${data.usuario.apellido}`;
    }
  } catch (e) { /* silencioso */ }
}

// ============================================
// SIDEBAR — mostrar/ocultar (mobile)
// ============================================
// Lo dispara el botón hamburguesa de la topbar, que solo se ve abajo de 769px.
// Nada que ver con el colapso de acá abajo, que es de escritorio.
function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;
  sidebar.classList.toggle('visible');
}

// ============================================
// SIDEBAR — colapsar a íconos (desktop)
// ============================================
const BO_SIDEBAR_KEY = 'bo-sidebar-collapsed';

// Se aplica en top-level y NO dentro de DOMContentLoaded, a propósito: bo.js se
// carga al final del <body>, con el layout ya parseado, así que la clase entra
// antes del primer paint. Adentro del DOMContentLoaded el sidebar se vería
// abierto y se cerraría a la vista del usuario en cada carga de página.
(function restaurarEstadoSidebar() {
  const layout = document.querySelector('.bo-layout');
  if (!layout) return;   // login.html no tiene sidebar
  if (localStorage.getItem(BO_SIDEBAR_KEY) !== '1') return;

  // `sin-transicion` es la mitad que falta del fix del parpadeo. Poner la clase
  // antes del paint no alcanza: el <aside> ya resolvió su estilo con el ancho
  // expandido cuando el parser lo leyó, así que al cambiar la variable se
  // dispara la transición de 0.3s y el sidebar se ve ACHICÁNDOSE en cada carga
  // de página. Con la transición apagada arranca directamente angosto.
  layout.classList.add('sidebar-collapsed', 'sin-transicion');

  // Doble rAF: el primer callback corre antes del paint, el segundo después.
  // Recién ahí se devuelve la transición, para que el click del usuario sí anime.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => layout.classList.remove('sin-transicion'));
  });
})();

function toggleSidebarColapso() {
  const layout = document.querySelector('.bo-layout');
  if (!layout) return;
  const colapsado = layout.classList.toggle('sidebar-collapsed');
  localStorage.setItem(BO_SIDEBAR_KEY, colapsado ? '1' : '0');
}

// El botón y los tooltips se inyectan desde acá en vez de escribirlos a mano en
// los 8 HTML del backoffice, que tienen el <aside> duplicado tal cual.
function initSidebarColapso() {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;

  // Tooltip = el texto del propio link. Colapsado solo se ven los íconos.
  sidebar.querySelectorAll('.bo-nav-link').forEach((link) => {
    if (!link.title) link.title = link.textContent.trim();
  });

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'bo-sidebar-collapse-btn';
  btn.setAttribute('aria-label', 'Colapsar o expandir el menú lateral');
  btn.innerHTML = '<i class="bi bi-chevron-double-left"></i>';
  btn.addEventListener('click', toggleSidebarColapso);
  sidebar.appendChild(btn);
}

// ============================================
// DATE FORMAT
// ============================================
function boFecha(fechaStr) {
  if (!fechaStr) return '—';
  return new Date(fechaStr).toLocaleDateString('es-AR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

function boFechaHora(fechaStr) {
  if (!fechaStr) return '—';
  return new Date(fechaStr).toLocaleString('es-AR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function boFechaInput(fechaStr) {
  if (!fechaStr) return '';
  return new Date(fechaStr).toISOString().split('T')[0];
}

// ============================================
// PRICE FORMAT
// ============================================
function boPrecio(valor) {
  //   = non-breaking space — evita que "$ 12.000" se parta en 2 líneas
  // cuando la celda de la tabla es angosta (ver eventos-lista.html).
  return `$ ${Number(valor || 0).toLocaleString('es-AR')}`;
}

// ============================================
// ALERT HELPER
// ============================================
function boAlert(msg, type = 'error', elId = 'bo-alert') {
  const el = document.getElementById(elId);
  if (!el) return;
  el.textContent = msg;
  el.className = `bo-alert show ${type}`;
  el.style.display = 'block';
  if (type === 'success') {
    setTimeout(() => { el.style.display = 'none'; }, 4000);
  }
}

// ============================================
// CONFIRM DIALOG
// ============================================
function boConfirm(msg) {
  return window.confirm(msg);
}

// ============================================
// PAGINATION BUILDER
// ============================================
function buildPagination(container, currentPage, totalPages, onPageChange) {
  if (!container) return;
  if (totalPages <= 1) { container.innerHTML = ''; return; }

  const pages = [];
  const range = 2;
  for (let i = Math.max(1, currentPage - range); i <= Math.min(totalPages, currentPage + range); i++) {
    pages.push(i);
  }

  // Render con data-page; el handler lo enganchamos abajo. Antes el código
  // stringificaba la función entera dentro de onclick="...", lo que se rompía
  // en cuanto onPageChange tenía template strings internos (backticks anidados
  // con outer template string).
  container.innerHTML = `
    <button class="bo-page-btn" ${currentPage === 1 ? 'disabled' : ''} data-page="${currentPage - 1}">
      <i class="bi bi-chevron-left"></i>
    </button>
    ${pages.map((p) => `
      <button class="bo-page-btn ${p === currentPage ? 'active' : ''}" data-page="${p}">${p}</button>
    `).join('')}
    <button class="bo-page-btn" ${currentPage === totalPages ? 'disabled' : ''} data-page="${currentPage + 1}">
      <i class="bi bi-chevron-right"></i>
    </button>
  `;

  container.querySelectorAll('button[data-page]').forEach((btn) => {
    if (btn.disabled) return;
    btn.addEventListener('click', () => {
      const p = parseInt(btn.dataset.page, 10);
      if (Number.isFinite(p)) onPageChange(p);
    });
  });
}

// ============================================
// INIT
// ============================================
document.addEventListener('DOMContentLoaded', () => {
  loadCurrentUser();
  initSidebarColapso();
});
