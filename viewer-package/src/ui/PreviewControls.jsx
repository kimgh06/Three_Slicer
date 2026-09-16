import React from 'react'
import { VIEW_TYPES } from 'three-slicer-viewer'
import { DEFAULT_RANGES_COLORS, TOOL_COLOR } from 'three-slicer-viewer'
import MoveBar from './MoveBar.jsx'

const rgb = (c) => `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})`

// Preview sidebar controls: view type select, the dual layer slider and the legend
// (a gradient for continuous views, role shares for the feature view, extruder swatches for the filament view).
export default function PreviewControls({
  viewType, onViewType, layerCount, layerLo, layerHi, segCount, singleLayer,
  onLayerLo, onLayerHi, onToggleSingle, showTravel, onToggleTravel, colorRange, roleLegend, extruderColors,
  moveScrub = null,
}) {
  // The filament view is categorical like the feature view, so it takes the swatch legend rather than the gradient —
  //  but its categories are extruders, not roles, and roleLegend would otherwise label them Wall/Sparse/Solid.
  //  At least one entry, because a host that passes no filament list is still slicing with one extruder.
  const filamentView = viewType === 'filament'
  const extruderCount = Math.max(1, Array.isArray(extruderColors) ? extruderColors.length : 0)
  return (
    <div className="slice-layer" data-testid="preview-controls">
      <label className="view-type-row">View type
        <select value={viewType} onChange={onViewType} data-testid="view-type-select" title="What the toolpath colors represent — feature type, speed, layer height, width, fan, temperature, printing filament">
          {VIEW_TYPES.map(v => <option key={v.key} value={v.key}>{v.label}</option>)}
        </select>
      </label>
      <label>Layer <b data-testid="layer-range">{singleLayer ? (layerHi + 1) : `${layerLo + 1}..${layerHi + 1}`}</b> / {layerCount}
        <span className="muted"> ({segCount.toLocaleString()} segments)</span></label>
      <div className="dual-slider">
        <input type="range" min="0" max={Math.max(0, layerCount - 1)} value={layerLo} onChange={onLayerLo} data-testid="layer-lo" title="Lowest layer to show (also adjustable with ↓/↑)" />
        <input type="range" min="0" max={Math.max(0, layerCount - 1)} value={layerHi} onChange={onLayerHi} data-testid="layer-hi" title="Highest layer to show (↓/↑, hold Shift for steps of 10)" />
      </div>
      {/* Directly under the layer slider, because it is the second axis of the same question: that one picks
          which layers, this one how far into the top of them. null when the result has no move order (resin). */}
      {moveScrub && (
        <MoveBar value={moveScrub.at} max={moveScrub.max} point={moveScrub.point} onScrub={moveScrub.onScrub} />
      )}
      <div className="layer-ctl">
        <button className={singleLayer ? 'on' : ''} onClick={onToggleSingle} data-testid="single-layer-btn" title="Show only the selected layer (L)">Single layer</button>
        <label className="slice-travel"><input type="checkbox" checked={showTravel} onChange={onToggleTravel} data-testid="travel-toggle" title="Show non-extruding moves as gray lines (T)" /> Travel</label>
      </div>
      {filamentView ? (
        // Swatches only, no share percentage: buildSegmentData accumulates extruded length per feature type
        //  (typeLengths) and never per tool, so a "% per extruder" here would be made up. The millimetres per tool
        //  are the stats card's job. The colors come from TOOL_COLOR because that is exactly what computeColors
        //  paints the segments with — an extruderColors swatch would show the user's picker color, not the toolpath.
        <div className="role-legend" data-testid="view-legend">
          {Array.from({ length: extruderCount }, (_unused, index) => (
            <span key={index} className="role-item">
              <i style={{ background: rgb(TOOL_COLOR[index % TOOL_COLOR.length]) }} />
              T{index + 1}
            </span>
          ))}
        </div>
      ) : colorRange && colorRange.cont ? (
        <div className="grad-legend" data-testid="view-legend">
          <div className="grad-title">{colorRange.label} <span className="muted">{colorRange.unit}</span></div>
          <div className="grad-bar" data-testid="gradient-bar" style={{ background: `linear-gradient(to right, ${DEFAULT_RANGES_COLORS.map(rgb).join(',')})` }} />
          <div className="grad-minmax"><span data-testid="grad-min">{colorRange.min.toFixed(colorRange.unit === 'mm' ? 2 : 0)}</span><span data-testid="grad-max">{colorRange.max.toFixed(colorRange.unit === 'mm' ? 2 : 0)}</span></div>
        </div>
      ) : (
        <div className="role-legend" data-testid="view-legend">
          {roleLegend.map(r => (
            <span key={r.type} className="role-item">
              <i style={{ background: rgb(r.color) }} />
              {r.label} <b>{r.pct.toFixed(0)}%</b>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
