/**
 * Authentication and Page Guard Utility (Direct Access / No Login Wall)
 */
const DEFAULT_USER = {
  id: 1,
  username: 'Administrator',
  role: 'admin',
};

const Auth = {
  checkSession: () => {
    // Ensure token & user exist in localStorage so all components work smoothly
    if (!API.getToken()) {
      API.setToken('direct-admin-session-token');
    }
    if (!API.getUser()) {
      API.setUser(DEFAULT_USER);
    }

    const isLoginPage = window.location.pathname.includes('login.html');
    if (isLoginPage) {
      window.location.href = '/index.html';
      return true;
    }

    const user = API.getUser() || DEFAULT_USER;

    // Populate user profile info in header/sidebar if present
    const userNameElements = document.querySelectorAll('.js-user-name');
    const userRoleElements = document.querySelectorAll('.js-user-role');
    const userAvatarElements = document.querySelectorAll('.js-user-avatar');

    userNameElements.forEach((el) => (el.textContent = user.username));
    userRoleElements.forEach((el) => (el.textContent = user.role));
    userAvatarElements.forEach((el) => (el.textContent = (user.username || 'A').charAt(0).toUpperCase()));

    return true;
  },

  logout: () => {
    // Simply reset session to default and refresh dashboard
    API.setUser(DEFAULT_USER);
    window.location.href = '/index.html';
  },

  init: () => {
    Auth.checkSession();

    // Bind logout buttons to reset session
    document.querySelectorAll('.js-logout-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        Auth.logout();
      });
    });
  },
};

document.addEventListener('DOMContentLoaded', () => {
  Auth.init();
});
