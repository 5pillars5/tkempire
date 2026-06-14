// TK Empire Service Worker v1
const CACHE = 'tkempire-v1';
const ASSETS = [
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

// Install — cache all assets
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

// Activate — clean old caches
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch — serve from cache, fallback to network
self.addEventListener('fetch', e => {
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(response => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE).then(cache => cache.put(e.request, clone));
        }
        return response;
      }).catch(() => caches.match('/index.html'));
    })
  );
});

// Push notifications
self.addEventListener('push', e => {
  const data = e.data ? e.data.json() : {};
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
  e.waitUntil(self.registration.showNotification(title, options));
});

// Notification click
self.addEventListener('notificationclick', e => {
  e.notification.close();
  if (e.action === 'view') {
    e.waitUntil(clients.openWindow(e.notification.data.url || '/'));
  }
});
