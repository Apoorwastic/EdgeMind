// The device's brain, rebuilt inside the browser for when the device can't be reached:
// hybrid search over the local copy of your notes, and an on-device model (WebLLM on WebGPU)
// that writes answers. Both download once while online — automatically, sized to this device —
// and then load from the browser's cache, so they work with no internet at all.
import { aiPrefs, chats, logActivity } from './local.js'

// Same prompts as the device (edge/llm.py), so answers read the same online and offline.
const SYSTEM =
  "You are EdgeMind, a personal memory assistant. Answer the user's question using ONLY the " +
  'memories provided. Memories are listed newest first; if two memories conflict, prefer the newer one ' +
  'and say that an older note disagreed. If the memories do not contain the answer, say so plainly — ' +
  'do not invent facts. Be concise (1-4 sentences). Cite memories inline like [1], [2].'
const SYSTEM_GENERAL =
  "You are EdgeMind, a helpful assistant. Nothing in the user's personal notes matched this question, " +
  'so answer from your general knowledge. Do not claim the answer comes from their notes or memories. ' +
  'Be clear and concise (at most 6 sentences, or a short list). If you are not sure, say so.'
const STOP = ['\n###', '### ', '\nQuestion:', '\nMemories:', '\nUser:', '<|end|>', '<|user|>', '<|im_end|>']

// Small models lose track when handed many notes: answer from the best few, and only look further
// down the list when those didn't contain the answer.
const NOTES_PER_PASS = 3

// ---------------------------------------------------------------- model catalog

// Download sizes are the real weight sizes on Hugging Face (mlc-ai/<id>/tensor-cache.json).
// f32 variants are for GPUs without half-precision shaders (shader-f16).
export const CATALOG = [
  { key: 'phone', label: 'Phone', name: 'Gemma 3 1B', gb: 0.56, hint: 'Fast. For phones and older laptops.',
    f16: 'gemma3-1b-it-q4f16_1-MLC', f32: 'Llama-3.2-1B-Instruct-q4f32_1-MLC', f32Name: 'Llama 3.2 1B', f32Gb: 0.7 },
  { key: 'standard', label: 'Standard', name: 'Qwen3.5 2B', gb: 1.06, hint: 'Good answers on most laptops.',
    f16: 'Qwen3.5-2B-q4f16_1-MLC', f32: 'Qwen3.5-2B-q4f32_1-MLC', thinking: true },
  { key: 'best', label: 'Best', name: 'Qwen3.5 4B', gb: 2.37, hint: 'Best answers. Needs a strong GPU.',
    f16: 'Qwen3.5-4B-q4f16_1-MLC', f32: 'Qwen3.5-4B-q4f32_1-MLC', thinking: true },
  { key: 'llama-1b', label: 'Llama 3.2 1B', name: 'Llama 3.2 1B', gb: 0.7, hint: 'Alternative small model.', extra: true,
    f16: 'Llama-3.2-1B-Instruct-q4f16_1-MLC', f32: 'Llama-3.2-1B-Instruct-q4f32_1-MLC' },
  { key: 'phi-4-mini', label: 'Phi-4 mini', name: 'Phi-4 mini', gb: 2.16, hint: 'Alternative large model, strong reasoning.', extra: true,
    f16: 'Phi-4-mini-instruct-q4f16_1-MLC', f32: 'Phi-4-mini-instruct-q4f32_1-MLC' },
]

// Which concrete build of a catalog entry this GPU runs.
export function resolve(entry, gpu) {
  const f16 = gpu?.f16 !== false
  return f16 || !entry.f32Name
    ? { id: f16 ? entry.f16 : entry.f32, name: entry.name, gb: entry.gb }
    : { id: entry.f32, name: entry.f32Name, gb: entry.f32Gb }
}
const entryFor = (id) => CATALOG.find((e) => e.f16 === id || e.f32 === id)

// Search model: bge-small-en-v1.5 (33M params, ~34 MB) finds the right note more often than MiniLM at
// the same size. It runs on the CPU via WebAssembly, so it works even without WebGPU.
const EMBED = {
  id: 'Xenova/bge-small-en-v1.5',
  pooling: 'cls',
  queryPrefix: 'Represent this sentence for searching relevant passages: ',
  // Calibrated on the demo notes (scratch run, 12 note questions + 5 general ones): the right note scored
  // 0.59–0.80, the best note for a general question 0.38–0.46. The floor sits between the two; the band
  // keeps a second note only when it scores nearly as well as the best one.
  min: 0.52,
  band: 0.08,
}

// ---------------------------------------------------------------- device capability

let gpuInfo
export function webgpu() {
  gpuInfo ||= (async () => {
    if (!navigator.gpu) return { ok: false, why: 'This browser has no WebGPU. Use a recent Chrome or Edge.' }
    try {
      const a = await navigator.gpu.requestAdapter()
      if (!a) return { ok: false, why: 'No compatible graphics adapter found.' }
      const info = a.info || {}
      return { ok: true, f16: a.features.has('shader-f16'), maxBuffer: a.limits.maxBufferSize,
        gpu: [info.vendor, info.architecture].filter(Boolean).join(' ') || 'unknown GPU' }
    } catch (e) {
      return { ok: false, why: e.message }
    }
  })()
  return gpuInfo
}

const GB = 1024 ** 3

// What this device can run, which tier to download by default, and why — shown in Admin.
export async function deviceProfile() {
  const gpu = await webgpu()
  const mem = navigator.deviceMemory // GB, rounded and capped at 8 by the browser; undefined outside Chromium
  const mobile = navigator.userAgentData?.mobile ?? /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent)
  const conn = navigator.connection
  const metered = !!(conn?.saveData || conn?.type === 'cellular' || ['slow-2g', '2g', '3g'].includes(conn?.effectiveType))
  let tier = null
  let why
  if (!gpu.ok) why = `${gpu.why} Search still works offline.`
  else if (mobile) { tier = 'phone'; why = 'phone or tablet' }
  else if (mem && mem <= 4) { tier = 'phone'; why = `${mem} GB memory` }
  else if (gpu.maxBuffer < GB) { tier = 'phone'; why = 'GPU allows small models only' }
  else { tier = 'standard'; why = `computer · ${mem ? `${mem} GB+ memory` : 'memory not reported'} · GPU ok` }
  // "Best" is never downloaded automatically (2.4 GB), but we say when the device can take it.
  const canBest = gpu.ok && !mobile && (!mem || mem >= 8) && gpu.maxBuffer >= 2 * GB
  return {
    gpu, mem, mobile, metered, tier, canBest,
    reason: tier ? `${CATALOG.find((e) => e.key === tier).label} — ${why}` : why,
    facts: [
      ['WebGPU', gpu.ok ? 'yes' : 'no'],
      ['Graphics', gpu.ok ? gpu.gpu : '—'],
      ['Half precision', gpu.ok ? (gpu.f16 ? 'yes' : 'no (uses f32 builds)') : '—'],
      ['GPU buffer limit', gpu.ok ? `${(gpu.maxBuffer / GB).toFixed(1)} GB` : '—'],
      ['Memory', mem ? `${mem} GB${mem >= 8 ? '+' : ''}` : 'not reported'],
      ['Device', mobile ? 'phone / tablet' : 'computer'],
      ['Connection', metered ? 'metered or slow' : conn?.effectiveType || 'unknown'],
    ],
  }
}

// ---------------------------------------------------------------- embeddings (semantic search)

let embedP = null
function embedder(progress) {
  embedP ||= import('@huggingface/transformers')
    .then(({ pipeline }) => pipeline('feature-extraction', EMBED.id, { dtype: 'q8', device: 'wasm', progress_callback: progress }))
    .catch((e) => { embedP = null; throw e })
  return embedP
}
const vectors = new Map() // note text -> unit vector
async function embed(texts) {
  const ex = await embedder()
  return (await ex(texts, { pooling: EMBED.pooling, normalize: true })).tolist()
}
async function vectorsFor(texts) {
  const missing = [...new Set(texts.filter((t) => !vectors.has(t)))]
  for (let i = 0; i < missing.length; i += 16) {
    const batch = missing.slice(i, i + 16)
    ;(await embed(batch)).forEach((v, j) => vectors.set(batch[j], v))
  }
  return texts.map((t) => vectors.get(t))
}
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0)
const searchModelReady = () => aiPrefs.get()?.embed === EMBED.id

// ---------------------------------------------------------------- keyword search (always available)

const STOPWORDS = new Set(('a an the is are was were be been am i me my mine you your we our it its of to in on at for by ' +
  'with and or but not no do does did what whats when where who whom which why how can could should would will ' +
  'shall may might this that these those there here from about as into than then so if any some all tell give ' +
  'please thanks thank much many get got have has had s t').split(' '))
const terms = (s) => (s.toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => !STOPWORDS.has(w))
// Light stemming so "appointments" meets "appointment" and "feeding" meets "feed".
const stem = (w) => w.length > 4 ? w.replace(/(ing|ed|es|s)$/, '') : w

function keywordScores(q, docs) {
  const qt = [...new Set(terms(q).map(stem))]
  const toks = docs.map((d) => terms(d.text).map(stem))
  const avg = toks.reduce((s, t) => s + t.length, 0) / Math.max(1, toks.length)
  return toks.map((t) => {
    let score = 0
    for (const w of qt) {
      const tf = t.filter((x) => x === w).length
      if (!tf) continue
      const df = toks.filter((x) => x.includes(w)).length
      const idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5))
      score += idf * (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * t.length / avg))
    }
    return score
  })
}

// Hybrid search over the browser's copy of the notes, best match first.
export async function search(q, memories, limit = 8) {
  const t0 = performance.now()
  const docs = memories.filter((m) => !m.superseded_by)
  const kw = keywordScores(q, docs)
  const kwTop = Math.max(0, ...kw)
  let sem = null
  let embedMs = 0
  if (searchModelReady()) {
    try {
      const e0 = performance.now()
      const [qv] = await embed([EMBED.queryPrefix + q])
      const dv = await vectorsFor(docs.map((d) => d.text))
      sem = dv.map((v) => dot(qv, v))
      embedMs = performance.now() - e0
    } catch (e) {
      console.warn('offline embeddings unavailable, keyword search only', e)
    }
  }
  const semTop = sem ? Math.max(0, ...sem) : 0
  const hits = docs.map((d, i) => {
    const k = kwTop ? kw[i] / kwTop : 0
    const s = sem ? sem[i] : k
    const relevant = sem
      ? (s >= EMBED.min && s >= semTop - EMBED.band) || (kw[i] > 0 && k >= 0.6 && s >= EMBED.min - 0.08)
      : kw[i] > 0 && k >= 0.5
    return { ...d, semantic: s, keyword: kw[i], relevant, score: sem ? s * 0.8 + k * 0.2 : k }
  })
  hits.sort((a, b) => b.score - a.score)
  return {
    hits: hits.slice(0, limit),
    timing: { embed_ms: Math.round(embedMs * 10) / 10, search_ms: Math.round((performance.now() - t0 - embedMs) * 100) / 100 },
  }
}

// ---------------------------------------------------------------- downloads (auto + manual)

let webllmMod = null
const webllm = async () => (webllmMod ||= await import('@mlc-ai/web-llm'))
let engine = null // loaded answer model
let engineP = null
let loading = null // engine mid-download, kept so Cancel can abort it
let cancelled = false
let running = null // promise of the install in progress (the UI may already show "cancelled" while it winds down)

const dl = { phase: 'idle', p: 0, text: '', target: null, auto: false, error: null, profile: null }
const dlListeners = new Set()
const setDl = (patch) => { Object.assign(dl, patch); dlListeners.forEach((fn) => fn({ ...dl })) }

export const downloads = {
  get: () => ({ ...dl }),
  subscribe(fn) { dlListeners.add(fn); return () => dlListeners.delete(fn) },
}

export function aiStatus() {
  const p = aiPrefs.get()
  return { downloaded: !!p?.model, model: p?.model || null, tier: p?.tier || null, auto: !!p?.auto,
    reason: p?.reason || null, search: searchModelReady(), loaded: !!engine, autoOff: !!p?.autoOff }
}

// Laptop and phone pages of the deployed demo share one origin (and one model cache): a lock keeps
// them from downloading the same gigabyte twice at once.
const withLock = (fn) => (navigator.locks ? navigator.locks.request('edgemind-offline-ai', fn) : fn())

// Bytes done → speed and time left, for the progress readout (slow links make a 1 GB model take a while).
// Speed is measured over the last ~15 s, so pieces already on disk (after a resume) don't fake a fast link.
function meter(totalBytes) {
  const samples = []
  return (done) => {
    const now = performance.now()
    samples.push([now, done])
    while (samples.length > 2 && now - samples[0][0] > 15000) samples.shift()
    const [t0, b0] = samples[0]
    const s = (now - t0) / 1000
    const bps = s > 2 ? (done - b0) / s : 0
    return { done, total: totalBytes, bps, eta: bps ? Math.max(0, (totalBytes - done) / bps) : null }
  }
}

async function ensureSearchModel(onBytes) {
  if (searchModelReady() && embedP) return
  const files = {} // the model arrives as several files (config, tokenizer, weights): sum them
  await embedder((p) => {
    if (p.status !== 'progress' || !p.total) return
    files[p.file] = [p.loaded, p.total]
    const v = Object.values(files)
    onBytes?.(v.reduce((s, [l]) => s + l, 0), v.reduce((s, [, t]) => s + t, 0))
  })
  await embed(['warm up'])
  aiPrefs.set({ ...(aiPrefs.get() || {}), embed: EMBED.id })
  vectors.clear() // vectors from an older search model don't mix with these
}

// Download (or switch to) a catalog model. Replaces the previous answer model to free space.
export async function install(key, opts = {}) {
  if (running) {
    if (!cancelled) return // already downloading
    await running // a cancelled one is still winding down: start right after it
  }
  running = doInstall(key, opts)
  return running
}

async function doInstall(key, { auto = false, reason } = {}) {
  const entry = CATALOG.find((e) => e.key === key)
  cancelled = false
  // Remembered until it finishes, so closing the window mid-download resumes it on the next start.
  aiPrefs.set({ ...(aiPrefs.get() || {}), pending: { key, auto, reason } })
  setDl({ phase: 'downloading', p: 0, text: 'Getting ready…', target: key, auto, error: null })
  try {
    const gpu = await webgpu()
    if (!gpu.ok) throw new Error(gpu.why)
    const { id, name } = resolve(entry, gpu)
    await withLock(async () => {
      await navigator.storage?.persist?.().catch(() => {}) // ask the browser not to evict a gigabyte under pressure
      // Two steps, each with its own % so the bar visibly moves even on a slow link.
      const SEARCH_BYTES = 34e6
      const total = SEARCH_BYTES + resolve(entry, gpu).gb * 1e9
      let m = meter(SEARCH_BYTES)
      setDl({ step: 1, stepName: 'Search model (bge-small)', stepP: 0, bytes: m(0), text: 'Downloading the search model…' })
      await ensureSearchModel((done, size) => {
        if (!cancelled) setDl({ stepP: done / size, p: (done / size) * SEARCH_BYTES / total, bytes: { ...m(done), total: size } })
      })
      // The search model (34 MB) can't be stopped mid-file; Cancel takes effect here, before the big one starts.
      if (cancelled) throw new Error('cancelled')
      m = meter(resolve(entry, gpu).gb * 1e9)
      setDl({ step: 2, stepName: name, stepP: 0, p: SEARCH_BYTES / total, bytes: m(0), text: 'Downloading the answer model…' })
      const { MLCEngine, hasModelInCache, deleteModelAllInfoInCache } = await webllm()
      const prev = aiPrefs.get()?.model
      if (!(await hasModelInCache(id))) {
        // Load = download + compile; keep this engine so offline questions don't pay for loading again.
        const modelBytes = resolve(entry, gpu).gb * 1e9
        const eng = new MLCEngine({ initProgressCallback: (r) => !cancelled && setDl({
          stepP: r.progress, p: (SEARCH_BYTES + r.progress * modelBytes) / total, bytes: m(r.progress * modelBytes), text: r.text,
        }) })
        loading = eng
        await eng.reload(id)
        loading = null
        if (cancelled) throw new Error('cancelled')
        if (engine) await engine.unload().catch(() => {})
        engine = eng
        engineP = Promise.resolve(eng)
      } else if (prev !== id && engine) {
        await engine.unload().catch(() => {}) // a different model is loaded; the new one loads on first use
        engine = null
        engineP = null
      }
      if (prev && prev !== id) await deleteModelAllInfoInCache(prev).catch(() => {})
      aiPrefs.set({ ...(aiPrefs.get() || {}), model: id, tier: key, name, auto, pending: null,
        reason: reason || (auto ? 'picked automatically' : 'chosen in Admin'), ts: Date.now() })
      logActivity('system', `Offline AI ready in this browser — ${name} (${auto ? 'downloaded automatically' : 'chosen in Admin'})`)
    })
    setDl({ phase: 'ready', p: 1, text: 'Ready' })
  } catch (e) {
    loading = null
    if (cancelled) {
      // Cancelled on purpose: forget it and free the space the unfinished pieces take (unless it's the one in use).
      aiPrefs.set({ ...(aiPrefs.get() || {}), pending: null })
      const gpu = await webgpu()
      const id = gpu.ok && resolve(entry, gpu).id
      if (id && id !== aiPrefs.get()?.model) (await webllm()).deleteModelAllInfoInCache(id).catch(() => {})
      setDl({ phase: 'idle', p: 0, text: 'Download cancelled' })
    } else {
      setDl({ phase: 'error', error: e.message || String(e) }) // kept as pending: retried on the next start
    }
  } finally {
    running = null
  }
}

export async function cancelInstall() {
  cancelled = true
  if (dl.auto) setAutoDownload(false) // the user said no: don't start again on the next visit
  aiPrefs.set({ ...(aiPrefs.get() || {}), pending: null })
  setDl({ phase: 'idle', p: 0, text: 'Download cancelled' }) // answer at once; the rest winds down behind it
  await loading?.unload().catch(() => {}) // aborts the in-flight download
}

export function setAutoDownload(on) {
  aiPrefs.set({ ...(aiPrefs.get() || {}), autoOff: !on })
  setDl({})
}

export async function removeAI() {
  const p = aiPrefs.get()
  if (engine) { await engine.unload().catch(() => {}); engine = null; engineP = null }
  if (p?.model) {
    const { deleteModelAllInfoInCache } = await webllm()
    await deleteModelAllInfoInCache(p.model).catch(() => {})
  }
  try { await caches.delete('transformers-cache') } catch { /* no cache api */ }
  embedP = null
  vectors.clear()
  aiPrefs.set({ autoOff: true }) // removed on purpose: don't download it again by itself
  setDl({ phase: 'idle', p: 0, text: '' })
}

// Is the model really in this browser's cache (not just remembered as downloaded)?
// How much this browser holds, and whether it promised not to clear it when disk space runs low.
export async function storageInfo() {
  try {
    const [persisted, est] = await Promise.all([navigator.storage?.persisted?.(), navigator.storage?.estimate?.()])
    return { persisted: !!persisted, used: est?.usage || 0, quota: est?.quota || 0 }
  } catch {
    return null
  }
}

export async function verifyCached() {
  const p = aiPrefs.get()
  if (!p?.model) return false
  try {
    const { hasModelInCache } = await webllm()
    return await hasModelInCache(p.model)
  } catch {
    return false
  }
}

// On every start of the laptop or phone page: check what's installed; if nothing, look at this
// device and download a model that suits it. Never on metered/slow connections or after the user
// cancelled or removed it.
let autoChecked = false
export async function autoSetup() {
  if (autoChecked) return
  autoChecked = true
  setDl({ phase: 'checking' })
  const profile = await deviceProfile()
  setDl({ profile, phase: 'idle' })
  const p = aiPrefs.get()
  const online = navigator.onLine && !profile.metered
  if (p?.model) navigator.storage?.persist?.().catch(() => {})
  // A download was interrupted (window closed, browser quit, connection lost): pick it up where it stopped.
  // Pieces already saved are skipped, so only the rest is fetched.
  if (p?.pending && navigator.onLine && (!p.pending.auto || !profile.metered)) {
    await new Promise((r) => setTimeout(r, 2000))
    install(p.pending.key, { auto: p.pending.auto, reason: p.pending.reason })
    return
  }
  if (p?.model && (await verifyCached())) {
    setDl({ phase: 'ready', p: 1 })
    if (!searchModelReady() && online) ensureSearchModel().catch(() => {}) // upgrade an older search model quietly
    return
  }
  if (p?.autoOff) return
  if (!online) { setDl({ text: profile.metered ? 'Waiting for Wi-Fi to download the offline AI' : 'Offline — will download when online' }); return }
  await new Promise((r) => setTimeout(r, 4000)) // let the page settle first
  if (!profile.tier) { ensureSearchModel().catch(() => {}); return } // no WebGPU: offline search only
  install(profile.tier, { auto: true, reason: `Picked automatically: ${profile.reason}` })
}

// Load the answer model ahead of time (e.g. the moment the device becomes unreachable), so the first
// offline question doesn't wait for it.
export function ensureEngine() {
  const p = aiPrefs.get()
  if (engine) return Promise.resolve(engine)
  if (!p?.model) return Promise.resolve(null)
  engineP ||= webllm()
    .then(({ CreateMLCEngine }) => CreateMLCEngine(p.model))
    .then((e) => (engine = e))
    .catch((e) => { engineP = null; throw e })
  return engineP
}

// ---------------------------------------------------------------- ask, offline

function buildMessages(q, hits, history, general) {
  if (general) {
    return [{ role: 'system', content: SYSTEM_GENERAL },
      ...history.slice(-4).map((t) => ({ role: t.role, content: t.text })),
      { role: 'user', content: q }]
  }
  // Browser models are small: with "[1] (date) text" lines they tend to echo a line back verbatim, or
  // answer the first fact in it rather than the one asked about. Plain notes + an explicit instruction
  // to answer only what was asked keeps them on track.
  const fmt = (ts) => new Date(ts).toISOString().slice(0, 10)
  const ctx = hits.map((h, i) => `Note ${i + 1} (saved ${fmt(h.ts)}): ${h.text}`).join('\n')
  const system = `${SYSTEM} Answer exactly what the question asks, in your own words as one or two full sentences. ` +
    'Never copy the "Note N (saved …)" labels into the answer.'
  return [{ role: 'system', content: system }, { role: 'user', content: `My notes:\n${ctx}\n\nQuestion: ${q}` }]
}

// "Your notes don't say…" — the cue to look at the next notes before giving up.
const NOT_FOUND = /\b(do(es)?n['’]?t|do(es)? not|can['’]?t|cannot|could ?n['’]?t|no)\b.{0,40}\b(mention|contain|include|say|find|information|info|details?|record)|\bnot (mentioned|included|found|in (your|the|these) notes)/i

const aborted = () => new DOMException('Stopped', 'AbortError')

// Same event stream as the device's /api/ask: chat → retrieval → token* → (reroute) → done.
export async function ask(q, cid, onEvent, signal, { memories, history, why = 'device unreachable · answered in this browser' }) {
  cid ||= chats.newId()
  onEvent({ type: 'chat', cid })
  const { hits, timing } = await search(q, memories)
  const relevant = hits.filter((h) => h.relevant && !h.superseded_by) // best match first
  const general = !relevant.length
  const mode = general ? 'general' : 'memory'
  const byNewest = (list) => [...list].sort((a, b) => b.ts - a.ts) // the prompt lists newest first
  let used = byNewest(relevant.slice(0, NOTES_PER_PASS))
  const status = aiStatus()
  const gpu = status.downloaded ? await webgpu() : { ok: false }
  let route = status.downloaded && gpu.ok ? 'local' : 'retrieval'
  const name = entryFor(status.model)?.name || status.model
  let reason = route === 'local'
    ? `${why} with ${name} · ${used.length} of ${relevant.length} matching notes sent`
    : `${why} · no offline AI downloaded (Admin → Offline AI) → ${general ? 'nothing to show' : 'matching notes shown'}`
  onEvent({ type: 'retrieval', hits, timing, route, reason, used: used.map((h) => h.mem_id), mode })
  logActivity('ask', `'${q.slice(0, 48)}' → ${relevant.length} notes matched in this browser · ${route}`)

  let answer = ''
  let stopped = false
  const save = () => {
    const ts = Date.now()
    const isPrivate = used.some((h) => h.sensitivity === 'private')
    chats.append(cid,
      { cid, role: 'user', text: q, ts, private: isPrivate, browser: true },
      { cid, role: 'assistant', text: answer, ts, route, used: used.map((h) => h.mem_id), private: isPrivate, mode,
        browser: true, ...(stopped ? { stopped: true } : {}) })
  }

  const generate = async (eng, notes) => {
    const thinking = entryFor(status.model)?.thinking
    const stream = await eng.chat.completions.create({
      messages: buildMessages(q, notes, history, general), stream: true, temperature: 0.2,
      max_tokens: general ? 600 : 300, stop: STOP,
      // Qwen3.5 thinks out loud by default; that doubles the wait for a short factual answer.
      ...(thinking ? { extra_body: { enable_thinking: false } } : {}),
    })
    let raw = ''
    for await (const chunk of stream) {
      if (signal?.aborted) break
      const t = chunk.choices?.[0]?.delta?.content
      if (!t) continue
      raw += t
      const visible = raw.replace(/<think>[\s\S]*?(<\/think>\s*|$)/, '') // belt and braces: hide any thinking
      if (visible.length > answer.length) { onEvent({ type: 'token', t: visible.slice(answer.length) }); answer = visible }
    }
  }

  if (route === 'local') {
    try {
      const eng = await ensureEngine()
      if (signal?.aborted) throw aborted()
      const onAbort = () => eng.interruptGenerate()
      signal?.addEventListener('abort', onAbort)
      try {
        await generate(eng, used)
        // Not in the best notes? Try the next ones (each pass stays small) before saying it isn't there.
        for (let next = NOTES_PER_PASS; !signal?.aborted && NOT_FOUND.test(answer) && next < relevant.length; next += NOTES_PER_PASS) {
          used = byNewest(relevant.slice(next, next + NOTES_PER_PASS))
          answer = ''
          reason = `${why} with ${name} · first notes didn't say, checked notes ${next + 1}–${next + used.length} of ${relevant.length}`
          onEvent({ type: 'reroute', route, reason, used: used.map((h) => h.mem_id) })
          await generate(eng, used)
        }
      } finally {
        signal?.removeEventListener('abort', onAbort)
      }
    } catch (e) {
      if (signal?.aborted) { /* handled below */ } else {
        console.warn('offline model failed', e)
        route = 'retrieval'
        reason = `offline model error (${e.message}) → matching notes shown`
        answer = ''
        onEvent({ type: 'reroute', route, reason })
      }
    }
  }
  if (signal?.aborted) {
    stopped = true
    save()
    throw aborted()
  }
  if (route === 'retrieval') {
    used = byNewest(relevant.slice(0, 4))
    answer = relevant.length
      ? 'Here is what your notes on this device say:\n' + used.map((h) => `• ${h.text}`).join('\n')
      : 'Nothing in your notes matches that. Download the offline AI (Admin → Offline AI) to get general answers without internet.'
    onEvent({ type: 'token', t: answer })
  }
  save()
  onEvent({ type: 'done', route, mode })
}
