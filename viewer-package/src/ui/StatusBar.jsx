import React from 'react'
import VersionBadge from './VersionBadge.jsx'
import { hms } from './StatsCard.jsx'

// The strip along the bottom of the window: what the scene reports on the left, the plate and its estimate on the right.
export default function StatusBar({ status, selectedPlate, plateCount, timeSec, versionBadge }) {
  return (
    <div className="vp-status" data-testid="vp-status">
      <span className="vs-text">{status}</span>
      <span className="vs-field" data-testid="status-plate">Plate {selectedPlate + 1} of {plateCount}</span>
      {timeSec > 0 && <span className="vs-field" data-testid="status-time">Print {hms(timeSec)}</span>}
      <VersionBadge on={versionBadge} />
    </div>
  )
}
