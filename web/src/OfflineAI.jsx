import { useEffect, useState } from 'react'
import { Icon } from './icons.jsx'
import { MODELS, aiStatus, download, removeAI, verifyCached, webgpu } from './offline/brain.js'

// Download the offline AI into this browser: a search model and a small answer model that run
// on this computer or phone, so questions still get answers when the device can't be reached.
export default function OfflineAI({ state, className = 'panel' }) {
  const [gpu, setGpu] = useState(null)
  const [status, setStatus] = useState(aiStatus)
  const [cached, setCached] = useState(null)
  const [size, setSize] = useState(state.device.kind === 'mobile' ? 'small' : 'standard')
  const [progress, setProgress] = useState(null) // {p, text} while downloading
  const [err, setErr] = useState(null)

  useEffect(() => {
    webgpu().then(setGpu)
    verifyCached().then(setCached)
  }, [status.model])

  const start = async () => {
    setErr(null)
    setProgress({ p: 0, text: 'Starting…' })
    try {
      await download(size, (p, text) => setProgress({ p, text }))
      setStatus(aiStatus())
      setCached(true)
    } catch (e) {
      setErr(e.message || String(e))
    } finally {
      setProgress(null)
    }
  }
  const remove = async () => {
    await removeAI()
    setStatus(aiStatus())
    setCached(false)
  }

  const ready = status.downloaded && cached
  return (
    <section className={`${className} offline-ai`}>
      <div className="oa-head">
        <span className={`oa-icon ${ready ? 'ok' : ''}`}><Icon name="chip" size={18} /></span>
        <div>
          <h3>Offline AI</h3>
          <p className="muted">
            {ready
              ? `Ready in this browser · ${status.model.replace(/-MLC$/, '')} · answers with no internet`
              : 'Without internet this page still opens, searches your notes and saves new ones. Download the offline AI to also get written answers.'}
          </p>
        </div>
      </div>

      {progress ? (
        <div className="oa-progress" role="progressbar" aria-valuenow={Math.round(progress.p * 100)} aria-valuemin={0} aria-valuemax={100}>
          <div className="oa-bar"><i style={{ width: `${Math.max(2, progress.p * 100)}%` }} /></div>
          <span className="muted">{Math.round(progress.p * 100)}% · {progress.text.replace(/\[.*?\]\s*/g, '').slice(0, 90)}</span>
        </div>
      ) : ready ? (
        <div className="row gap">
          <span className="badge shared"><Icon name="check" size={12} />Works offline</span>
          <button className="btn ghost small" onClick={remove}><Icon name="trash" size={13} /> Remove download</button>
        </div>
      ) : gpu && !gpu.ok ? (
        <p className="oa-note"><Icon name="info" size={13} /> {gpu.why} Offline search and notes still work.</p>
      ) : (
        <div className="oa-actions">
          <div className="seg" role="radiogroup" aria-label="Model size">
            {Object.entries(MODELS).map(([k, m]) => (
              <button key={k} type="button" role="radio" aria-checked={size === k} className={size === k ? 'active' : ''}
                onClick={() => setSize(k)} title={m.hint}>
                {m.label} <span className="muted">{m.size}</span>
              </button>
            ))}
          </div>
          <button className="btn primary small" onClick={start} disabled={!gpu || !navigator.onLine}>
            <Icon name="arrowDown" size={14} /> {status.downloaded && cached === false ? 'Download again' : 'Download'}
          </button>
          {!navigator.onLine && <span className="muted">Connect to the internet to download.</span>}
        </div>
      )}
      {err && <p className="note-err"><Icon name="warn" size={13} /> {err}</p>}
    </section>
  )
}
