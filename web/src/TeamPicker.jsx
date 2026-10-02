import { useState } from 'react'
import { api } from './api.js'
import { Icon } from './icons.jsx'

// Above this many teams, a filter box appears — scanning a tall list by eye stops being faster
// than typing a few letters.
const FILTER_ABOVE = 6

// Which team a shareable note goes to. A compact "Sharing to <Team>" button that expands into a
// list + "New team" row (itself Create or Join) — shown the same way whether there's 0, 1 or
// several teams, so there's always a visible, clickable place to see or change the destination.
// The row list is capped and scrolls internally (see .team-picker-rows), so it can never push the
// rest of the page down no matter how many teams there are.
export default function TeamPicker({ teams, value, onPick, onAdded }) {
  // Teams created or joined from inside this picker, merged in locally so the team shows up and
  // gets selected immediately — the parent's `teams` prop only catches up once the next
  // state/SSE refresh lands, which otherwise reads as "nothing happened" and invites re-submitting.
  const [justAdded, setJustAdded] = useState([])
  const [expanded, setExpanded] = useState(() => !value)
  const [addMode, setAddMode] = useState(teams.length === 0 ? 'create' : null) // null | 'create' | 'join'
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [filter, setFilter] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const allTeams = [...teams, ...justAdded.filter((t) => !teams.some((x) => x.id === t.id))]
  const selected = allTeams.find((t) => t.id === value)
  const shownTeams = filter.trim()
    ? allTeams.filter((t) => t.name.toLowerCase().includes(filter.trim().toLowerCase()))
    : allTeams
  const codeValid = code.replace(/[^A-Z0-9]/g, '').length === 6

  const pick = (id) => { onPick(id); setExpanded(false); setAddMode(null) }

  const added = (team) => {
    setJustAdded((js) => [...js, team])
    pick(team.id)
    onAdded(team.id)
  }

  // Plain functions, not form submits: this picker lives inside the note composer's own <form>,
  // and nested <form> elements are invalid HTML — the browser won't reliably route a submit to an
  // inner one (Enter/click can silently no-op or submit the outer form instead), which is why
  // "Create & share here" looked like it did nothing before this was changed to plain buttons.
  const create = async () => {
    const n = name.trim()
    if (!n || busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await api.createTeam(n)
      setName('')
      added(res.result)
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const join = async () => {
    if (!codeValid || busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await api.joinTeam(code.trim())
      setCode('')
      added(res.result)
    } catch (e) {
      setError(e.message) // e.g. "No team has that invite code."
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="team-picker">
      <button type="button" className="team-picker-summary" aria-expanded={expanded}
        onClick={() => setExpanded((x) => !x)}>
        <Icon name="users" size={14} />
        <span>{selected ? <>Sharing to <b>{selected.name}</b></> : 'Pick a team'}</span>
        <Icon name="arrowDown" size={13} className={`team-picker-caret ${expanded ? 'open' : ''}`} />
      </button>

      {expanded && (
        <div className="team-picker-panel">
          {allTeams.length > FILTER_ABOVE && (
            <div className="team-picker-filter">
              <Icon name="search" size={13} />
              <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter teams…" />
            </div>
          )}

          {allTeams.length > 0 && (
            <div className="team-picker-rows">
              {shownTeams.length ? shownTeams.map((t) => (
                <button key={t.id} type="button" className={`team-picker-row ${t.id === value ? 'active' : ''}`}
                  onClick={() => pick(t.id)}>
                  <Icon name="users" size={14} />
                  <span>{t.name}</span>
                  {t.id === value && <Icon name="check" size={14} />}
                </button>
              )) : (
                <p className="team-picker-empty">No team matches “{filter}”.</p>
              )}
            </div>
          )}

          {addMode ? (
            <div className="team-picker-add">
              <div className="seg team-picker-add-tabs" role="tablist" aria-label="Create or join">
                <button type="button" role="tab" aria-selected={addMode === 'create'}
                  className={addMode === 'create' ? 'active' : ''} onClick={() => { setAddMode('create'); setError(null) }}>
                  <Icon name="plus" size={13} /> Create
                </button>
                <button type="button" role="tab" aria-selected={addMode === 'join'}
                  className={addMode === 'join' ? 'active' : ''} onClick={() => { setAddMode('join'); setError(null) }}>
                  <Icon name="link" size={13} /> Join
                </button>
              </div>

              {addMode === 'create' ? (
                <div className="team-picker-create">
                  <input autoFocus value={name} onChange={(e) => setName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); create() } }}
                    placeholder="Team name, e.g. Our Family" maxLength={40} />
                  <div className="row gap">
                    <button type="button" className="btn primary small" disabled={busy || !name.trim()} onClick={create}>
                      Create &amp; share here
                    </button>
                    {allTeams.length > 0 && <button type="button" className="btn ghost small" onClick={() => setAddMode(null)}>Cancel</button>}
                  </div>
                </div>
              ) : (
                <div className="team-picker-create">
                  <input autoFocus className="code-input" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); join() } }}
                    placeholder="ABC-123" maxLength={8} />
                  <div className="row gap">
                    <button type="button" className="btn primary small" disabled={busy || !codeValid} onClick={join}>
                      Join &amp; share here
                    </button>
                    {allTeams.length > 0 && <button type="button" className="btn ghost small" onClick={() => setAddMode(null)}>Cancel</button>}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <button type="button" className="team-picker-row new" onClick={() => setAddMode('create')}>
              <Icon name="plus" size={14} /> New team
            </button>
          )}
          {error && <p className="team-error"><Icon name="warn" size={13} /> {error}</p>}
        </div>
      )}

      {!expanded && !selected && (
        <p className="team-picker-hint"><Icon name="warn" size={12} /> Pick a team to share this with.</p>
      )}
    </div>
  )
}
