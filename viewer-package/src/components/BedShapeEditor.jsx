// Custom editor dedicated to printable_area — the web equivalent of the upstream BedShapeDialog (Rectangular/Circular/Custom).
// Whatever the mode, the output is always a vertex array (coPoints), so everything downstream (engine bed derivation, plate rendering) is unchanged.
//  · Rectangular: width x depth + origin (equivalent to rect_size/rect_origin)
//  · Circular: diameter -> 32-gon approximation (as in the upstream BedShapePanel)
//  · Custom: enter the coordinate JSON directly
import React, { useEffect, useState } from 'react'
import { leanSchema } from 'three-slicer-viewer/data'

const rectPts = (w, d, ox, oy) => [[ox, oy], [w + ox, oy], [w + ox, d + oy], [ox, d + oy]]
// The schema's own printable_area default — the bed shown when the value is missing or not a point list.
const DEFAULT_PTS = leanSchema.printable_area.default
const circlePts = (dia) => {
  const r = dia / 2, n = 32
  return Array.from({ length: n }, (_, i) => {
    const a = 2 * Math.PI * i / n
    return [+(r + r * Math.cos(a)).toFixed(2), +(r + r * Math.sin(a)).toFixed(2)]
  })
}
const bbox = (pts) => {
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1])
  return { x0: Math.min(...xs), y0: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), d: Math.max(...ys) - Math.min(...ys) }
}

export default function BedShapeEditor({ value, onChange, disabled }) {
  const pts = Array.isArray(value) && value.length >= 3 ? value : DEFAULT_PTS
  const b = bbox(pts)
  const [mode, setMode] = useState(pts.length === 4 ? 'rect' : pts.length >= 12 ? 'circle' : 'custom')
  const [rect, setRect] = useState({ w: b.w, d: b.d, ox: b.x0, oy: b.y0 })
  const [dia, setDia] = useState(Math.round(b.w))
  const [json, setJson] = useState(JSON.stringify(pts))
  const [jsonErr, setJsonErr] = useState(false)
  // Sync with external resets (value deleted -> back to the default)
  useEffect(() => {
    const nb = bbox(pts)
    setRect({ w: nb.w, d: nb.d, ox: nb.x0, oy: nb.y0 }); setDia(Math.round(nb.w)); setJson(JSON.stringify(pts)); setJsonErr(false)
  }, [JSON.stringify(value)])  // eslint-disable-line react-hooks/exhaustive-deps

  const commitRect = (next) => { setRect(next); const { w, d, ox, oy } = next; if (w > 0 && d > 0) onChange(rectPts(w, d, ox, oy)) }
  const commitDia = (v) => { setDia(v); if (v > 0) onChange(circlePts(v)) }
  const commitJson = (t) => {
    setJson(t)
    try {
      const p = JSON.parse(t)
      if (!Array.isArray(p) || p.length < 3 || !p.every(q => Array.isArray(q) && q.length === 2 && q.every(Number.isFinite))) throw 0
      setJsonErr(false); onChange(p)
    } catch { setJsonErr(true) }
  }
  const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0 }

  return (
    <div className="bse" data-testid="bed-shape-editor">
      <div className="bse-modes">
        {[['rect', 'Rectangular'], ['circle', 'Circular'], ['custom', 'Custom']].map(([k, l]) => (
          <button key={k} type="button" className={mode === k ? 'on' : ''} disabled={disabled} onClick={() => setMode(k)}>{l}</button>
        ))}
      </div>
      {mode === 'rect' && (
        <div className="bse-grid">
          <label>Width <input type="number" min="1" value={rect.w} disabled={disabled} data-testid="bed-w"
            onChange={e => commitRect({ ...rect, w: num(e.target.value) })} /> mm</label>
          <label>Depth <input type="number" min="1" value={rect.d} disabled={disabled} data-testid="bed-d"
            onChange={e => commitRect({ ...rect, d: num(e.target.value) })} /> mm</label>
          <label>Origin X <input type="number" value={rect.ox} disabled={disabled}
            onChange={e => commitRect({ ...rect, ox: num(e.target.value) })} /></label>
          <label>Origin Y <input type="number" value={rect.oy} disabled={disabled}
            onChange={e => commitRect({ ...rect, oy: num(e.target.value) })} /></label>
        </div>
      )}
      {mode === 'circle' && (
        <div className="bse-grid">
          <label>Diameter <input type="number" min="1" value={dia} disabled={disabled} data-testid="bed-dia"
            onChange={e => commitDia(num(e.target.value))} /> mm</label>
        </div>
      )}
      {mode === 'custom' && (
        <textarea className={'bse-json' + (jsonErr ? ' err' : '')} rows={3} value={json} disabled={disabled}
          data-testid="bed-json" onChange={e => commitJson(e.target.value)} placeholder={JSON.stringify(DEFAULT_PTS)} />
      )}
    </div>
  )
}
