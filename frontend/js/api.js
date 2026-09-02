/**
 * Global API Client for SSA Accounting System
 */
const API = (() => {
  const BASE_URL = '/api';

  const getToken = () => localStorage.getItem('ssa_token');
  const setToken = (token) => localStorage.setItem('ssa_token', token);
  const removeToken = () => localStorage.removeItem('ssa_token');
  const getUser = () => {
    try {
      return JSON.parse(localStorage.getItem('ssa_user') || 'null');
    } catch (e) {
      return null;
    }
  };
  const setUser = (user) => localStorage.setItem('ssa_user', JSON.stringify(user));
  const removeUser = () => localStorage.removeItem('ssa_user');

  const request = async (endpoint, options = {}) => {
    const url = `${BASE_URL}${endpoint}`;
    const token = getToken();

    const headers = {
      ...options.headers,
    };

    if (!(options.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
    }

    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    try {
      const response = await fetch(url, {
        ...options,
        headers,
      });

      // Handle Unauthorized (401)
      if (response.status === 401) {
        removeToken();
        removeUser();
        if (!window.location.pathname.includes('login.html')) {
          window.location.href = '/login.html';
        }
        throw new Error('Session expired. Please log in again.');
      }

      // If downloading binary file (e.g. excel)
      const contentType = response.headers.get('content-type');
      if (contentType && (contentType.includes('spreadsheetml') || contentType.includes('octet-stream'))) {
        if (!response.ok) throw new Error('File download failed');
        return response.blob();
      }

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.message || 'An unexpected error occurred.');
      }

      return data;
    } catch (error) {
      console.error(`API Error [${endpoint}]:`, error);
      throw error;
    }
  };

  return {
    get: (endpoint, params = {}) => {
      const query = new URLSearchParams(params).toString();
      return request(query ? `${endpoint}?${query}` : endpoint, { method: 'GET' });
    },
    post: (endpoint, body) => {
      const isFormData = body instanceof FormData;
      return request(endpoint, {
        method: 'POST',
        body: isFormData ? body : JSON.stringify(body),
      });
    },
    put: (endpoint, body) => request(endpoint, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
    delete: (endpoint) => request(endpoint, { method: 'DELETE' }),
    getToken,
    setToken,
    removeToken,
    getUser,
    setUser,
    removeUser,
  };
})();
