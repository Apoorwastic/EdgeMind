import { useState } from 'react'
import { ago, api } from './api.js'
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
          <span>A team is the group of devices your <em>Team</em> notes sync with. Private notes never join.</span>
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

export default function TeamPanel({ state, admin = false }) {
  const team = state.team
  const online = state.network.online
  const me = state.device.id
  const { busy, error, run } = useAction()
  const [copied, setCopied] = useState(false)
  const [renaming, setRenaming] = useState(null)

  if (!team) return <NoTeam online={online} />

  const isAdmin = team.role === 'admin'
  const members = team.members || []
  const adminName = members.find((m) => m.role === 'admin')?.device_name || 'the admin'
  const copy = async () => {
    try { await navigator.clipboard.writeText(team.code) } catch { /* clipboard blocked */ }
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="team-panel">
      <section className="team-head">
        <span className="team-avatar"><Icon name="users" size={22} /></span>
        <div className="team-title">
          {renaming !== null ? (
            <form className="row gap" onSubmit={(e) => { e.preventDefault(); run(async () => { await api.renameTeam(renaming.trim()); setRenaming(null) }) }}>
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
              onClick={() => run(() => api.newTeamCode())}>
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
                    onClick={() => { if (window.confirm(`Remove ${m.device_name} from ${team.name}? It stops syncing and loses the team's notes.`)) run(() => api.removeMember(m.device_id)) }}>
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
        <button className="btn ghost small danger-text" disabled={busy}
          onClick={() => {
            const msg = isAdmin && members.length > 1
              ? `Leave ${team.name}? Admin passes to the next member. Notes from others are removed from this device.`
              : `Leave ${team.name}? Notes from others are removed from this device; your own stay.`
            if (window.confirm(msg)) run(() => api.leaveTeam())
          }}>
          <Icon name="back" size={14} /> Leave team
        </button>
      </section>
      {error && <p className="team-error"><Icon name="warn" size={13} /> {error}</p>}
    </div>
  )
}
