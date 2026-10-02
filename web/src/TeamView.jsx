import TeamPanel from './TeamPanel.jsx'

export default function TeamView({ cloud, state, memories, onSelectTeam }) {
  const teams = state.teams || []
  return (
    <div className="notes-view">
      <div className="page-head">
        <div>
          <h1>{teams.length > 1 ? 'Teams' : teams.length === 1 ? teams[0].name : 'Team'}</h1>
          <p className="lead">
            {teams.length > 1 ? `${teams.length} teams you're part of — choose one to see its notes and members`
              : teams.length === 1 ? 'Devices and notes you share'
              : 'Share notes with your other devices'}
          </p>
        </div>
      </div>

      <TeamPanel state={state} cloud={cloud} memories={memories} onSelect={onSelectTeam} />
    </div>
  )
}
