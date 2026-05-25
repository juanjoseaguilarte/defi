const CACHE_PREFIX = 'defi-';
const STATIC_ASSETS = [
    '/',
    '/assets/app.css',
    '/assets/app.js',
    '/manifest.json',
];

self.addEventListener('install', event => {
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k.startsWith(CACHE_PREFIX)).map(k => caches.delete(k)))
        ).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);

    if (url.pathname.startsWith('/api/')) {
        event.respondWith(fetch(event.request));
        return;
    }

    event.respondWith(
        fetch(event.request).catch(() => caches.match(event.request))
    );
});

// ── Push Notifications ──
self.addEventListener('push', event => {
    if (!event.data) return;
    const data = event.data.json();
    const options = {
        body: data.body || '',
        icon: '/assets/icon-192.png',
        badge: '/assets/icon-192.png',
        tag: data.tag || 'defi-alert',
        renotify: data.renotify || false,
        data: data.data || {},
        actions: [{ action: 'open', title: 'Ver' }, { action: 'dismiss', title: 'OK' }],
        vibrate: data.data?.type === 'critical' ? [200, 100, 200, 100, 200] : [200, 100, 200],
    };
    event.waitUntil(self.registration.showNotification(data.title || 'DeFi Alert', options));
});

self.addEventListener('notificationclick', event => {
    event.notification.close();
    if (event.action === 'dismiss') return;
    const url = event.notification.data?.url || '/';
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
            for (const c of list) {
                if (c.url.includes(url) && 'focus' in c) return c.focus();
            }
            return clients.openWindow(url);
        })
    );
});

self.addEventListener('message', event => {
    if (event.data === 'skipWaiting') {
        self.skipWaiting();
    }
});
