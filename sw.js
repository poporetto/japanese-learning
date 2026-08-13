const CACHE = 'kaiwassap-v3';
const CORE = [
  './', './index.html', './manifest.webmanifest', './src/styles.css', './src/app.js',
  './src/engine/engine.js', './src/engine/state.js', './src/engine/director.js',
  './assets/portraits/yui-chat-profile.png', './assets/icons/kaiwassap-192.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(CORE)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== location.origin) return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) caches.open(CACHE).then((cache) => cache.put(event.request, response.clone()));
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match('./index.html')))
  );
});

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data?.json() || {}; } catch { data = { body: event.data?.text() || '' }; }
  event.waitUntil(self.registration.showNotification(data.title || '結衣 Yui', {
    body: data.body || 'ちょっと話したくなった。',
    icon: './assets/portraits/yui-chat-profile.png',
    badge: './assets/icons/kaiwassap-192.png',
    tag: data.tag || 'yui-background', renotify: true,
    ...(data.image ? { image: data.image } : {}),
    data: { url: data.url || './', message: data.message || null },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || './', self.registration.scope).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (clients) => {
    const existing = clients.find((client) => new URL(client.url).origin === new URL(target).origin);
    if (existing) { await existing.focus(); existing.postMessage({ type: 'PUSH_OPENED', payload: event.notification.data }); return; }
    return self.clients.openWindow(target);
  }));
});
