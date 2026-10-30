const CACHE_NAME = 'memory-trainer-v4';
const urlsToCache = [
    '/',
    '/index.html',
    '/styles.css',
    '/game.js',
    '/manifest.json'
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(urlsToCache))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys()
            .then(names => Promise.all(names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', event => {
    if (event.request.method !== 'GET' && !event.request.url.includes('/api/')) return;

    if (event.request.url.includes('/api/')) {
        event.respondWith(
            fetch(event.request).catch(() => new Response(
                JSON.stringify({ offline: true }),
                { status: 503, headers: { 'Content-Type': 'application/json' } }
            ))
        );
        return;
    }

    event.respondWith(
        fetch(event.request)
            .then(response => {
                if (response && response.status === 200 && response.type === 'basic') {
                    const copy = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
                }
                return response;
            })
            .catch(() => caches.match(event.request))
    );
});
