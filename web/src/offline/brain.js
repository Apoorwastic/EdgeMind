// The device's brain, rebuilt inside the browser for when the device can't be reached:
// hybrid search over the local copy of your notes, and an optional on-device model (WebLLM
// on WebGPU) that writes answers. Both download once while online and then load from the
// browser's cache, so they work with no internet at all.
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

export const MODELS = {
  small: { base: 'Qwen2.5-0.5B-Instruct', label: 'Small', size: '≈ 400 MB', hint: 'faster, fine for phones' },
  standard: { base: 'Qwen2.5-1.5B-Instruct', label: 'Standard', size: '≈ 1 GB', hint: 'better answers' },
}
const EMBED_MODEL = 'Xenova/all-MiniLM-L6-v2' // ~23 MB, runs on the CPU via WebAssembly

// ---------------------------------------------------------------- capability

let gpuInfo
export async function webgpu() {
  if (gpuInfo) return gpuInfo
  gpuInfo = (async () => {
    if (!navigator.gpu) return { ok: false, why: 'This browser has no WebGPU. Use a recent Chrome or Edge.' }
    try {
      const a = await navigator.gpu.requestAdapter()
      if (!a) return { ok: false, why: 'No compatible graphics adapter found.' }
      return { ok: true, f16: a.features.has('shader-f16') }
    } catch (e) {
      return { ok: false, why: e.message }
    }
  })()
  return gpuInfo
}

const modelId = (size, f16) => `${MODELS[size].base}-${f16 ? 'q4f16_1' : 'q4f32_1'}-MLC`

// ---------------------------------------------------------------- embeddings (semantic search)

let embedP = null
function embedder(progress) {
  if (!embedP) {
    embedP = import('@huggingface/transformers')
      .then(({ pipeline }) => pipeline('feature-extraction', EMBED_MODEL, { dtype: 'q8', device: 'wasm', progress_callback: progress }))
      .catch((e) => { embedP = null; throw e })
  }
  return embedP
}
const vectors = new Map() // note text -> unit vector
async function embed(texts) {
  const ex = await embedder()
  const out = await ex(texts, { pooling: 'mean', normalize: true })
  return out.tolist()
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

// Hybrid search over the browser's copy of the notes. Mirrors the device's relevance rules.
export async function search(q, memories, limit = 6) {
  const t0 = performance.now()
  const docs = memories.filter((m) => !m.superseded_by)
  const kw = keywordScores(q, docs)
  const kwTop = Math.max(0, ...kw)
  let sem = null
  let embedMs = 0
  if (aiPrefs.get()?.embed) {
    try {
      const e0 = performance.now()
      const [qv, ...dv] = await vectorsFor([q, ...docs.map((d) => d.text)])
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
    // MiniLM puts unrelated notes near 0.0–0.25; a hit must clear a floor and sit near the best one.
    const relevant = sem
      ? (s >= 0.32 && s >= semTop - 0.15) || (kw[i] > 0 && k >= 0.6 && s >= 0.2)
      : kw[i] > 0 && k >= 0.5
    return { ...d, semantic: s, keyword: kw[i], relevant, score: sem ? s * 0.8 + k * 0.2 : k }
  })
  hits.sort((a, b) => b.score - a.score)
  return {
    hits: hits.slice(0, limit),
    timing: { embed_ms: Math.round(embedMs * 10) / 10, search_ms: Math.round((performance.now() - t0 - embedMs) * 100) / 100 },
  }
}

// ---------------------------------------------------------------- on-device model (WebLLM)

let engine = null
let engineP = null
let webllmMod = null
const webllm = async () => (webllmMod ||= await import('@mlc-ai/web-llm'))

export function aiStatus() {
  const p = aiPrefs.get()
  return { downloaded: !!p?.model, model: p?.model || null, size: p?.size || null, loaded: !!engine }
}

async function loadEngine(id, onProgress) {
  const { CreateMLCEngine } = await webllm()
  return CreateMLCEngine(id, { initProgressCallback: (r) => onProgress?.(r.progress, r.text) })
}

export function ensureEngine(onProgress) {
  const p = aiPrefs.get()
  if (engine) return Promise.resolve(engine)
  if (!p?.model) return Promise.resolve(null)
  engineP ||= loadEngine(p.model, onProgress).then((e) => (engine = e)).catch((e) => { engineP = null; throw e })
  return engineP
}

// Downloads the search model and the answer model, reporting 0..1 progress with a short label.
export async function download(size, onProgress) {
  const gpu = await webgpu()
  if (!gpu.ok) throw new Error(gpu.why)
  onProgress(0, 'Downloading the search model…')
  await embedder((p) => { if (p.status === 'progress' && p.total) onProgress(0.05 * (p.loaded / p.total), 'Downloading the search model…') })
  await embed(['warm up'])
  const id = modelId(size, gpu.f16)
  if (engine) { await engine.unload?.(); engine = null; engineP = null }
  engine = await loadEngine(id, (p, text) => onProgress(0.05 + 0.95 * p, text))
  engineP = Promise.resolve(engine)
  aiPrefs.set({ model: id, size, embed: true, ts: Date.now() })
  logActivity('system', `Offline AI ready in this browser — ${id}`)
  onProgress(1, 'Ready')
  return id
}

export async function removeAI() {
  const p = aiPrefs.get()
  if (engine) { await engine.unload?.(); engine = null; engineP = null }
  if (p?.model) {
    const { deleteModelAllInfoInCache } = await webllm()
    await deleteModelAllInfoInCache(p.model).catch(() => {})
  }
  try { await caches.delete('transformers-cache') } catch { /* no cache api */ }
  embedP = null
  vectors.clear()
  aiPrefs.set(null)
}

// Is the model really in this browser's cache (not just remembered as downloaded)?
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

// ---------------------------------------------------------------- ask, offline

function buildMessages(q, hits, history, general) {
  if (general) {
    return [{ role: 'system', content: SYSTEM_GENERAL },
      ...history.slice(-4).map((t) => ({ role: t.role, content: t.text })),
      { role: 'user', content: q }]
  }
  // Browser models are small (0.5B–1.5B): with "[1] (date) text" lines they tend to echo a line back
  // verbatim, or answer the first fact in it rather than the one asked about. Plain notes + an explicit
  // instruction to answer only what was asked keeps them on track.
  const fmt = (ts) => new Date(ts).toISOString().slice(0, 10)
  const ctx = hits.map((h, i) => `Note ${i + 1} (saved ${fmt(h.ts)}): ${h.text}`).join('\n')
  const system = `${SYSTEM} Answer exactly what the question asks, in your own words as one or two full sentences. ` +
    'Never copy the "Note N (saved …)" labels into the answer.'
  return [{ role: 'system', content: system }, { role: 'user', content: `My notes:\n${ctx}\n\nQuestion: ${q}` }]
}

const aborted = () => new DOMException('Stopped', 'AbortError')

// Same event stream as the device's /api/ask: chat → retrieval → token* → (reroute) → done.
export async function ask(q, cid, onEvent, signal, { memories, history }) {
  cid ||= chats.newId()
  onEvent({ type: 'chat', cid })
  const { hits, timing } = await search(q, memories)
  const context = hits.filter((h) => h.relevant && !h.superseded_by).sort((a, b) => b.ts - a.ts)
  const general = !context.length
  const mode = general ? 'general' : 'memory'
  const status = aiStatus()
  const gpu = status.downloaded ? await webgpu() : { ok: false }
  let route = status.downloaded && gpu.ok ? 'local' : 'retrieval'
  const why = 'device unreachable · answered in this browser'
  let reason = route === 'local'
    ? `${why} with ${status.model}`
    : `${why} · no offline AI downloaded (Admin → Offline AI) → ${general ? 'nothing to show' : 'matching notes shown'}`
  const used = context
  onEvent({ type: 'retrieval', hits, timing, route, reason, used: used.map((h) => h.mem_id), mode })
  logActivity('ask', `'${q.slice(0, 48)}' → ${context.length} notes matched in this browser · ${route}`)

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

  if (route === 'local') {
    try {
      const eng = await ensureEngine()
      if (signal?.aborted) throw aborted()
      const onAbort = () => eng.interruptGenerate()
      signal?.addEventListener('abort', onAbort)
      try {
        const stream = await eng.chat.completions.create({
          messages: buildMessages(q, context, history, general), stream: true, temperature: 0.2,
          max_tokens: general ? 600 : 300, stop: STOP,
        })
        for await (const chunk of stream) {
          if (signal?.aborted) break
          const t = chunk.choices?.[0]?.delta?.content
          if (t) { answer += t; onEvent({ type: 'token', t }) }
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
    answer = context.length
      ? 'Here is what your notes on this device say:\n' + context.slice(0, 4).map((h) => `• ${h.text}`).join('\n')
      : 'Nothing in your notes matches that. Download the offline AI (Admin → Offline AI) to get general answers without internet.'
    onEvent({ type: 'token', t: answer })
  }
  save()
  onEvent({ type: 'done', route, mode })
}
