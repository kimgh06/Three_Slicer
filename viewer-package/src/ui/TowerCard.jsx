import React from 'react'

// Prime tower card. Everything about the tower used to be one checkbox in the object list, with its size, position
// and purge amount unreachable — the kernel read prime_tower_* parameters that nothing in the UI wrote. This card is
// the settings surface for them, in the same shape the printer and filament cards use.
//
// Upstream keeps the tower as a first-class object (its own settings page, and a draggable volume in the scene).
// The scene half lives in use_three_scene.js; this is the numeric half.

// Purge volume for going from one filament to another, mm³, as a flat N×N table indexed [from*N + to] — upstream's
// flush_volumes_matrix layout, so the same numbers mean the same thing. The diagonal is a filament changing to
// itself, which never happens and is not editable.
export function readMatrix(raw, count) {
  const flat = Array.isArray(raw) ? raw.map(Number) : []
  return Array.from({ length: count }, (_, from) =>
    Array.from({ length: count }, (_, to) => {
      const v = flat[from * count + to]
      return Number.isFinite(v) ? v : (from === to ? 0 : DEFAULT_FLUSH)
    }))
}
// Upstream's own schema default for a pair with nothing configured.
export const DEFAULT_FLUSH = 140

// Write one plate's tower position into the settings map. wipe_tower_x/y are upstream's per-plate arrays
// (coFloats, one entry per plate); a scalar left over from the pre-array days means "every plate alike", so it
// is broadcast across the existing plates before the one index changes — otherwise the first per-plate edit
// would silently flip every OTHER plate to automatic placement. x === null clears this plate's entry (back to
// auto) without touching the rest. Shared by the card's inputs and the scene's drag — one setting, two surfaces.
export function writeTowerPosition(prev, plate, plateCount, x, y) {
  const promote = (v) => {
    if (Array.isArray(v)) return [...v]
    const n = Number(v)
    return (v != null && v !== '' && Number.isFinite(n)) ? Array(plateCount).fill(n) : []
  }
  const xs = promote(prev?.wipe_tower_x), ys = promote(prev?.wipe_tower_y)
  xs[plate] = x === null ? null : Number(x)
  ys[plate] = y === null ? null : Number(y)
  return { ...prev, wipe_tower_x: xs, wipe_tower_y: ys }
}

export default function TowerCard({
  settings, setSettings, extruderColors, wipeTowerReal, onToggleWipeTower, towerStats,
  selectedPlate = 0, plateCount = 1,
}) {
  const colors = Array.isArray(extruderColors) ? extruderColors : []
  const count = colors.length
  const raw = settings ?? {}
  const scalar = (key) => { const v = raw[key]; return Array.isArray(v) ? v[0] : v }
  const num = (key, fallback) => { const v = Number(scalar(key)); return Number.isFinite(v) ? v : fallback }
  // Per-plate options read the SELECTED plate's entry — the card edits the plate on screen, like upstream's
  //  per-plate wipe tower. A hole (null) is "auto for this plate", so it must not fall back to another entry.
  const atPlate = (key) => { const v = raw[key]; return Array.isArray(v) ? v[selectedPlate] : v }

  // Three states, not two: no tower at all, the deterministic ring, or the real port. "Off" is the absence of a
  //  tower — upstream's own default — and it only makes sense next to a destination for the purge, which is the
  //  row below. Stored as enable_prime_tower so it reads the same as upstream's key.
  const towerOff = raw.enable_prime_tower === false
  const mode = towerOff ? 'off' : (wipeTowerReal ? 'real' : 'ring')
  const setMode = (next) => {
    setSettings?.(prev => {
      const out = { ...prev }
      if (next === 'off') out.enable_prime_tower = false
      else delete out.enable_prime_tower
      return out
    })
    if (next !== 'off') onToggleWipeTower?.({ target: { checked: next === 'real' } })
  }
  const flushIntoInfill = raw.flush_into_infill === true
  const setFlush = (on) => setSettings?.(prev => {
    const out = { ...prev }
    if (on) out.flush_into_infill = true; else delete out.flush_into_infill
    return out
  })

  const width = num('prime_tower_width', 0)
  const towerX = atPlate('wipe_tower_x'), towerY = atPlate('wipe_tower_y')
  // "auto" is the absence of a position, not a separate flag: with no wipe_tower_x/y entry for THIS plate the
  //  slicer places the tower beside the model itself. Writing a coordinate is what takes over, and clearing it
  //  hands placement back. The null check matters now that holes exist: Number(null) is 0, which is finite.
  const manual = towerX != null && towerX !== '' && Number.isFinite(Number(towerX))

  const set = (key, value) => setSettings?.(prev => {
    const next = { ...prev }
    if (value === null || value === '' || !Number.isFinite(Number(value))) delete next[key]
    else next[key] = Number(value)
    return next
  })
  const setPosition = (x, y) => setSettings?.(prev => writeTowerPosition(prev, selectedPlate, plateCount, x, y))

  const matrix = readMatrix(raw.flush_volumes_matrix, count)
  const setCell = (from, to, value) => setSettings?.(prev => {
    const next = { ...prev }
    const table = readMatrix(prev?.flush_volumes_matrix, count)
    table[from][to] = Math.max(0, Number(value) || 0)
    next.flush_volumes_matrix = table.flat()
    return next
  })

  return (
    <section className="side-card" data-testid="tower-section">
      <div className="sc-head">🗼 Prime tower</div>

      <div className="sc-info"><span>Mode</span>
        {/* The real WipeTower is the only implementation that sizes a purge from a volume, but it is not
            reproducible yet (see params.h), so the option says so rather than presenting the two as equals. */}
        <select className="sc-model" data-testid="tower-mode" value={mode} onChange={e => setMode(e.target.value)}>
          <option value="ring">Ring — deterministic</option>
          <option value="real">Real wipe tower — not reproducible yet</option>
          <option value="off">Off — no tower</option>
        </select>
      </div>

      {/* Where the purge goes. Without a tower it has to go somewhere, and the model's own sparse infill is the
          one place the material is not wasted — but a layer with no infill to give cannot absorb it, which is why
          turning the tower off without this is called out rather than silently accepted. */}
      <div className="sc-info"><span>Purge into</span>
        <select className="sc-model" data-testid="tower-flush"
          value={flushIntoInfill ? 'infill' : 'tower'} onChange={e => setFlush(e.target.value === 'infill')}
          title="Infill hides the purge inside the part; a layer with no sparse infill still needs the tower.">
          <option value="tower">The tower</option>
          <option value="infill">The model's infill</option>
        </select>
      </div>
      {towerOff && !flushIntoInfill && (
        <div className="bp-note" data-testid="tower-off-warning">
          With no tower and no flush destination, a tool change carries the previous colour into the model.
        </div>
      )}

      {mode !== 'off' && <div className="sc-info"><span>Width</span>
        <span className="sc-num">
          <input type="number" min="5" max="150" step="1" value={width || ''} placeholder="auto"
            data-testid="tower-width" title="Footprint of the tower (mm). Empty uses the slicer's own default."
            onChange={e => set('prime_tower_width', e.target.value)} /> mm
        </span>
      </div>}

      {/* Position is the one per-plate option on the card, so with several plates the label says which one is
          being edited — everything else here applies to every plate alike. */}
      {mode !== 'off' && <div className="sc-info"><span>{plateCount > 1 ? `Position · plate ${selectedPlate + 1}` : 'Position'}</span>
        <select className="sc-model" data-testid="tower-position-mode" value={manual ? 'manual' : 'auto'}
          onChange={e => setPosition(e.target.value === 'auto' ? null : (towerStats?.x ?? 10), towerStats?.y ?? 10)}
          title="Auto places the tower beside the model; manual pins it to a bed coordinate.">
          <option value="auto">Beside the model</option>
          <option value="manual">Fixed coordinate</option>
        </select>
      </div>}
      {mode !== 'off' && manual && (
        <div className="sc-info"><span>X / Y</span>
          <span className="sc-num">
            <input type="number" step="1" value={Number(towerX)} data-testid="tower-x"
              onChange={e => setPosition(e.target.value, Number(towerY) || 0)} />
            <input type="number" step="1" value={Number(towerY) || 0} data-testid="tower-y"
              onChange={e => setPosition(Number(towerX) || 0, e.target.value)} /> mm
          </span>
        </div>
      )}

      {/* The purge table. A grid rather than a settings row because it is N×N: one column per destination
          filament, and the swatches are the same colours the filament card and the preview use, so a cell reads
          as "going from this colour to that one". */}
      {count > 1 && (
        <details className="sc-fold" data-testid="tower-purge-fold">
          <summary><span className="sc-fold-lbl">Purging volumes</span><b>mm³</b></summary>
          <div className="sc-fold-body">
            <table className="purge-grid" data-testid="purge-matrix">
              <thead>
                {/* No whitespace between the cells: a text node between <th>s is invalid inside a row. */}
                <tr>
                  <th />
                  {colors.map((c, to) => (
                    <th key={to}><span className="stat-swatch" style={{ background: c }} />T{to + 1}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {colors.map((c, from) => (
                  <tr key={from}>
                    <th><span className="stat-swatch" style={{ background: c }} />T{from + 1}</th>
                    {colors.map((_c, to) => (
                      <td key={to}>
                        {from === to ? <span className="muted">—</span> : (
                          <input type="number" min="0" step="10" value={matrix[from][to]}
                            data-testid={`purge-${from}-${to}`}
                            onChange={e => setCell(from, to, e.target.value)} />
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="muted bp-note">Volume pushed out when the print switches from the row's filament to the
              column's. A dark colour following a light one needs more.</div>
          </div>
        </details>
      )}

      {/* What the last slice actually did, next to the settings that caused it — the stats card shows the same
          totals, but a tower setting is easier to judge against its own result. */}
      {towerStats && (
        <div className="muted bp-counts" data-testid="tower-stats">
          last slice: {towerStats.changes} tool change{towerStats.changes === 1 ? '' : 's'} ·{' '}
          {towerStats.purge.toFixed(1)} mm purged
          {Number.isFinite(towerStats.x) && ` · at ${towerStats.x.toFixed(0)}, ${towerStats.y.toFixed(0)}`}
        </div>
      )}
    </section>
  )
}
