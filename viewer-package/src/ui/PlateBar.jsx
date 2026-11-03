import React from 'react'

// Stage 29-2 plate tab bar: select a plate, add one, drop the last one.
// `docked` is the sidebar's place above the slice button; without it the bar floats over the canvas.
// `overridePlates` marks the plates carrying per-plate setting overrides — the list-level answer to
// "which plates slice with something other than the global settings".
// `plateRun` is an all-plates run's map (core/slice_pool.js): each tab shows what its plate is doing — busy,
// queued, done, failed, as the fill of the tab — separately from being selected, because with several plates slicing at once the
// selection can no longer follow the work.
function runTextOf(run) {
  if (!run) return ''
  if (run.state === 'busy') return `\nSlicing ${Math.round(run.progress * 100)}%`
  let text = `\n${run.state[0].toUpperCase()}${run.state.slice(1)}`
  if (run.error) text += `: ${run.error}`
  return text
}

// How far a tab is filled during a run, in the --plate-fill-height custom property the stylesheet draws.
function fillOf(run) {
  if (!run) return undefined
  if (run.state === 'busy') return { '--plate-fill-height': `${Math.round(run.progress * 100)}%` }
  if (run.state === 'queued') return undefined
  return { '--plate-fill-height': '100%' }
}

export default function PlateBar({ docked = false, plateCount, selectedPlate, maxPlates, onSelect, onAdd, onDelete, overridePlates, plateRun = null }) {
  let barClass = 'plate-bar'
  if (docked) barClass += ' docked'
  return (
    <div className={barClass} data-testid="plate-bar" role="tablist" aria-label="Plates">
      {Array.from({ length: plateCount }, (_, i) => {
        const overridden = overridePlates?.includes(i)
        const run = plateRun?.plates?.[i]
        let className = 'plate-tab'
        if (i === selectedPlate) className += ' on'
        if (run) className += ' run-' + run.state
        return (
          <button key={i} role="tab" className={className} style={fillOf(run)} onClick={() => onSelect(i)}
            title={`Select plate ${i + 1} — in Preview this switches to that plate's result`
              + (overridden && '\nHas per-plate setting overrides' || '') + runTextOf(run)}
            data-testid={`plate-${i}`}>
            {i + 1}{overridden && <span className="plate-dot" data-testid={`plate-dot-${i}`} />}
          </button>
        )
      })}
      <button className="plate-add" onClick={onAdd} disabled={plateCount >= maxPlates} title={`Add an empty plate (max ${maxPlates}) — each plate slices and exports separately`} data-testid="plate-add">+</button>
      <button className="plate-del" onClick={onDelete} disabled={plateCount <= 1} title="Delete the last plate and its slice result (the first plate stays)" data-testid="plate-del">−</button>
    </div>
  )
}
