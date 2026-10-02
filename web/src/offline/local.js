// Browser-side copy of this device, so the page keeps working when the device can't be reached
// (e.g. the deployed demo with Wi-Fi off). Everything lives in this browser's localStorage,
// namespaced per device path (/laptop/ and /mobile/ share an origin when deployed).

const NS = `em:${window.location.pathname.replace(/[^/]*$/, '')}:`

function read(key, fallback) {
  try {
    const v = localStorage.getItem(NS + key)
    return v == null ? fallback : JSON.parse(v)
  } catch {
    return fallback
  }
}

function write(key, value) {
  try { localStorage.setItem(NS + key, JSON.stringify(value)) } catch { /* full or blocked: best effort */ }
}

// ---------------------------------------------------------------- read-through cache of device GETs

export const cache = {
  get: (path) => read(`get:${path}`, undefined),
  put: (path, value) => write(`get:${path}`, value),
}

// ---------------------------------------------------------------- outbox: note changes made offline

// Ops, in order: {op:'add', id, text, sensitivity, ts} · {op:'edit', id, patch} · {op:'delete', id}
// A note created offline has a temporary id (b_…) until the device assigns its real one.
export const outbox = {
  all: () => read('outbox', []),
  set: (ops) => write('outbox', ops),
  clear: () => write('outbox', []),
}

const tmpId = (p) => `${p}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`

export function queueAdd(text, sensitivity, device, teamId = null) {
  const now = Date.now()
  const rec = {
    mem_id: tmpId('b'), text, sensitivity, team_id: teamId, role: 'user', origin: device?.id, updated_by: device?.id,
    synced: false, ts: now, updated_ts: now, rev: 0, base_rev: 0, offline: true,
  }
  outbox.set([...outbox.all(), { op: 'add', id: rec.mem_id, text, sensitivity, teamId, ts: now }])
  return rec
}

export function queueEdit(id, patch) {
  const ops = outbox.all()
  const add = ops.find((o) => o.op === 'add' && o.id === id)
  if (add) Object.assign(add, patch) // still only in this browser: just change what will be sent
  else ops.push({ op: 'edit', id, patch })
  outbox.set(ops)
}

export function queueDelete(id) {
  let ops = outbox.all()
  const local = ops.some((o) => o.op === 'add' && o.id === id)
  ops = ops.filter((o) => o.id !== id)
  if (!local) ops.push({ op: 'delete', id })
  outbox.set(ops)
}

// The device's notes as last seen, with the outbox applied on top.
export function mirrorMemories() {
  let list = (cache.get('api/memories') || []).map((m) => ({ ...m }))
  for (const o of outbox.all()) {
    if (o.op === 'add') {
      list.push({ mem_id: o.id, text: o.text, sensitivity: o.sensitivity, team_id: o.teamId ?? null, role: 'user', origin: read('device', {}).id,
        synced: false, ts: o.ts, updated_ts: o.ts, rev: 0, base_rev: 0, offline: true })
    } else if (o.op === 'edit') {
      const m = list.find((x) => x.mem_id === o.id)
      if (m) Object.assign(m, o.patch, { updated_ts: Date.now(), ...(o.patch.sensitivity || m.sensitivity === 'shareable' ? { synced: false } : {}) })
    } else if (o.op === 'delete') {
      list = list.filter((x) => x.mem_id !== o.id)
    }
  }
  return list
}

export const rememberDevice = (device) => write('device', device)

// ---------------------------------------------------------------- chats held in this browser

export const chats = {
  all: () => read('chats', {}), // cid -> turns[]
  turns: (cid) => read('chats', {})[cid] || [],
  append: (cid, ...turns) => {
    const all = read('chats', {})
    all[cid] = [...(all[cid] || []), ...turns]
    write('chats', all)
  },
  remove: (cid) => {
    const all = read('chats', {})
    delete all[cid]
    write('chats', all)
  },
  newId: () => tmpId('c'),
}

// ---------------------------------------------------------------- activity + offline-AI prefs

export function logActivity(kind, message) {
  const list = read('activity', [])
  list.push({ seq: `b${Date.now()}`, ts: Date.now(), kind, message, browser: true })
  write('activity', list.slice(-100))
}
export const browserActivity = () => read('activity', [])

export const aiPrefs = {
  get: () => read('offline-ai', null), // {model, ts} once downloaded
  set: (v) => write('offline-ai', v),
}
