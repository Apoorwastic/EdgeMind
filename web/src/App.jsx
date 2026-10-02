import { useCallback, useEffect, useRef, useState } from 'react'
import { api, link, subscribe } from './api.js'
import Sidebar from './Sidebar.jsx'
import TeamView from './TeamView.jsx'
import AskView from './AskView.jsx'
import NotesView from './NotesView.jsx'
import AdminView from './AdminView.jsx'
import MobileApp from './MobileApp.jsx'
import { autoSetup } from './offline/brain.js'

// Hash routes: #/ (new chat), #/chat/<cid>, #/notes, #/team, #/admin, #/admin/<tab>
function useRoute() {
  const read = () => (window.location.hash.replace(/^#\/?/, '') || 'ask').split('/')
  const [route, setRoute] = useState(read)
  useEffect(() => {
    const on = () => setRoute(read())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  const go = (path) => { window.location.hash = `/${path}` }
  return [route, go]
}

// Shown only when the device can't be reached AND this browser has no copy of it yet
// (with a copy, the page quietly switches to browser mode instead).
const LOCAL_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\])/.test(window.location.hostname)

function DeviceUnreachable() {
  return (
    <div className="reach-banner" role="alert">
      <b>Can’t reach this EdgeMind device.</b>{' '}
      {LOCAL_HOST
        ? 'It runs on this computer — check that it’s still running (EdgeMind.bat or scripts\\start.ps1).'
        : 'Open this link once while you’re online — after that it keeps working in this browser without internet.'}
    </div>
  )
}

export default function App() {
  const [route, go] = useRoute()
  const [state, setState] = useState(null)
  const [memories, setMemories] = useState([])
  const [cloud, setCloud] = useState({ live: false, records: [], as_of: null })
  // Which team's shared-store view (Team page, Admin's "Shared store") is showing — defaults to
  // the device's only team when there's just one, so that view stays exactly as before for the
  // single-team case. A ref mirrors it so refreshCloud (stable across renders) always reads the
  // latest pick without needing to be re-created every time the selection changes.
  const [teamId, setTeamId] = useState(null)
  const teams = state?.teams || []
  const activeTeamId = teams.some((t) => t.id === teamId) ? teamId : teams[0]?.id ?? null
  const teamIdRef = useRef(null)
  teamIdRef.current = activeTeamId
  const [conflicts, setConflicts] = useState([])
  const [activity, setActivity] = useState([])
  const [egress, setEgress] = useState([])
  const [audit, setAudit] = useState(null)
  const [particles, setParticles] = useState([])
  const [transition, setTransition] = useState(null) // 'offline' | 'online' one-shot
  const [syncing, setSyncing] = useState(false)
  const [chats, setChats] = useState([])
  const [unreachable, setUnreachable] = useState(false) // the device process itself can't be reached
  const prevOnline = useRef(null)

  const refresh = useCallback(async () => {
    try {
      const [s, m] = await Promise.all([api.state(), api.memories()])
      setState(s)
      setMemories(m)
      setUnreachable(false)
    } catch {
      setUnreachable(true)
    }
  }, [])
  const refreshCloud = useCallback(async () => {
    const tid = teamIdRef.current
    const [c, k, e] = await Promise.all([
      tid ? api.cloud(tid) : Promise.resolve({ live: false, records: [], as_of: null }),
      api.conflicts(), api.egress(),
    ])
    setCloud(c)
    setConflicts(k)
    setEgress(e)
  }, [])
  const refreshAudit = useCallback(() => api.audit().then(setAudit).catch(() => {}), [])
  const refreshChats = useCallback(() => api.chats().then(setChats).catch(() => {}), [])

  useEffect(() => {
    refresh()
    refreshCloud().catch(() => {})
    refreshAudit()
    refreshChats()
    api.activity().then(setActivity).catch(() => {})
    const poll = setInterval(refresh, 5000)
    const auditPoll = setInterval(refreshAudit, 20000)
    let memTimer
    const off = subscribe({
      activity: (e) => setActivity((a) => [...a.slice(-299), e]),
      network: (n) => setState((s) => (s ? { ...s, network: n } : s)),
      memory: () => {
        clearTimeout(memTimer)
        memTimer = setTimeout(refresh, 80)
      },
      sync: (e) => {
        setSyncing(e.phase !== 'end')
        if (e.phase === 'end') {
          refresh()
          refreshCloud()
          refreshAudit()
        }
      },
      'sync-move': (p) => {
        const id = `${p.mem_id}-${Date.now()}-${Math.random()}`
        setParticles((ps) => [...ps, { ...p, id }])
        setTimeout(() => setParticles((ps) => ps.filter((x) => x.id !== id)), 1800)
      },
      conflict: () => api.conflicts().then(setConflicts),
      chats: refreshChats,
      team: () => { refresh(); refreshCloud() },
    })
    return () => {
      off()
      clearInterval(poll)
      clearInterval(auditPoll)
    }
  }, [refresh, refreshCloud, refreshAudit, refreshChats])

  // Refetch the shared-store view whenever the selected team changes (including the first time
  // `teams` loads and auto-picks one).
  useEffect(() => { if (activeTeamId) refreshCloud().catch(() => {}) }, [activeTeamId, refreshCloud])

  // Device became unreachable (browser mode) or came back (queued notes were just replayed): reload everything.
  useEffect(() => link.onChats(refreshChats), [refreshChats])
  // On every start: is the offline AI here? If not, pick one that suits this device and download it.
  useEffect(() => { autoSetup() }, [])
  useEffect(() => link.subscribe(() => { refresh(); refreshCloud().catch(() => {}); refreshAudit(); refreshChats() }),
    [refresh, refreshCloud, refreshAudit, refreshChats])

  // The browser hears about Wi-Fi drops instantly; ask the device to re-probe instead of waiting for its loop.
  useEffect(() => {
    const recheck = () => api.recheckNetwork().then((n) => setState((s) => (s ? { ...s, network: n } : s))).catch(() => {})
    window.addEventListener('offline', recheck)
    window.addEventListener('online', recheck)
    return () => {
      window.removeEventListener('offline', recheck)
      window.removeEventListener('online', recheck)
    }
  }, [])

  // One-shot banner when connectivity flips.
  const online = state?.network?.online
  useEffect(() => {
    if (online === undefined) return
    const prev = prevOnline.current
    prevOnline.current = online
    if (prev === null || prev === online) return
    setTransition(online ? 'online' : 'offline')
    refreshCloud()
    const t = setTimeout(() => setTransition(null), 2600)
    return () => clearTimeout(t)
  }, [online, refreshCloud])

  const toggleNetwork = async () => {
    const n = await api.setNetwork(state.network.mode === 'offline' ? 'auto' : 'offline')
    setState((s) => ({ ...s, network: n }))
  }

  const banner = unreachable && <DeviceUnreachable />
  if (!state) {
    return <>{banner}<div className="boot"><span className="boot-dot" /> {unreachable ? 'Can’t reach this device…' : 'Loading your memory…'}</div></>
  }

  const page = ['notes', 'team', 'admin'].includes(route[0]) ? route[0] : 'ask'
  const openConflicts = conflicts.filter((c) => !c.resolved).length
  const chatId = page === 'ask' && route[0] === 'chat' ? route[1] : null
  const deleteChat = async (cid) => {
    await api.deleteChat(cid)
    if (cid === chatId) go('')
    refreshChats()
  }

  if (state.device.kind === 'mobile') {
    return (
      <>{banner}<MobileApp route={route} go={go} state={state} memories={memories} cloud={cloud} conflicts={conflicts}
        activity={activity} audit={audit} particles={particles} syncing={syncing} chats={chats} transition={transition}
        egress={egress} onToggleNetwork={toggleNetwork} onChanged={refresh} onAudit={refreshAudit} onDeleteChat={deleteChat}
        teamId={activeTeamId} onSelectTeam={setTeamId}
        onPrefs={async (v) => { await api.setPrefs(v); refresh() }}
        onRestore={async (id) => { await api.restore(id); refreshCloud(); refresh() }} /></>
    )
  }

  return (
    <>{banner}
    <div className={`app ${online ? 'is-online' : 'is-offline'}`}>
      <Sidebar state={state} page={page} memories={memories} cloud={cloud} audit={audit} alerts={openConflicts}
        syncing={syncing} particles={particles} onToggleNetwork={toggleNetwork}
        chats={chats} chatId={chatId} onDeleteChat={deleteChat} />

      {transition && (
        <div className={`toast ${transition}`} role="status">
          {transition === 'offline'
            ? <><b>You're offline.</b> Everything still works — shared notes will sync when you're back.</>
            : <><b>Back online.</b> Syncing your shared notes now.</>}
        </div>
      )}

      <main className="page">
        {page === 'notes' && (
          <NotesView memories={memories} state={state} onChanged={refresh} />
        )}
        {page === 'team' && (
          <TeamView cloud={cloud} state={state} memories={memories} onSelectTeam={setTeamId} />
        )}
        {page === 'admin' && (
          <AdminView tab={route[1] || 'overview'} go={go} state={state} memories={memories} cloud={cloud}
            teamId={activeTeamId} onSelectTeam={setTeamId}
            conflicts={conflicts} egress={egress} activity={activity} audit={audit} particles={particles}
            syncing={syncing} onAudit={refreshAudit} onToggleNetwork={toggleNetwork}
            onPrefs={async (v) => { await api.setPrefs(v); refresh() }}
            onRestore={async (id) => { await api.restore(id); refreshCloud(); refresh() }} />
        )}
        {page === 'ask' && (
          <AskView state={state} memories={memories} onChanged={refresh} activity={activity}
            cid={chatId} onChatStarted={(cid) => go(`chat/${cid}`)} />
        )}
      </main>
    </div>
    </>
  )
}
