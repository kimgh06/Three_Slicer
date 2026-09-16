import React from 'react'

// The Global | Plate N segment — which map a settings card's edits land in. Shared by the Process and
// Printer cards so the two heads cannot render the switch differently; both bind the same Viewport state,
// so flipping it in either card flips it for both (one scope per screen, not one per card).
// `onReset` (plate scope, only when the plate holds overrides) drops the plate's whole override in one click —
// the complement of a plate pick writing a whole machine: what one click put there, one click takes back.
export default function ScopeToggle({ plateScope, selectedPlate, onScope, onReset = null, testid = 'scope-toggle', plateTestid = 'scope-plate' }) {
  return (
    <span className="scope-toggle" data-testid={testid} role="tablist" aria-label="Settings scope">
      <button role="tab" className={plateScope ? '' : 'on'} onClick={() => onScope('global')}
        title="Edit the global settings — every plate without an override follows them">Global</button>
      <button role="tab" className={plateScope ? 'on' : ''} onClick={() => onScope('plate')}
        title="Edit this plate only — changed values override the global ones for this plate's slice"
        data-testid={plateTestid}>Plate {selectedPlate + 1}</button>
      {plateScope && onReset && (
        <button type="button" className="scope-reset" onClick={onReset} data-testid={`${testid}-reset`}
          title="Drop every override of this plate — it follows the global settings again">↺</button>
      )}
    </span>
  )
}
