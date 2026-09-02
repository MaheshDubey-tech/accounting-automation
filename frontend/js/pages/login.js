/**
 * Login & Admin Initial Setup Page Handler
 */
document.addEventListener('DOMContentLoaded', async () => {
  const form = document.getElementById('authForm');
  const usernameInput = document.getElementById('usernameInput');
  const passwordInput = document.getElementById('passwordInput');
  const submitBtn = document.getElementById('submitBtn');
  const submitBtnText = document.getElementById('submitBtnText');
  const setupBanner = document.getElementById('setupBanner');
  const formSubtitle = document.getElementById('formSubtitle');

  let isInitialSetup = false;

  // Check if initial admin setup is required
  try {
    const status = await API.get('/auth/setup-status');
    if (status.needsSetup) {
      isInitialSetup = true;
      setupBanner.style.display = 'block';
      formSubtitle.textContent = 'System Initialization';
      submitBtnText.textContent = 'Create Admin & Sign In';
    }
  } catch (err) {
    console.warn('Could not check setup status:', err);
  }

  // Handle form submission
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = usernameInput.value.trim();
    const password = passwordInput.value;

    if (!username || !password) {
      Toast.error('Please fill in all fields.');
      return;
    }

    submitBtn.disabled = true;
    submitBtnText.textContent = isInitialSetup ? 'Setting up...' : 'Signing in...';

    try {
      const endpoint = isInitialSetup ? '/auth/setup-admin' : '/auth/login';
      const res = await API.post(endpoint, { username, password });

      if (res.token && res.user) {
        API.setToken(res.token);
        API.setUser(res.user);
        Toast.success(res.message || 'Login successful!');

        setTimeout(() => {
          window.location.href = '/index.html';
        }, 500);
      } else {
        throw new Error(res.message || 'Authentication failed');
      }
    } catch (err) {
      Toast.error(err.message || 'Authentication failed. Please try again.');
      submitBtn.disabled = false;
      submitBtnText.textContent = isInitialSetup ? 'Create Admin & Sign In' : 'Sign In';
    }
  });
});
