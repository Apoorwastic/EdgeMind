import { useState } from 'react'
import { ago, api, deviceName } from './api.js'
import { Icon } from './icons.jsx'

function StatusBadge({ m }) {
  if (m.sensitivity === 'private') return <span className="badge private"><Icon name="lock" size={12} />Only me</span>
  if (m.synced) return <span className="badge shared"><Icon name="users" size={12} />Team</span>
  return <span className="badge waiting"><Icon name="queued" size={12} />Waiting to sync</span>
}

// Plain-words answer to "where does this note live?"
function whereItLives(m, device) {
  if (m.sensitivity === 'private') return `Stored only on this ${device.name}. It never leaves this device.`
  if (m.synced) return 'Shared with your team — copied to your other devices whenever they’re online.'
  return 'Will be shared with your team as soon as this device is back online.'
}

function NoteCard({ m, device, onChanged, old }) {
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  const [text, setText] = useState(m.text)
  const [err, setErr] = useState(null)
  const foreign = m.origin && m.origin !== device.id
  const priv = m.sensitivity === 'private'

  const run = async (fn) => {
    setErr(null)
    try { await fn(); onChanged() } catch (e) { setErr(e.message) }
  }
  const toggle = () => { if (!editing) { setOpen(!open); setConfirmDel(false) } }

  return (
    <li className={`note ${priv ? 'private' : 'shared'} ${old ? 'old' : ''} ${open ? 'open' : ''}`}>
      <div className="note-main" role="button" tabIndex={editing ? -1 : 0} aria-expanded={open}
        onClick={toggle} onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggle() } }}>
        {editing ? (
          <form className="note-edit" onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => { e.preventDefault(); run(async () => { await api.editMemory(m.mem_id, { text }); setEditing(false) }) }}>
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} autoFocus />
            <div className="row gap">
              <button className="btn primary small" type="submit">Save changes</button>
              <button className="btn ghost small" type="button" onClick={() => { setEditing(false); setText(m.text) }}>Cancel</button>
            </div>
          </form>
        ) : (
          <p className="note-text">{m.text}</p>
        )}

        <div className="note-foot">
          <div className="note-tags">
            <StatusBadge m={m} />
            {foreign && <span className="badge neutral"><Icon name="arrowDown" size={12} />From {deviceName(m.origin)}</span>}
            {m.supersedes && !old && <span className="badge neutral"><Icon name="restore" size={12} />Updated</span>}
            {old && <span className="badge neutral">Older version</span>}
          </div>
          <span className="note-time" title={new Date(m.updated_ts).toLocaleString()}>{ago(m.updated_ts)}</span>
        </div>
      </div>

      {open && !editing && (
        <p className="note-where">
          <Icon name={priv ? 'lock' : m.synced ? 'users' : 'queued'} size={13} />
          <span>{whereItLives(m, device)} Last changed {new Date(m.updated_ts).toLocaleString()}.</span>
        </p>
      )}

      {err && <div className="note-err"><Icon name="warn" size={13} /> {err}</div>}

      {open && !editing && (
        confirmDel ? (
          <div className="note-confirm">
            <span>Delete this note{!priv ? ' for everyone' : ''}?</span>
            <button className="btn danger small" onClick={() => run(() => api.deleteMemory(m.mem_id))}>Delete</button>
            <button className="btn ghost small" onClick={() => setConfirmDel(false)}>Cancel</button>
          </div>
        ) : (
          <div className="note-actions">
            {!(foreign && !priv) && (
              <button className="btn ghost small" onClick={() => run(() => api.editMemory(m.mem_id, { sensitivity: priv ? 'shareable' : 'private' }))}
                title={priv ? 'Share with your other devices' : 'Make private — removes it from the shared store'}>
                <Icon name={priv ? 'users' : 'lock'} size={14} /> {priv ? 'Share' : 'Make private'}
              </button>
            )}
            <button className="btn ghost small" onClick={() => { setText(m.text); setEditing(true) }}>
              <Icon name="edit" size={14} /> Edit
            </button>
            <button className="btn ghost small danger-text" onClick={() => setConfirmDel(true)}>
              <Icon name="trash" size={14} /> Delete
            </button>
          </div>
        )
      )}
    </li>
  )
}

function NewNote({ onSaved, onCancel }) {
  const [text, setText] = useState('')
  const [sensitivity, setSensitivity] = useState('private')
  const [busy, setBusy] = useState(false)
  const save = async (e) => {
    e.preventDefault()
    if (!text.trim()) return
    setBusy(true)
    try { await api.addMemory(text.trim(), sensitivity); onSaved() } finally { setBusy(false) }
  }
  return (
    <form className="new-note card" onSubmit={save}>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} autoFocus
        placeholder="What do you want to remember?" />
      <div className="new-note-bar">
        <div className="seg" role="radiogroup" aria-label="Who can see this note">
          <button type="button" className={sensitivity === 'private' ? 'active private' : ''} onClick={() => setSensitivity('private')}>
            <Icon name="lock" size={14} /> Only me
          </button>
          <button type="button" className={sensitivity === 'shareable' ? 'active shared' : ''} onClick={() => setSensitivity('shareable')}>
            <Icon name="users" size={14} /> Team
          </button>
        </div>
        <div className="row gap">
          <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy || !text.trim()}>
            <Icon name="check" size={15} /> Save note
          </button>
        </div>
      </div>
    </form>
  )
}

export default function NotesView({ memories, state, onChanged }) {
  const [filter, setFilter] = useState('all')
  const [q, setQ] = useState('')
  const [results, setResults] = useState(null)
  const [adding, setAdding] = useState(false)
  const [showOld, setShowOld] = useState(false)
  const device = state.device

  const current = memories.filter((m) => !m.superseded_by)
  const older = memories.filter((m) => m.superseded_by)
  const FILTERS = [
    ['all', 'All', current.length],
    ['private', 'Only me', current.filter((m) => m.sensitivity === 'private').length],
    ['shared', 'Team', current.filter((m) => m.sensitivity === 'shareable').length],
    ['waiting', 'Waiting', current.filter((m) => m.sensitivity === 'shareable' && !m.synced).length],
  ].filter(([k, , n]) => k !== 'waiting' || n > 0)
  const active = FILTERS.some(([k]) => k === filter) ? filter : 'all'
  const match = (m) =>
    active === 'all' ? true
      : active === 'private' ? m.sensitivity === 'private'
        : active === 'shared' ? m.sensitivity === 'shareable'
          : m.sensitivity === 'shareable' && !m.synced

  const shown = results
    ? results.hits.filter((h) => h.relevant).map((h) => memories.find((m) => m.mem_id === h.mem_id) || h)
    : current.filter(match).sort((a, b) => b.updated_ts - a.updated_ts)

  const search = async (e) => {
    e.preventDefault()
    if (!q.trim()) { setResults(null); return }
    setResults(await api.search(q))
  }

  return (
    <div className="notes-view">
      <div className="page-head">
        <div>
          <h1>My notes</h1>
          <p className="lead">{current.length} on this device · search works offline</p>
        </div>
        {!adding && (
          <button className="btn primary" onClick={() => setAdding(true)}>
            <Icon name="plus" size={16} strokeWidth={2.2} /> New note
          </button>
        )}
      </div>

      {adding && <NewNote onSaved={() => { setAdding(false); onChanged() }} onCancel={() => setAdding(false)} />}

      <form className="search" onSubmit={search}>
        <Icon name="search" size={18} />
        <input value={q} placeholder="Search your notes…"
          onChange={(e) => { setQ(e.target.value); if (!e.target.value) setResults(null) }} />
        {results
          ? <button type="button" className="btn ghost small" onClick={() => { setQ(''); setResults(null) }}><Icon name="x" size={14} /> Clear</button>
          : <button type="submit" className="btn small" disabled={!q.trim()}>Search</button>}
      </form>

      {results ? (
        <div className="result-note">
          {shown.length ? `${shown.length} matching note${shown.length > 1 ? 's' : ''}` : 'No notes match that'} · found on this device in {Math.round(results.timing.search_ms)} ms
        </div>
      ) : (
        <div className="filters" role="tablist">
          {FILTERS.map(([k, label, n]) => (
            <button key={k} role="tab" aria-selected={active === k} className={`chip ${active === k ? 'active' : ''}`}
              onClick={() => setFilter(k)}>
              {label} <span className="count">{n}</span>
            </button>
          ))}
        </div>
      )}

      {!shown.length && !results ? (
        <div className="empty-state">
          <Icon name="notes" size={32} />
          <b>{memories.length ? 'Nothing in this list' : 'No notes yet'}</b>
          <span>{memories.length ? 'Try another filter.' : 'Save your first note — it’s stored on this device instantly, signal or not.'}</span>
          {!memories.length && <button className="btn primary" onClick={() => setAdding(true)}><Icon name="plus" size={15} /> New note</button>}
        </div>
      ) : (
        <ul className="note-grid">
          {shown.map((m) => <NoteCard key={m.mem_id} m={m} device={device} onChanged={onChanged} old={!!m.superseded_by} />)}
        </ul>
      )}

      {!results && older.length > 0 && (
        <div className="older">
          <button className="btn ghost small" onClick={() => setShowOld(!showOld)}>
            <Icon name="restore" size={14} /> {showOld ? 'Hide' : 'Show'} {older.length} older version{older.length > 1 ? 's' : ''}
          </button>
          {showOld && (
            <ul className="note-grid">
              {older.map((m) => <NoteCard key={m.mem_id} m={m} device={device} onChanged={onChanged} old />)}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
