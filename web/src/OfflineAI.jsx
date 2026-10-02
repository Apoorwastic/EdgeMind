import { useEffect, useState } from 'react'
import { Icon } from './icons.jsx'
import {
  CATALOG, aiStatus, builtinName, cancelInstall, deviceProfile, downloads, install, removeAI, resolve, setAutoDownload, storageInfo,
  usePreference,
} from './offline/brain.js'

export function useDownload() {
  const [d, setD] = useState(downloads.get)
  useEffect(() => downloads.subscribe(setD), [])
  return d
}

const gb = (n) => `${n < 1 ? Math.round(n * 1000) + ' MB' : n.toFixed(2).replace(/0$/, '') + ' GB'}`

const mb = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${Math.round(b / 1e6)} MB`)
const eta = (s) => (s == null ? 'estimating time…' : s < 90 ? `about ${Math.max(1, Math.round(s / 10) * 10)} s left` : `about ${Math.round(s / 60)} min left`)

// What the browser's own model is doing, for "What this device can run".
const BUILTIN = {
  available: 'ready', downloading: 'the browser is fetching it', downloadable: 'can be fetched by the browser',
  unavailable: 'not on this device', unsupported: 'not in this browser',
}

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
        {installed && status.using === 'webllm' && <span className="badge shared"><Icon name="check" size={12} />In use</span>}
        {installed && status.using !== 'webllm' && (
          <button className="btn small" onClick={() => usePreference('webllm')}><Icon name="check" size={13} /> Use this</button>
        )}
        {!installed && (
          <button className="btn small" disabled={busy || !profile?.gpu?.ok || !navigator.onLine}
            title={!profile?.gpu?.ok ? profile?.gpu?.why : !navigator.onLine ? 'Connect to the internet to download' : undefined}
            onClick={() => install(entry.key)}>
            <Icon name="arrowDown" size={13} /> {status.downloaded ? 'Switch to this' : 'Download'}
          </button>
        )}
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
  // By the exact model first: tiers get re-pointed to better models over time, and a model installed under
  // an older tier name must still show as itself.
  const installed = CATALOG.find((e) => e.f16 === status.model || e.f32 === status.model) ||
    (status.model ? null : CATALOG.find((e) => e.key === status.tier))
  const main = CATALOG.filter((e) => !e.extra)
  const extra = CATALOG.filter((e) => e.extra)

  const when = (ts) => (ts ? new Date(ts).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '')
  const dlm = installed ? resolve(installed, profile?.gpu) : null
  const builtinState = d.builtin // available | downloading | downloadable | unavailable | unsupported
  const builtinLabel = {
    available: 'Ready on this device', downloading: `The browser is fetching it${d.builtinP ? ` · ${Math.round(d.builtinP * 100)}%` : ''}`,
    downloadable: 'Available — the browser fetches it when you choose it', unavailable: 'Not available on this device',
    unsupported: 'This browser has no built-in AI',
  }[builtinState] || 'Checking…'

  let active
  if (d.phase === 'checking' || !profile) active = <>Checking what this device can run…</>
  else if (status.using === 'builtin') active = <><b>{builtinName()}</b> · the browser’s built-in AI · nothing downloaded for it</>
  else if (status.using === 'webllm') {
    active = <><b>{dlm?.name || status.name || status.model}</b> · downloaded{dlm ? ` (${installed.label}, ${gb(dlm.gb)})` : ''}</>
  } else if (busy && target) active = <>Nothing yet — downloading <b>{resolve(target, profile.gpu).name}</b> (see below)</>
  else if (builtinState === 'downloading') active = <>Nothing yet — the browser is fetching <b>{builtinName()}</b></>
  else if (!profile.gpu.ok && builtinState !== 'available') active = <>Nothing — {profile.reason}</>
  else active = <>Nothing yet{status.autoOff ? ' — automatic download is off for this browser' : d.text ? ` — ${d.text}` : ''}</>

  return (
    <section className={`${className} offline-ai`}>
      <div className="oa-head">
        <span className={`oa-icon ${status.ready ? 'ok' : ''}`}><Icon name="chip" size={18} /></span>
        <div>
          <h3>Offline AI</h3>
          <p className="oa-active"><span className="muted">Answering offline with:</span> {active}</p>
          <p className="muted oa-sub">
            Search model: {status.search ? 'bge-small (34 MB) · ready' : 'not downloaded yet'} · answers and search run in this browser with no internet.
          </p>
        </div>
      </div>

      {busy && target && <Progress d={d} entry={target} gpu={profile?.gpu} />}
      {d.phase === 'error' && (
        <p className="note-err"><Icon name="warn" size={13} /> Download stopped: {d.error}
          {d.retrying && <span className="muted"> · tries again by itself</span>}
          {target && <button className="btn ghost small" onClick={() => install(target.key, { auto: d.auto })}>Try again</button>}
        </p>
      )}

      <div className="oa-section">
        <h4>Browser’s built-in AI</h4>
        <div className="oa-row">
          <div className="oa-model-main">
            <b>{builtinState && builtinState !== 'unsupported' ? builtinName() : 'None'}</b>
            <span className="muted">{builtinLabel}</span>
          </div>
          <div className="oa-model-tags">
            {status.using === 'builtin' && <span className="badge shared"><Icon name="check" size={12} />In use</span>}
            {status.using !== 'builtin' && (builtinState === 'available' || builtinState === 'downloadable') && (
              <button className="btn small" onClick={() => usePreference('builtin')}><Icon name="check" size={13} /> Use browser’s AI</button>
            )}
          </div>
        </div>
      </div>

      <div className="oa-section">
        <h4>Downloaded model</h4>
        <div className="oa-row">
          <div className="oa-model-main">
            <b>{status.downloaded ? (dlm?.name || status.name || status.model) : 'None downloaded'}</b>
            <span className="muted">
              {status.downloaded
                ? [installed && `${installed.label} tier`, dlm && gb(dlm.gb), status.downloadedAt && `downloaded ${when(status.downloadedAt)}`,
                  status.auto ? 'picked automatically for this device' : 'chosen by you'].filter(Boolean).join(' · ')
                : profile?.gpu.ok ? `Suggested for this device: ${profile.reason}` : (profile?.gpu.why || '')}
            </span>
          </div>
          <div className="oa-model-tags">
            {status.downloaded && status.using === 'webllm' && <span className="badge shared"><Icon name="check" size={12} />In use</span>}
            {status.downloaded && status.using !== 'webllm' && (
              <button className="btn small" onClick={() => usePreference('webllm')}><Icon name="check" size={13} /> Use this model</button>
            )}
            {status.downloaded && !busy && (
              <button className="btn ghost small" onClick={removeAI}><Icon name="trash" size={13} /> Remove</button>
            )}
          </div>
        </div>
      </div>

      <div className="oa-section">
        <h4>Switch model</h4>
        {profile && !profile.gpu.ok && <p className="oa-note"><Icon name="info" size={13} /> {profile.gpu.why} Models can’t be downloaded in this browser.</p>}
        <ul className="oa-models">
          {main.map((e) => <ModelRow key={e.key} entry={e} profile={profile} status={status} busy={busy} />)}
        </ul>
        <details className="oa-more">
          <summary>More models</summary>
          <ul className="oa-models">
            {extra.map((e) => <ModelRow key={e.key} entry={e} profile={profile} status={status} busy={busy} />)}
          </ul>
        </details>
      </div>

      {profile && (
        <details className="oa-more">
          <summary>What this device can run</summary>
          <div className="kv-grid oa-facts">
            {[...profile.facts, ['Built-in model', BUILTIN[d.builtin] || 'checking…']].map(([k, v]) => <div key={k}><span>{k}</span><b>{v}</b></div>)}
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

// Going offline before the offline AI is installed: say so once, plainly, so a general question that gets
// no answer isn't a surprise. `browser` = the page is answering by itself (the device can't be reached);
// `local` = the device runs on this computer and has its own model, so losing Wi-Fi alone doesn't matter.
export function OfflineAIWarning({ browser, local }) {
  const d = useDownload()
  const [netOff, setNetOff] = useState(!navigator.onLine)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const on = () => setNetOff(false)
    const off = () => setNetOff(true)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off) }
  }, [])
  const offline = browser || (netOff && !local)
  useEffect(() => { setOpen(offline && !aiStatus().ready) }, [offline])
  if (!open || aiStatus().ready) return null

  const noGpu = d.profile && !d.profile.gpu.ok
  const pct = Math.round((d.p || 0) * 100)
  return (
    <div className="oa-warn-scrim" role="presentation" onClick={() => setOpen(false)}>
      <div className="oa-warn" role="alertdialog" aria-modal="true" aria-labelledby="oa-warn-t" aria-describedby="oa-warn-d"
        onClick={(e) => e.stopPropagation()}>
        <span className="oa-warn-icon"><Icon name="warn" size={20} /></span>
        <h3 id="oa-warn-t">You’re offline — Offline AI isn’t installed</h3>
        <p id="oa-warn-d" className="muted">
          {noGpu
            ? 'This browser can’t run the offline AI (no WebGPU), so '
            : pct > 0 ? `It was ${pct}% downloaded when the connection dropped, so ` : 'It hasn’t been downloaded yet, so '}
          general questions won’t get answers until you’re back online. Questions about your notes still work —
          you’ll see the matching notes instead of a written answer.
        </p>
        {!noGpu && (
          <p className="muted oa-warn-sub">
            {aiStatus().autoOff
              ? 'To have it ready next time, turn on “Download automatically” in Admin → Offline AI.'
              : 'The download carries on by itself when the connection comes back.'}
          </p>
        )}
        <button className="btn primary" autoFocus onClick={() => setOpen(false)}>Got it</button>
      </div>
    </div>
  )
}
