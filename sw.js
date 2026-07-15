// TK Empire Service Worker v2
const CACHE = 'tkempire-v2';

const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/about.html',
  '/results.html',
  '/community.html',
  '/recovery.html',
  '/join.html',
  '/empire.css',
  '/empire.js',
  '/manifest.json'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE)
          .map(key => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method !== 'GET') {
    return;
  }

  const isHtml =
    request.mode === 'navigate' ||
    request.destination === 'document';

  const isLiveData =
    url.pathname.startsWith('/api/') ||
    url.pathname.includes('/data/') ||
    url.pathname.endsWith('.json');

  if (isHtml || isLiveData) {
    event.respondWith(
      fetch(request, { cache: 'no-store' })
        .then(response => response)
        .catch(() =>
          isHtml
            ? caches.match('/index.html')
            : new Response(
                JSON.stringify({ error: 'offline' }),
                {
                  status: 503,
                  headers: { 'Content-Type': 'application/json' }
                }
              )
        )
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) {
        return cached;
      }

      return fetch(request).then(response => {
        if (!response || response.status !== 200) {
          return response;
        }

        const copy = response.clone();

        caches.open(CACHE).then(cache => {
          cache.put(request, copy);
        });

        return response;
      });
    })
  );
});

self.addEventListener('push', event => {
  const data = event.data ? event.data.json() : {};
  const title = data.title || '⚡ TK Empire Signal';

  const options = {
    body: data.body || 'New signal fired. Check the app.',
    icon: 'https://i.imgur.com/Kf99eJt.jpeg',
    badge: 'https://i.imgur.com/Kf99eJt.jpeg',
    vibrate: [200, 100, 200],
    data: { url: data.url || '/' },
    actions: [
      { action: 'view', title: 'View Signal' },
      { action: 'dismiss', title: 'Dismiss' }
    ]
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();

  if (event.action === 'view') {
    event.waitUntil(
      clients.openWindow(event.notification.data.url || '/')
    );
  }
});
