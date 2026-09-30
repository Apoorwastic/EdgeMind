import { Icon } from './icons.jsx'
import { ago, api } from './api.js'

function Logo() {
  return (
    <svg className="logo" width="30" height="30" viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="16" r="5" className="logo-core" />
      <circle cx="16" cy="16" r="10" className="logo-ring" />
      <circle cx="16" cy="16" r="14.5" className="logo-ring faint" />
    </svg>
  )
}

// Mini sync line: device ── server, with records travelling along it.
function MiniChannel({ online, syncing, particles }) {
  return (
    <div className={`mini-channel ${online ? 'open' : 'closed'} ${syncing ? 'flowing' : ''}`}>
      <Icon name="chip" size={15} />
      <div className="mini-pipe">
        <i className="mini-flow" />
        {!online && <i className="mini-cut" />}
        {particles.map((p) => <i key={p.id} className={`mini-packet ${p.direction}`} />)}
      </div>
      <Icon name={online ? 'cloud' : 'cloudOff'} size={15} />
    </div>
  )
}

export default function Sidebar({ state, page, memories, cloud, audit, alerts, syncing, particles, onToggleNetwork,
  chats, chatId, onDeleteChat }) {
  const { device, network, sync, memory } = state
  const online = network.online
  const notes = memories.filter((m) => !m.superseded_by).length

  const NAV = [
    ['notes', 'My notes', 'notes', notes],
    ['team', state.team ? 'Team' : 'Join a team', 'users', state.team ? (state.team.members?.length || null) : null],
    ['admin', 'Admin', 'gear', alerts || null],
  ]

  return (
    <aside className="sidebar">
      <a className="brand" href="#/" aria-label="EdgeMind home">
        <Logo />
        <span className="brand-text">
          <span className="brand-name">EdgeMind</span>
          <span className="brand-device" title={`${device.id} · port ${device.port}`}>{device.name}</span>
        </span>
      </a>

      <a href="#/" className={`new-chat ${page === 'ask' && !chatId ? 'active' : ''}`}>
        <Icon name="plus" size={16} strokeWidth={2.2} /> <span className="side-label">New chat</span>
      </a>

      <nav className="side-nav" aria-label="Main">
        {NAV.map(([key, label, icon, count]) => (
          <a key={key} href={`#/${key === 'ask' ? '' : key}`} className={page === key ? 'active' : ''}
            aria-current={page === key ? 'page' : undefined}>
            <Icon name={icon} size={18} />
            <span className="side-label">{label}</span>
            {count != null && <i className={`side-count ${key === 'admin' ? 'alert' : ''}`}>{count}</i>}
          </a>
        ))}
      </nav>

      <div className="chat-list" aria-label="Chats">
        <div className="chat-list-title">Chats</div>
        {!chats.length && <p className="chat-empty">Your conversations will appear here.</p>}
        {chats.map((c) => (
          <div key={c.id} className={`chat-item ${c.id === chatId ? 'active' : ''}`}>
            <a href={`#/chat/${c.id}`} title={c.title || 'Chat'}>
              <Icon name="chat" size={14} />
              <span className="chat-title">{c.title || 'Untitled chat'}</span>
            </a>
            <button className="chat-del" title="Delete chat" aria-label="Delete chat"
              onClick={() => { if (window.confirm('Delete this chat?')) onDeleteChat(c.id) }}>
              <Icon name="trash" size={13} />
            </button>
          </div>
        ))}
      </div>

      <div className="side-status">
        <button className={`conn ${online ? 'on' : 'off'}`} onClick={onToggleNetwork}
          title={network.mode === 'offline' ? 'Go back online' : online ? 'Switch to offline mode' : 'Keep offline mode on'} aria-pressed={online}>
          <i className="conn-dot" />
          <span className="conn-text">
            <b>{online ? 'Online' : 'Offline'}</b>
            <small>{online ? (syncing ? 'syncing…' : `synced ${ago(sync.last_sync)}`)
              : network.mode === 'offline' ? 'offline mode on'
              : network.quality === 'weak' ? 'weak internet' : 'no internet'}</small>
          </span>
          <span className="conn-switch"><span className="conn-knob" /></span>
        </button>

        <MiniChannel online={online} syncing={syncing} particles={particles} />

        <div className="mini-stats">
          <span title="Private — never leaves this device" className="ms private"><Icon name="lock" size={13} />{memory.private}</span>
          <span title="Shared with team" className="ms shared"><Icon name="users" size={13} />{memory.shareable}</span>
          <span title="Waiting to sync" className={`ms waiting ${sync.pending ? 'on' : ''}`}><Icon name="queued" size={13} />{sync.pending}</span>
          <button className="ms sync-btn" title="Sync now" disabled={!online || syncing} onClick={() => api.sync()}>
            <Icon name="sync" size={13} className={syncing ? 'spin' : ''} />
          </button>
        </div>

        <a href="#/admin/privacy" className={`shield ${audit ? (audit.ok ? 'ok' : 'bad') : ''}`}
          title="Privacy audit — compares every private note against everything that left this device">
          <Icon name="shield" size={15} />
          {!audit ? 'Checking privacy…' : audit.ok ? 'Privacy intact' : 'Privacy breach!'}
        </a>
      </div>
    </aside>
  )
}
