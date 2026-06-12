// KingaPlay Service Worker v5.0
// IMPORTANTE: Cambiar CACHE_NAME en cada release fuerza limpieza del caché viejo

const CACHE_NAME   = 'kingaplay-v5';   // ← actualizado desde v3
const OFFLINE_PAGE = './index.html';

const PRECACHE_ASSETS = [
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
];

// INSTALL — precachear assets nuevos
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE_ASSETS))
      .then(() => self.skipWaiting())   // activar inmediatamente sin esperar
  );
});

// ACTIVATE — eliminar TODOS los caches viejos
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(k => k !== CACHE_NAME)   // borrar kingaplay-v3, v4, etc.
          .map(k => {
            console.log('[SW] Eliminando caché viejo:', k);
            return caches.delete(k);
          })
      ))
      .then(() => self.clients.claim())    // tomar control de todas las pestañas
  );
});

// FETCH — Network First para navegación, Cache First para assets
self.addEventListener('fetch', event => {
  const req = event.request;
  const url = req.url;

  // Ignorar: blob, chrome-extension, data, no-http
  if (!url.startsWith('http')) return;
  if (url.startsWith('blob:')) return;
  if (url.startsWith('chrome-extension:')) return;

  // Navegación → Network First (siempre trae versión fresca si hay red)
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then(res => {
          // Si la respuesta es válida, actualizamos el caché
          if (res && res.status === 200) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then(c => c.put(req, clone));
          }
          return res;
        })
        .catch(() => caches.match(OFFLINE_PAGE))
    );
    return;
  }

  // Assets propios → Network First con fallback a caché
  try {
    const origin = new URL(url).origin;
    if (origin === self.location.origin) {
      event.respondWith(
        fetch(req)
          .then(res => {
            if (res && res.status === 200 && res.type !== 'opaque') {
              const clone = res.clone();
              caches.open(CACHE_NAME).then(c => c.put(req, clone));
            }
            return res;
          })
          .catch(() => caches.match(req).then(c => c || caches.match(OFFLINE_PAGE)))
      );
      return;
    }
  } catch(e) {}

  // Recursos externos (Google Fonts, streams, etc.) → Network puro
  event.respondWith(
    fetch(req).catch(() => caches.match(req))
  );
});

// Mensaje para forzar actualización desde la app
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
