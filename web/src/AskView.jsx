import { useEffect, useRef, useState } from 'react'
import { ago, api, fmtTime } from './api.js'
import { Icon } from './icons.jsx'
import TeamPicker from './TeamPicker.jsx'

const ROUTES = {
  cloud: { label: 'Answered by cloud AI', icon: 'cloud', cls: 'r-cloud' },
  local: { label: 'Answered on this device', icon: 'chip', cls: 'r-local' },
  retrieval: { label: 'Matching notes', icon: 'search', cls: 'r-retrieval' },
}
// No note matched: the answer comes from the model's general knowledge, never presented as memory.
const GENERAL = {
  cloud: { label: 'General answer · cloud AI', icon: 'globe', cls: 'r-general' },
  local: { label: 'General answer · on this device', icon: 'globe', cls: 'r-general' },
}

const SUGGESTIONS = [
  "What's the Wi-Fi password?",
  'When is my dentist appointment?',
  'How long should I boil an egg?',
]

function PrivacyChoice({ value, onChange }) {
  return (
    <div className="privacy-choice" role="radiogroup" aria-label="Who can see this note">
      <button type="button" role="radio" aria-checked={value === 'private'}
        className={`pc private ${value === 'private' ? 'active' : ''}`} onClick={() => onChange('private')}
        title="Stays on this device — never synced">
        <Icon name="lock" size={14} /> Only me
      </button>
      <button type="button" role="radio" aria-checked={value === 'shareable'}
        className={`pc shared ${value === 'shareable' ? 'active' : ''}`} onClick={() => onChange('shareable')}
        title="Syncs to your other devices">
        <Icon name="users" size={14} /> Team
      </button>
    </div>
  )
}

function Sources({ ids, memories }) {
  if (!ids?.length) return null
  return (
    <div className="sources">
      <span className="sources-label">Based on</span>
      {ids.map((id, i) => {
        const m = memories.find((x) => x.mem_id === id)
        const priv = m?.sensitivity === 'private'
        return (
          <span key={id} className={`source ${priv ? 'private' : 'shared'}`} title={m?.text}>
            <b>{i + 1}</b>
            <Icon name={priv ? 'lock' : 'users'} size={12} />
            <span className="source-text">{m ? m.text : 'a note'}</span>
          </span>
        )
      })}
    </div>
  )
}

function Related({ note, related, onDone }) {
  const r = related[0]
  return (
    <div className="related">
      <div className="related-q"><Icon name="restore" size={15} /> Is this an update to an older note?</div>
      <p className="related-old">“{r.text}”</p>
      <div className="row gap">
        <button className="btn primary small" onClick={async () => { await api.supersede(note.mem_id, r.mem_id); onDone() }}>
          Yes, replace the old one
        </button>
        <button className="btn ghost small" onClick={onDone}>No, keep both</button>
      </div>
    </div>
  )
}

// Ambient orb: breathes while online, dims and stills when offline.
export function Orb({ online, size = 132 }) {
  return (
    <div className={`orb ${online ? 'on' : 'off'}`} style={{ width: size, height: size }} aria-hidden="true">
      <i className="orb-ring r1" /><i className="orb-ring r2" /><i className="orb-ring r3" />
      <i className="orb-core" />
    </div>
  )
}

function Welcome({ onPick, online, count }) {
  return (
    <div className="welcome">
      <Orb online={online} />
      <h1>Ask your memory.</h1>
      <p className="lead">
        {count} notes on this device · {online ? 'online' : 'offline — still works'}
      </p>
      <div className="suggestions">
        {SUGGESTIONS.map((s) => (
          <button key={s} className="chip" onClick={() => onPick({ mode: 'ask', text: s })}>{s}</button>
        ))}
      </div>
    </div>
  )
}

const ACT_ICON = { sync: 'sync', privacy: 'shield', conflict: 'warn', memory: 'notes', ask: 'spark', search: 'search', network: 'link', system: 'chip' }
// Activity messages carry internal ids; the rail shows a readable one-liner.
const tidy = (msg) => msg.replace(/\s*\bm_\d+_[a-z0-9]{4}\b/g, '').replace(/\s{2,}/g, ' ').replace(/^(Stored|Edited|Deleted) locally/, '$1 note locally')

function MemoryRail({ last, memories, activity }) {
  const recent = memories.filter((m) => !m.superseded_by).sort((a, b) => b.updated_ts - a.updated_ts).slice(0, 4)
  const hits = last?.hits || []
  const best = Math.max(...hits.map((h) => h.semantic), 0.0001)
  return (
    <aside className="rail" aria-label="Memory on this device">
      <section className="rail-block">
        <div className="rail-head">
          <h3>{last ? 'Matched memory' : 'Recent memory'}</h3>
          {last && <span className="speed"><Icon name="search" size={11} /> {last.timing.search_ms} ms</span>}
        </div>
        {last && !hits.length && <p className="rail-empty">No note matched — answered from general knowledge.</p>}
        <ul className="rail-list">
          {(last ? hits : recent).map((m) => {
            const priv = m.sensitivity === 'private'
            const used = last?.used.includes(m.mem_id)
            return (
              <li key={m.mem_id} className={`mem-chip ${priv ? 'private' : 'shared'} ${used ? 'used' : ''}`}>
                <Icon name={priv ? 'lock' : 'users'} size={13} />
                <span className="mem-chip-text">{m.text}</span>
                {last && (
                  <span className="match" title={`similarity ${m.semantic.toFixed(2)}`}>
                    <i style={{ width: `${Math.round((m.semantic / best) * 100)}%` }} />
                  </span>
                )}
                {used && <span className="used-tag">used</span>}
              </li>
            )
          })}
        </ul>
      </section>

      <section className="rail-block">
        <div className="rail-head"><h3>Live activity</h3><a className="rail-link" href="#/admin/activity">All</a></div>
        <ol className="ticker">
          {activity.filter((a) => a.kind !== 'ask' && a.kind !== 'search').slice(-6).reverse().map((a) => (
            <li key={a.seq} className={`k-${a.kind}`}>
              <span className="tick-icon"><Icon name={ACT_ICON[a.kind] || 'pulse'} size={12} /></span>
              <span className="tick-msg">{tidy(a.message)}</span>
              <span className="tick-time">{ago(a.ts)}</span>
            </li>
          ))}
        </ol>
      </section>
    </aside>
  )
}

export default function AskView({ state, memories, onChanged, activity, cid, onChatStarted, rail = true }) {
  const [turns, setTurns] = useState([])
  const current = useRef(undefined) // conversation shown right now; a new chat learns its id from the device
  const [mode, setMode] = useState('ask')
  const [sensitivity, setSensitivity] = useState('private')
  const [teamId, setTeamId] = useState(null) // which team a 'shareable' note goes to
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [last, setLast] = useState(null) // last retrieval, shown in the memory rail
  const [answering, setAnswering] = useState(false)
  const abort = useRef(null) // aborts the answer being streamed right now
  const scroller = useRef(null)
  const input = useRef(null)
  const online = state.network.online
  const teams = state.teams || []

  // Zero-friction single-team path: the moment "Team" is picked, auto-select the device's only
  // team so the picker never has to be shown for that case.
  useEffect(() => {
    if (sensitivity === 'shareable' && teams.length === 1 && teamId !== teams[0].id) setTeamId(teams[0].id)
  }, [sensitivity, teams, teamId])

  useEffect(() => {
    // The first question of a new chat changes the URL to its new id; that chat is already on screen.
    if (cid === current.current) return
    current.current = cid
    setLast(null)
    if (!cid) { setTurns([]); return }
    let stale = false
    api.chat(cid).then((h) => { if (!stale) setTurns(h.map((t) => ({ ...t, kind: 'chat' }))) }).catch(() => setTurns([]))
    return () => { stale = true }
  }, [cid])
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' })
  }, [turns])

  const pick = ({ mode: m, text: t, sensitivity: s }) => {
    if (m) setMode(m)
    if (s) setSensitivity(s)
    if (t !== undefined) setText(t)
    setTimeout(() => input.current?.focus(), 0)
  }

  const patchLast = (fn) => setTurns((ts) => [...ts.slice(0, -1), fn(ts[ts.length - 1])])

  const ask = async (q) => {
    setTurns((ts) => [...ts, { role: 'user', text: q, ts: Date.now(), kind: 'chat' },
      { role: 'assistant', text: '', ts: Date.now(), kind: 'chat', pending: true }])
    let askCid = current.current
    const ctrl = new AbortController()
    abort.current = ctrl
    setAnswering(true)
    try {
      await api.ask(q, askCid, (ev) => {
        if (ev.type === 'chat') {
          if (!current.current && askCid === current.current) {
            current.current = ev.cid
            onChatStarted(ev.cid)
          }
          askCid = ev.cid
          return
        }
        if (current.current !== askCid) return // user switched chats mid-answer; it is saved on the device anyway
        if (ev.type === 'retrieval') {
          setLast({ q, hits: ev.hits.filter((h) => h.relevant), used: ev.used, timing: ev.timing })
          patchLast((t) => ({ ...t, route: ev.route, mode: ev.mode, reason: ev.reason, used: ev.used, timing: ev.timing,
            nHits: ev.hits.filter((h) => h.relevant).length }))
        } else if (ev.type === 'token') {
          patchLast((t) => ({ ...t, text: t.text + ev.t }))
        } else if (ev.type === 'reroute') {
          patchLast((t) => ({ ...t, route: ev.route, reason: ev.reason, text: '', ...(ev.used ? { used: ev.used } : {}) }))
        } else if (ev.type === 'done') {
          patchLast((t) => ({ ...t, pending: false, route: ev.route }))
        }
      }, ctrl.signal)
    } catch (e) {
      // Stopped by the user (the device keeps the partial answer), or the connection dropped.
      if (current.current === askCid) {
        patchLast((t) => t.pending
          ? { ...t, pending: false, stopped: ctrl.signal.aborted, text: t.text || (ctrl.signal.aborted ? '' : `Couldn’t reach this device: ${e.message}`) }
          : t)
      }
    } finally {
      if (abort.current === ctrl) { abort.current = null; setAnswering(false) }
    }
  }

  const stop = () => abort.current?.abort()

  const remember = async (note) => {
    const res = await api.addMemory(note, sensitivity, undefined, teamId)
    setTurns((ts) => [...ts, { kind: 'note', text: note, ts: Date.now(), sensitivity, teamId: res.memory.team_id,
      mem: res.memory, related: res.related }])
    onChanged()
  }

  const needsTeamPick = sensitivity === 'shareable' && teams.length > 1 && !teamId
  const submit = async (e) => {
    e?.preventDefault()
    const v = text.trim()
    if (!v || busy || (mode === 'remember' && needsTeamPick)) return
    setText('')
    setBusy(true)
    try { await (mode === 'ask' ? ask(v) : remember(v)) } finally { setBusy(false) }
  }

  const modelFor = (route) => route === 'cloud' ? state.models.cloud_llm : route === 'local' ? state.models.local_llm : null

  return (
    <div className={`ask-layout ${rail ? '' : 'no-rail'}`}>
    <div className="ask-view">
      <div className="turns" ref={scroller}>
        <div className="turns-inner">
          {!turns.length && (
            <Welcome onPick={pick} online={online} count={memories.filter((m) => !m.superseded_by).length} />
          )}
          {turns.map((t, i) => {
            if (t.kind === 'note') {
              const priv = t.sensitivity === 'private'
              const tTeam = teams.find((x) => x.id === t.teamId)
              const teamLabel = tTeam ? `Shared with ${tTeam.name}` : 'Shared with team'
              return (
                <div key={i} className={`bubble saved ${priv ? 'private' : 'shared'}`}>
                  <div className="saved-head">
                    <span className="saved-check"><Icon name="check" size={13} strokeWidth={2.4} /></span>
                    <b>Note saved</b>
                    <span className={`badge ${priv ? 'private' : online ? 'shared' : 'waiting'}`}>
                      <Icon name={priv ? 'lock' : online ? 'users' : 'queued'} size={12} />
                      {priv ? 'Only me' : !t.teamId ? 'Shares once you join a team' : online ? teamLabel : 'Will share when online'}
                    </span>
                  </div>
                  <p>{t.text}</p>
                  {t.related?.length > 0 && !t.resolved && (
                    <Related note={t.mem} related={t.related}
                      onDone={() => { setTurns((ts) => ts.map((x, j) => j === i ? { ...x, resolved: true } : x)); onChanged() }} />
                  )}
                </div>
              )
            }
            if (t.role === 'user') {
              return <div key={i} className="bubble user"><p>{t.text}</p></div>
            }
            const r = (t.mode === 'general' && GENERAL[t.route]) || ROUTES[t.route] || ROUTES.retrieval
            return (
              <div key={i} className={`bubble assistant ${t.pending ? 'pending' : ''} ${r.cls}`}>
                {t.route && (
                  <div className="answer-by">
                    <Icon name={r.icon} size={13} /> {r.label}
                    {modelFor(t.route) && <span className="muted"> · {modelFor(t.route)}</span>}
                    {t.timing && <span className="speed"><Icon name="search" size={11} /> {t.timing.search_ms} ms</span>}
                  </div>
                )}
                <p className="answer">
                  {t.text || (t.pending
                    ? <span className="thinking"><i /><i /><i /></span>
                    : t.stopped ? ''
                      : t.route === 'retrieval' && !t.used?.length ? 'I couldn’t find anything about that in your notes.' : '')}
                </p>
                {t.stopped && <div className="stopped-note"><Icon name="stop" size={11} strokeWidth={2.4} /> Stopped{t.text ? '' : ' before answering'}</div>}
                <Sources ids={t.used} memories={memories} />
                {t.mode === 'general' && !t.pending && t.route !== 'retrieval' && (
                  <div className="general-note"><Icon name="info" size={12} /> Not from your notes — check important facts.</div>
                )}
                {!t.pending && t.reason && (
                  <details className="why">
                    <summary>Why this answer?</summary>
                    <ul>
                      <li>Searched notes on this device{t.timing ? ` in ${Math.round(t.timing.search_ms)} ms` : ''} — {t.nHits ?? 0} matched.</li>
                      <li>{t.reason}.</li>
                      {t.used?.some((id) => memories.find((m) => m.mem_id === id)?.sensitivity === 'private') &&
                        <li>Private notes were used, so nothing was sent to the cloud.</li>}
                    </ul>
                  </details>
                )}
                {t.ts && <span className="time">{fmtTime(t.ts)}</span>}
              </div>
            )
          })}
        </div>
      </div>

      <div className="composer-wrap">
        <form className={`composer mode-${mode}`} onSubmit={submit}>
          <div className="composer-top">
            <div className="mode-switch" role="tablist" aria-label="What do you want to do">
              <button type="button" role="tab" aria-selected={mode === 'ask'} className={mode === 'ask' ? 'active' : ''}
                onClick={() => pick({ mode: 'ask' })}>
                <Icon name="spark" size={15} /> Ask
              </button>
              <button type="button" role="tab" aria-selected={mode === 'remember'} className={mode === 'remember' ? 'active' : ''}
                onClick={() => pick({ mode: 'remember' })}>
                <Icon name="plus" size={15} /> Save a note
              </button>
            </div>
            {mode === 'remember' && <PrivacyChoice value={sensitivity} onChange={(v) => { setSensitivity(v); if (v === 'private') setTeamId(null) }} />}
          </div>
          {mode === 'remember' && sensitivity === 'shareable' && (
            <TeamPicker teams={teams} value={teamId} onPick={setTeamId} onAdded={setTeamId} />
          )}
          <div className="composer-input">
            <textarea ref={input} value={text} rows={2} onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && answering) { e.preventDefault(); stop() }
                else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() }
              }}
              placeholder={mode === 'ask' ? 'Type your question…' : 'Type what you want to remember…'} />
            {answering ? (
              <button className="send stop" type="button" onClick={stop} title="Stop answering (Esc)" aria-label="Stop answering">
                <Icon name="stop" size={14} strokeWidth={2.4} /> Stop
              </button>
            ) : (
              <button className="send" disabled={busy || !text.trim() || (mode === 'remember' && needsTeamPick)} type="submit">
                {mode === 'ask' ? <><Icon name="arrowUp" size={16} strokeWidth={2.2} /> Ask</> : <><Icon name="check" size={16} strokeWidth={2.2} /> Save</>}
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
    {rail && <MemoryRail last={last} memories={memories} activity={activity} />}
    </div>
  )
}
