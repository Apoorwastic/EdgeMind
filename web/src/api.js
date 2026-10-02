// Thin client for the device API. Everything is relative, so the same build
// talks to whichever device process served it.
//
// When the device can't be reached (the deployed demo with Wi-Fi off, or the device process is down)
// the client switches to "browser mode": reads come from the last copy this browser saw, note changes
// queue in an outbox, and questions are answered by the browser's own search + offline AI. The outbox
// is replayed to the device as soon as it answers again, and the device then syncs as usual.
import { aiStatus, ask as askInBrowser, ensureEngine, search as searchInBrowser } from './offline/brain.js'
import * as local from './offline/local.js'

// Toggling Wi-Fi makes the browser abort requests for a moment (net::ERR_NETWORK_CHANGED), even to
// localhost. The device itself is still up, so retry network-level failures briefly before giving up.
async function fetchRetry(path, init, tries = 4) {
  for (let i = 1; ; i++) {
    try {
      return await fetch(path, init)
    } catch (e) {
      if (i >= tries || e.name === 'AbortError') throw e
      await new Promise((res) => setTimeout(res, 400 * i))
    }
  }
}

// ---------------------------------------------------------------- device reachability

class Unreachable extends Error {}
let browserMode = false
let browserSince = null
const listeners = new Set()
const chatListeners = new Set() // browser-mode chats changed (the device's live events can't reach us then)

export const link = {
  get browser() { return browserMode },
  // fn(browserMode) whenever the page switches between the device and browser mode
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
  onChats(fn) { chatListeners.add(fn); return () => chatListeners.delete(fn) },
}

function setBrowser(on) {
  if (on === browserMode) return
  browserMode = on
  browserSince = on ? Date.now() : null
  local.logActivity('network', on ? 'Device unreachable — running from this browser' : 'Device reachable again')
  if (!on) flushOutbox()
  // Warm up the offline model now, so the first question asked offline doesn't wait for it to load.
  if (on && aiStatus().downloaded) ensureEngine().catch((e) => console.warn('offline model failed to load', e))
  listeners.forEach((fn) => fn(on))
}

// One request to the device. Gateway errors (the device process is down behind the proxy) count as unreachable.
async function send(path, init, { stream = false } = {}) {
  // A hung GET (half-dead network) counts as unreachable; writes and streams may legitimately take long.
  const hang = !stream && init.method === 'GET' && AbortSignal.timeout(browserMode ? 5000 : 20000)
  const signals = [init.signal, hang].filter(Boolean)
  let r
  try {
    // In browser mode try once: offline, a request fails instantly; retries would only delay the fallback.
    r = await fetchRetry(path, { ...init, signal: AbortSignal.any(signals) }, browserMode ? 1 : 4)
  } catch (e) {
    if (init.signal?.aborted) throw e // the user pressed Stop
    setBrowser(true)
    throw new Unreachable(e.message)
  }
  if ([502, 503, 504].includes(r.status)) { setBrowser(true); throw new Unreachable(r.statusText) }
  setBrowser(false)
  return r
}

async function direct(method, path, body) {
  const r = await send(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!r.ok) {
    let detail = r.statusText
    try { detail = (await r.json()).detail || detail } catch { /* not json */ }
    const err = new Error(detail)
    err.status = r.status
    throw err
  }
  const data = await r.json()
  if (method === 'GET') {
    local.cache.put(path, data)
    if (path === 'api/state') local.rememberDevice(data.device)
  }
  return data
}

async function req(method, path, body) {
  try {
    return await direct(method, path, body)
  } catch (e) {
    if (e instanceof Unreachable) return offline(method, path, body)
    throw e
  }
}

// Replay note changes made while the device was unreachable, oldest first.
let flushing = false
async function flushOutbox() {
  if (flushing) return
  flushing = true
  let sent = 0
  try {
    for (let ops = local.outbox.all(); ops.length; ops = local.outbox.all()) {
      const o = ops[0]
      try {
        if (o.op === 'add') await direct('POST', 'api/memories', { text: o.text, sensitivity: o.sensitivity, team_id: o.teamId ?? null })
        else if (o.op === 'edit') await direct('PATCH', `api/memories/${o.id}`, o.patch)
        else await direct('DELETE', `api/memories/${o.id}`)
      } catch (e) {
        if (e instanceof Unreachable) return // gone again: keep the rest for next time
        console.warn('dropping queued change the device refused', o, e) // e.g. 404: deleted elsewhere
      }
      local.outbox.set(local.outbox.all().filter((x) => !(x.op === o.op && x.id === o.id && x.ts === o.ts)))
      sent++
    }
  } finally {
    flushing = false
    if (sent) {
      local.logActivity('sync', `Sent ${sent} change${sent > 1 ? 's' : ''} made offline to the device`)
      listeners.forEach((fn) => fn(browserMode))
    }
  }
}

// ---------------------------------------------------------------- browser mode

function offlineState() {
  const s = local.cache.get('api/state')
  if (!s) throw new Error('This device hasn’t been opened online in this browser yet')
  const mem = local.mirrorMemories().filter((m) => !m.superseded_by)
  const pending = mem.filter((m) => m.sensitivity === 'shareable' && !m.synced).length
  const ai = aiStatus()
  return {
    ...s,
    network: { ...s.network, online: false, mode: 'browser', cloud_reachable: false, internet: false, quality: 'none',
      latency_ms: null, since: browserSince || Date.now() },
    memory: { total: mem.length, private: mem.filter((m) => m.sensitivity === 'private').length,
      shareable: mem.filter((m) => m.sensitivity === 'shareable').length, pending },
    sync: { ...s.sync, running: false, pending },
    models: { embedder: ai.search ? 'bge-small · in this browser' : 'keyword search · in this browser',
      local_llm: local.aiPrefs.get()?.name || ai.model, cloud_llm: null, cloud_llm_error: null },
  }
}

function chatTurns(cid) {
  const server = cid ? local.cache.get(`api/chats/${cid}`) || [] : []
  return [...server, ...local.chats.turns(cid)].sort((a, b) => a.ts - b.ts)
}

function chatList() {
  const byId = new Map((local.cache.get('api/chats') || []).map((c) => [c.id, { ...c }]))
  for (const [cid, turns] of Object.entries(local.chats.all())) {
    if (!turns.length) continue
    const c = byId.get(cid) || { id: cid, title: null, ts: 0, turns: 0 }
    c.title ||= turns.find((t) => t.role === 'user')?.text.slice(0, 80)
    c.ts = Math.max(c.ts, ...turns.map((t) => t.ts))
    c.turns += turns.length
    byId.set(cid, c)
  }
  return [...byId.values()].sort((a, b) => b.ts - a.ts)
}

const NOT_OFFLINE = 'Not available while the device is unreachable — reconnect first.'

async function offline(method, path, body) {
  const [, a, b] = path.split('/') // api/<a>/<b>
  const key = `${method} ${a}`
  if (method === 'GET') {
    if (path === 'api/state') return offlineState()
    if (path === 'api/memories') return local.mirrorMemories()
    if (path === 'api/chats') return chatList()
    if (a === 'chats' && b) return chatTurns(b)
    if (path === 'api/activity') return [...(local.cache.get(path) || []), ...local.browserActivity()].sort((x, y) => x.ts - y.ts)
    const isCloud = path.startsWith('api/cloud')
    const cached = local.cache.get(path)
    if (cached !== undefined) return isCloud ? { ...cached, live: false } : cached
    if (isCloud) return { live: false, records: [], as_of: null }
    return { 'api/conflicts': [], 'api/egress': [], 'api/team': { teams: [] } }[path] ?? null
  }
  const device = local.cache.get('api/state')?.device
  switch (key) {
    case 'POST memories':
      if (b) throw new Error(NOT_OFFLINE) // supersede
      return { memory: local.queueAdd(body.text, body.sensitivity, device, body.team_id), related: [] }
    case 'PATCH memories': {
      const m = local.mirrorMemories().find((x) => x.mem_id === b)
      if (!m) throw new Error('not found')
      if (body.sensitivity === 'private' && m.origin && device && m.origin !== device.id) {
        throw new Error('Shared from another device — it isn’t yours to make private.')
      }
      local.queueEdit(b, body)
      return local.mirrorMemories().find((x) => x.mem_id === b)
    }
    case 'DELETE memories':
      local.queueDelete(b)
      return { ok: true }
    case 'POST search':
      return searchInBrowser(body.q, local.mirrorMemories(), 8)
    case 'POST network':
      return offlineState().network
    case 'POST sync':
      return { ok: false, reason: 'device unreachable' }
    default:
      throw new Error(NOT_OFFLINE)
  }
}

export const api = {
  state: () => req('GET', 'api/state'),
  memories: () => req('GET', 'api/memories'),
  addMemory: (text, sensitivity, supersedes, teamId) => req('POST', 'api/memories', { text, sensitivity, supersedes, team_id: teamId ?? null }),
  editMemory: (id, patch) => req('PATCH', `api/memories/${id}`, patch),
  deleteMemory: (id) => req('DELETE', `api/memories/${id}`),
  supersede: (id, oldId) => req('POST', `api/memories/${id}/supersede/${oldId}`),
  search: (q) => req('POST', 'api/search', { q }),
  chats: () => req('GET', 'api/chats'),
  // A chat can hold turns from both the device and this browser (asked while the device was unreachable).
  chat: async (cid) => {
    const turns = await req('GET', `api/chats/${cid}`)
    return browserMode ? turns : [...turns, ...local.chats.turns(cid)].sort((a, b) => a.ts - b.ts)
  },
  deleteChat: async (cid) => {
    const inBrowser = local.chats.turns(cid).length > 0
    local.chats.remove(cid)
    try {
      return await req('DELETE', `api/chats/${cid}`)
    } catch (e) {
      if (inBrowser) return { ok: true } // it only existed in this browser
      throw e
    }
  },
  cloud: (teamId) => req('GET', `api/cloud?team_id=${encodeURIComponent(teamId)}`),
  conflicts: () => req('GET', 'api/conflicts'),
  restore: (cid) => req('POST', `api/conflicts/${cid}/restore`),
  activity: () => req('GET', 'api/activity'),
  egress: () => req('GET', 'api/egress'),
  audit: () => req('GET', 'api/privacy/audit'),
  setNetwork: (mode) => req('POST', 'api/network', { mode }),
  recheckNetwork: () => req('POST', 'api/network/recheck'),
  setPrefs: (private_route) => req('POST', 'api/prefs', { private_route }),
  sync: () => req('POST', 'api/sync'),
  team: () => req('GET', 'api/team'),
  createTeam: (name) => req('POST', 'api/team', { name }),
  joinTeam: (code) => req('POST', 'api/team/join', { code }),
  leaveTeam: (teamId, resolution) => req('POST', `api/team/${teamId}/leave${resolution ? `?resolution=${resolution}` : ''}`),
  renameTeam: (teamId, name) => req('POST', `api/team/${teamId}/rename`, { name }),
  newTeamCode: (teamId) => req('POST', `api/team/${teamId}/code`),
  removeMember: (teamId, deviceId) => req('DELETE', `api/team/${teamId}/members/${deviceId}`),

  // Streams NDJSON events from /api/ask: chat → retrieval → token* → (reroute) → done.
  // cid continues a conversation; without it the device starts a new one and reports its id.
  // Aborting `signal` (the Stop button) closes the stream; the device stops generating and keeps the partial answer.
  // If the device can't be reached, the question is answered in this browser with the same events.
  async ask(q, cid, onEvent, signal) {
    // The device is up but can't write answers (e.g. a small server whose model gets killed for lack of
    // memory, and no cloud key): if this browser has the offline AI, let it write the answer instead.
    const models = local.cache.get('api/state')?.models
    if (!browserMode && models && !models.local_llm && !models.cloud_llm && aiStatus().downloaded) {
      try {
        return await askInBrowser(q, cid, onEvent, signal, { memories: local.mirrorMemories(), history: chatTurns(cid),
          why: 'the server has no AI model running · answered in this browser' })
      } finally {
        chatListeners.forEach((fn) => fn())
      }
    }
    let r
    try {
      r = await send('api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q, cid }),
        signal,
      }, { stream: true })
    } catch (e) {
      if (!(e instanceof Unreachable)) throw e
      try {
        return await askInBrowser(q, cid, onEvent, signal, { memories: local.mirrorMemories(), history: chatTurns(cid) })
      } finally {
        chatListeners.forEach((fn) => fn())
      }
    }
    if (!r.ok) {
      // e.g. 429 from the public demo's rate limit: show the reason in the answer bubble.
      let detail = r.statusText
      try { detail = (await r.json()).detail || detail } catch { /* not json */ }
      onEvent({ type: 'token', t: detail })
      onEvent({ type: 'done', route: 'retrieval' })
      return
    }
    const reader = r.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (line) onEvent(JSON.parse(line))
      }
    }
  },
}

export function subscribe(handlers) {
  const es = new EventSource('api/events')
  for (const [name, fn] of Object.entries(handlers)) {
    es.addEventListener(name, (e) => fn(e.data ? JSON.parse(e.data) : null))
  }
  return () => es.close()
}

export const fmtTime = (ts) =>
  ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '—'

// Friendly device names for the two demo devices; anything else is prettified from its id.
const DEVICE_NAMES = { device_a: 'Laptop', device_b: 'Mobile' }
export const deviceName = (id) =>
  DEVICE_NAMES[id] || (id ? id.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : 'unknown device')

export function ago(ts) {
  if (!ts) return 'never'
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  return `${Math.floor(s / 3600)}h ago`
}
