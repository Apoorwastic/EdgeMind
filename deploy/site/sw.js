// Keeps the demo page itself (laptop + phone side by side) available offline.
// /laptop/ and /mobile/ have their own service workers; everything outside this page passes through.
const CACHE = 'edgemind-site-v1'

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  if (e.request.method !== 'GET' || url.origin !== location.origin) return
  if (url.pathname !== '/' && url.pathname !== '/index.html') return
  e.respondWith((async () => {
    const cache = await caches.open(CACHE)
    try {
      const res = await fetch(e.request)
      if (res.ok) cache.put('/', res.clone())
      return res
    } catch {
      return (await cache.match('/')) || Response.error()
    }
  })())
})
