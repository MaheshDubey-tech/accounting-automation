const CACHE_NAME = 'ssa-accounting-v2';
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/login.html',
  '/manifest.json',
  '/css/base.css',
  '/css/layout.css',
  '/css/components.css',
  '/css/pages/login.css',
  '/css/pages/dashboard.css',
  '/js/api.js',
  '/js/auth.js',
  '/js/pwa.js',
  '/js/components/modal.js',
  '/js/components/toast.js',
  '/js/pages/app.js',
  '/js/pages/login.js'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      for (const asset of ASSETS_TO_CACHE) {
        try {
          await cache.add(asset);
        } catch (e) {
          // silently continue if individual asset is not present
        }
      }
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  // CRITICAL: NEVER intercept non-GET requests (e.g. POST, PUT, DELETE, uploads)
  if (event.request.method !== 'GET') {
    return;
  }

  // CRITICAL: NEVER intercept API calls or non-HTTP protocols
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api') || !url.protocol.startsWith('http')) {
    return;
  }

  // Handle navigation requests (Network-first with index.html fallback)
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .catch(async () => {
          const cached = await caches.match(event.request);
          if (cached) return cached;
          const indexFallback = await caches.match('/index.html');
          return indexFallback || new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
        })
    );
    return;
  }

  // Stale-while-revalidate for static assets
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      const fetchPromise = fetch(event.request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const responseClone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, responseClone).catch(() => {});
            });
          }
          return networkResponse;
        })
        .catch(() => {
          // If network fetch fails and we have cache, return cache
          if (cachedResponse) return cachedResponse;
          return new Response('', { status: 408, statusText: 'Request Timed Out' });
        });

      return cachedResponse || fetchPromise;
    })
  );
});
