/**
 * PWA Service Worker Handler - Self-cleaning & Unregister to guarantee zero fetch errors
 */
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then((registrations) => {
    for (const registration of registrations) {
      registration.unregister().catch(() => {});
    }
  }).catch(() => {});

  if (window.caches) {
    caches.keys().then((names) => {
      for (const name of names) caches.delete(name).catch(() => {});
    }).catch(() => {});
  }
}
