/* ============================================================================
   REPORTE PÚBLICO POR EVENTO (#9) — solo lectura, sin sesión.
   ----------------------------------------------------------------------------
   Reusa la lógica de render de reportes.js (backoffice) pero:
   - Lee el token del path (/reporte/<token>) y llama /api/reporte/<token>/* sin
     cookies.
   - Solo las 4 secciones estrictamente por-evento (resumen, timeline, tandas,
     cadencia). No expone datos de otros eventos.
   - Si el token es inválido/expirado, muestra un estado de error limpio.
   No referencia bo.js/reportes.js: viven bajo /backoffice/ (guarded). Se duplica
   el subconjunto necesario a propósito.
   ============================================================================ */

const COLOR = {
  vendidas: '#f6c90e',
  invitaciones: '#90cdf4',
  recaudado: '#48bb78',
};

// Defaults Chart.js (modo oscuro) — idénticos al backoffice.
Chart.defaults.color = '#aaa';
Chart.defaults.font.family = "'Inter', -apple-system, BlinkMacSystemFont, sans-serif";
Chart.defaults.font.size = 11;
Chart.defaults.borderColor = '#2a2a2a';

const charts = {};
function destroyChart(id) { if (charts[id]) { charts[id].destroy(); delete charts[id]; } }

function fmtPesos(v) {
  if (v === null || v === undefined) return '—';
  return '$ ' + Number(v).toLocaleString('es-AR');
}
function fmtPct(v) {
  if (v === null || v === undefined) return '—';
  return v.toFixed(1).replace(/\.0$/, '') + '%';
}
function fmtFechaCorta(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' });
}
function fmtFechaLarga(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('es-AR', { day: '2-digit', month: 'long', year: 'numeric' });
}

// El token es el último segmento del path: /reporte/<token>
function getToken() {
  const parts = location.pathname.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}
const TOKEN = getToken();

let granularidad = 'dia';

function mostrarError(msg) {
  document.getElementById('estado-carga').style.display = 'none';
  document.getElementById('reporte-contenido').style.display = 'none';
  if (msg) document.getElementById('estado-error-msg').textContent = msg;
  document.getElementById('estado-error').style.display = 'flex';
}

// Fetch al API público (sin credentials — no hay sesión). Cualquier respuesta
// !ok lanza, para que el caller corte y muestre el estado de error.
async function fetchReporte(path) {
  const res = await fetch(`/api/reporte/${encodeURIComponent(TOKEN)}${path}`);
  if (!res.ok) {
    const e = new Error(`HTTP ${res.status}`);
    e.status = res.status;
    throw e;
  }
  return res.json();
}

// ============================================
// META (valida token + encabezado)
// ============================================
async function cargarMeta() {
  const data = await fetchReporte('/meta');
  document.getElementById('reporte-evento').textContent = data.evento.nombre;
  const hora = data.evento.hora ? ` · ${data.evento.hora} hs` : '';
  document.getElementById('reporte-fecha').textContent = fmtFechaLarga(data.evento.fecha) + hora;
  document.getElementById('reporte-expira').textContent = data.expiraEn ? fmtFechaLarga(data.expiraEn) : '—';
}

// ============================================
// RESUMEN
// ============================================
async function cargarResumen() {
  const data = await fetchReporte('/resumen');
  document.getElementById('r-vendidas').textContent = data.entradas.vendidas;
  document.getElementById('r-invitaciones').textContent = data.entradas.invitaciones;
  document.getElementById('r-pendientes').textContent = data.compras.pendientes;
  document.getElementById('r-recaudado').textContent = fmtPesos(data.recaudado.total);
  document.getElementById('r-aporte').textContent = fmtPesos(data.recaudado.aporteExtra);
  document.getElementById('r-con-aporte').textContent = data.compras.conAporte;
  document.getElementById('r-asistencia').textContent = fmtPct(data.asistenciaPct);
}

// ============================================
// VENTAS EN EL TIEMPO
// ============================================
async function cargarTimeline() {
  const data = await fetchReporte(`/ventas-timeline?granularidad=${granularidad}`);
  const empty = document.getElementById('chart-timeline-empty');
  destroyChart('timeline');
  if (!data.data.length) { empty.style.display = 'block'; return; }
  empty.style.display = 'none';

  charts.timeline = new Chart(document.getElementById('chart-timeline'), {
    type: 'line',
    data: {
      labels: data.data.map((r) => r.periodo),
      datasets: [
        {
          label: 'Entradas',
          data: data.data.map((r) => r.entradas),
          borderColor: COLOR.vendidas,
          backgroundColor: COLOR.vendidas + '33',
          yAxisID: 'y',
          tension: 0.2,
        },
        {
          label: 'Recaudado acumulado',
          data: data.data.map((r) => r.recaudadoAcumulado),
          borderColor: COLOR.recaudado,
          backgroundColor: COLOR.recaudado + '22',
          yAxisID: 'y1',
          tension: 0.2,
          borderDash: [4, 4],
        },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        y: { position: 'left', title: { display: true, text: 'Entradas', color: '#888' }, beginAtZero: true },
        y1: {
          position: 'right', title: { display: true, text: '$ acumulado', color: '#888' },
          beginAtZero: true, grid: { drawOnChartArea: false },
          ticks: { callback: (v) => '$ ' + Number(v).toLocaleString('es-AR') },
        },
      },
      plugins: {
        legend: { position: 'top' },
        tooltip: {
          callbacks: {
            label: (ctx) => ctx.dataset.yAxisID === 'y1'
              ? `${ctx.dataset.label}: $ ${Number(ctx.parsed.y).toLocaleString('es-AR')}`
              : `${ctx.dataset.label}: ${ctx.parsed.y}`,
          },
        },
      },
    },
  });
}

// ============================================
// DISTRIBUCIÓN POR TANDA
// ============================================
async function cargarTandas() {
  const data = await fetchReporte('/distribucion-tandas');
  destroyChart('tandas');
  const empty = document.getElementById('chart-tandas-empty');
  if (!data.tandas.length) { empty.style.display = 'block'; return; }
  empty.style.display = 'none';

  charts.tandas = new Chart(document.getElementById('chart-tandas'), {
    type: 'bar',
    data: {
      labels: data.tandas.map((t) => t.nombre),
      datasets: [
        { label: 'Vendidas', data: data.tandas.map((t) => t.vendidas), backgroundColor: '#f6c90e', stack: 's' },
        { label: 'Invitaciones', data: data.tandas.map((t) => t.invitaciones), backgroundColor: '#90cdf4', stack: 's' },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      indexAxis: 'y',
      scales: {
        x: { stacked: true, beginAtZero: true, ticks: { precision: 0 } },
        y: { stacked: true },
      },
      plugins: {
        legend: { position: 'top' },
        tooltip: {
          callbacks: {
            footer: (items) => {
              const t = data.tandas[items[0].dataIndex];
              const cap = t.capacidad === null ? '∞' : t.capacidad;
              const ocup = t.pctOcupacion === null ? '—' : fmtPct(t.pctOcupacion);
              return `Recaudado: ${fmtPesos(t.recaudado)} · Capacidad: ${cap} · Ocup: ${ocup}`;
            },
          },
        },
      },
    },
  });
}

// ============================================
// CADENCIA DE VENTA
// ============================================
async function cargarCadencia() {
  const data = await fetchReporte('/cadencia-tandas');
  const cont = document.getElementById('cadencia-lista');
  if (!data.tandas.length) {
    cont.innerHTML = '<div class="empty-state">Sin tandas creadas.</div>';
    return;
  }
  cont.innerHTML = data.tandas.map((t) => {
    const estado = t.agotada
      ? '<span style="color:#48bb78; font-weight:600;">Agotada</span>'
      : '<span style="color:#888;">Sin agotarse</span>';
    const dias = t.diasParaAgotar !== null
      ? `<strong>${t.diasParaAgotar} días</strong> hasta agotar`
      : (t.primeraCompra ? `Abierta desde ${fmtFechaCorta(t.primeraCompra)}` : 'Sin ventas');
    const capInfo = t.capacidad !== null ? `${t.cantidadVendida}/${t.capacidad}` : `${t.cantidadVendida}/∞`;
    return `
      <div class="cadencia-item">
        <div style="display:flex; justify-content:space-between; align-items:baseline; gap:10px; flex-wrap:wrap;">
          <div>
            <div style="font-size:0.9rem; font-weight:600;">${t.nombre}</div>
            <div style="font-size:0.75rem; color:#888;">${capInfo} entradas · ${estado}</div>
          </div>
          <div style="font-size:0.8rem; color:#aaa; text-align:right;">${dias}</div>
        </div>
      </div>`;
  }).join('');
}

// ============================================
// INIT
// ============================================
document.addEventListener('DOMContentLoaded', async () => {
  if (!TOKEN) { mostrarError(); return; }

  // cargarMeta valida el token: si es inválido/expirado lanza 404 → error global.
  try {
    await cargarMeta();
  } catch (err) {
    mostrarError();
    return;
  }

  document.getElementById('estado-carga').style.display = 'none';
  document.getElementById('reporte-contenido').style.display = 'block';

  // Tabs día/hora del timeline
  document.querySelectorAll('.bo-tab-btn[data-granularidad]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.bo-tab-btn[data-granularidad]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      granularidad = btn.dataset.granularidad;
      cargarTimeline().catch((e) => console.error('timeline:', e));
    });
  });

  // Secciones en paralelo. Si una falla, se loguea pero no tumba el resto.
  cargarResumen().catch((e) => console.error('resumen:', e));
  cargarTimeline().catch((e) => console.error('timeline:', e));
  cargarTandas().catch((e) => console.error('tandas:', e));
  cargarCadencia().catch((e) => console.error('cadencia:', e));
});
