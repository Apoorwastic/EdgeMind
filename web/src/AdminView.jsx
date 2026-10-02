import { useEffect, useRef, useState } from 'react'
import { ago, api, deviceName, fmtTime } from './api.js'
import { Icon } from './icons.jsx'
import TeamPanel from './TeamPanel.jsx'
import OfflineAI from './OfflineAI.jsx'

const TABS = [
  ['overview', 'Overview', 'grid'],
  ['team', 'Team', 'users'],
  ['sync', 'Sync', 'sync'],
  ['shared', 'Shared store', 'server'],
  ['conflicts', 'Conflicts', 'warn'],
  ['privacy', 'Privacy & egress', 'shield'],
  ['activity', 'Activity log', 'pulse'],
  ['settings', 'Settings', 'gear'],
]

function Stat({ label, value, tone, icon }) {
  return (
    <div className={`stat ${tone || ''}`}>
      <span className="stat-icon"><Icon name={icon} size={16} /></span>
      <b>{value}</b>
      <span>{label}</span>
    </div>
  )
}

function Health({ ok, warn, title, detail, icon }) {
  const tone = ok ? 'ok' : warn ? 'warn' : 'bad'
  return (
    <div className={`health ${tone}`}>
      <Icon name={icon} size={18} />
      <div>
        <b>{title}</b>
        <span>{detail}</span>
      </div>
      <i className="health-dot" aria-label={tone} />
    </div>
  )
}

// The sync channel: device on the left, shared server on the right; records travel along the pipe.
function SyncChannel({ online, sync, particles, syncing }) {
  return (
    <div className={`channel ${online ? 'open' : 'closed'} ${syncing ? 'flowing' : ''}`}>
      <div className="channel-end"><Icon name="chip" size={18} /><span>This device</span></div>
      <div className="channel-pipe">
        <div className="channel-flow" />
        {!online && <div className="channel-gate"><Icon name="unlink" size={14} /></div>}
        {particles.map((p) => (
          <span key={p.id} className={`packet ${p.direction}`} title={p.text}>
            <Icon name={p.direction === 'up' ? 'arrowUp' : 'arrowDown'} size={10} strokeWidth={2.4} />
          </span>
        ))}
      </div>
      <div className="channel-end"><Icon name={online ? 'cloud' : 'cloudOff'} size={18} /><span>Shared server</span></div>
      <div className="channel-label">
        {online ? syncing ? 'Syncing now…' : `Connected · last sync ${ago(sync.last_sync)}` : `Disconnected · ${sync.pending} note${sync.pending === 1 ? '' : 's'} waiting`}
      </div>
    </div>
  )
}

function Overview({ state, audit, cloud, conflicts, particles, syncing }) {
  const { memory, sync, models, network } = state
  const open = conflicts.filter((c) => !c.resolved).length
  return (
    <>
      <div className="stat-grid">
        <Stat label="Notes" value={memory.total} icon="notes" />
        <Stat label="Private" value={memory.private} icon="lock" tone="private" />
        <Stat label="Shared" value={memory.shareable} icon="users" tone="shared" />
        <Stat label="On server" value={cloud.records.length} icon="server" />
        <Stat label="Conflicts" value={open} icon="warn" tone={open ? 'bad' : ''} />
      </div>

      <section className="panel">
        <SyncChannel online={network.online} sync={sync} particles={particles} syncing={syncing} />
      </section>

      <section className="panel">
        <h3>Health</h3>
        <div className="health-grid">
          <Health icon={network.online ? 'link' : 'unlink'} ok={network.online} warn={network.mode === 'offline'}
            title={network.online ? 'Online' : network.mode === 'browser' ? 'Running in this browser' : network.mode === 'offline' ? 'Offline (manual)'
              : network.internet === false ? 'No internet' : 'No connection'}
            detail={`since ${ago(network.since)}`} />
          <Health icon="server" ok={network.cloud_reachable} title="Qdrant Server"
            detail={network.cloud_reachable ? 'reachable' : 'unreachable'} />
          <Health icon="shield" ok={audit?.ok} warn={!audit}
            title={!audit ? 'Privacy' : audit.ok ? 'Privacy intact' : 'Privacy breach'}
            detail={audit ? `${audit.private_in_outbound.length}/${audit.private_records} private leaked` : 'checking…'} />
          <Health icon="search" ok={models.embedder?.startsWith('ollama')} warn title="Embeddings" detail={models.embedder} />
          <Health icon="chip" ok={!!models.local_llm} warn title="On-device AI" detail={models.local_llm || 'not running'} />
          <Health icon="cloud" ok={!!models.cloud_llm} warn title="Cloud AI" detail={models.cloud_llm || (models.cloud_llm_error ? 'key rejected' : 'no key')} />
        </div>
      </section>

      <OfflineAI />
    </>
  )
}

function SyncTab({ state, particles, syncing }) {
  const { sync, network } = state
  const [result, setResult] = useState(null)
  return (
    <>
      <section className="panel">
        <SyncChannel online={network.online} sync={sync} particles={particles} syncing={syncing} />
        <div className="kv-grid">
          <div><span>Last sync</span><b>{sync.last_sync ? `${fmtTime(sync.last_sync)} (${ago(sync.last_sync)})` : 'never'}</b></div>
          <div><span>Waiting to push</span><b>{sync.pending}</b></div>
          <div><span>Private, held back</span><b>{sync.private_held}</b></div>
          <div><span>Pending retractions</span><b>{sync.retractions}</b></div>
          <div><span>Conflicts logged</span><b>{sync.conflicts}</b></div>
          <div><span>Schedule</span><b>on reconnect · every 8 s</b></div>
        </div>
        <div className="row gap">
          <button className="btn primary" disabled={!network.online || syncing}
            onClick={async () => setResult(await api.sync())}>
            <Icon name="sync" size={15} className={syncing ? 'spin' : ''} /> Sync now
          </button>
          {!network.online && <span className="muted">Go online to sync.</span>}
          {result && (
            <span className="muted">
              {result.ok
                ? `Done · ${result.pushed} pushed · ${result.pulled} pulled · ${result.retracted} retracted · ${result.conflicts} conflicts`
                : `Sync failed · ${result.reason}`}
            </span>
          )}
        </div>
      </section>
    </>
  )
}

function SharedTab({ cloud, device, online }) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h3>Shared store <span className="muted">· {cloud.records.length} notes</span></h3>
        <span className={`badge ${online && cloud.live ? 'shared' : 'waiting'}`}>
          {online && cloud.live ? 'Live' : `Cached · ${ago(cloud.as_of)}`}
        </span>
      </div>
      {!cloud.records.length ? <p className="muted">The shared store is empty.</p> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Note</th><th>From</th><th>Revision</th><th>Updated</th></tr></thead>
            <tbody>
              {cloud.records.map((r) => (
                <tr key={r.mem_id}>
                  <td className="t-text">{r.text}</td>
                  <td>{r.from === device.id ? 'This device' : deviceName(r.from)}
                    {r.updated_by && r.updated_by !== r.from && <div className="muted small">edited by {deviceName(r.updated_by)}</div>}</td>
                  <td>{r.rev}</td>
                  <td className="nowrap">{fmtTime(r.updated_ts)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function ConflictsTab({ conflicts, onRestore }) {
  return (
    <>
      <section className="panel callout">
        <Icon name="warn" size={18} />
        <div>
          <b>Last write wins — nothing is lost</b>
          <p>The later edit is kept everywhere; the other version stays here to restore.</p>
        </div>
      </section>
      {!conflicts.length && <section className="panel"><p className="muted">No conflicts yet.</p></section>}
      {conflicts.map((c) => {
        const win = c[c.winner]
        const lose = c[c.winner === 'local' ? 'remote' : 'local']
        return (
          <section key={c.id} className={`panel conflict ${c.resolved ? 'resolved' : ''}`}>
            <div className="panel-head">
              <span className="muted">{fmtTime(c.ts)}</span>
              {c.resolved ? <span className="badge neutral">Restored</span> : <span className="badge waiting">Needs review</span>}
            </div>
            <div className="versions">
              <div className="version win"><span className="v-label"><Icon name="check" size={13} /> Kept · {deviceName(win.by)} · {fmtTime(win.updated_ts)}</span><p>{win.text}</p></div>
              <div className="version lose"><span className="v-label"><Icon name="restore" size={13} /> Replaced · {deviceName(lose.by)} · {fmtTime(lose.updated_ts)}</span><p>{lose.text}</p></div>
            </div>
            {!c.resolved && (
              <button className="btn small" onClick={() => onRestore(c.id)}><Icon name="restore" size={14} /> Restore replaced version</button>
            )}
          </section>
        )
      })}
    </>
  )
}

function PrivacyTab({ audit, egress, onAudit }) {
  const [all, setAll] = useState(false)
  const carrying = egress.filter((e) => e.mem_ids.length)
  const shown = all ? egress : carrying
  return (
    <>
      <section className={`panel audit-card ${audit ? (audit.ok ? 'ok' : 'bad') : ''}`}>
        <Icon name="shield" size={34} />
        <div className="audit-main">
          <b>{!audit ? 'Checking privacy boundary…' : audit.ok ? 'Privacy boundary intact' : 'Privacy boundary breached'}</b>
          {audit && (
            <span>
              {audit.private_in_outbound.length} of {audit.private_records} private notes appeared in {audit.outbound_calls} outbound requests ·{' '}
              {audit.cloud_checked ? `${audit.private_in_cloud.length} found on the server` : 'server not checked (offline)'}
            </span>
          )}
        </div>
        <button className="btn" onClick={onAudit}><Icon name="restore" size={14} /> Re-run audit</button>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h3>Egress ledger</h3>
          <label className="toggle">
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
            Include metadata-only calls ({egress.length - carrying.length})
          </label>
        </div>
        <div className="table-wrap">
          <table className="table mono-cells">
            <thead><tr><th>Time</th><th>Purpose</th><th>Destination</th><th>Notes carried</th></tr></thead>
            <tbody>
              {shown.map((e, i) => (
                <tr key={i}>
                  <td className="nowrap">{fmtTime(e.ts)}</td>
                  <td>{e.purpose}</td>
                  <td>{e.dest.replace(/^https?:\/\//, '')}</td>
                  <td>{e.mem_ids.length ? e.mem_ids.map((m) => m.slice(-4)).join(' ') : '—'}</td>
                </tr>
              ))}
              {!shown.length && <tr><td colSpan={4} className="muted">No note content has left this device.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </>
  )
}

const KINDS = ['all', 'sync', 'privacy', 'conflict', 'memory', 'ask', 'network']

function ActivityTab({ activity }) {
  const [kind, setKind] = useState('all')
  const box = useRef(null)
  const rows = activity.filter((a) => kind === 'all' || a.kind === kind || (kind === 'ask' && a.kind === 'search'))
  useEffect(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight }, [rows.length])
  return (
    <section className="panel log-panel">
      <div className="panel-head">
        <div className="filters">
          {KINDS.map((k) => (
            <button key={k} className={`chip ${kind === k ? 'active' : ''}`} onClick={() => setKind(k)}>{k}</button>
          ))}
        </div>
        <span className="muted">{activity.length} events</span>
      </div>
      <ol className="log" ref={box}>
        {rows.map((a) => (
          <li key={a.seq} className={`k-${a.kind} ${a.level ? `l-${a.level}` : ''}`}>
            <span className="log-ts">{fmtTime(a.ts)}</span>
            <span className="log-kind">{a.kind}</span>
            <span className="log-msg">{a.message}</span>
          </li>
        ))}
      </ol>
    </section>
  )
}

function SettingsTab({ state, onPrefs, onToggleNetwork }) {
  const { prefs, network, device, models } = state
  return (
    <>
      <section className="panel setting">
        <div>
          <b>Connection</b>
          <p className="muted">Force offline mode to demo local-only answers. Real connectivity detection keeps running.</p>
        </div>
        <button className={`btn ${network.mode === 'offline' ? 'primary' : ''}`} onClick={onToggleNetwork}>
          <Icon name={network.mode === 'offline' ? 'link' : 'unlink'} size={15} />
          {network.mode === 'offline' ? 'Go back online' : 'Go offline'}
        </button>
      </section>
      <section className="panel setting">
        <div>
          <b>When a private note matches a question while online</b>
          <p className="muted">Choose who writes the answer. Private text is never sent to the cloud either way.</p>
        </div>
        <div className="seg vertical">
          <button className={prefs.private_route === 'local' ? 'active' : ''} onClick={() => onPrefs('local')}>
            <Icon name="chip" size={14} /> Answer on this device
          </button>
          <button className={prefs.private_route === 'redact' ? 'active' : ''} onClick={() => onPrefs('redact')}>
            <Icon name="cloud" size={14} /> Withhold private notes, ask cloud
          </button>
        </div>
      </section>
      <section className="panel">
        <h3>Device</h3>
        <div className="kv-grid">
          <div><span>Name</span><b>{device.name}</b></div>
          <div><span>Device id</span><b className="mono">{device.id}</b></div>
          <div><span>Port</span><b className="mono">{device.port}</b></div>
          <div><span>Embedder</span><b className="mono">{models.embedder}</b></div>
          <div><span>On-device model</span><b className="mono">{models.local_llm || '—'}</b></div>
          <div><span>Cloud model</span><b className="mono">{models.cloud_llm || (models.cloud_llm_error ? 'key rejected — fix .env' : 'no key')}</b></div>
        </div>
      </section>
    </>
  )
}

export default function AdminView(props) {
  const { tab, go, state, conflicts, audit } = props
  const open = conflicts.filter((c) => !c.resolved).length
  const title = TABS.find(([k]) => k === tab)?.[1] || 'Overview'

  return (
    <div className="admin">
      <div className="page-head">
        <h1>{title}</h1>
      </div>
      <nav className="admin-tabs" aria-label="Admin sections">
        {TABS.map(([k, label, icon]) => (
          <button key={k} className={tab === k ? 'active' : ''} onClick={() => go(`admin/${k}`)}>
            <Icon name={icon} size={15} /> <span>{label}</span>
            {k === 'conflicts' && open > 0 && <i className="count">{open}</i>}
            {k === 'privacy' && audit && !audit.ok && <i className="count bad">!</i>}
          </button>
        ))}
      </nav>
      <div className="admin-body">
        {tab === 'overview' && <Overview {...props} />}
        {tab === 'sync' && <SyncTab {...props} />}
        {tab === 'shared' && <SharedTab cloud={props.cloud} device={state.device} online={state.network.online} />}
        {tab === 'conflicts' && <ConflictsTab conflicts={conflicts} onRestore={props.onRestore} />}
        {tab === 'privacy' && <PrivacyTab audit={audit} egress={props.egress} onAudit={props.onAudit} />}
        {tab === 'activity' && <ActivityTab activity={props.activity} />}
        {tab === 'team' && <TeamPanel state={state} admin />}
        {tab === 'settings' && <SettingsTab state={state} onPrefs={props.onPrefs} onToggleNetwork={props.onToggleNetwork} />}
      </div>
    </div>
  )
}
