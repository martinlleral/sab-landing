/**
 * El botón flotante «Afiliate» de la portada (escalón 0, la invitación).
 *
 * Que la invitación «te siga» quiere decir que queda a mano mientras bajás por la
 * página, no que te persigue: si lo cerrás, no vuelve achicado (lo que NN/g llama
 * «stalking overlay»). Lo arranca app.js sólo cuando /api/home dice que las
 * afiliaciones abrieron (la fecha vive en src/config/afiliaciones.js); antes, el
 * HTML lo trae oculto y nadie lo muestra.
 *
 * Se ve cuando se cumple TODO esto: pasaste el hero; el modal de compra no está
 * abierto; la sección de afiliación no está a la vista (ya invita a lo mismo); la
 * pantalla tiene 480 px de alto o más; y no lo cerraste (30 días) ni lo tocaste
 * (esta visita). Entra con un fundido y queda quieto.
 *
 * La regla y la memoria no tocan el DOM: el archivo también se carga desde Node,
 * y así se prueban (tests/integration/afiliate-flotante.test.js).
 */
(function (raiz) {
  'use strict';

  var CLAVE_CERRADO = 'sab.afiliate.flotante.cerradoHasta';
  var CLAVE_TOCADO = 'sab.afiliate.flotante.tocado';
  var DIAS_CERRADO = 30;
  var ALTO_MINIMO = 480;
  var DIA_MS = 24 * 60 * 60 * 1000;

  // La regla: con lo que se midió, ¿se ve?
  function debeVerse(e) {
    return e.abiertas === true &&
      !e.descartado &&
      e.pasoElHero === true &&
      !e.modalAbierto &&
      !e.seccionAVista &&
      e.altoVentana >= ALTO_MINIMO;
  }

  // La memoria. Cerrado: hasta dentro de 30 días (localStorage). Tocado: hasta que
  // se cierre la pestaña (sessionStorage). Si el navegador no deja guardar, vale
  // sólo para esta página: se oculta en esta visita y nada se rompe.
  function crearMemoria(local, sesion, ahora) {
    var enEstaVisita = false;
    function leer(st, k) { try { return st ? st.getItem(k) : null; } catch (e) { return null; } }
    function escribir(st, k, v) { try { if (st) st.setItem(k, v); } catch (e) { /* sin almacenamiento: vale esta visita */ } }
    return {
      descartado: function () {
        if (enEstaVisita) return true;
        if (leer(sesion, CLAVE_TOCADO) === '1') return true;
        var hasta = Number(leer(local, CLAVE_CERRADO));
        return Number.isFinite(hasta) && hasta > ahora();
      },
      cerrar: function () { enEstaVisita = true; escribir(local, CLAVE_CERRADO, String(ahora() + DIAS_CERRADO * DIA_MS)); },
      tocar: function () { enEstaVisita = true; escribir(sesion, CLAVE_TOCADO, '1'); },
    };
  }

  // ── En el navegador ─────────────────────────────────────────────────────────
  function almacen(nombre) {
    try { return raiz[nombre] || null; } catch (e) { return null; } // acceder puede tirar (cookies bloqueadas)
  }

  var iniciado = false;
  function iniciar() {
    if (iniciado || typeof document === 'undefined') return;
    var nodo = document.getElementById('afiliate-flotante');
    if (!nodo) return;
    iniciado = true;

    var link = nodo.querySelector('.afl-pill');
    var cerrar = nodo.querySelector('.afl-cerrar');
    var hero = document.getElementById('hero');
    var seccion = document.getElementById('afiliate');
    var memoria = crearMemoria(almacen('localStorage'), almacen('sessionStorage'), function () { return Date.now(); });
    var estado = { abiertas: true, modalAbierto: document.body.classList.contains('modal-open') };
    var visible = false;
    var pendiente = false;

    function aVista(el) {
      if (!el || el.hidden) return false;
      var r = el.getBoundingClientRect();
      return r.height > 0 && r.top < window.innerHeight && r.bottom > 0;
    }
    function medir() {
      estado.descartado = memoria.descartado();
      estado.pasoElHero = hero ? hero.getBoundingClientRect().bottom <= 0 : window.scrollY > window.innerHeight;
      estado.seccionAVista = aVista(seccion);
      estado.altoVentana = window.innerHeight;
    }
    // Mientras está en juego, el final de la página no queda tapado: 96 px de
    // aire abajo (y el scroll del foco los respeta). Se saca cuando lo descartan.
    function aire() {
      document.documentElement.classList.toggle('afl-en-juego', !memoria.descartado());
    }
    function aplicar() {
      pendiente = false;
      medir();
      var ver = debeVerse(estado);
      if (ver === visible) return;
      visible = ver;
      if (ver) {
        nodo.hidden = false;
        void nodo.offsetWidth; // que el fundido arranque desde 0
        nodo.classList.add('afl--visible');
      } else {
        nodo.classList.remove('afl--visible');
        nodo.hidden = true;
      }
    }
    function pedir() {
      if (pendiente) return;
      pendiente = true;
      (raiz.requestAnimationFrame || setTimeout)(aplicar);
    }

    window.addEventListener('scroll', pedir, { passive: true });
    window.addEventListener('resize', pedir);
    // Los eventos de los modales de Bootstrap 5 burbujean: cualquiera lo esconde.
    document.addEventListener('show.bs.modal', function () { estado.modalAbierto = true; aplicar(); });
    document.addEventListener('hidden.bs.modal', function () { estado.modalAbierto = document.querySelectorAll('.modal.show').length > 0; aplicar(); });
    // Al volver con «atrás» desde /afiliate la página puede venir del caché.
    window.addEventListener('pageshow', function () { aire(); aplicar(); });

    cerrar.addEventListener('click', function () {
      var teniaFoco = document.activeElement === cerrar;
      memoria.cerrar();
      aire();
      aplicar();
      // El foco no se pierde: pasa a lo que sigue (el botón de WhatsApp).
      if (teniaFoco) {
        var siguiente = document.querySelector('.whatsapp-float') || document.getElementById('main-content') || document.body;
        if (siguiente === document.body) document.body.setAttribute('tabindex', '-1');
        siguiente.focus();
      }
    });
    link.addEventListener('click', function () { memoria.tocar(); pedir(); });

    aire();
    aplicar();
  }

  var api = { debeVerse: debeVerse, crearMemoria: crearMemoria, iniciar: iniciar, CLAVE_CERRADO: CLAVE_CERRADO, CLAVE_TOCADO: CLAVE_TOCADO, DIAS_CERRADO: DIAS_CERRADO, ALTO_MINIMO: ALTO_MINIMO };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else raiz.sabFlotante = api;
})(typeof window !== 'undefined' ? window : this);
