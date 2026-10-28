/* GeoTag IRL service worker: offline app shell + cached libraries + light tile cache.
   deploy.sh rewrites VERSION on every deploy so phones pick up new files. */
const VERSION = 'geotag-20261028192200';
const SHELL = `${VERSION}-shell`;
const LIBS = `${VERSION}-libs`;
const TILES = 'geotag-tiles';          // kept across versions
const TILE_MAX = 400;

const SHELL_FILES = ['./', 'index.html', 'styles.css', 'app.js', 'manifest.json',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png'];
const LIB_FILES = [
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/peerjs/1.5.2/peerjs.min.js'
];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const shell = await caches.open(SHELL);
    await shell.addAll(SHELL_FILES);
    const libs = await caches.open(LIBS);
    await Promise.all(LIB_FILES.map(u => libs.add(u).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keep = new Set([SHELL, LIBS, TILES]);
    for (const k of await caches.keys()) if (!keep.has(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

async function staleWhileRevalidate(req, cacheName, trim) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req, { ignoreSearch: true });
  const net = fetch(req).then(async res => {
    if (res && (res.ok || res.type === 'opaque')) {
      await cache.put(req, res.clone());
      if (trim) {
        const keys = await cache.keys();
        for (let i = 0; i < keys.length - trim; i++) await cache.delete(keys[i]);
      }
    }
    return res;
  }).catch(() => null);
  return hit || (await net) || Response.error();
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
  return res;
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    if (req.mode === 'navigate') {
      e.respondWith(staleWhileRevalidate(req, SHELL).then(r => r.type === 'error' ? caches.match('index.html') : r));
    } else e.respondWith(staleWhileRevalidate(req, SHELL));
  } else if (url.hostname === 'cdnjs.cloudflare.com') {
    e.respondWith(cacheFirst(req, LIBS));
  } else if (url.hostname === 'tile.openstreetmap.org') {
    e.respondWith(staleWhileRevalidate(req, TILES, TILE_MAX));
  }
  // everything else (PeerJS signalling etc.) goes straight to the network
});
