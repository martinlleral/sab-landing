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
// SIDEBAR TOGGLE
// ============================================
function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;
  sidebar.classList.toggle('visible');
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
  return `$ ${Number(valor || 0).toLocaleString('es-AR')}`;
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

  container.innerHTML = `
    <button class="bo-page-btn" ${currentPage === 1 ? 'disabled' : ''} onclick="(${onPageChange})(${currentPage - 1})">
      <i class="bi bi-chevron-left"></i>
    </button>
    ${pages.map((p) => `
      <button class="bo-page-btn ${p === currentPage ? 'active' : ''}" onclick="(${onPageChange})(${p})">${p}</button>
    `).join('')}
    <button class="bo-page-btn" ${currentPage === totalPages ? 'disabled' : ''} onclick="(${onPageChange})(${currentPage + 1})">
      <i class="bi bi-chevron-right"></i>
    </button>
  `;
}

// ============================================
// INIT
// ============================================
document.addEventListener('DOMContentLoaded', () => {
  loadCurrentUser();
});
