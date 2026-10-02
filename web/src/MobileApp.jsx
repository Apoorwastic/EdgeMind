import { useEffect, useState } from 'react'
import { ago, api, deviceName } from './api.js'
import { Icon } from './icons.jsx'
import AskView from './AskView.jsx'
import NotesView from './NotesView.jsx'
import TeamView from './TeamView.jsx'
import OfflineAI from './OfflineAI.jsx'
import AdminView from './AdminView.jsx'

// Mobile device UI: a phone-shaped app with a bottom tab bar. On a desktop browser it renders
// inside a phone frame so it can sit next to the laptop in a demo; on a real phone it is full-screen.

function Clock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 15000)
    return () => clearInterval(t)
  }, [])
  return <span>{now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}</span>
}

// Fake OS status bar — the signal glyphs mirror EdgeMind's connectivity so "offline" reads at a glance.
function OsBar({ online }) {
  return (
    <div className={`m-os ${online ? 'on' : 'off'}`} aria-hidden="true">
      <Clock />
      <span className="m-os-right">
        <span className="m-os-sig">
          <svg width="17" height="11" viewBox="0 0 17 11" className={online ? '' : 'dim'}><rect x="0" y="7" width="3" height="4" rx="1" /><rect x="4.5" y="5" width="3" height="6" rx="1" /><rect x="9" y="2.5" width="3" height="8.5" rx="1" /><rect x="13.5" y="0" width="3" height="11" rx="1" /></svg>
          {!online && <i className="m-os-x">✕</i>}
        </span>
        <svg width="15" height="11" viewBox="0 0 15 11" className={online ? '' : 'dim'}>
          <path d="M7.5 10.5 5.3 8.2a3.1 3.1 0 0 1 4.4 0zM3.2 6.1a6.1 6.1 0 0 1 8.6 0l-1.4 1.4a4.1 4.1 0 0 0-5.8 0zM1 3.9a9.2 9.2 0 0 1 13 0l-1.4 1.4a7.2 7.2 0 0 0-10.2 0z" />
          {!online && <path d="M1.5 1 13.5 10.5" stroke="currentColor" strokeWidth="1.4" />}
        </svg>
        <span className="m-battery"><i /></span>
      </span>
    </div>
  )
}

function ChatSheet({ chats, chatId, onClose, onDelete }) {
  return (
    <div className="m-sheet-wrap" onClick={onClose}>
      <div className="m-sheet" role="dialog" aria-label="Past chats" onClick={(e) => e.stopPropagation()}>
        <div className="m-sheet-grip" />
        <div className="m-sheet-head">
          <h2>Chats</h2>
          <a className="btn primary small" href="#/" onClick={onClose}><Icon name="plus" size={14} /> New</a>
        </div>
        {!chats.length && <p className="m-muted">No chats yet. Ask something to start one.</p>}
        <ul className="m-chat-list">
          {chats.map((c) => (
            <li key={c.id} className={c.id === chatId ? 'active' : ''}>
              <a href={`#/chat/${c.id}`} onClick={onClose}>
                <Icon name="chat" size={16} />
                <span className="m-chat-title">{c.title || 'New chat'}</span>
                <span className="m-chat-time">{ago(c.ts)}</span>
              </a>
              <button className="m-icon-btn" aria-label="Delete chat" onClick={() => onDelete(c.id)}>
                <Icon name="trash" size={15} />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

const tidy = (msg) => msg.replace(/\s*\bm_\d+_[a-z0-9]{4}\b/g, '').replace(/\s{2,}/g, ' ')
const ACT_ICON = { sync: 'sync', privacy: 'shield', conflict: 'warn', memory: 'notes', network: 'link', system: 'chip' }

function SyncTab({ state, audit, conflicts, activity, particles, syncing, onToggleNetwork, onRestore, onAudit }) {
  const { network, sync, memory } = state
  const online = network.online
  const open = conflicts.filter((c) => !c.resolved)
  const feed = activity.filter((a) => a.kind !== 'ask' && a.kind !== 'search').slice(-10).reverse()

  return (
    <div className="m-sync">
      <section className={`m-card m-conn ${online ? 'on' : 'off'}`}>
        <div className="m-conn-row">
          <span className="m-conn-dot" />
          <div className="m-conn-text">
            <b>{online ? 'Online' : 'Offline'}</b>
            <span>{online
              ? (syncing ? 'Syncing now…' : `Last synced ${ago(sync.last_sync)}`)
              : network.mode === 'browser' ? 'No connection — running from this phone'
              : network.mode === 'offline' ? 'Offline mode is on — tap to go online'
                : network.quality === 'weak' ? 'Weak internet — switched to offline'
                : network.internet === false ? 'No internet — switched to offline' : 'No connection — retrying'}</span>
          </div>
          <button className={`m-switch ${online ? 'on' : ''}`} role="switch"
            aria-checked={online} aria-label="Connectivity" onClick={onToggleNetwork}>
            <i />
          </button>
        </div>

        <div className={`m-channel ${online ? 'open' : 'closed'} ${syncing ? 'flowing' : ''}`}>
          <span className="m-ch-end"><Icon name="chip" size={18} /><small>This phone</small></span>
          <div className="m-ch-pipe">
            <i className="m-ch-flow" />
            {!online && <i className="m-ch-cut"><Icon name="x" size={10} strokeWidth={3} /></i>}
            {particles.map((p) => <i key={p.id} className={`m-ch-packet ${p.direction}`} />)}
          </div>
          <span className="m-ch-end"><Icon name={online ? 'cloud' : 'cloudOff'} size={18} /><small>Team</small></span>
        </div>

        <button className="btn primary m-full" disabled={!online || syncing} onClick={() => api.sync()}>
          <Icon name="sync" size={15} className={syncing ? 'spin' : ''} /> {syncing ? 'Syncing…' : 'Sync now'}
        </button>
      </section>

      <OfflineAI state={state} className="m-card" />

      <section className="m-stats">
        <div className="m-stat private"><Icon name="lock" size={16} /><b>{memory.private}</b><span>Only me</span></div>
        <div className="m-stat shared"><Icon name="users" size={16} /><b>{memory.shareable}</b><span>Team</span></div>
        <div className={`m-stat waiting ${sync.pending ? 'on' : ''}`}><Icon name="queued" size={16} /><b>{sync.pending}</b><span>Waiting</span></div>
      </section>

      <button className={`m-card m-privacy ${audit ? (audit.ok ? 'ok' : 'bad') : ''}`} onClick={onAudit}>
        <Icon name="shield" size={26} />
        <div>
          <b>{!audit ? 'Checking privacy…' : audit.ok ? 'Privacy intact' : 'Privacy breach!'}</b>
          <span>
            {audit
              ? `${audit.private_records} private note${audit.private_records === 1 ? '' : 's'} · none ever left this phone` +
                (audit.cloud_checked ? ' · verified with server' : '')
              : 'Comparing private notes against everything sent'}
          </span>
        </div>
      </button>

      {open.length > 0 && (
        <section className="m-card m-conflicts">
          <h3><Icon name="warn" size={14} /> {open.length} edit conflict{open.length > 1 ? 's' : ''}</h3>
          {open.map((c) => {
            const win = c[c.winner]
            const lose = c[c.winner === 'local' ? 'remote' : 'local']
            return (
              <div key={c.id} className="m-conflict">
                <p className="m-win"><small>Kept · {deviceName(win.by)}</small>{win.text}</p>
                <p className="m-lose"><small>Replaced · {deviceName(lose.by)}</small>{lose.text}</p>
                <button className="btn small" onClick={() => onRestore(c.id)}><Icon name="restore" size={13} /> Use replaced version</button>
              </div>
            )
          })}
        </section>
      )}

      <section className="m-card">
        <h3>Recent activity</h3>
        <ol className="m-feed">
          {feed.map((a) => (
            <li key={a.seq} className={`k-${a.kind}`}>
              <span className="tick-icon"><Icon name={ACT_ICON[a.kind] || 'pulse'} size={12} /></span>
              <span className="m-feed-msg">{tidy(a.message)}</span>
              <span className="m-feed-time">{ago(a.ts)}</span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  )
}

const TABS = [
  ['ask', 'Ask', 'spark'],
  ['notes', 'Notes', 'notes'],
  ['team', 'Team', 'users'],
  ['sync', 'Sync', 'sync'],
  ['admin', 'Admin', 'gear'],
]

export default function MobileApp({
  route, go, state, memories, cloud, conflicts, egress, activity, audit, particles, syncing, chats, transition,
  onToggleNetwork, onChanged, onRestore, onAudit, onDeleteChat, onPrefs,
}) {
  const [sheet, setSheet] = useState(false)
  const online = state.network.online
  const page = ['notes', 'team', 'sync', 'admin'].includes(route[0]) ? route[0] : 'ask'
  const chatId = page === 'ask' && route[0] === 'chat' ? route[1] : null
  const openConflicts = conflicts.filter((c) => !c.resolved).length
  const badges = { sync: state.sync.pending + openConflicts || null, team: null, notes: null, ask: null,
    admin: openConflicts || (audit && !audit.ok ? '!' : null) }
  const title = { ask: chatId ? (chats.find((c) => c.id === chatId)?.title || 'Chat') : 'EdgeMind', notes: 'My notes', team: state.team?.name || 'Team', sync: 'Sync & privacy', admin: 'Admin' }[page]

  return (
    <div className={`m-stage ${online ? 'is-online' : 'is-offline'}`}>
      <div className="m-phone">
        <OsBar online={online} />

        <header className="m-top">
          {page === 'ask' ? (
            <button className="m-icon-btn" aria-label="Past chats" onClick={() => setSheet(true)}>
              <Icon name="chat" size={19} />
            </button>
          ) : <span className="m-top-spacer" />}
          <h1 className="m-title">{title}</h1>
          <button className={`m-net ${online ? 'on' : 'off'}`} onClick={onToggleNetwork}
            aria-label={online ? 'Online — tap for offline mode' : 'Offline — tap to reconnect'}>
            <i />{online ? 'Online' : 'Offline'}
          </button>
        </header>

        {transition && (
          <div className={`m-toast ${transition}`} role="status">
            {transition === 'offline'
              ? <><b>Offline.</b> Everything still works on this phone.</>
              : <><b>Back online.</b> Syncing shared notes…</>}
          </div>
        )}

        <main className={`m-body page-${page}`}>
          {page === 'ask' && (
            <AskView state={state} memories={memories} onChanged={onChanged} activity={activity}
              cid={chatId} onChatStarted={(cid) => go(`chat/${cid}`)} rail={false} />
          )}
          {page === 'notes' && <NotesView memories={memories} state={state} onChanged={onChanged} />}
          {page === 'team' && <TeamView cloud={cloud} state={state} />}
          {page === 'sync' && (
            <SyncTab state={state} audit={audit} conflicts={conflicts} activity={activity} particles={particles}
              syncing={syncing} onToggleNetwork={onToggleNetwork} onRestore={onRestore} onAudit={onAudit} />
          )}
          {page === 'admin' && (
            // The laptop's Admin, section for section; mobile.css fits it to the phone.
            <AdminView tab={route[1] || 'overview'} go={go} state={state} memories={memories} cloud={cloud}
              conflicts={conflicts} egress={egress} activity={activity} audit={audit} particles={particles}
              syncing={syncing} onAudit={onAudit} onToggleNetwork={onToggleNetwork} onPrefs={onPrefs}
              onRestore={onRestore} />
          )}
        </main>

        <nav className="m-tabs" aria-label="Main">
          {TABS.map(([key, label, icon]) => (
            <a key={key} href={`#/${key === 'ask' ? '' : key}`} className={page === key ? 'active' : ''}
              aria-current={page === key ? 'page' : undefined}>
              <span className="m-tab-icon">
                <Icon name={icon} size={21} className={key === 'sync' && syncing ? 'spin' : ''} />
                {badges[key] && <i className="m-badge">{badges[key]}</i>}
              </span>
              {label}
            </a>
          ))}
        </nav>

        {sheet && <ChatSheet chats={chats} chatId={chatId} onClose={() => setSheet(false)}
          onDelete={async (cid) => { await onDeleteChat(cid); if (cid === chatId) go('') }} />}
      </div>
    </div>
  )
}
