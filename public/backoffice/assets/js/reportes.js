/* ============================================
   REPORTES — dashboard de KPIs (Sprint 3 ítem 5)
   ============================================
   Carga los 9 endpoints de /api/admin/dashboard en paralelo y dibuja
   los 7 bloques de la página. Los filtros (evento, desde, hasta) viajan
   server-side: nunca filtramos client-side sobre datos paginados (ver
   memoria insight_filtros_paginados_client_side.md).
*/

// Paleta consistente con el resto del backoffice (ver evento-compras.html)
const COLOR = {
  vendidas: '#f6c90e',
  invitaciones: '#90cdf4',
  pendientes: '#ed8936',
  recaudado: '#48bb78',
  aporte: '#a78bfa',
  asistencia: '#38b2ac',
  azul: '#4299e1',
  rojo: '#e63946',
  gris: '#a0aec0',
  rosa: '#fc8181',
};
const PALETA_VAR = ['#f6c90e', '#90cdf4', '#a78bfa', '#48bb78', '#ed8936', '#38b2ac', '#4299e1', '#fc8181'];

// Defaults para Chart.js (modo oscuro)
Chart.defaults.color = '#aaa';
Chart.defaults.font.family = "'Inter', -apple-system, BlinkMacSystemFont, sans-serif";
Chart.defaults.font.size = 11;
Chart.defaults.borderColor = '#2a2a2a';

// Cache de instancias para destruir antes de re-renderizar
const charts = {};
function destroyChart(id) {
  if (charts[id]) { charts[id].destroy(); delete charts[id]; }
}

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
  const d = new Date(iso);
  return d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' });
}

// ============================================
// ESTADO Y FILTROS
// ============================================
const state = {
  eventoId: null,    // null = todos
  desde: '',
  hasta: '',
  granularidad: 'dia',
  eventos: [],       // lista para el selector
};

function getQueryParams(extras = {}) {
  const p = new URLSearchParams();
  if (state.eventoId) p.set('eventoId', state.eventoId);
  if (state.desde) p.set('desde', state.desde);
  if (state.hasta) p.set('hasta', state.hasta);
  Object.entries(extras).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') p.set(k, v); });
  return p.toString();
}

// ============================================
// CARGA DE EVENTOS PARA EL SELECTOR
// ============================================
async function cargarSelectorEventos() {
  try {
    // Traemos todos en una sola pasada (limit alto). Si crece muchísimo se agrega
    // /api/admin/eventos?limit=all o un endpoint dedicado. Hoy < 50 eventos.
    const [actuales, pasados] = await Promise.all([
      boFetch('/api/admin/eventos?limit=200'),
      boFetch('/api/admin/eventos/pasados?limit=200'),
    ]);
    const todos = [...(actuales.eventos || []), ...(pasados.eventos || [])];
    // Dedupe por id (puede haber overlap si un evento se "pasó" entre listados)
    const dedup = new Map();
    todos.forEach((e) => { if (!dedup.has(e.id)) dedup.set(e.id, e); });
    state.eventos = [...dedup.values()].sort((a, b) => new Date(b.fecha) - new Date(a.fecha));

    const select = document.getElementById('filtro-evento');
    select.innerHTML = '<option value="">Todos los eventos</option>'
      + state.eventos.map((e) => {
        const fecha = boFecha(e.fecha);
        return `<option value="${e.id}">${e.nombre} — ${fecha}</option>`;
      }).join('');
  } catch (err) {
    console.error('Error al cargar selector de eventos:', err);
  }
}

// ============================================
// RESUMEN
// ============================================
async function cargarResumen() {
  try {
    const data = await boFetch(`/api/admin/dashboard/resumen?${getQueryParams()}`);
    document.getElementById('r-eventos').textContent = data.totalEventos;
    document.getElementById('r-vendidas').textContent = data.entradas.vendidas;
    document.getElementById('r-invitaciones').textContent = data.entradas.invitaciones;
    document.getElementById('r-pendientes').textContent = data.compras.pendientes;
    document.getElementById('r-recaudado').textContent = fmtPesos(data.recaudado.total);
    document.getElementById('r-aporte').textContent = fmtPesos(data.recaudado.aporteExtra);
    document.getElementById('r-asistencia').textContent = fmtPct(data.asistenciaPct);
  } catch (err) {
    console.error('Error en resumen:', err);
  }
}

// ============================================
// VENTAS TIMELINE
// ============================================
async function cargarTimeline() {
  try {
    const data = await boFetch(`/api/admin/dashboard/ventas-timeline?${getQueryParams({ granularidad: state.granularidad })}`);
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
  } catch (err) {
    console.error('Error en timeline:', err);
  }
}

// ============================================
// APORTE EXTRA
// ============================================
async function cargarAporteExtra() {
  try {
    const data = await boFetch(`/api/admin/dashboard/aporte-extra?${getQueryParams()}`);
    document.getElementById('aporte-total').textContent = fmtPesos(data.totalAporteExtra);
    document.getElementById('aporte-compras').textContent = data.comprasConAporte;
    document.getElementById('aporte-pct').textContent = fmtPct(data.pctConversion);

    destroyChart('aporteEventos');
    const empty = document.getElementById('chart-aporte-empty');
    if (!data.breakdownPorEvento.length) { empty.style.display = 'block'; return; }
    empty.style.display = 'none';

    charts.aporteEventos = new Chart(document.getElementById('chart-aporte-eventos'), {
      type: 'doughnut',
      data: {
        labels: data.breakdownPorEvento.map((b) => b.nombre),
        datasets: [{
          data: data.breakdownPorEvento.map((b) => b.aporteExtra),
          backgroundColor: PALETA_VAR.slice(0, data.breakdownPorEvento.length),
          borderColor: '#1e1e1e',
          borderWidth: 2,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 10 } },
          tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${fmtPesos(ctx.parsed)}` } },
        },
      },
    });
  } catch (err) {
    console.error('Error en aporte extra:', err);
  }
}

// ============================================
// DRILL-DOWN POR EVENTO (tandas + cadencia + QR)
// ============================================
async function cargarPorEvento() {
  const seccion = document.getElementById('seccion-por-evento');
  const vacio = document.getElementById('seccion-por-evento-vacio');
  const titulo = document.getElementById('evento-titulo');

  if (!state.eventoId) {
    seccion.style.display = 'none';
    vacio.style.display = 'block';
    titulo.textContent = '';
    return;
  }
  seccion.style.display = '';
  vacio.style.display = 'none';
  const ev = state.eventos.find((e) => e.id === Number(state.eventoId));
  titulo.textContent = ev ? `— ${ev.nombre}` : '';

  try {
    const [tandasData, cadenciaData, qrData] = await Promise.all([
      boFetch(`/api/admin/dashboard/distribucion-tandas/${state.eventoId}`),
      boFetch(`/api/admin/dashboard/cadencia-tandas/${state.eventoId}`),
      boFetch(`/api/admin/dashboard/validacion-qr?eventoId=${state.eventoId}`),
    ]);
    renderTandas(tandasData);
    renderCadencia(cadenciaData);
    renderQR(qrData);
  } catch (err) {
    console.error('Error en drill-down evento:', err);
  }
}

function renderTandas(data) {
  destroyChart('tandas');
  const empty = document.getElementById('chart-tandas-empty');
  if (!data.tandas.length) { empty.style.display = 'block'; return; }
  empty.style.display = 'none';

  charts.tandas = new Chart(document.getElementById('chart-tandas'), {
    type: 'bar',
    data: {
      labels: data.tandas.map((t) => t.nombre),
      datasets: [
        { label: 'Vendidas', data: data.tandas.map((t) => t.vendidas), backgroundColor: COLOR.vendidas, stack: 's' },
        { label: 'Invitaciones', data: data.tandas.map((t) => t.invitaciones), backgroundColor: COLOR.invitaciones, stack: 's' },
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
              const idx = items[0].dataIndex;
              const t = data.tandas[idx];
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

function renderCadencia(data) {
  const cont = document.getElementById('cadencia-lista');
  if (!data.tandas.length) {
    cont.innerHTML = '<div class="empty-state">Sin tandas creadas.</div>';
    return;
  }
  cont.innerHTML = data.tandas.map((t) => {
    const estado = t.agotada
      ? `<span style="color:${COLOR.recaudado}; font-weight:600;">Agotada</span>`
      : `<span style="color:#888;">Sin agotarse</span>`;
    const dias = t.diasParaAgotar !== null
      ? `<strong>${t.diasParaAgotar} días</strong> hasta agotar`
      : (t.primeraCompra ? `Abierta desde ${fmtFechaCorta(t.primeraCompra)}` : 'Sin ventas');
    const capInfo = t.capacidad !== null
      ? `${t.cantidadVendida}/${t.capacidad}`
      : `${t.cantidadVendida}/∞`;
    return `
      <div style="padding:10px 0; border-bottom:1px solid #2a2a2a;">
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

function renderQR(data) {
  document.getElementById('qr-total').textContent = data.total;
  document.getElementById('qr-validadas').textContent = data.validadas;
  document.getElementById('qr-pct').textContent = fmtPct(data.asistenciaPct);
}

// ============================================
// COMPARATIVA ENTRE EVENTOS
// ============================================
async function cargarComparativa() {
  try {
    const data = await boFetch(`/api/admin/dashboard/comparativa-eventos?${getQueryParams()}`);
    const tbody = document.getElementById('comparativa-body');
    if (!data.eventos.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="text-center py-4" style="color:#666;">Sin eventos.</td></tr>';
      return;
    }
    tbody.innerHTML = data.eventos.map((e) => {
      const externo = e.esExterno ? ' <span title="Evento externo" style="color:#888;">(ext)</span>' : '';
      return `
        <tr>
          <td><a href="/backoffice/evento-compras.html?id=${e.eventoId}" style="color:#fff; text-decoration:none;">${e.nombre}${externo}</a></td>
          <td>${boFecha(e.fecha)}</td>
          <td>${e.vendidas}</td>
          <td>${e.invitaciones}</td>
          <td>${fmtPesos(e.recaudado)}</td>
          <td>${e.aporteExtra > 0 ? fmtPesos(e.aporteExtra) : '—'}</td>
          <td>${e.pctOcupacion !== null ? fmtPct(e.pctOcupacion) : '<span style="color:#666;">∞</span>'}</td>
        </tr>`;
    }).join('');
  } catch (err) {
    console.error('Error en comparativa:', err);
  }
}

// ============================================
// TOP CUPONES
// ============================================
async function cargarTopCupones() {
  try {
    const data = await boFetch('/api/admin/dashboard/top-cupones?limit=10');
    const tbody = document.getElementById('top-cupones-body');
    if (!data.cupones.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="text-center py-4" style="color:#666;">Aún no hay cupones usados.</td></tr>';
      return;
    }
    tbody.innerHTML = data.cupones.map((c) => {
      const tipoLabel = c.tipo === 'porcentaje' ? `${c.valor}%` : fmtPesos(c.valor);
      const topePct = c.pctTopeUsado !== null
        ? `${fmtPct(c.pctTopeUsado)} (${c.usos}/${c.topeUsos})`
        : `${c.usos} usos (sin tope)`;
      const estado = c.activo
        ? '<span style="color:#48bb78;">Activo</span>'
        : '<span style="color:#888;">Desactivado</span>';
      return `
        <tr>
          <td><strong>${c.codigo}</strong></td>
          <td>${c.eventoNombre}</td>
          <td>${tipoLabel}</td>
          <td>${c.usos}</td>
          <td>${fmtPesos(c.descuentoTotal)}</td>
          <td>${topePct}</td>
          <td>${estado}</td>
        </tr>`;
    }).join('');
  } catch (err) {
    console.error('Error en top cupones:', err);
  }
}

// ============================================
// COMUNIDAD (waitlist)
// ============================================
async function cargarComunidad() {
  try {
    const data = await boFetch('/api/admin/dashboard/waitlist');
    const seccion = document.getElementById('seccion-comunidad');
    const vacio = document.getElementById('seccion-comunidad-vacio');
    if (!data.disponible) {
      seccion.style.display = 'none';
      vacio.style.display = 'block';
      vacio.textContent = data.motivo || 'No disponible.';
      return;
    }
    seccion.style.display = '';
    vacio.style.display = 'none';

    document.getElementById('wl-total').textContent = data.total;
    document.getElementById('wl-hoy').textContent = data.hoy;
    document.getElementById('wl-semana').textContent = data.semana;

    // Por día (últimos 30)
    destroyChart('wlDia');
    charts.wlDia = new Chart(document.getElementById('chart-wl-dia'), {
      type: 'line',
      data: {
        labels: data.porDia.map((r) => r.fecha.slice(5)),
        datasets: [{
          label: 'Inscripciones',
          data: data.porDia.map((r) => r.n),
          borderColor: COLOR.azul,
          backgroundColor: COLOR.azul + '33',
          tension: 0.25,
          fill: true,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
        plugins: { legend: { display: false } },
      },
    });

    // Por hora hoy
    const wlHoraEmpty = document.getElementById('chart-wl-hora-empty');
    destroyChart('wlHora');
    if (!data.porHoraHoy.length) {
      wlHoraEmpty.style.display = 'block';
    } else {
      wlHoraEmpty.style.display = 'none';
      // Construir array completo 0-23 con 0s para huecos
      const horas = Array.from({ length: 24 }, (_, h) => {
        const found = data.porHoraHoy.find((x) => x.hora === h);
        return found ? found.n : 0;
      });
      charts.wlHora = new Chart(document.getElementById('chart-wl-hora'), {
        type: 'bar',
        data: {
          labels: horas.map((_, h) => `${String(h).padStart(2, '0')}h`),
          datasets: [{
            label: 'Inscripciones',
            data: horas,
            backgroundColor: COLOR.vendidas,
          }],
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
          plugins: { legend: { display: false } },
        },
      });
    }

    // Intereses
    destroyChart('wlIntereses');
    const interesesLabels = ['Early access', 'Descuentos', 'Backstage', 'Comunidad'];
    const interesesData = [
      data.porIntereses.early_access || 0,
      data.porIntereses.descuentos || 0,
      data.porIntereses.backstage || 0,
      data.porIntereses.comunidad || 0,
    ];
    charts.wlIntereses = new Chart(document.getElementById('chart-wl-intereses'), {
      type: 'bar',
      data: {
        labels: interesesLabels,
        datasets: [{
          label: 'Personas',
          data: interesesData,
          backgroundColor: PALETA_VAR.slice(0, 4),
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        indexAxis: 'y',
        scales: { x: { beginAtZero: true, ticks: { precision: 0 } } },
        plugins: { legend: { display: false } },
      },
    });

    // Relación
    destroyChart('wlRelacion');
    const relLabels = Object.keys(data.porRelacion);
    const relData = Object.values(data.porRelacion);
    if (relLabels.length) {
      charts.wlRelacion = new Chart(document.getElementById('chart-wl-relacion'), {
        type: 'doughnut',
        data: {
          labels: relLabels,
          datasets: [{
            data: relData,
            backgroundColor: PALETA_VAR.slice(0, relLabels.length),
            borderColor: '#1e1e1e',
            borderWidth: 2,
          }],
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { position: 'bottom', labels: { boxWidth: 10 } } },
        },
      });
    }
  } catch (err) {
    console.error('Error en comunidad:', err);
  }
}

// ============================================
// ORQUESTACIÓN
// ============================================
async function recargarTodo() {
  await Promise.all([
    cargarResumen(),
    cargarTimeline(),
    cargarAporteExtra(),
    cargarPorEvento(),
    cargarComparativa(),
    cargarTopCupones(),
  ]);
}

// ============================================
// INIT
// ============================================
document.addEventListener('DOMContentLoaded', async () => {
  // 1. Cargar selector de eventos primero (necesario para drill-down)
  await cargarSelectorEventos();

  // 2. Wire-up de filtros
  document.getElementById('btn-aplicar-filtros').addEventListener('click', () => {
    state.eventoId = document.getElementById('filtro-evento').value || null;
    state.desde = document.getElementById('filtro-desde').value || '';
    state.hasta = document.getElementById('filtro-hasta').value || '';
    recargarTodo();
  });

  document.getElementById('btn-limpiar-filtros').addEventListener('click', () => {
    document.getElementById('filtro-evento').value = '';
    document.getElementById('filtro-desde').value = '';
    document.getElementById('filtro-hasta').value = '';
    state.eventoId = null;
    state.desde = '';
    state.hasta = '';
    recargarTodo();
  });

  // Tabs día/hora del timeline
  document.querySelectorAll('.bo-tab-btn[data-granularidad]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.bo-tab-btn[data-granularidad]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.granularidad = btn.dataset.granularidad;
      cargarTimeline();
    });
  });

  // Cambio en evento del filtro → recargar drill-down sin esperar el botón Aplicar
  // (es la interacción más natural: elegir evento y ver tandas/cadencia/QR).
  document.getElementById('filtro-evento').addEventListener('change', (e) => {
    state.eventoId = e.target.value || null;
    cargarPorEvento();
  });

  // 3. Carga inicial: todo en paralelo + comunidad (lleva un round-trip a Supabase)
  recargarTodo();
  cargarComunidad();
});
