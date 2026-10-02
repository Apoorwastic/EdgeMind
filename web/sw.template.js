// EdgeMind service worker — keeps the app itself available with no internet.
// Generated at build time from web/sw.template.js; PRECACHE lists this build's app shell.
const VERSION = '__VERSION__'
const PRECACHE = __PRECACHE__
// Caches are shared by every page of the origin (the deployed /laptop/, /mobile/ and the / showcase each
// run their own worker), so names carry this worker's scope and each worker only ever deletes its own.
const SCOPE = new URL(self.registration.scope).pathname
const PREFIX = `edgemind:${SCOPE}:`
const CACHE = `${PREFIX}${VERSION}` // this build's app shell, replaced on every deploy
// Files fetched on first use (the 6 MB offline-AI library, the ONNX runtime). Their names are content
// hashes, so they never go stale; keeping them across deploys means a new build doesn't silently remove
// the code the offline AI needs — which, offline, made the page think the model itself was gone.
const RUNTIME = `${PREFIX}runtime`
const scope = () => new URL(self.registration.scope)

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE.map((u) => new Request(u, { cache: 'reload' })))))
  self.skipWaiting()
})

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) {
      const oldOwn = k.startsWith(PREFIX) && k !== CACHE && k !== RUNTIME
      const legacy = /^edgemind-[0-9a-f]{10}$/.test(k) // unscoped names from earlier builds
      if (oldOwn || legacy) await caches.delete(k)
    }
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
  const hit = (await (await caches.open(CACHE)).match(req)) || (await (await caches.open(RUNTIME)).match(req))
  if (hit) return hit
  const res = await fetch(req)
  if (res.ok) (await caches.open(RUNTIME)).put(req, res.clone())
  return res
}
