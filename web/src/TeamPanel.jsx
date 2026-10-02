import { useEffect, useState } from 'react'
import { ago, api, deviceName } from './api.js'
import { Icon } from './icons.jsx'

const ACTIVE_MS = 30000 // a member that synced this recently counts as active

function useAction() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const run = async (fn) => {
    setBusy(true)
    setError(null)
    try { return await fn() } catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  return { busy, error, run }
}

function NoTeam({ online }) {
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const { busy, error, run } = useAction()
  return (
    <div className="team-setup">
      <div className="team-intro">
        <Icon name="users" size={22} />
        <div>
          <b>You're not in a team yet</b>
          <span>A team is a group of devices your <em>Team</em> notes sync with. Private notes never join.</span>
        </div>
      </div>
      <div className="team-cards">
        <form className="team-card" onSubmit={(e) => { e.preventDefault(); run(() => api.createTeam(name.trim())) }}>
          <span className="team-card-icon create"><Icon name="plus" size={20} strokeWidth={2} /></span>
          <b>Create a team</b>
          <span className="muted small">You become its admin and get an invite code.</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Team name, e.g. Our Family" maxLength={40} />
          <button className="btn primary" disabled={!online || busy || !name.trim()}>Create team</button>
        </form>
        <form className="team-card" onSubmit={(e) => { e.preventDefault(); run(() => api.joinTeam(code.trim())) }}>
          <span className="team-card-icon join"><Icon name="link" size={20} strokeWidth={2} /></span>
          <b>Join a team</b>
          <span className="muted small">Enter the invite code from the team admin.</span>
          <input className="code-input" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="ABC-123" maxLength={8} />
          <button className="btn" disabled={!online || busy || code.replace(/[^A-Z0-9]/g, '').length !== 6}>Join team</button>
        </form>
      </div>
      {!online && <p className="team-note"><Icon name="unlink" size={13} /> You're offline. Teams live on the shared server, so connect to create or join one.</p>}
      {error && <p className="team-error"><Icon name="warn" size={13} /> {error}</p>}
    </div>
  )
}

// A second (or third, ...) team, added from the grid rather than the empty state above.
function AddTeam({ online }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const { busy, error, run } = useAction()
  if (!open) {
    return (
      <button className="btn ghost team-add-btn" disabled={!online} onClick={() => setOpen(true)}>
        <Icon name="plus" size={14} /> Create or join another team
      </button>
    )
  }
  return (
    <div className="team-cards">
      <form className="team-card" onSubmit={(e) => { e.preventDefault(); run(() => api.createTeam(name.trim())) }}>
        <span className="team-card-icon create"><Icon name="plus" size={20} strokeWidth={2} /></span>
        <b>Create a team</b>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Team name" maxLength={40} />
        <button className="btn primary" disabled={!online || busy || !name.trim()}>Create team</button>
      </form>
      <form className="team-card" onSubmit={(e) => { e.preventDefault(); run(() => api.joinTeam(code.trim())) }}>
        <span className="team-card-icon join"><Icon name="link" size={20} strokeWidth={2} /></span>
        <b>Join a team</b>
        <input className="code-input" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="ABC-123" maxLength={8} />
        <button className="btn" disabled={!online || busy || code.replace(/[^A-Z0-9]/g, '').length !== 6}>Join team</button>
      </form>
      {error && <p className="team-error"><Icon name="warn" size={13} /> {error}</p>}
    </div>
  )
}

// Overview: one small card per team, just enough to tell them apart and see at a glance whether
// anything needs attention. Click a card to open its full detail (members, invite code, notes).
function TeamGrid({ teams, me, online, onOpen }) {
  return (
    <div className="team-grid-wrap">
      <div className="team-grid">
        {teams.map((t) => {
          const members = t.members || []
          const active = members.filter((m) => m.device_id === me ? online : Date.now() - (m.last_seen || 0) < ACTIVE_MS).length
          return (
            <button key={t.id} className="team-grid-card" onClick={() => onOpen(t.id)}>
              <span className="team-avatar"><Icon name="users" size={20} /></span>
              <div className="team-grid-info">
                <b>{t.name}</b>
                <span className="muted small">{members.length} member{members.length === 1 ? '' : 's'} · {active} active</span>
              </div>
              <span className={`badge ${t.role === 'admin' ? 'waiting' : 'neutral'}`}>{t.role === 'admin' ? 'Admin' : 'Member'}</span>
              <Icon name="back" size={16} className="team-grid-chevron" />
            </button>
          )
        })}
      </div>
      <AddTeam online={online} />
    </div>
  )
}

// One shared note, used in a team's "Shared notes" feed.
function FeedItem({ r, me }) {
  const mine = r.from === me
  return (
    <li className={`feed-item ${mine ? 'mine' : ''}`}>
      <span className={`avatar ${mine ? 'me' : ''}`}><Icon name={mine ? 'chip' : 'arrowDown'} size={15} /></span>
      <div className="feed-body">
        <div className="feed-meta">
          <b>{mine ? 'You' : deviceName(r.from)}</b>
          <span>{ago(r.updated_ts)}</span>
          {r.updated_by && r.updated_by !== r.from && <span>· edited by {deviceName(r.updated_by)}</span>}
        </div>
        <p>{r.text}</p>
      </div>
    </li>
  )
}

function TeamDetail({ team, online, me, admin, cloud, memories = [], onBack }) {
  const { busy, error, run } = useAction()
  const [copied, setCopied] = useState(false)
  const [renaming, setRenaming] = useState(null)
  const [leaving, setLeaving] = useState(false)
  const [resolution, setResolution] = useState('private')

  const isAdmin = team.role === 'admin'
  const members = team.members || []
  const adminName = members.find((m) => m.role === 'admin')?.device_name || 'the admin'
  const copy = async () => {
    try { await navigator.clipboard.writeText(team.code) } catch { /* clipboard blocked */ }
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  const live = cloud && online && cloud.live
  const records = cloud ? [...cloud.records].sort((a, b) => b.updated_ts - a.updated_ts) : null
  // Notes this device wrote itself for this team — what leaving actually has a choice to make
  // about. Pulled-from-others notes always get dropped on leave; there's nothing to ask there.
  const myCount = memories.filter((m) => m.team_id === team.id && !m.superseded_by && (!m.origin || m.origin === me)).length

  return (
    <div className="team-panel">
      {onBack && (
        <button type="button" className="btn ghost small team-back" onClick={onBack}>
          <Icon name="back" size={14} /> All teams
        </button>
      )}

      <section className="team-head">
        <span className="team-avatar"><Icon name="users" size={22} /></span>
        <div className="team-title">
          {renaming !== null ? (
            <form className="row gap" onSubmit={(e) => { e.preventDefault(); run(async () => { await api.renameTeam(team.id, renaming.trim()); setRenaming(null) }) }}>
              <input autoFocus value={renaming} onChange={(e) => setRenaming(e.target.value)} maxLength={40} />
              <button className="btn primary small" disabled={busy || !renaming.trim()}>Save</button>
              <button type="button" className="btn ghost small" onClick={() => setRenaming(null)}>Cancel</button>
            </form>
          ) : (
            <h2>{team.name}</h2>
          )}
          <span className="muted small">
            {members.length} member{members.length === 1 ? '' : 's'} · you're {isAdmin ? 'the admin' : 'a member'}
            {!online && ' · offline, showing saved info'}
          </span>
        </div>
        <span className={`badge ${isAdmin ? 'waiting' : 'neutral'}`}>{isAdmin ? 'Admin' : 'Member'}</span>
      </section>

      <section className="invite">
        <div>
          <span className="muted small">Invite code</span>
          <b className="invite-code">{team.code}</b>
          <span className="muted small">On the other device, open <b>Team</b>, choose <b>Join a team</b> and enter this code.</span>
        </div>
        <div className="invite-actions">
          <button className="btn small" onClick={copy}><Icon name={copied ? 'check' : 'notes'} size={14} /> {copied ? 'Copied' : 'Copy'}</button>
          {admin && isAdmin && (
            <button className="btn ghost small" disabled={!online || busy} title="The old code stops working"
              onClick={() => run(() => api.newTeamCode(team.id))}>
              <Icon name="restore" size={14} /> New code
            </button>
          )}
        </div>
      </section>

      <section className="members">
        <h3>Members</h3>
        <ul>
          {members.map((m) => {
            const self = m.device_id === me
            const active = self ? online : Date.now() - (m.last_seen || 0) < ACTIVE_MS
            return (
              <li key={m.device_id}>
                <span className={`member-dot ${active ? 'on' : ''}`} />
                <div className="member-info">
                  <b>{m.device_name}{self && <span className="muted"> · this device</span>}</b>
                  <span className="muted small">{active ? 'Active now' : `Last synced ${ago(m.last_seen)}`} · joined {ago(m.joined_ts)}</span>
                </div>
                {m.role === 'admin' && <span className="badge waiting">Admin</span>}
                {admin && isAdmin && !self && (
                  <button className="btn ghost small danger-text" disabled={!online || busy}
                    onClick={() => { if (window.confirm(`Remove ${m.device_name} from ${team.name}? It stops syncing and loses the team's notes.`)) run(() => api.removeMember(team.id, m.device_id)) }}>
                    <Icon name="x" size={14} /> Remove
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      </section>

      <section className="team-actions">
        {admin && isAdmin && renaming === null && (
          <button className="btn ghost small" disabled={!online || busy} onClick={() => setRenaming(team.name)}>
            <Icon name="edit" size={14} /> Rename team
          </button>
        )}
        {admin && !isAdmin && <span className="muted small">Only the admin ({adminName}) can manage members.</span>}
        {!admin && isAdmin && <a className="link small" href="#/admin/team">Manage team in Admin</a>}
        {!leaving && (
          <button className="btn ghost small danger-text" disabled={busy} onClick={() => setLeaving(true)}>
            <Icon name="back" size={14} /> Leave team
          </button>
        )}
      </section>

      {leaving && (
        <section className="team-leave-confirm">
          <p>
            <b>Leave {team.name}?</b>{' '}
            {isAdmin && members.length > 1 && 'Admin passes to the next member. '}
            Notes shared by other members are removed from this device.
          </p>
          {myCount > 0 && (
            <div className="team-leave-choice">
              <span className="muted small">
                You wrote {myCount} note{myCount === 1 ? '' : 's'} shared with this team. Keep {myCount === 1 ? 'it' : 'them'} as:
              </span>
              <div className="seg" role="radiogroup" aria-label="What happens to your notes">
                <button type="button" className={resolution === 'private' ? 'active private' : ''} onClick={() => setResolution('private')}>
                  <Icon name="lock" size={14} /> Only me
                </button>
                <button type="button" className={resolution === 'discard' ? 'active' : ''} onClick={() => setResolution('discard')}>
                  <Icon name="trash" size={14} /> Discard
                </button>
              </div>
            </div>
          )}
          <div className="row gap">
            <button className="btn danger small" disabled={busy}
              onClick={() => run(async () => { await api.leaveTeam(team.id, resolution); setLeaving(false) })}>
              <Icon name="back" size={14} /> Leave team
            </button>
            <button className="btn ghost small" onClick={() => setLeaving(false)}>Cancel</button>
          </div>
        </section>
      )}
      {error && <p className="team-error"><Icon name="warn" size={13} /> {error}</p>}

      {records !== null && (
        <section className="team-feed-section">
          <div className="panel-head">
            <h3 className="feed-title">Shared notes</h3>
            <span className={`live-pill ${live ? 'live' : 'stale'}`}>
              <i />{live ? 'Live' : `Offline copy · ${ago(cloud.as_of)}`}
            </span>
          </div>
          {!records.length ? (
            <div className="empty-state">
              <Icon name="users" size={32} />
              <b>Nothing shared yet</b>
              <span>Save a note as <b>Team</b> and it appears here after the next sync.</span>
            </div>
          ) : (
            <ul className={`feed ${live ? '' : 'stale'}`}>
              {records.map((r) => <FeedItem key={r.mem_id} r={r} me={me} />)}
            </ul>
          )}
        </section>
      )}
    </div>
  )
}

export default function TeamPanel({ state, admin = false, cloud, memories = [], onSelect }) {
  const teams = state.teams || []
  const online = state.network.online
  const me = state.device.id
  const [openId, setOpenId] = useState(null)

  // Keep the parent's notion of "which team's shared-store view is this" pointed at whichever
  // team is actually on screen: the sole team (nothing to choose), or whichever card was opened.
  const shown = teams.length === 1 ? teams[0].id : openId
  useEffect(() => { if (shown) onSelect?.(shown) }, [shown]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!teams.length) return <NoTeam online={online} />
  if (teams.length === 1) return <TeamDetail team={teams[0]} online={online} me={me} admin={admin} cloud={cloud} memories={memories} />

  const open = teams.find((t) => t.id === openId)
  if (!open) return <TeamGrid teams={teams} me={me} online={online} onOpen={setOpenId} />
  return <TeamDetail team={open} online={online} me={me} admin={admin} cloud={cloud} memories={memories} onBack={() => setOpenId(null)} />
}
