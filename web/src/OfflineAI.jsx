import { useEffect, useState } from 'react'
import { Icon } from './icons.jsx'
import {
  CATALOG, aiStatus, cancelInstall, deviceProfile, downloads, install, removeAI, resolve, setAutoDownload, storageInfo,
} from './offline/brain.js'

export function useDownload() {
  const [d, setD] = useState(downloads.get)
  useEffect(() => downloads.subscribe(setD), [])
  return d
}

const gb = (n) => `${n < 1 ? Math.round(n * 1000) + ' MB' : n.toFixed(2).replace(/0$/, '') + ' GB'}`

const mb = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${Math.round(b / 1e6)} MB`)
const eta = (s) => (s == null ? 'estimating time…' : s < 90 ? `about ${Math.max(1, Math.round(s / 10) * 10)} s left` : `about ${Math.round(s / 60)} min left`)

function Progress({ d, entry, gpu }) {
  const r = resolve(entry, gpu)
  const b = d.bytes
  const stepP = d.stepP ?? 0
  return (
    <div className="oa-progress" role="progressbar" aria-valuenow={Math.round(stepP * 100)} aria-valuemin={0} aria-valuemax={100}>
      <div className="oa-progress-head">
        <span>Downloading <b>{r.name}</b> · {gb(r.gb)}{d.auto ? ' · picked for this device' : ''}</span>
        <button className="btn ghost small" onClick={cancelInstall}><Icon name="x" size={13} /> Cancel</button>
      </div>
      <span className="oa-step">Step {d.step || 1} of 2 · {d.stepName || 'Getting ready'} · <b>{Math.round(stepP * 100)}%</b></span>
      <div className="oa-bar"><i style={{ width: `${Math.max(2, stepP * 100)}%` }} /></div>
      <span className="muted">
        {b ? `${mb(b.done)} of ${mb(b.total)}${b.bps ? ` · ${(b.bps / 1e6).toFixed(1)} MB/s · ${eta(b.eta)}` : ' · measuring speed…'}` : 'Starting…'}
        {' · '}{Math.round(d.p * 100)}% overall
      </span>
      <span className="muted oa-hint">Keep this page open. Parts already downloaded are kept if you close it.</span>
    </div>
  )
}

function ModelRow({ entry, profile, status, busy }) {
  const r = resolve(entry, profile?.gpu)
  const installed = status.model === r.id
  const recommended = profile?.tier === entry.key
  const heavy = entry.key === 'best' || entry.key === 'phi-4-mini'
  const tooBig = heavy && profile && !profile.canBest
  return (
    <li className={`oa-model ${installed ? 'installed' : ''}`}>
      <div className="oa-model-main">
        <b>{entry.label}{entry.label !== r.name && <span className="muted"> · {r.name}</span>}</b>
        <span className="muted">{gb(r.gb)} · {entry.hint}</span>
      </div>
      <div className="oa-model-tags">
        {recommended && <span className="badge shared">Recommended</span>}
        {tooBig && <span className="badge waiting">May be slow here</span>}
        {installed
          ? <span className="badge neutral"><Icon name="check" size={12} />Installed</span>
          : <button className="btn small" disabled={busy || !profile?.gpu?.ok || !navigator.onLine}
              onClick={() => install(entry.key)}>
              <Icon name="arrowDown" size={13} /> {status.downloaded ? 'Switch' : 'Download'}
            </button>}
      </div>
    </li>
  )
}

// Offline AI: what this browser downloaded (automatically, sized to the device) and a way to pick another.
export default function OfflineAI({ className = 'panel' }) {
  const d = useDownload()
  const [profile, setProfile] = useState(d.profile)
  const status = aiStatus() // re-read on every download event
  const [store, setStore] = useState(null)
  useEffect(() => { if (!profile) deviceProfile().then(setProfile) }, [profile])
  useEffect(() => { storageInfo().then(setStore) }, [d.phase, status.model])
  const busy = d.phase === 'downloading'
  const target = CATALOG.find((e) => e.key === d.target)
  const installed = CATALOG.find((e) => e.key === status.tier)
  const main = CATALOG.filter((e) => !e.extra)
  const extra = CATALOG.filter((e) => e.extra)

  let line
  if (d.phase === 'checking' || !profile) line = 'Checking what this device can run…'
  else if (status.downloaded && installed) {
    const r = resolve(installed, profile.gpu)
    line = <>Installed: <b>{r.name}</b> ({installed.label}, {gb(r.gb)}) · {status.reason}</>
  } else if (!profile.gpu.ok) line = profile.reason
  else if (status.autoOff) line = 'Not installed. Automatic download is off for this browser.'
  else if (d.text) line = d.text
  else line = `Not installed yet. This device suits the ${profile.reason}.`

  return (
    <section className={`${className} offline-ai`}>
      <div className="oa-head">
        <span className={`oa-icon ${status.downloaded ? 'ok' : ''}`}><Icon name="chip" size={18} /></span>
        <div>
          <h3>Offline AI</h3>
          <p className="muted">{line}</p>
          <p className="muted oa-sub">
            Search model: {status.search ? 'bge-small (34 MB) · ready' : 'not downloaded yet'} · answers and search run in this browser with no internet.
          </p>
        </div>
      </div>

      {busy && target && <Progress d={d} entry={target} gpu={profile?.gpu} />}
      {d.phase === 'error' && (
        <p className="note-err"><Icon name="warn" size={13} /> Download failed: {d.error}
          {target && <button className="btn ghost small" onClick={() => install(target.key, { auto: d.auto })}>Try again</button>}
        </p>
      )}

      {profile?.gpu.ok && (
        <ul className="oa-models">
          {main.map((e) => <ModelRow key={e.key} entry={e} profile={profile} status={status} busy={busy} />)}
        </ul>
      )}
      {profile?.gpu.ok && (
        <details className="oa-more">
          <summary>More models</summary>
          <ul className="oa-models">
            {extra.map((e) => <ModelRow key={e.key} entry={e} profile={profile} status={status} busy={busy} />)}
          </ul>
        </details>
      )}

      {profile && (
        <details className="oa-more">
          <summary>What this device can run</summary>
          <div className="kv-grid oa-facts">
            {profile.facts.map(([k, v]) => <div key={k}><span>{k}</span><b>{v}</b></div>)}
          </div>
        </details>
      )}

      {store && (status.downloaded || store.used > 50e6) && (
        <p className="oa-store muted">
          <Icon name={store.persisted ? 'shield' : 'info'} size={13} />
          <span>
            Saved in this browser ({mb(store.used)}) — stays when you close the window or restart, and loads without downloading again.{' '}
            {store.persisted
              ? 'Protected from automatic cleanup.'
              : 'The browser may clear it if the disk gets full; installing EdgeMind as an app (browser menu → Install) protects it.'}
            {' '}Clearing this site’s data or a private window removes it.
          </span>
        </p>
      )}

      <div className="oa-foot">
        <label className="oa-toggle">
          <input type="checkbox" checked={!status.autoOff} onChange={(e) => setAutoDownload(e.target.checked)} />
          Download automatically on this browser
        </label>
        {status.downloaded && !busy && (
          <button className="btn ghost small" onClick={removeAI}><Icon name="trash" size={13} /> Remove download</button>
        )}
      </div>
    </section>
  )
}

// A small "Offline AI 34%" chip while a download runs, so an automatic download is never invisible.
export function AIDownloadChip({ className = '' }) {
  const d = useDownload()
  if (d.phase !== 'downloading') return null
  return (
    <a className={`ai-chip ${className}`} href="#/admin" title="Offline AI is downloading — open Admin to see or cancel">
      <Icon name="arrowDown" size={12} /> Offline AI {Math.round(d.p * 100)}%{d.bytes?.eta ? ` · ${Math.max(1, Math.round(d.bytes.eta / 60))} min` : ''}
    </a>
  )
}
