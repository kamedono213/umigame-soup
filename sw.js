const CACHE_NAME = 'umigame-soup-v1';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './src/app.js',
  './src/db.js',
  './src/room.js',
  './src/puzzles.js',
  './src/firebase-config.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

// ネットワーク優先: 更新をキャッシュに埋もれさせないよう、まずネットワークから
// 取りに行き、オフラインの時だけキャッシュにフォールバックする。
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request).then((response) => {
      if (!response || response.status !== 200 || response.type === 'opaque') return response;
      const copy = response.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
      return response;
    }).catch(() => caches.match(event.request).then((cached) => cached || caches.match('./index.html')))
  );
});
