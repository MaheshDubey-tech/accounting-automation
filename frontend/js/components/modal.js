/**
 * Modal Management Utility
 */
const Modal = {
  open: (modalId) => {
    const modal = document.getElementById(modalId);
    if (modal) {
      modal.classList.add('open');
      document.body.style.overflow = 'hidden';
      const firstInput = modal.querySelector('input, select, textarea');
      if (firstInput) firstInput.focus();
    }
  },
  close: (modalId) => {
    const modal = document.getElementById(modalId);
    if (modal) {
      modal.classList.remove('open');
      document.body.style.overflow = '';
    }
  },
  init: () => {
    // Close modal when clicking backdrop or close buttons
    document.addEventListener('click', (e) => {
      if (e.target.classList.contains('modal-overlay')) {
        e.target.classList.remove('open');
        document.body.style.overflow = '';
      }
      if (e.target.hasAttribute('data-modal-close')) {
        const modal = e.target.closest('.modal-overlay');
        if (modal) {
          modal.classList.remove('open');
          document.body.style.overflow = '';
        }
      }
    });

    // Close on Escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const openModals = document.querySelectorAll('.modal-overlay.open');
        openModals.forEach((m) => {
          m.classList.remove('open');
        });
        document.body.style.overflow = '';
      }
    });
  },
};

document.addEventListener('DOMContentLoaded', () => {
  Modal.init();
});
