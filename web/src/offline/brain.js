// The device's brain, rebuilt inside the browser for when the device can't be reached:
// hybrid search over the local copy of your notes, and an on-device model that writes answers: the
// browser's built-in one when it has it (nothing to download), otherwise WebLLM on WebGPU, downloaded once
// while online — automatically, sized to this device — and then loaded from the browser's cache.
import { aiPrefs, chats, logActivity } from './local.js'
import { Vocabulary, followupKind, isPersonal, words } from './textsearch.js'

// Same prompts as the device (edge/llm.py), so answers read the same online and offline.
const SYSTEM =
  "You are EdgeMind, a personal memory assistant. Answer the user's question using ONLY the " +
  'memories provided. Memories are listed newest first; if two memories conflict, prefer the newer one ' +
  'and say that an older note disagreed. If the memories do not contain the answer, say so plainly — ' +
  'do not invent facts. Be concise (1-4 sentences). Cite memories inline like [1], [2].'
// "What is MY plumber's number?" and no note has it: general knowledge can only guess, so say it wasn't found.
const SYSTEM_PERSONAL =
  "You are EdgeMind, a personal memory assistant. The question is about the user's own life, and none of " +
  'their notes on this device answers it. If it asks for a personal fact (a number, date, name, code, place, ' +
  "plan), say in one sentence that you couldn't find it in their notes, and do not guess or invent anything. " +
  'If it is really a general question (how to do something, general advice), answer it briefly.'
const SYSTEM_GENERAL =
  "You are EdgeMind, a helpful assistant. Nothing in the user's personal notes matched this question, " +
  'so answer from your general knowledge. Do not claim the answer comes from their notes or memories. ' +
  'Be clear and concise (at most 6 sentences, or a short list). If you are not sure, say so.'
const STOP = ['\n###', '### ', '\nQuestion:', '\nMemories:', '\nUser:', '<|end|>', '<|user|>', '<|im_end|>']
// Small browser models: also stop where they start re-listing notes or open a code block.
const BROWSER_STOP = [...STOP, '\n[', '\nNote ', '\nNotes:', '```', '\n- ']

// Small models lose track when handed many notes: answer from the best few, and only look further
// down the list when those didn't contain the answer.
const NOTES_PER_PASS = 3

// ---------------------------------------------------------------- model catalog

// Download sizes are the real weight sizes on Hugging Face (mlc-ai/<id>/tensor-cache.json).
// f32 variants are for GPUs without half-precision shaders (shader-f16).
// Tiers picked by an offline comparison (11 hard questions: typos, rewording, a negation trap, general
// questions; browser fully offline): Gemma 3 1B 8/11 at 3.4 s, Llama 3.2 1B 9/11 at 5.0 s, Qwen2.5 1.5B
// 10/11 at 6.0 s, Qwen3.5 2B 8/11 at 7.0 s, Qwen2.5 3B 10/11 at 12.2 s. Qwen2.5 3B is also the model the
// device runs through Ollama, so "Best" answers like the device does online.
export const CATALOG = [
  { key: 'phone', label: 'Substandard', name: 'Gemma 3 1B', gb: 0.56, hint: 'Fastest and smallest. For phones and older laptops.',
    f16: 'gemma3-1b-it-q4f16_1-MLC', f32: 'Llama-3.2-1B-Instruct-q4f32_1-MLC', f32Name: 'Llama 3.2 1B', f32Gb: 0.7 },
  { key: 'standard', label: 'Standard', name: 'Qwen2.5 1.5B', gb: 0.87, hint: 'Accurate answers on most laptops.',
    f16: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC', f32: 'Qwen2.5-1.5B-Instruct-q4f32_1-MLC' },
  { key: 'best', label: 'Best', name: 'Qwen2.5 3B', gb: 1.74, hint: 'Same model the device uses online. Slower.',
    f16: 'Qwen2.5-3B-Instruct-q4f16_1-MLC', f32: 'Qwen2.5-3B-Instruct-q4f32_1-MLC' },
  { key: 'llama-1b', label: 'Llama 3.2 1B', name: 'Llama 3.2 1B', gb: 0.7, hint: 'Alternative small model.', extra: true,
    f16: 'Llama-3.2-1B-Instruct-q4f16_1-MLC', f32: 'Llama-3.2-1B-Instruct-q4f32_1-MLC' },
  { key: 'qwen35-2b', label: 'Qwen3.5 2B', name: 'Qwen3.5 2B', gb: 1.06, hint: 'Newer, but less accurate here.', extra: true,
    f16: 'Qwen3.5-2B-q4f16_1-MLC', f32: 'Qwen3.5-2B-q4f32_1-MLC', thinking: true },
  { key: 'phi-4-mini', label: 'Phi-4 mini', name: 'Phi-4 mini', gb: 2.16, hint: 'Large model, strong reasoning (not tested here).', extra: true,
    f16: 'Phi-4-mini-instruct-q4f16_1-MLC', f32: 'Phi-4-mini-instruct-q4f32_1-MLC' },
]

// Which concrete build of a catalog entry this GPU runs.
export function resolve(entry, gpu) {
  const f16 = gpu?.f16 !== false
  return f16 || !entry.f32Name
    ? { id: f16 ? entry.f16 : entry.f32, name: entry.name, gb: entry.gb }
    : { id: entry.f32, name: entry.f32Name, gb: entry.f32Gb }
}
// WebLLM 0.2.85's Gemma 3 record sets a 4096-token context while the model itself declares a 512-token
// sliding window, and loading refuses both ("Only one of context_window_size and sliding_window_size can
// be positive"). Use the plain context window; questions here are short.
const chatOptsFor = (id) => (id?.startsWith('gemma3') ? { sliding_window_size: -1 } : undefined)
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
  min: 0.50, // weak matches (below `strong`) also need a shared word, so this can sit low
  band: 0.08,
  strong: 0.58, // below this a note must also share a word with the question (same rule as the device)
  clearMin: 0.47, // a clear winner may sit a little below `min`…
  clearGap: 0.06, // …when it leads the next note by this much and shares a word with the question
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

// ---------------------------------------------------------------- the browser's built-in model

// Chrome (Gemini Nano) and Edge (Phi-4 mini) ship a model of their own (the Prompt API). It's shared by
// every site and kept outside this site's storage, so when it's there we use it and download nothing.
// Without it (phones, other browsers, too little disk or memory) the WebLLM download below takes over.
const LM_OPTS = { expectedInputs: [{ type: 'text', languages: ['en'] }], expectedOutputs: [{ type: 'text', languages: ['en'] }] }
const isEdge = () => navigator.userAgentData?.brands?.some((b) => /Edge/.test(b.brand)) ?? /Edg\//.test(navigator.userAgent)
export const builtinName = () => (isEdge() ? 'Phi-4 mini (built into Edge)' : 'Gemini Nano (built into Chrome)')
let builtinFailed = false // the browser offered it but couldn't get it: use WebLLM for the rest of this visit

// 'unsupported' | 'unavailable' | 'downloadable' | 'downloading' | 'available'
export async function builtinState() {
  if (builtinFailed) return 'unavailable'
  if (!self.LanguageModel) return 'unsupported'
  try { return await self.LanguageModel.availability(LM_OPTS) } catch { return 'unavailable' }
}

// The browser only fetches its model after a click or key press on the page, so start it on the first one.
let builtinStart = null
function startBuiltinOnGesture(now = false) {
  builtinStart ||= new Promise((done) => {
    const go = () => {
      off()
      setDl({ builtin: 'downloading', builtinP: 0, text: '' })
      self.LanguageModel.create({ ...LM_OPTS, monitor: (m) => m.addEventListener('downloadprogress', (e) => setDl({ builtinP: e.loaded })) })
        .then((s) => {
          s.destroy()
          setDl({ builtin: 'available', builtinP: 1, phase: 'ready', p: 1 })
          logActivity('system', `Offline AI ready in this browser — ${builtinName()}`)
          done(true)
        })
        .catch((e) => { console.warn('built-in model unavailable', e); done(false) })
    }
    const off = () => ['pointerdown', 'keydown'].forEach((t) => window.removeEventListener(t, go, true))
    if (now) go() // called from a click (Admin → "Use browser's AI"): that click is the gesture the browser needs
    else ['pointerdown', 'keydown'].forEach((t) => window.addEventListener(t, go, true))
  })
  return builtinStart
}

// Admin: which of the two answers offline. 'builtin' = the browser's own model, 'webllm' = the downloaded one.
// Remembered per browser; an explicit choice always beats the automatic one.
export function usePreference(which) {
  aiPrefs.set({ ...(aiPrefs.get() || {}), prefer: which })
  if (which === 'builtin' && (dl.builtin === 'downloadable' || dl.builtin === 'downloading')) {
    startBuiltinOnGesture(true).then((ok) => { if (!ok) { builtinFailed = true; setDl({ builtin: 'unavailable' }) } })
  }
  setDl({})
}

// Same messages as WebLLM gets: everything but the question becomes the session's opening prompts.
async function builtinGenerate(messages, signal, onText) {
  const session = await self.LanguageModel.create({ ...LM_OPTS, initialPrompts: messages.slice(0, -1), signal })
  try {
    let raw = ''
    for await (const chunk of session.promptStreaming(messages.at(-1).content, { signal })) {
      raw = raw && chunk.startsWith(raw) ? chunk : raw + chunk // older Chrome streamed the whole text so far
      onText(raw)
    }
  } finally {
    session.destroy()
  }
}

const GB = 1024 ** 3

// What this device can run, which tier to download by default, and why — shown in Admin.
export async function deviceProfile() {
  const gpu = await webgpu()
  const mem = navigator.deviceMemory // GB, rounded and capped at 8 by the browser; undefined outside Chromium
  const mobile = navigator.userAgentData?.mobile ?? /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent)
  const conn = navigator.connection
  // Only when the user said so (Data Saver) or the browser knows it's mobile data. effectiveType isn't used:
  // Chrome reports "3g" for any high-latency link, which kept ordinary Wi-Fi from ever downloading.
  const metered = !!(conn?.saveData || conn?.type === 'cellular')
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

// Hybrid search over the browser's copy of the notes, best match first. Same steps as the device
// (edge/app.py local_search): fix typos → keyword fast path → meaning + keyword scores → relevance rules.
const vocab = new Vocabulary()
const queryVectors = new Map() // recent questions → vectors (asking again costs nothing)

async function queryVector(query) {
  const key = query.trim().toLowerCase()
  if (queryVectors.has(key)) return queryVectors.get(key)
  const [v] = await embed([EMBED.queryPrefix + query])
  queryVectors.set(key, v)
  if (queryVectors.size > 128) queryVectors.delete(queryVectors.keys().next().value)
  return v
}

export async function search(q, memories, limit = 8) {
  const t0 = performance.now()
  const docs = memories.filter((m) => !m.superseded_by)
  vocab.refresh(docs)
  const { query, fixes } = vocab.correct(q) // "plumbre" → "plumber"
  const searched_for = Object.keys(fixes).length ? query : null

  const only = vocab.onlyNoteWithAll(query) // every meaningful word is in exactly one note → done
  if (only) {
    const d = docs.find((x) => x.mem_id === only)
    return { hits: [{ ...d, semantic: 1, keyword: 1, relevant: true, score: 1, match: 'all words' }],
      timing: { embed_ms: 0, search_ms: Math.round((performance.now() - t0) * 100) / 100, searched_for, fast: true } }
  }

  const kw = keywordScores(query, docs)
  const kwTop = Math.max(0, ...kw)
  let sem = null
  let embedMs = 0
  if (searchModelReady()) {
    try {
      const e0 = performance.now()
      const qv = await queryVector(query)
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
      ? s >= EMBED.min && s >= semTop - EMBED.band && (semTop >= EMBED.strong || vocab.covers(query, d.mem_id, 0.3))
      : kw[i] > 0 && k >= 0.5 && vocab.covers(query, d.mem_id)
    return { ...d, semantic: s, keyword: kw[i], relevant, score: sem ? s * 0.8 + k * 0.2 : k }
  })
  if (sem && !hits.some((h) => h.relevant)) { // clear winner: well ahead of the rest and shares a word
    const bySem = [...hits].sort((a, b) => b.semantic - a.semantic)
    const [top, second] = bySem
    if (top && top.semantic >= EMBED.clearMin && top.semantic - (second?.semantic || 0) >= EMBED.clearGap &&
        vocab.covers(query, top.mem_id, 0.3)) {
      top.relevant = true
      top.match = 'clear winner'
    }
  }
  hits.sort((a, b) => b.score - a.score)
  return {
    hits: hits.slice(0, limit),
    timing: { embed_ms: Math.round(embedMs * 10) / 10, search_ms: Math.round((performance.now() - t0 - embedMs) * 100) / 100, searched_for },
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

// `downloaded` = a WebLLM model is in this site's cache; `ready` = something can write answers offline.
// A model picked by hand in Admin wins over the built-in one; an automatic pick doesn't.
export function aiStatus() {
  const p = aiPrefs.get()
  const builtin = dl.builtin === 'available'
  let using
  if (p?.prefer === 'webllm' && p?.model) using = 'webllm'
  else if (p?.prefer === 'builtin' && builtin) using = 'builtin'
  else using = p?.model && (!p.auto || !builtin) ? 'webllm' : builtin ? 'builtin' : null
  return { downloaded: !!p?.model, model: p?.model || null, tier: p?.tier || null, auto: !!p?.auto,
    prefer: p?.prefer || null, downloadedAt: p?.model ? p.ts || null : null,
    builtinModel: dl.builtin && dl.builtin !== 'unsupported' ? builtinName() : null,
    reason: p?.reason || null, search: searchModelReady(), loaded: !!engine, autoOff: !!p?.autoOff,
    builtin: dl.builtin || null, ready: !!using, using,
    name: using === 'builtin' ? builtinName() : using ? p.name || entryFor(p.model)?.name || p.model : null }
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
  setDl({ phase: 'downloading', p: 0, text: 'Getting ready…', target: key, auto, error: null, retrying: false })
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
      // Load = download (skipped for pieces already saved) + compile. Always load, even when everything is
      // cached: a model only counts as installed once it has actually run in this browser.
      const modelBytes = resolve(entry, gpu).gb * 1e9
      const eng = new MLCEngine({ initProgressCallback: (r) => !cancelled && setDl({
        stepP: r.progress, p: (SEARCH_BYTES + r.progress * modelBytes) / total, bytes: m(r.progress * modelBytes), text: r.text,
      }) })
      loading = eng
      try {
        await eng.reload(id, chatOptsFor(id))
      } catch (e) {
        if (!cancelled) throw new Error(`${name} doesn't run in this browser: ${e.message}`)
        throw e
      } finally {
        loading = null
      }
      if (cancelled) throw new Error('cancelled')
      if (engine) await engine.unload().catch(() => {})
      engine = eng
      engineP = Promise.resolve(eng)
      if (prev && prev !== id) await deleteModelAllInfoInCache(prev).catch(() => {})
      aiPrefs.set({ ...(aiPrefs.get() || {}), model: id, tier: key, name, auto, pending: null,
        ...(auto ? {} : { prefer: 'webllm' }),
        reason: reason || (auto ? 'picked automatically' : 'chosen in Admin'), ts: Date.now() })
      retries = 0
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
      // Kept as pending and tried again by itself: soon, and at once when the connection comes back.
      setDl({ phase: 'error', error: e.message || String(e), retrying: true, text: '' })
      scheduleRetry()
    }
  } finally {
    running = null
  }
}

export async function cancelInstall() {
  cancelled = true
  clearTimeout(retryTimer)
  // The user said no: don't start again by itself (unless another model is already installed, then nothing would).
  if (dl.auto || !aiPrefs.get()?.model) setAutoDownload(false)
  aiPrefs.set({ ...(aiPrefs.get() || {}), pending: null })
  setDl({ phase: 'idle', p: 0, text: 'Download cancelled' }) // answer at once; the rest winds down behind it
  await loading?.unload().catch(() => {}) // aborts the in-flight download
}

export function setAutoDownload(on) {
  aiPrefs.set({ ...(aiPrefs.get() || {}), autoOff: !on })
  setDl({})
  if (on) ensureInstalled() // ticked the box: start now, not on the next visit
}

// An automatically downloaded WebLLM model isn't needed once the browser's own model works: free the space.
async function dropWebLLM(why) {
  const p = aiPrefs.get()
  if (engine) { await engine.unload().catch(() => {}); engine = null; engineP = null }
  await (await webllm()).deleteModelAllInfoInCache(p.model).catch(() => {})
  aiPrefs.set({ ...p, model: null, tier: null, name: null, auto: false, pending: null })
  logActivity('system', `Removed ${p.name || p.model} from this browser — ${why}`)
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
  let lib
  try {
    lib = await webllm()
  } catch {
    // The check itself couldn't run (offline and the AI library isn't loadable right now): that says nothing
    // about the model, so keep it rather than forgetting a gigabyte the browser still holds.
    return true
  }
  try {
    return await lib.hasModelInCache(p.model)
  } catch {
    return true
  }
}

// On every start of the laptop or phone page, whenever the connection comes back, and again after a
// failed try: check what's installed; if nothing, look at this device and download a model that suits it.
// Never on mobile data / Data Saver, or after the user cancelled or removed it.
let started = false
let checking = null
let retryTimer = null
let retries = 0

// The offline-AI code is loaded on demand, and each build gives those files new names. A page opened online
// after a deploy must fetch this build's copies now (the service worker keeps them), or offline it finds
// only the previous build's files and search silently drops to keywords. Seen in testing: after a rebuild,
// "transformers.web-<hash>.js" failed to load offline and "What is my plumbre number?" found nothing.
function warmOfflineCode() {
  if (!navigator.onLine) return
  const p = aiPrefs.get()
  if (p?.embed) embedder().catch(() => {}) // also caches the ONNX runtime it pulls in
  if (p?.model) webllm().catch(() => {})
}

export function autoSetup() {
  if (started) return
  started = true
  warmOfflineCode()
  window.addEventListener('online', () => { retries = 0; warmOfflineCode(); ensureInstalled() })
  navigator.connection?.addEventListener?.('change', () => ensureInstalled()) // e.g. mobile data → Wi-Fi
  return ensureInstalled({ first: true })
}

function ensureInstalled(opts) {
  clearTimeout(retryTimer)
  if (running) return running
  checking ||= check(opts).catch((e) => console.warn('offline AI setup failed', e)).finally(() => { checking = null })
  return checking
}

// After a failed download: 15 s, 30 s, 1 min … up to every 5 min. Coming back online retries at once.
function scheduleRetry() {
  clearTimeout(retryTimer)
  retryTimer = setTimeout(() => ensureInstalled(), Math.min(5 * 60e3, 15e3 * 2 ** retries++))
}

async function check({ first = false } = {}) {
  if (first) setDl({ phase: 'checking' })
  const profile = await deviceProfile()
  setDl({ profile, ...(dl.phase === 'checking' ? { phase: 'idle' } : {}) })
  let p = aiPrefs.get()
  // First choice: the browser's own model. Nothing is downloaded into this site when it's there.
  const builtin = await builtinState()
  setDl({ builtin })
  if (builtin === 'available') {
    if (p?.model && p.auto && p.prefer !== 'webllm') await dropWebLLM('the browser’s built-in model is used instead')
    else if (p?.pending?.auto) aiPrefs.set({ ...p, pending: null })
    p = aiPrefs.get()
    if (!p?.model && !p?.pending) {
      setDl({ phase: 'ready', p: 1, text: '' })
      if (!searchModelReady() && navigator.onLine) ensureSearchModel().catch(() => {})
      return
    }
  }
  if ((builtin === 'downloadable' || builtin === 'downloading') && !p?.model && !p?.autoOff && !(p?.pending && !p.pending.auto)) {
    // The browser can get its model: it does so on the first click on the page. Only if that fails, WebLLM.
    setDl({ text: 'This browser has a built-in model; it’s fetched the first time you click on the page.' })
    startBuiltinOnGesture().then((ok) => { if (!ok) { builtinFailed = true; setDl({ builtin: 'unavailable' }); ensureInstalled() } })
    if (!searchModelReady() && navigator.onLine) ensureSearchModel().catch(() => {})
    return
  }
  if (p?.model) {
    navigator.storage?.persist?.().catch(() => {})
    if (await verifyCached()) {
      retries = 0
      setDl({ phase: 'ready', p: 1, text: '' })
      if (!searchModelReady() && navigator.onLine) ensureSearchModel().catch(() => {}) // upgrade an older search model quietly
      return
    }
    // The browser cleared it (low disk, site data cleared): it isn't installed any more, so get it again.
    aiPrefs.set({ ...p, model: null, tier: null, name: null })
    p = aiPrefs.get()
  }
  // A download was interrupted (window closed, browser quit, connection lost): pick it up where it stopped.
  // Pieces already saved are skipped, so only the rest is fetched.
  const pending = p?.pending
  if (!pending && p?.autoOff) return
  if (!profile.tier) { // no WebGPU: offline search only
    if (navigator.onLine) ensureSearchModel().catch(() => {})
    return
  }
  if (!navigator.onLine) { setDl({ text: 'Offline — the download starts by itself when you’re back online.' }); return }
  if (profile.metered && (!pending || pending.auto)) {
    setDl({ text: 'On mobile data or Data Saver — the download starts by itself on Wi-Fi.' })
    return
  }
  if (first) {
    setDl({ text: 'Starting the download…' })
    await new Promise((r) => setTimeout(r, 1500)) // let the page settle first
    if (running) return
  }
  if (pending) install(pending.key, { auto: pending.auto, reason: pending.reason })
  else install(profile.tier, { auto: true, reason: `Picked automatically: ${profile.reason}` })
}

// Load the answer model ahead of time (e.g. the moment the device becomes unreachable), so the first
// offline question doesn't wait for it.
export function ensureEngine() {
  const p = aiPrefs.get()
  if (engine) return Promise.resolve(engine)
  if (!p?.model) return Promise.resolve(null)
  engineP ||= webllm()
    .then(({ CreateMLCEngine }) => CreateMLCEngine(p.model, undefined, chatOptsFor(p.model)))
    .then((e) => (engine = e))
    .catch((e) => { engineP = null; throw e })
  return engineP
}

// ---------------------------------------------------------------- ask, offline

// Gemma 3 1B refused "What is my plumbre number?" ("I'm designed to be harmless…") although the number was in
// the user's own note: say outright that repeating their notes back to them is the whole point.
const OWN_NOTES = 'These are the user’s own private notes, shown only to them: repeating their names, phone ' +
  'numbers, codes and passwords back to them is expected and safe. '

// The model refused anyway: the matched note itself is the honest answer.
const REFUSAL = /\b(i['’]?m sorry|i am sorry|i cannot|i can['’]?t (help|answer|provide|share)|as an ai|i(['’]m| am) (not able|unable)|i do not have access)\b/i

function buildMessages(q, hits, history, general, weak = false) {
  if (general) {
    return [{ role: 'system', content: isPersonal(q) ? SYSTEM_PERSONAL : SYSTEM_GENERAL },
      ...history.slice(-4).map((t) => ({ role: t.role, content: t.text })),
      { role: 'user', content: q }]
  }
  // Browser models are small (1-2B). Tested offline with Gemma 3 1B: given "[1] (date) text" lines and
  // the device's "cite like [1]" instruction, they echo the list back ("[1] … [2] …"), keep going until
  // the token limit (~40 s), and can garble a code. A bare list of notes and a short, strict instruction
  // keeps them to one accurate sentence.
  const ctx = hits.map((h) => `- ${h.text}`).join('\n')
  // Weak match (the best note scored low): the notes may be about something else, so they're offered,
  // not imposed — e.g. "How do I change a car tyre?" brushing past the car-insurance note.
  if (weak) {
    const sys = 'You are EdgeMind, a helpful assistant. Some of the user’s notes are listed; they MAY be related. ' + OWN_NOTES +
      'If a note answers the question, reply with one short sentence copying its facts exactly. If no note ' +
      (isPersonal(q)
        // "What is my car's licence plate?" brushing past the car-insurance note: Gemma invented "123456789".
        ? "answers it, say in one sentence that you couldn't find it in their notes. Never guess or invent a personal fact."
        : 'answers it, answer from general knowledge in a few sentences and do not mention the notes.')
    return [{ role: 'system', content: sys }, { role: 'user', content: `Notes:\n${ctx}\n\nQuestion: ${q}` }]
  }
  const system = 'You are EdgeMind, a personal memory assistant. Answer the question using ONLY the notes. ' + OWN_NOTES +
    'Reply with one short sentence. Copy names, numbers, dates and codes exactly as written in the notes. ' +
    'Do not list the notes, number anything or use brackets. If the notes do not contain the answer, ' +
    'say "Your notes don\'t mention that."'
  return [{ role: 'system', content: system }, { role: 'user', content: `Notes:\n${ctx}\n\nQuestion: ${q}` }]
}

// Numbers and codes in an answer that appear in none of the notes it was given ("sunflower24" for
// "sunflower2024"): a small model garbled something, so the note itself is shown next to the answer.
export function unsupported(answer, notes) {
  const source = notes.map((n) => n.text.toLowerCase()).join(' ')
  const noteNumbers = new Set(source.match(/\d+/g) || [])
  return (answer.toLowerCase().match(/[a-z0-9]*\d[a-z0-9:-]*/g) || [])
    .map((tok) => tok.replace(/[.:]+$/, '').replace(/^(\d+)(st|nd|rd|th)$/, '$1')) // "18th" is the note's "18"
    .filter((tok) => (/^\d+$/.test(tok)
      // A plain number must be one of the note's numbers, single digits included: Gemma answered grandma's
      // "3 November" with "November 1st".
      ? !noteNumbers.has(tok)
      : tok.replace(/\D/g, '').length >= 2 && !source.includes(tok)))
}

// "Can the dog have chocolate?" → "Yes" while the note says "never give him chocolate": small models
// (Gemma 3 1B, Qwen2.5 1.5B, Qwen3.5 2B in testing) miss the negation. A yes/no question answered "yes"
// when a matched note negates one of the question's words right next to it gets the note shown too.
export function contradicts(question, answer, notes) {
  // Anything but a clear "no" counts: "Yes", but also a dodge like "The dog eats 1 cup of food at 8 am".
  if (!/^\s*(can|could|should|is|are|does|do|may|will)\b/i.test(question) || /^\W*(no|never|don['’]?t|do not)\b/i.test(answer)) return null
  const asked = words(question).filter((w) => w.length > 3)
  for (const n of notes) {
    const ws = words(n.text)
    for (let i = 0; i < ws.length; i++) {
      if (!['never', 'not', 'dont', 'no', 'avoid', 'cannot'].includes(ws[i])) continue
      if (ws.slice(i + 1, i + 6).some((w) => asked.includes(w))) return n
    }
  }
  return null
}

// "Your notes don't say…" — the cue to look at the next notes before giving up.
const NOT_FOUND = /\b(do(es)?n['’]?t|do(es)? not|can['’]?t|cannot|could ?n['’]?t|no)\b.{0,40}\b(mention|contain|include|say|find|information|info|details?|record|provide|offer|specify|suggest|recommend|list)|\bnot (mentioned|included|found|in (your|the|these) notes)/i

const aborted = () => new DOMException('Stopped', 'AbortError')

// Same event stream as the device's /api/ask: chat → retrieval → token* → (reroute) → done.
export async function ask(q, cid, onEvent, signal, { memories, history, why = 'device unreachable · answered in this browser' }) {
  cid ||= chats.newId()
  onEvent({ type: 'chat', cid })
  let { hits, timing } = await search(q, memories)
  // Follow-up ("When is grandma's birthday?" → "What does she like?"): search again together with the previous
  // question — only when the question alone found no strong match (same rule as the device).
  const prev = [...history].reverse().find((t) => t.role === 'user')
  let followup = null
  const kind = prev ? followupKind(q) : null
  if (kind === 'pronoun' || (kind === 'hint' && !timing.fast && !hits.some((h) => h.relevant && h.semantic >= EMBED.strong))) {
    const second = await search(`${prev.text} ${q}`, memories)
    if (second.hits.some((h) => h.relevant)) {
      ;({ hits } = second)
      timing = { ...second.timing, searched_for: timing.searched_for, followup_of: prev.text }
      followup = prev
    }
  }
  const relevant = hits.filter((h) => h.relevant && !h.superseded_by) // best match first
  const general = !relevant.length
  let mode = general ? 'general' : 'memory'
  const byNewest = (list) => [...list].sort((a, b) => b.ts - a.ts) // the prompt lists newest first
  let used = byNewest(relevant.slice(0, NOTES_PER_PASS))
  // Only weak matches (no note reached `strong`, no all-words hit): the model may answer generally instead.
  const weak = !general && !timing.fast && relevant.slice(0, NOTES_PER_PASS).every((h) => h.semantic < EMBED.strong)
  const builtin = await builtinState() // cheap; catches the browser getting (or losing) its model meanwhile
  if (builtin !== dl.builtin) setDl({ builtin })
  const status = aiStatus()
  const useBuiltin = status.using === 'builtin'
  const gpu = status.using === 'webllm' ? await webgpu() : { ok: false }
  let route = useBuiltin || gpu.ok ? 'local' : 'retrieval'
  const name = status.name
  let reason = route === 'local'
    ? `${why} with ${name} · ${used.length} of ${relevant.length} matching notes sent`
    : `${why} · no offline AI downloaded (Admin → Offline AI) → ${general ? 'nothing to show' : 'matching notes shown'}`
  onEvent({ type: 'retrieval', hits, timing, route, reason, used: used.map((h) => h.mem_id), mode })
  logActivity('ask', `'${q.slice(0, 48)}' → ${relevant.length} notes matched in this browser · ${route}`)

  let answer = ''
  let related = null // weak-match note, shown under a general answer
  let stopped = false
  const save = () => {
    const ts = Date.now()
    const isPrivate = used.some((h) => h.sensitivity !== 'shareable')
    chats.append(cid,
      { cid, role: 'user', text: q, ts, private: isPrivate, browser: true },
      { cid, role: 'assistant', text: answer, ts, route, used: used.map((h) => h.mem_id), private: isPrivate, mode,
        browser: true, ...(stopped ? { stopped: true } : {}) })
  }

  const generate = async (eng, notes, isGeneral = general) => {
    const asked = timing.searched_for || q // spelling-corrected question
    // Small models given "Earlier question … / Follow-up question …" tend to answer the earlier one (Gemma: "What
    // does she like?" → grandma's birthday). New question first, the earlier one only as context for "she"/"his".
    const messages = buildMessages(followup ? `${asked}\n(Answer only this question. "${followup.text}" was asked just before, ` +
      'so words like she, he, his, it or they refer to what it was about.)' : asked,
      notes, history, isGeneral, weak && !isGeneral)
    const loose = isGeneral || weak // may be a longer general answer
    const show = (raw) => {
      const visible = raw.replace(/<think>[\s\S]*?(<\/think>\s*|$)/, '') // belt and braces: hide any thinking
      if (visible.length > answer.length) { onEvent({ type: 'token', t: visible.slice(answer.length) }); answer = visible }
    }
    if (!eng) return builtinGenerate(messages, signal, show)
    const thinking = entryFor(status.model)?.thinking
    const stream = await eng.chat.completions.create({
      messages, stream: true, temperature: 0.2, max_tokens: loose ? 300 : 120, stop: loose ? STOP : BROWSER_STOP,
      repetition_penalty: 1.1, // small models otherwise loop on their own last line
      // Qwen3.5 thinks out loud by default; that doubles the wait for a short factual answer.
      ...(thinking ? { extra_body: { enable_thinking: false } } : {}),
    })
    let raw = ''
    for await (const chunk of stream) {
      if (signal?.aborted) break
      const t = chunk.choices?.[0]?.delta?.content
      if (!t) continue
      raw += t
      show(raw)
    }
  }

  if (route === 'local') {
    try {
      const eng = useBuiltin ? null : await ensureEngine() // null = the browser's built-in model
      if (signal?.aborted) throw aborted()
      const onAbort = () => eng?.interruptGenerate()
      signal?.addEventListener('abort', onAbort)
      try {
        if (weak) {
          // Only a weak match. Small browser models can't tell whether a loosely related note answers the
          // question: given the car-insurance note, Gemma 3 1B invented a licence plate and opened a tyre-change
          // answer with the policy number. So answer as a general (or "not in your notes") question and show
          // the note underneath, where the reader can judge it.
          related = used[0]
          used = []
          mode = 'general'
          reason = `${why} with ${name} · only a weak match → general answer, possibly related note shown`
          onEvent({ type: 'reroute', route, reason, used: [], mode })
          await generate(eng, [], true)
        } else {
          await generate(eng, used)
        }
        // Not in the best notes? Try the next ones (each pass stays small) before saying it isn't there.
        for (let next = NOTES_PER_PASS; !weak && !signal?.aborted && NOT_FOUND.test(answer) && next < relevant.length; next += NOTES_PER_PASS) {
          used = byNewest(relevant.slice(next, next + NOTES_PER_PASS))
          answer = ''
          reason = `${why} with ${name} · first notes didn't say, checked notes ${next + 1}–${next + used.length} of ${relevant.length}`
          onEvent({ type: 'reroute', route, reason, used: used.map((h) => h.mem_id) })
          await generate(eng, used)
        }
        // None of the matching notes had it: the match was a false lead ("Recommend a good book" brushing
        // past the library-books note). Answer from general knowledge instead of "your notes don't say".
        if (!general && !signal?.aborted && NOT_FOUND.test(answer)) {
          used = []
          mode = 'general'
          answer = ''
          reason = `${why} with ${name} · your notes didn't have it → general answer`
          onEvent({ type: 'reroute', route, reason, used: [], mode })
          await generate(eng, [], true)
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
  // A number or code the notes don't contain means the small model garbled it: show the note as written.
  if (related && !signal?.aborted) {
    const add = `\n\nPossibly related note: “${related.text}”`
    answer += add
    onEvent({ type: 'token', t: add })
  }
  // A refusal on a question the notes answer: show the best note instead of "I'm sorry, I can't".
  const best = relevant[0] || used[0]
  // On a weak match only when the note holds at least half the question's words ("plumber" for "my plumbre
  // number"); "my car's licence plate" vs the car-insurance note shares just "car", so that refusal stands.
  // A follow-up answered by repeating the previous answer ("What does she like?" → "Grandma's birthday is
  // 3 November." again, from Gemma 3 1B): the note itself holds the new part ("she loves orchids").
  const prevAnswer = followup ? [...history].reverse().find((t) => t.role === 'assistant')?.text || '' : ''
  const sameWords = (a, b) => {
    const A = new Set(words(a))
    const B = new Set(words(b))
    return A.size && B.size ? [...A].filter((w) => B.has(w)).length / Math.min(A.size, B.size) : 0
  }
  const repeated = followup && prevAnswer && sameWords(answer, prevAnswer) >= 0.8
  if (route === 'local' && mode === 'memory' && best && (repeated || (REFUSAL.test(answer) &&
      (!weak || vocab.covers(timing.searched_for || q, best.mem_id, 0.5))))) {
    const note = best
    answer = `Here’s your note: “${note.text}”`
    onEvent({ type: 'reroute', route, used: [note.mem_id],
      reason: `${reason} · ${repeated ? 'the model repeated its previous answer' : 'the model declined'}, so the matching note is shown` })
    onEvent({ type: 'token', t: answer })
    used = [note]
  }
  // …and so does a "yes" the note contradicts ("never give him chocolate").
  const against = route === 'local' && mode === 'memory' && used.length ? contradicts(q, answer, used) : null
  const madeUp = route === 'local' && mode === 'memory' && used.length ? unsupported(answer, used) : []
  if (madeUp.length) {
    // A number or code the notes don't contain is invented ("licence plate 4217890") or garbled
    // ("sunflower24"): don't show it at all. The closest note, word for word, is the honest answer.
    const overlap = (n) => n.text.toLowerCase().split(/\W+/).filter((w) => w.length > 2 && answer.toLowerCase().includes(w)).length
    const note = [...used].sort((a, b) => overlap(b) - overlap(a))[0]
    answer = `I couldn’t find that exact detail in your notes. The closest note is: “${note.text}”`
    reason = `${reason} · the model’s answer had details not in your notes, so the note is shown instead`
    onEvent({ type: 'reroute', route, reason, used: [note.mem_id] })
    onEvent({ type: 'token', t: answer })
    used = [note]
  } else if (against) {
    const add = `\n\nCheck your note: “${against.text}”`
    answer += add
    onEvent({ type: 'token', t: add })
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
