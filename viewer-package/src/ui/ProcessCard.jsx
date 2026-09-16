import React from 'react'
import { cardScope } from '../core/plate_settings.js'
import ScopeToggle from './ScopeToggle.jsx'

// The Process card: the host's settings-panel slot, plus the per-plate scope toggle.
//
// With more than one plate and a FUNCTION slot, the Global|Plate toggle projects the panel onto the selected
// plate: it shows that plate's EFFECTIVE map and writes edits into plateSettings[selectedPlate] only — the
// per-plate mirror of FilamentCard's per-extruder projection (same function-slot shape, same diff-back write).
// A plain node slot keeps the pre-feature global binding and shows no toggle.
export default function ProcessCard({
  processPanel, settings, setSettings, plateSettings, setPlateSettings,
  plateCount, selectedPlate, settingsScope, setSettingsScope, onResetPlate = null,
}) {
  const scoped = cardScope({ settings, setSettings, plateSettings, setPlateSettings, plateCount, selectedPlate, settingsScope }, typeof processPanel === 'function')
  const active = scoped.plateScope
  const scopeMeta = { scope: active ? 'plate' : 'global', selectedPlate, overriddenKeys: scoped.overriddenKeys, onRevertKey: scoped.onRevertKey }
  const panel = typeof processPanel === 'function' ? processPanel(scoped.settings, scoped.setSettings, scopeMeta) : processPanel
  return (
    <section className="side-card process-card" data-testid="process-section">
      <div className="sc-head">⚙ Process
        {plateCount > 1 && typeof processPanel === 'function' && (
          <ScopeToggle plateScope={active} selectedPlate={selectedPlate} onScope={setSettingsScope} onReset={onResetPlate} />
        )}
      </div>
      {panel}
    </section>
  )
}
