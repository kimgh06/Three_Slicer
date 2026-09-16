import React from 'react'
import { PaintToolRow, isFillTool } from './MaterialPaintPanel.jsx'

// Floating brush panel shown while support painting is active.
export default function PaintPanel({
  paintMode, onPaintMode, onClear, brushRadius, onBrushRadius, paintCounts,
  paintTool, onPaintTool, brushCursor, onBrushCursor, fillAngle, onFillAngle, axisLock, onAxisLock,
  overhangOnly, onOverhangOnly, overhangAngle = 30,
}) {
  return (
    <div className="brush-panel" data-testid="paint-tools">
      <div className="bp-title">Support painting</div>
      <div className="bp-modes">
        <button className={paintMode === 'enforcer' ? 'on enf' : 'enf'} onClick={() => onPaintMode('enforcer')} title="Force support under the painted facets" data-testid="paint-enforcer">enforcer</button>
        <button className={paintMode === 'blocker' ? 'on blk' : 'blk'} onClick={() => onPaintMode('blocker')} title="Block support under the painted facets" data-testid="paint-blocker">blocker</button>
        <button onClick={onClear} data-testid="paint-clear" title="Clear every painted enforcer/blocker area">Clear</button>
        <button onClick={() => onPaintMode('off')} data-testid="paint-off" title="Leave painting mode (Esc)">Close</button>
      </div>
      {/* The same tools the material panel offers: both brushes write to one selector, so the fills reach enforcer
          and blocker marks without a second implementation. */}
      <PaintToolRow tool={paintTool} onTool={onPaintTool} cursor={brushCursor} onCursor={onBrushCursor}
        fillAngle={fillAngle} onFillAngle={onFillAngle} axisLock={axisLock} onAxisLock={onAxisLock} />
      {/* Upstream's "on overhangs only" (m_paint_on_overhangs_only): the stroke lands only where the model actually
          needs support, so a rough drag over a whole side marks the underside and leaves the walls alone. It shares
          the support threshold angle with the overhang view, as it does upstream. */}
      <label className="bp-check" title={`Paint only facets overhanging by more than ${overhangAngle}° — the support threshold`}>
        <input type="checkbox" checked={!!overhangOnly} onChange={e => onOverhangOnly?.(e.target.checked)}
          data-testid="paint-overhangs-only" />
        On overhangs only ({overhangAngle}°)
      </label>
      {!isFillTool(paintTool) && (
        <label className="bp-radius">Brush radius {brushRadius}mm
          <input type="range" min="1" max="15" step="0.5" value={brushRadius}
            onChange={e => onBrushRadius(parseFloat(e.target.value))} data-testid="brush-radius" />
        </label>
      )}
      <div className="muted bp-counts" data-testid="paint-counts">enforcer {paintCounts.enf} · blocker {paintCounts.blk} · {isFillTool(paintTool) ? 'click the model to fill' : 'drag over the model to paint'}</div>
    </div>
  )
}
