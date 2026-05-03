// Prime Anchor Workforce SMS — Service Worker
const CACHE_NAME = 'pa-sms-v1';
const APP_SHELL = [
  '/sms-inbox',
  '/manifest.json',
  '/logo.svg',
  'https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap'
];

// Install: cache app shell
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(APP_SHELL).catch(err => {
        console.warn('[SW] Some resources failed to cache:', err);
      });
    })
  );
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: network-first for API, cache-first for app shell
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Never cache API calls, webhooks, or POST requests
  if (url.pathname.startsWith('/api/') || event.request.method !== 'GET') {
    return;
  }

  // For navigation and app shell: try network first, fall back to cache
  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Clone and cache successful responses
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => {
        // Network failed — try cache
        return caches.match(event.request).then(cached => {
          if (cached) return cached;
          // If it's a navigation request, return the cached inbox page
          if (event.request.mode === 'navigate') {
            return caches.match('/sms-inbox');
          }
          return new Response('Offline', { status: 503, statusText: 'Offline' });
        });
      })
  );
});
