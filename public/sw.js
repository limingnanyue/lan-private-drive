const version = 'lan-drive-shell-v9';
const shell = ['/', '/style.css', '/app.js', '/ui.js', '/files.js', '/views.js', '/shares-ui.js', '/preview.js', '/offline.js', '/transfer.js',
  '/vendor/icons/bootstrap-icons.min.css', '/vendor/icons/fonts/bootstrap-icons.woff2',
  '/vendor/barlow/barlow-latin-500-normal.woff2', '/vendor/barlow/barlow-latin-600-normal.woff2', '/vendor/barlow/barlow-latin-700-normal.woff2',
  '/vendor/pdf/build/pdf.mjs', '/vendor/pdf/build/pdf.worker.mjs', '/vendor/highlight/highlight.min.js', '/vendor/highlight/styles/github.min.css'];

self.addEventListener('install', (event) => event.waitUntil(caches.open(version).then((cache) => cache.addAll(shell)).then(() => self.skipWaiting())));
self.addEventListener('activate', (event) => event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith('lan-drive-shell-') && key !== version).map((key) => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('fetch', (event) => {
  const address = new URL(event.request.url);
  if (address.origin !== location.origin || event.request.method !== 'GET' || (!shell.includes(address.pathname) && !address.pathname.startsWith('/vendor/'))) return;
  event.respondWith(fetch(event.request).then((response) => {
    if (response.ok) {
      const copy = response.clone();
      caches.open(version).then((cache) => cache.put(address.pathname, copy)).catch(() => {});
    }
    return response;
  }).catch(async () => (await caches.match(address.pathname)) ?? Response.error()));
});
