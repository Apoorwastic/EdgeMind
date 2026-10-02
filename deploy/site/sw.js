// The demo page used to keep itself offline with this worker, registered at /. The main link is now the
// sign-in page (/app/, which has its own worker), so this one clears its cache and removes itself.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k.startsWith('edgemind-site')) await caches.delete(k)
  await self.registration.unregister()
  for (const c of await self.clients.matchAll({ type: 'window' })) c.navigate(c.url)
})()))
