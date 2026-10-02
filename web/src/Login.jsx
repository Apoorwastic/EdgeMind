import { useState } from 'react'
import { login } from './api.js'
import { Icon } from './icons.jsx'

const DEVICE_LABEL = (id) => (/phone|mobile/.test(id) ? 'Phone' : 'Laptop')

// One sign-in page for every account. The gateway (edge/gateway.py) sends the session to the
// account's own device; an account with several devices picks which one this browser acts as.
export default function Login({ session }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [device, setDevice] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const u = username.trim().toLowerCase()
  const account = (session.accounts || []).find((a) => a.id === u || a.name.toLowerCase() === u)
  const devices = account?.devices || []
  const chosen = devices.includes(device) ? device : devices[0]

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await login(username, password, chosen)
      window.location.reload()
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }
  const fill = (a) => { setUsername(a.name); setPassword(a.password); setError(null) }

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <span className="login-logo" aria-hidden="true"><i /></span>
        <h1>Sign in to EdgeMind</h1>
        <p className="muted">Private notes are encrypted for your own devices. Team notes go to your team.</p>

        <label>
          <span>Name</span>
          <input autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="e.g. Apoorwa" />
        </label>
        <label>
          <span>Password</span>
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {devices.length > 1 && (
          <div className="login-device">
            <span>Use this browser as</span>
            <div className="seg" role="radiogroup" aria-label="Device">
              {devices.map((d) => (
                <button key={d} type="button" className={chosen === d ? 'active' : ''} onClick={() => setDevice(d)}>
                  <Icon name={DEVICE_LABEL(d) === 'Phone' ? 'chip' : 'grid'} size={14} /> {account.name}’s {DEVICE_LABEL(d).toLowerCase()}
                </button>
              ))}
            </div>
          </div>
        )}
        {error && <p className="team-error"><Icon name="warn" size={13} /> {error}</p>}
        <button className="btn primary" disabled={busy || !username.trim() || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        {session.demo?.length > 0 && (
          <div className="login-demo">
            <span className="muted small">Demo accounts · team Thunderbolts</span>
            <div className="row gap">
              {session.demo.map((a) => (
                <button key={a.id} type="button" className={`login-chip ${account?.id === a.id ? 'on' : ''}`} onClick={() => fill(a)}>
                  <Icon name="users" size={13} /> {a.name}
                </button>
              ))}
            </div>
          </div>
        )}
      </form>
    </div>
  )
}
