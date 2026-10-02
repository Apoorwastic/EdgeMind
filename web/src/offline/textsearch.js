// Text helpers that make offline note search forgiving and fast — the browser twin of edge/search.py,
// so online and offline search treat a question the same way.
//  * typo correction: a question word no note uses ("plumbre") becomes the closest note word ("plumber")
//  * word coverage: does a note contain most of the question's meaningful words (trigram near-misses count)
//  * fast path: exactly one note holds every meaningful word of the question → it's the match

const STOP = new Set(('a an the is are was were be been am i me my mine you your we our it its of to in on at for by with and ' +
  'or but not no do does did what whats when where who whom which why how can could should would will shall may might ' +
  'this that these those there here from about as into than then so if any some all tell give please thanks much many ' +
  'get got have has had s t').split(' '))

// How strongly a question leans on the previous one (same rules as edge/search.py followup_kind):
//  'pronoun' — he/she/his/it/they point back ("What's his number?" after "Who is the plumber?"): always search
//              together with the previous question (alone, "his number" finds Dad's emergency number)
//  'hint'    — "And the Wi-Fi password?", "that one", a one-word question: only when the question alone
//              finds no strong match
export function followupKind(q) {
  if (/\b(he|she|him|her|his|hers|it|its|they|them|their|theirs)\b/i.test(q)) return 'pronoun'
  if (/\b(that|this|those|these|there|same|one)\b/i.test(q) || /^\s*(and|also|what about|how about|what else|then|so|but)\b/i.test(q) ||
      words(q).filter((w) => !STOP.has(w)).length <= 1) return 'hint'
  return null
}

// Asks about the user's own things ("my", "our"): only their notes can answer, never general knowledge.
// "I"/"me" don't count: "How do I change a tyre?" is a general question.
export const isPersonal = (q) => /\b(my|our|mine|ours)\b/i.test(q)

// "Wi-Fi" → "wifi", "Grandma's" → "grandma"
export const words = (text) => text.toLowerCase().replace(/-/g, '').replace(/['’]s\b/g, '').match(/[a-z0-9]+/g) || []
export const stem = (w) => (w.length > 4 ? w.replace(/(ing|ed|es|s)$/, '') : w)
export const terms = (text) => new Set(words(text).filter((w) => !STOP.has(w)).map(stem))

// Damerau-Levenshtein (an adjacent swap is one edit: "plumbre" → "plumber"); gives up past `cap`.
export function editDistance(a, b, cap) {
  if (Math.abs(a.length - b.length) > cap) return cap + 1
  let prev2 = null
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] !== b[j - 1] ? 1 : 0))
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) cur[j] = Math.min(cur[j], prev2[j - 2] + 1)
    }
    if (Math.min(...cur) > cap) return cap + 1
    prev2 = prev
    prev = cur
  }
  return prev[b.length]
}

const trigrams = (w) => {
  const s = `  ${w} `
  const out = new Set()
  for (let i = 0; i < s.length - 2; i++) out.add(s.slice(i, i + 3))
  return out
}
const jaccard = (a, b) => {
  const A = trigrams(a)
  const B = trigrams(b)
  let n = 0
  for (const x of A) if (B.has(x)) n++
  return n / (A.size + B.size - n)
}

export class Vocabulary {
  constructor() { this.key = null; this.counts = new Map(); this.stems = new Set(); this.noteTerms = new Map() }

  refresh(notes) {
    const key = notes.map((n) => `${n.mem_id}:${n.updated_ts}`).join('|')
    if (key === this.key) return
    this.counts = new Map()
    for (const n of notes) for (const w of words(n.text)) if (w.length >= 3) this.counts.set(w, (this.counts.get(w) || 0) + 1)
    this.stems = new Set([...this.counts.keys()].map(stem))
    this.noteTerms = new Map(notes.map((n) => [n.mem_id, terms(n.text)]))
    this.key = key
  }

  // The question with unknown words replaced by the closest note word: { query, fixes: {typo: fix} }.
  correct(question) {
    const fixes = {}
    for (const w of new Set(words(question))) {
      if (w.length < 4 || STOP.has(w) || /^\d+$/.test(w) || this.counts.has(w) || this.stems.has(stem(w))) continue
      const cap = w.length <= 5 ? 1 : 2
      let best = null
      for (const [cand, n] of this.counts) {
        // Typos rarely change the first letter; requiring it keeps general questions from being "corrected".
        if (cand[0] !== w[0] || Math.abs(cand.length - w.length) > cap) continue
        const d = editDistance(w, cand, cap)
        if (d > cap || (d === 2 && jaccard(w, cand) < 0.3)) continue // two edits must keep most trigrams
        if (!best || d < best.d || (d === best.d && n > best.n)) best = { d, n, cand }
      }
      if (best) fixes[w] = best.cand
    }
    if (!Object.keys(fixes).length) return { query: question, fixes }
    const query = question.replace(/[A-Za-z0-9'’-]+/g, (tok) => fixes[words(tok)[0]] || tok)
    return { query, fixes }
  }

  covers(question, memId, share = 0.6) {
    const want = [...terms(question)]
    const have = [...(this.noteTerms.get(memId) || [])]
    if (!want.length || !have.length) return false
    const hit = want.filter((w) => have.includes(w) || have.some((h) => jaccard(w, h) >= 0.5)).length
    return hit >= Math.max(1, Math.ceil(want.length * share))
  }

  onlyNoteWithAll(question) {
    const want = [...terms(question)]
    if (want.length < 2) return null
    const found = [...this.noteTerms].filter(([, have]) => want.every((w) => have.has(w)))
    return found.length === 1 ? found[0][0] : null
  }
}
