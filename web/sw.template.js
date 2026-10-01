// EdgeMind service worker — keeps the app itself available with no internet.
// Generated at build time from web/sw.template.js; PRECACHE lists this build's app shell.
const VERSION = '__VERSION__'
const PRECACHE = __PRECACHE__
const CACHE = `edgemind-${VERSION}`
const scope = () => new URL(self.registration.scope)

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE.map((u) => new Request(u, { cache: 'reload' })))))
  self.skipWaiting()
})

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('edgemind-') && k !== CACHE) await caches.delete(k)
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  const root = scope()
  // Only this app's own files. The API is never cached here (the page keeps its own copy of the data),
  // and model downloads from other origins are cached by the AI libraries themselves.
  if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname)) return
  const rel = url.pathname.slice(root.pathname.length)
  if (rel.startsWith('api/')) return
  if (req.mode === 'navigate' || rel === '' || rel === 'index.html') e.respondWith(page(req))
  else e.respondWith(file(req))
})

// The page: newest when online (so a new deploy shows up), cached copy when not.
async function page(req) {
  const cache = await caches.open(CACHE)
  const key = new URL('./', self.registration.scope).href
  try {
    const res = await fetch(req)
    if (res.ok) cache.put(key, res.clone())
    return res
  } catch {
    return (await cache.match(key)) || (await cache.match(new URL('index.html', self.registration.scope).href)) ||
      new Response('EdgeMind is offline and this page was never opened online.', { status: 503 })
  }
}

// Hashed build files never change: cache first. Files loaded later (the offline-AI code) are cached on first use.
async function file(req) {
  const cache = await caches.open(CACHE)
  const hit = await cache.match(req)
  if (hit) return hit
  const res = await fetch(req)
  if (res.ok) cache.put(req, res.clone())
  return res
}
