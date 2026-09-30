import { ago, deviceName } from './api.js'
import { Icon } from './icons.jsx'
import TeamPanel from './TeamPanel.jsx'

export default function TeamView({ cloud, state }) {
  const { device, network } = state
  const live = network.online && cloud.live
  const records = [...cloud.records].sort((a, b) => b.updated_ts - a.updated_ts)

  return (
    <div className="notes-view">
      <div className="page-head">
        <div>
          <h1>{state.team ? state.team.name : 'Team'}</h1>
          <p className="lead">{state.team ? 'Devices and notes you share' : 'Share notes with your other devices'}</p>
        </div>
        {state.team && (
          <span className={`live-pill ${live ? 'live' : 'stale'}`}>
            <i />{live ? 'Live' : `Offline copy · ${ago(cloud.as_of)}`}
          </span>
        )}
      </div>

      <TeamPanel state={state} />
      {state.team && <h3 className="feed-title">Shared notes</h3>}

      {!state.team ? null : !records.length ? (
        <div className="empty-state">
          <Icon name="users" size={32} />
          <b>Nothing shared yet</b>
          <span>Save a note as <b>Team</b> and it appears here after the next sync.</span>
        </div>
      ) : (
        <ul className={`feed ${live ? '' : 'stale'}`}>
          {records.map((r) => {
            const mine = r.from === device.id
            return (
              <li key={r.mem_id} className={`feed-item ${mine ? 'mine' : ''}`}>
                <span className={`avatar ${mine ? 'me' : ''}`}>
                  <Icon name={mine ? 'chip' : 'arrowDown'} size={15} />
                </span>
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
          })}
        </ul>
      )}
    </div>
  )
}
