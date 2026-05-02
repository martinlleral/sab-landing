/* ============================================
   CUPONES — UI de admin dentro del evento
   ============================================
   Se inicializa con initCupones(eventoId) desde evento-detalle.html.
   Usa helpers globales de bo.js (boFetch, boConfirm, boFechaHora, boPrecio).
*/

(function () {
  let _eventoId = null;
  let _cupones = [];

  function escHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function showFeedback(msg, isError = false) {
    const el = document.getElementById('cupones-feedback');
    if (!el) return;
    el.style.display = 'block';
    el.innerHTML = `<span style="color:${isError ? '#fc8181' : '#48bb78'};">${msg}</span>`;
    setTimeout(() => { el.style.display = 'none'; }, 4000);
  }

  function showWarnings(warnings) {
    const el = document.getElementById('cupones-warnings');
    if (!el) return;
    if (!warnings || !warnings.length) {
      el.style.display = 'none';
      return;
    }
    el.style.display = 'block';
    el.innerHTML = warnings.map((w) => `
      <div class="alert alert-warning" style="background:#3a2a10;border:1px solid #f6ad55;color:#fbd38d;padding:10px 14px;border-radius:6px;margin-bottom:8px;">
        <i class="bi bi-exclamation-triangle me-2"></i>${escHtml(w)}
      </div>
    `).join('');
  }

  function renderCupones() {
    const tbody = document.getElementById('cupones-body');
    if (!tbody) return;
    if (!_cupones.length) {
      tbody.innerHTML = `<tr><td colspan="8" class="text-center py-3" style="color:#666;">
        Sin cupones para este evento. Tocá "Agregar cupón" para crear el primero.
      </td></tr>`;
      return;
    }
    tbody.innerHTML = _cupones.map((c) => {
      const valorTxt = c.tipo === 'porcentaje' ? `${c.valor}%` : boPrecio(c.valor);
      const tipoBadge = c.tipo === 'porcentaje'
        ? '<span class="badge bg-info">Porcentaje</span>'
        : '<span class="badge bg-warning text-dark">Monto fijo</span>';
      const usosTxt = c.topeUsos !== null
        ? `${c.usosActuales} / ${c.topeUsos}`
        : `${c.usosActuales} / ∞`;
      const venceTxt = c.validoHasta ? boFechaHora(c.validoHasta) : '<span style="color:#666;">Sin vencimiento</span>';
      const usosDisable = c._count.usos > 0 || c.usosActuales > 0;
      const borrarTitle = usosDisable
        ? 'No se puede borrar — desactivalo en su lugar'
        : 'Eliminar cupón';
      const borrarDisabled = usosDisable ? 'disabled' : '';
      return `<tr data-cupon-id="${c.id}">
        <td><code style="background:#1a1a1a;padding:3px 8px;border-radius:4px;color:#90cdf4;font-size:.9rem;">${escHtml(c.codigo)}</code></td>
        <td>${tipoBadge}</td>
        <td style="font-weight:600;">${valorTxt}</td>
        <td style="color:#888;">${usosTxt}</td>
        <td style="color:#888;font-size:.85rem;">${venceTxt}</td>
        <td class="text-center">
          <div class="form-check form-switch d-inline-block">
            <input class="form-check-input" type="checkbox" ${c.activo ? 'checked' : ''} data-toggle-id="${c.id}">
          </div>
        </td>
        <td class="text-center">
          <button type="button" class="btn-bo-secondary btn-sm" data-detalle-id="${c.id}" title="Ver usos">
            <i class="bi bi-eye"></i>
          </button>
        </td>
        <td>
          <button type="button" class="btn-bo-danger btn-sm" data-borrar-id="${c.id}" ${borrarDisabled} title="${borrarTitle}">
            <i class="bi bi-trash"></i>
          </button>
        </td>
      </tr>`;
    }).join('');

    // Event listeners (no inline onclick — evita el antipatrón de stringificar funciones).
    tbody.querySelectorAll('input[data-toggle-id]').forEach((inp) => {
      inp.addEventListener('change', () => toggleActivo(parseInt(inp.dataset.toggleId, 10), inp.checked));
    });
    tbody.querySelectorAll('button[data-borrar-id]').forEach((btn) => {
      btn.addEventListener('click', () => borrarCupon(parseInt(btn.dataset.borrarId, 10)));
    });
    tbody.querySelectorAll('button[data-detalle-id]').forEach((btn) => {
      btn.addEventListener('click', () => verDetalle(parseInt(btn.dataset.detalleId, 10)));
    });
  }

  async function cargar() {
    try {
      _cupones = await boFetch(`/api/admin/cupones?eventoId=${_eventoId}`);
      renderCupones();
    } catch (err) {
      const tbody = document.getElementById('cupones-body');
      if (tbody) {
        tbody.innerHTML = `<tr><td colspan="8" class="text-center py-3" style="color:#fc8181;">
          Error: ${escHtml(err.message)}
        </td></tr>`;
      }
    }
  }

  function abrirFormCrear() {
    document.getElementById('cupon-crear-card').style.display = 'block';
    document.getElementById('cupon-codigo').focus();
    showWarnings(null);
  }

  function cerrarFormCrear() {
    document.getElementById('cupon-crear-card').style.display = 'none';
    ['cupon-codigo', 'cupon-valor', 'cupon-tope-usos', 'cupon-valido-hasta'].forEach((id) => {
      document.getElementById(id).value = '';
    });
    document.getElementById('cupon-tipo').value = 'porcentaje';
    document.getElementById('cupon-activo').checked = true;
    showWarnings(null);
  }

  function actualizarSufijoValor() {
    const tipo = document.getElementById('cupon-tipo').value;
    const sufijo = document.getElementById('cupon-valor-sufijo');
    const input = document.getElementById('cupon-valor');
    if (tipo === 'porcentaje') {
      sufijo.textContent = '%';
      input.max = 100;
      input.placeholder = 'Ej: 25 (= 25% off)';
    } else {
      sufijo.textContent = '$';
      input.removeAttribute('max');
      input.placeholder = 'Ej: 5000 (= $5.000 off)';
    }
  }

  async function crearCupon() {
    const codigo = document.getElementById('cupon-codigo').value.trim();
    const tipo = document.getElementById('cupon-tipo').value;
    const valor = parseInt(document.getElementById('cupon-valor').value, 10);
    const topeRaw = document.getElementById('cupon-tope-usos').value.trim();
    const validoRaw = document.getElementById('cupon-valido-hasta').value;
    const activo = document.getElementById('cupon-activo').checked;

    if (!codigo) return showFeedback('⚠️ Falta el código', true);
    if (codigo.length < 3) return showFeedback('⚠️ El código debe tener al menos 3 caracteres', true);
    if (!Number.isFinite(valor) || valor <= 0) return showFeedback('⚠️ El valor debe ser mayor a 0', true);
    if (tipo === 'porcentaje' && valor > 100) return showFeedback('⚠️ El porcentaje no puede ser mayor a 100', true);

    const body = { eventoId: _eventoId, codigo, tipo, valor, activo };
    if (topeRaw) body.topeUsos = parseInt(topeRaw, 10);
    if (validoRaw) body.validoHasta = new Date(validoRaw).toISOString();

    const btn = document.getElementById('btn-cupon-crear');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Creando...';

    try {
      const res = await boFetch('/api/admin/cupones', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      cerrarFormCrear();
      showWarnings(res.warnings);
      showFeedback(`✅ Cupón "${res.cupon.codigo}" creado`);
      await cargar();
    } catch (err) {
      showFeedback(`❌ ${err.message}`, true);
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<i class="bi bi-plus-lg me-1"></i>Crear cupón';
    }
  }

  async function toggleActivo(cuponId, nuevoEstado) {
    try {
      await boFetch(`/api/admin/cupones/${cuponId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ activo: nuevoEstado }),
      });
      showFeedback(nuevoEstado ? '✅ Cupón activado' : '✅ Cupón desactivado');
      await cargar();
    } catch (err) {
      showFeedback(`❌ ${err.message}`, true);
      await cargar(); // revertir el switch
    }
  }

  async function borrarCupon(cuponId) {
    if (!boConfirm('¿Eliminar este cupón? Esta acción no se puede deshacer.')) return;
    try {
      await boFetch(`/api/admin/cupones/${cuponId}`, { method: 'DELETE' });
      showFeedback('✅ Cupón eliminado');
      await cargar();
    } catch (err) {
      showFeedback(`❌ ${err.message}`, true);
    }
  }

  async function verDetalle(cuponId) {
    try {
      const data = await boFetch(`/api/admin/cupones/${cuponId}`);
      const usosHtml = data.usos.length
        ? `<table class="table table-sm" style="background:transparent;">
            <thead><tr style="color:#888;font-size:.85rem;">
              <th>Compra #</th><th>Comprador</th><th>Email</th>
              <th>Estado</th><th>Descuento</th><th>Fecha</th>
            </tr></thead>
            <tbody>${data.usos.map((u) => `
              <tr style="border-top:1px solid #2a2a2a;">
                <td>${u.compra.id}</td>
                <td>${escHtml(u.compra.nombre)} ${escHtml(u.compra.apellido)}</td>
                <td style="color:#888;font-size:.85rem;">${escHtml(u.compra.email)}</td>
                <td><span class="badge-estado ${u.compra.mpEstado}">${u.compra.mpEstado}</span></td>
                <td>${boPrecio(u.descuentoAplicado)}</td>
                <td style="color:#888;font-size:.85rem;">${boFechaHora(u.createdAt)}</td>
              </tr>
            `).join('')}</tbody>
          </table>`
        : '<p style="color:#666;text-align:center;padding:20px;">Este cupón todavía no se usó.</p>';

      // Modal simple: usa el modal de Bootstrap incluido en el HTML.
      document.getElementById('cupon-detalle-titulo').textContent = `Usos de "${data.codigo}"`;
      document.getElementById('cupon-detalle-body').innerHTML = usosHtml;
      const modal = new bootstrap.Modal(document.getElementById('cupon-detalle-modal'));
      modal.show();
    } catch (err) {
      showFeedback(`❌ ${err.message}`, true);
    }
  }

  // Expongo la API pública del módulo
  window.initCupones = function (eventoId) {
    _eventoId = eventoId;

    document.getElementById('btn-abrir-cupon').addEventListener('click', abrirFormCrear);
    document.getElementById('btn-cupon-cancelar').addEventListener('click', cerrarFormCrear);
    document.getElementById('btn-cupon-crear').addEventListener('click', crearCupon);
    document.getElementById('cupon-tipo').addEventListener('change', actualizarSufijoValor);

    actualizarSufijoValor();
    cargar();
  };
})();
