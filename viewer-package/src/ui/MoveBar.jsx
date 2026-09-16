import React from 'react'

// The move scrub, rendered inside the Preview card right under the layer slider: that one picks WHICH layers are
// shown, this one how far into the top of them the print has got. Laid out the same way — a label line, then the
// control — so the two read as one pair rather than as unrelated widgets.
//
// The count is of MOVES, extrusions and travels together in the order the printer performs them, and the
// coordinates are where the nozzle ends up. `value === null` is "the whole layer", where it sits until dragged.
// FFF only — see use_move_scrub.js for why resin has no counterpart.
export default function MoveBar({ value, max, point, onScrub }) {
  const at = value == null ? max : value
  return (
    <>
      <label>Move <b data-testid="move-at">{at.toLocaleString()}</b> / {max.toLocaleString()}
        {point && (
          <span className="muted" data-testid="move-point">
            {' '}X {point[0].toFixed(1)} Y {point[1].toFixed(1)} Z {point[2].toFixed(2)}
          </span>
        )}
      </label>
      <div className="move-bar" data-testid="move-bar">
        <input type="range" min="0" max={Math.max(0, max)} value={at} data-testid="move-range"
          title="How far into the top shown layer the nozzle has got"
          onChange={e => onScrub(Number(e.target.value))} />
        <button className="move-reset" disabled={value == null} data-testid="move-reset"
          title="Show the whole layer again" onClick={() => onScrub(null)}>Full</button>
      </div>
    </>
  )
}
