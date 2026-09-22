import React from 'react'
import { THEME } from '../core/theme.js'
import { ANGLE_FILL_TOOLS, FILL_TOOLS } from '../core/paint_tools.js'

// Chip labels sit on the filament's own colour, which spans black PLA to white PETG — pick the ink per chip
//  instead of hard-coding one, or the label disappears on half of any real palette.
function readableInkFor(backgroundColor) {
  const hex = String(backgroundColor ?? '').trim().replace(/^#/, '')
  if (hex.length !== 3 && hex.length !== 6) return THEME.inkOnDark
  const expanded = hex.length === 3 ? hex.split('').map(digit => digit + digit).join('') : hex
  const channels = [0, 2, 4].map(offset => parseInt(expanded.slice(offset, offset + 2), 16) / 255)
  if (channels.some(Number.isNaN)) return THEME.inkOnDark
  const [red, green, blue] = channels
  const relativeLuminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue
  return relativeLuminance > 0.55 ? THEME.inkOnLight : THEME.inkOnDark
}

// The counts source indexes by extruder, but it arrives as a dense array from one producer and as a sparse
//  object (only the tools that own facets) from another — read both, and read an absent source as zero, so an
//  unwired kernel side renders "0" rather than throwing on every pointer move.
export function paintedFacetCount(paintCounts, extruderIndex) {
  if (!paintCounts) return 0
  const value = Array.isArray(paintCounts) ? paintCounts[extruderIndex] : paintCounts[extruderIndex]
  return Number.isFinite(value) ? value : 0
}

// Upstream's four painting tools (GLGizmoMmuSegmentation's tool_type plus the POINTER cursor). Shared by both
// brush panels rather than living in a third file: the two painting modes drive the SAME selector, so a tool that
// works for one works unchanged for the other, and the support panel already borrows this panel's shell.
// The radius belongs to the brush alone — a fill selects by mesh topology, so there is nothing for a radius to mean.
export const PAINT_TOOLS = [
  ['brush',    'brush',    'Drag a radius cursor over the model'],
  ['smart',    'smart',    'Click once to flood the smooth feature under the cursor (Smart fill)'],
  ['bucket',   'bucket',   "Click once to flood everything sharing the clicked spot's current mark"],
  ['triangle', 'triangle', 'Click to mark exactly one facet'],
]
export const isFillTool = (tool) => FILL_TOOLS.has(tool)

// Upstream offers the axis lock as two mutually exclusive checkboxes (Vertical / Horizontal — GLGizmoMmuSegmentation
// .cpp:541). Three buttons say the same thing with the "neither" state on screen, which matters here because the
// lock is also reachable from the keyboard: a lock you cannot see is a lock you cannot work out how to leave.
const AXIS_LOCKS = [
  ['none', 'free', 'No lock — the stroke follows the pointer'],
  ['vertical', 'vertical ↕', 'Lock the stroke to a vertical line through the press (V)'],
  ['horizontal', 'horizontal ↔', 'Lock the stroke to a horizontal line through the press (H)'],
]

export function PaintToolRow({ tool = 'brush', onTool, cursor = 'circle', onCursor, fillAngle = 30, onFillAngle, axisLock = 'none', onAxisLock }) {
  return (
    <>
      <div className="bp-modes bp-tools">
        {PAINT_TOOLS.map(([id, label, hint]) => (
          <button key={id} className={tool === id ? 'bp-tool on' : 'bp-tool'} onClick={() => onTool?.(id)}
            title={hint} data-testid={`paint-tool-${id}`}>{label}</button>
        ))}
      </div>
      {tool === 'brush' && (
        <>
          <div className="bp-modes bp-tools">
            <button className={cursor === 'circle' ? 'bp-tool on' : 'bp-tool'} onClick={() => onCursor?.('circle')}
              title="Circle (C) — a disc facing the camera, so only the surface you are looking at"
              data-testid="paint-cursor-circle">circle</button>
            <button className={cursor === 'sphere' ? 'bp-tool on' : 'bp-tool'} onClick={() => onCursor?.('sphere')}
              title="Sphere (S) — a ball around the hit, so the far side of a thin wall is painted too"
              data-testid="paint-cursor-sphere">sphere</button>
          </div>
          <div className="bp-modes bp-tools">
            {AXIS_LOCKS.map(([id, label, hint]) => (
              <button key={id} className={axisLock === id ? 'bp-tool on' : 'bp-tool'} onClick={() => onAxisLock?.(id)}
                title={hint} data-testid={`paint-axis-${id}`}>{label}</button>
            ))}
          </div>
        </>
      )}
      {/* "Triangle" is bucket fill with the propagation off, so it never consults the angle — no slider for it. */}
      {ANGLE_FILL_TOOLS.has(tool) && (
        <label className="bp-radius">Fill angle {fillAngle}°
          <input type="range" min="1" max="90" step="1" value={fillAngle}
            onChange={e => onFillAngle?.(parseFloat(e.target.value))} data-testid="paint-fill-angle" />
        </label>
      )}
    </>
  )
}

// Floating brush panel shown while material painting is active: one chip per extruder, filled with that
// extruder's own filament colour, plus an eraser that returns facets to the default (unpainted) extruder.
// Deliberately the same shell as the support PaintPanel — same `.brush-panel` classes, same row order — so the
// two brushes are recognisably one tool with two targets.
export default function MaterialPaintPanel({
  colors, activeExtruder, onSelectExtruder, onClear, onClose,
  brushRadius, onBrushRadius, paintCounts,
  paintTool, onPaintTool, brushCursor, onBrushCursor, fillAngle, onFillAngle, axisLock, onAxisLock,
}) {
  // Every input here can be missing while the kernel side is still being wired, so each one gets a floor rather
  //  than a guard at the call site — an empty panel is a fine intermediate state, a crash is not.
  const extruderColors = Array.isArray(colors) ? colors : []
  const radius = Number.isFinite(brushRadius) ? brushRadius : 5
  const erasing = activeExtruder == null

  return (
    <div className="brush-panel" data-testid="material-paint-tools">
      <div className="bp-title">Material painting</div>
      <div className="bp-modes">
        {extruderColors.map((color, index) => (
          <button key={index}
            className={activeExtruder === index ? 'bp-chip on' : 'bp-chip'}
            style={{ background: color, color: readableInkFor(color) }}
            onClick={() => onSelectExtruder?.(index)}
            // T1 is the extruder every unpainted facet already prints with, so painting it is a legal way to take a
            //  region back from another tool — but on its own it changes nothing in the slice. Saying that on the
            //  chip is cheaper than letting a user paint T1 over a whole model and get a single-material export.
            title={index === 0
              ? 'T1 is the default extruder — painting it takes a region back from another tool (same result as the eraser)'
              : `Paint the brushed facets to print with T${index + 1}`}
            data-testid={`material-chip-${index}`}>T{index + 1}</button>
        ))}
        <button className={erasing ? 'bp-chip bp-eraser on' : 'bp-chip bp-eraser'}
          onClick={() => onSelectExtruder?.(null)}
          title="Erase — return the brushed facets to the default extruder"
          data-testid="material-eraser">erase</button>
      </div>
      <div className="bp-modes bp-actions">
        <button onClick={() => onClear?.()} data-testid="material-paint-clear"
          title="Clear every material-painted region on this object">Clear</button>
        <button onClick={() => onClose?.()} data-testid="material-paint-close"
          title="Leave painting mode (Esc)">Close</button>
      </div>
      <PaintToolRow tool={paintTool} onTool={onPaintTool} cursor={brushCursor} onCursor={onBrushCursor}
        fillAngle={fillAngle} onFillAngle={onFillAngle} axisLock={axisLock} onAxisLock={onAxisLock} />
      {!isFillTool(paintTool) && (
        <label className="bp-radius">Brush radius {radius}mm
          <input type="range" min="1" max="15" step="0.5" value={radius}
            onChange={e => onBrushRadius?.(parseFloat(e.target.value))} data-testid="material-brush-radius" />
        </label>
      )}
      <div className="muted bp-counts" data-testid="material-paint-counts">
        {extruderColors.map((_color, index) => `T${index + 1} ${paintedFacetCount(paintCounts, index)}`).join(' · ')}
        {extruderColors.length > 0 && ' · '}{isFillTool(paintTool) ? 'click the model to fill' : 'drag over the model to paint'}
      </div>
      {/* Upstream's exact per-layer segmentation (MultiMaterialSegmentation.cpp) is ported and is what runs here:
          each layer's contour is partitioned against the painted facets, so a patch keeps its outline, and a flat
          face lands in its top/bottom shell rather than in a slab. Measured on cube20: a 5mm wall patch stays
          inside its own corner (x[10.5,19.8] y[0.5,9.8]) instead of covering the layer, and a painted top face
          colours exactly top_shell_layers. The only thing left to say is the one thing the user cannot see: paint
          and support still cannot be sliced together, which the slice notice covers. */}
      <div className="bp-note" data-testid="material-paint-note">
        Painted regions follow the paint outline per layer; a painted flat face fills that surface's shell.
      </div>
    </div>
  )
}
