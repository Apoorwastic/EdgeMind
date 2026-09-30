// Thin client for the device API. Everything is relative, so the same build
// talks to whichever device process served it.

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

async function req(method, path, body) {
  const r = await fetchRetry(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!r.ok) {
    let detail = r.statusText
    try { detail = (await r.json()).detail || detail } catch { /* not json */ }
    throw new Error(detail)
  }
  return r.json()
}

export const api = {
  state: () => req('GET', 'api/state'),
  memories: () => req('GET', 'api/memories'),
  addMemory: (text, sensitivity, supersedes) => req('POST', 'api/memories', { text, sensitivity, supersedes }),
  editMemory: (id, patch) => req('PATCH', `api/memories/${id}`, patch),
  deleteMemory: (id) => req('DELETE', `api/memories/${id}`),
  supersede: (id, oldId) => req('POST', `api/memories/${id}/supersede/${oldId}`),
  search: (q) => req('POST', 'api/search', { q }),
  chats: () => req('GET', 'api/chats'),
  chat: (cid) => req('GET', `api/chats/${cid}`),
  deleteChat: (cid) => req('DELETE', `api/chats/${cid}`),
  cloud: () => req('GET', 'api/cloud'),
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
  leaveTeam: () => req('POST', 'api/team/leave'),
  renameTeam: (name) => req('POST', 'api/team/rename', { name }),
  newTeamCode: () => req('POST', 'api/team/code'),
  removeMember: (deviceId) => req('DELETE', `api/team/members/${deviceId}`),

  // Streams NDJSON events from /api/ask: chat → retrieval → token* → (reroute) → done.
  // cid continues a conversation; without it the device starts a new one and reports its id.
  // Aborting `signal` (the Stop button) closes the stream; the device stops generating and keeps the partial answer.
  async ask(q, cid, onEvent, signal) {
    const r = await fetchRetry('api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q, cid }),
      signal,
    })
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
