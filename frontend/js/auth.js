/**
 * Authentication and Page Guard Utility
 */
const Auth = {
  checkSession: () => {
    const isLoginPage = window.location.pathname.includes('login.html');
    const token = API.getToken();
    const user = API.getUser();

    if (!token || !user) {
      if (!isLoginPage) {
        window.location.href = '/login.html';
      }
      return false;
    }

    if (isLoginPage) {
      window.location.href = '/index.html';
      return true;
    }

    // Populate user profile info in header/sidebar if present
    const userNameElements = document.querySelectorAll('.js-user-name');
    const userRoleElements = document.querySelectorAll('.js-user-role');
    const userAvatarElements = document.querySelectorAll('.js-user-avatar');

    userNameElements.forEach((el) => (el.textContent = user.username));
    userRoleElements.forEach((el) => (el.textContent = user.role));
    userAvatarElements.forEach((el) => (el.textContent = user.username.charAt(0).toUpperCase()));

    return true;
  },

  logout: () => {
    API.removeToken();
    API.removeUser();
    window.location.href = '/login.html';
  },

  init: () => {
    Auth.checkSession();

    // Bind logout buttons
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
