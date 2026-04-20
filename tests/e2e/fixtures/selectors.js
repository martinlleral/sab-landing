// Selectores compartidos entre specs.
// Centralizados para que si cambia un id/clase en el HTML, se actualiza en un solo lugar.
module.exports = {
  // Home pública
  home: {
    hero: '#hero',
    heroSlider: '#carousel-inner',
    trustBar: '.trust-bar',
    trustPersonas: '#trust-personas',
    navLinks: {
      proximos: 'a[href="#proximos"]',
      quienesSomos: 'a[href="#quienes-somos"]',
      waitlist: 'a[href="#waitlist"]',
    },
    proximosEventos: '#proximos',
    eventoDestacado: '#evento-destacado',
    btnComprarHero: '#btn-comprar-hero',
    quienesSomos: '#quienes-somos',
    statsEdiciones: '#qs-stat-ediciones',
    statsShows: '#qs-stat-shows',
    statsPersonas: '#qs-stat-personas',
    waitlistForm: '#waitlist-form',
    waitlistContador: '#waitlist-count',
    whatsappFlotante: '.whatsapp-float',
  },
  // Modal de compra
  modalCompra: {
    container: '#modal-compra',
    nombre: '#modal-nombre',
    apellido: '#modal-apellido',
    email: '#modal-email',
    telefono: '#modal-telefono',
    cantidad: '#modal-cantidad',
    btnPagar: '#btn-pagar',
    error: '#modal-error',
  },
  // Backoffice
  backoffice: {
    login: {
      email: 'input[type="email"]',
      password: 'input[type="password"]',
      submit: 'button[type="submit"]',
    },
    sidebar: '.bo-sidebar',
    topbarUser: '#topbar-user',
  },
};
