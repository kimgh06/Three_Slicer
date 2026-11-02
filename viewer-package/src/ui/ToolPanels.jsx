import React from 'react'

// The floating panels of the object tools. Props in, markup out: core/ and actions/ hold what they do.
const mm = (value) => value.toFixed(2)
const AXES = ['X', 'Y', 'Z']
const NEGATIVE_SHAPES = ['box', 'cylinder', 'sphere']
const CUT_SIDES = [['both', 'Keep both'], ['upper', 'Keep upper'], ['lower', 'Keep lower']]
const DEFAULT_BAND = { from: 10, height: 0.1 }

function MeasurePanel({ tool, onClose }) {
  const { picks, result } = tool
  return (
    <div className="brush-panel" data-testid="measure-panel">
      <div className="bp-title">Measure</div>
      {!result && <div className="tool-hint">{picks === 0 && 'Click the first point on a model'}{picks === 1 && 'Click the second point'}</div>}
      {result && (
        <dl className="tool-readout">
          <dt>Distance</dt><dd data-testid="measure-distance">{mm(result.distance)} mm</dd>
          {['X', 'Y', 'Z'].map((axis, index) => <React.Fragment key={axis}><dt>{axis}</dt><dd>{mm(result.delta[index])} mm</dd></React.Fragment>)}
          <dt>Face angle</dt><dd data-testid="measure-angle">{result.angle.toFixed(1)}°</dd>
        </dl>
      )}
      <button className="bp-close" onClick={onClose} data-testid="tool-close">Close</button>
    </div>
  )
}

function TextPanel({ tool, onOption, onFont, onBed, onClose }) {
  const { text, size, depth } = tool.options
  const number = (key) => (event) => { const value = Number(event.target.value); if (value > 0) onOption(key, value) }
  return (
    <div className="brush-panel" data-testid="text-panel">
      <div className="bp-title">Text</div>
      <label className="tool-field">Text
        <input value={text} onChange={event => onOption('text', event.target.value)} data-testid="text-value" />
      </label>
      <label className="tool-field">Height (mm)
        <input type="number" min="0.5" step="0.5" value={size} onChange={number('size')} data-testid="text-size" />
      </label>
      <label className="tool-field">Depth (mm)
        <input type="number" min="0.2" step="0.2" value={depth} onChange={number('depth')} data-testid="text-depth" />
      </label>
      <label className="tool-check"><input type="checkbox" checked={tool.options.engraved} onChange={event => onOption('engraved', event.target.checked)} data-testid="text-engraved" /> Engrave into the model</label>
      <label className="tool-field">Font
        <select value={tool.options.fontId} onChange={event => onOption('fontId', event.target.value)} data-testid="text-font-choice">
          {tool.fonts.map(font => <option key={font.id} value={font.id}>{font.label}</option>)}
        </select>
      </label>
      <label className="tool-field">Upload font
        <input type="file" accept=".ttf,.otf" title="Any TrueType or OpenType file"
          onChange={event => { const file = event.target.files?.[0]; if (file) onFont(file) }} data-testid="text-font" />
      </label>
      <div className="tool-hint">Hanzi and kanji are drawn in the font picked here</div>
      {tool.notice && <div className="tool-hint" data-testid="text-notice">{tool.notice}</div>}
      {tool.problem && <div className="tool-problem" data-testid="text-problem">{tool.problem}</div>}
      <div className="tool-hint">Click a model to place the text on that surface</div>
      <button className="bp-close" onClick={onBed} data-testid="text-on-bed">Place on bed</button>
      <button className="bp-close" onClick={onClose} data-testid="tool-close">Close</button>
    </div>
  )
}

function BooleanPanel({ tool, onRun, onSwap, onClose }) {
  const { names, busy = false } = tool
  return (
    <div className="brush-panel" data-testid="boolean-panel">
      <div className="bp-title">Boolean</div>
      <div className="tool-hint">{names[0]}, then {names[1]}</div>
      <button className="bp-close" onClick={onSwap} disabled={busy} data-testid="boolean-swap">Swap order</button>
      {['union', 'difference', 'intersection'].map(operation => (
        <button key={operation} className="bp-close" disabled={busy} onClick={() => onRun(operation)} data-testid={`boolean-${operation}`}>
          {operation[0].toUpperCase() + operation.slice(1)}
        </button>
      ))}
      {busy && <div className="tool-hint">Working…</div>}
      <button className="bp-close" onClick={onClose} data-testid="tool-close">Close</button>
    </div>
  )
}

function CutPanel({ tool, onOption, onRun, onClose }) {
  const { axis, at, bounds, keep, busy = false } = tool
  return (
    <div className="brush-panel" data-testid="cut-panel">
      <div className="bp-title">Cut</div>
      <div className="bp-modes">
        {AXES.map((name, index) => {
          let className = ''
          if (axis === index) className = 'on'
          return <button key={name} className={className} onClick={() => onOption('axis', index)} data-testid={`cut-axis-${name}`}>{name}</button>
        })}
      </div>
      <label className="tool-field">Position (mm)
        <input type="number" step="0.1" value={Number(at.toFixed(2))} min={bounds.min[axis]} max={bounds.max[axis]}
          onChange={event => onOption('at', Number(event.target.value))} data-testid="cut-at" />
      </label>
      <input type="range" min={bounds.min[axis]} max={bounds.max[axis]} step="0.1" value={at} onChange={event => onOption('at', Number(event.target.value))} />
      <label className="tool-field">Keep
        <select value={keep} onChange={event => onOption('keep', event.target.value)} data-testid="cut-keep">
          {CUT_SIDES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      <button className="bp-close" onClick={onRun} disabled={busy} data-testid="cut-run">{busy && 'Working…'}{!busy && 'Cut'}</button>
      <button className="bp-close" onClick={onClose} data-testid="tool-close">Close</button>
    </div>
  )
}

function NegativePanel({ tool, onOption, onAdd, onToggle, onHeight, onClose }) {
  const { shape, size } = tool
  return (
    <div className="brush-panel" data-testid="negative-panel">
      <div className="bp-title">Negative part</div>
      <div className="tool-hint">Red parts cut away what they overlap when you slice or export</div>
      <label className="tool-field">Shape
        <select value={shape} onChange={event => onOption('shape', event.target.value)} data-testid="negative-shape">
          {NEGATIVE_SHAPES.map(name => <option key={name} value={name}>{name}</option>)}
        </select>
      </label>
      <label className="tool-field">Size (mm)
        <input type="number" min="1" step="1" value={size} onChange={event => { const value = Number(event.target.value); if (value > 0) onOption('size', value) }} data-testid="negative-size" />
      </label>
      <button className="bp-close" onClick={onAdd} data-testid="negative-add">Add to plate</button>
      <button className="bp-close" onClick={onToggle} data-testid="negative-toggle">Toggle negative on selection</button>
      <label className="tool-field">Height above bed (mm)
        <input type="number" min="0" step="0.5" defaultValue={0} onChange={event => onHeight(Number(event.target.value))} data-testid="negative-height" />
      </label>
      <button className="bp-close" onClick={onClose} data-testid="tool-close">Close</button>
    </div>
  )
}

function LayerBandsPanel({ bands, onBands, onClose }) {
  const edit = (index, key) => (event) => {
    const value = Number(event.target.value)
    if (!(value >= 0)) return
    onBands(bands.map((band, at) => { if (at === index) return { ...band, [key]: value }; return band }))
  }
  return (
    <div className="brush-panel" data-testid="layers-panel">
      <div className="bp-title">Variable layers</div>
      <div className="tool-hint">Each height applies from its Z upward. Below the first band the plate's layer height applies</div>
      {bands.map((band, index) => (
        <div className="tool-band-row" key={index}>
          <label>From Z <input type="number" min="0" step="0.5" value={band.from} onChange={edit(index, 'from')} data-testid={`layers-from-${index}`} /></label>
          <label>Height <input type="number" min="0.04" step="0.02" value={band.height} onChange={edit(index, 'height')} data-testid={`layers-height-${index}`} /></label>
          <button className="bp-remove" onClick={() => onBands(bands.filter((_band, at) => at !== index))} title="Remove this band">×</button>
        </div>
      ))}
      <button className="bp-close" onClick={() => onBands([...bands, { ...DEFAULT_BAND }])} data-testid="layers-add">Add band</button>
      <div className="tool-hint">Works without support, raft, spiral mode and several filaments</div>
      <button className="bp-close" onClick={onClose} data-testid="tool-close">Close</button>
    </div>
  )
}

// The open tool's panel. `tools` is actions/object_tools.js.
export function ToolPanel({ tool, tools, bands }) {
  const onClose = tools.closeTool
  if (tool?.kind === 'measure') return <MeasurePanel tool={tool} onClose={onClose} />
  if (tool?.kind === 'text') return <TextPanel tool={tool} onOption={tools.setTextOption} onFont={tools.loadFont} onBed={tools.placeTextOnBed} onClose={onClose} />
  if (tool?.kind === 'boolean') return <BooleanPanel tool={tool} onRun={tools.runBoolean} onSwap={tools.swapBoolean} onClose={onClose} />
  if (tool?.kind === 'cut') return <CutPanel tool={tool} onOption={tools.setCutOption} onRun={tools.runCut} onClose={onClose} />
  if (tool?.kind === 'negative') return <NegativePanel tool={tool} onOption={tools.setNegativeOption} onAdd={tools.addNegative} onToggle={tools.toggleNegative} onHeight={tools.setNegativeHeight} onClose={onClose} />
  if (tool?.kind === 'layers') return <LayerBandsPanel bands={bands} onBands={tools.setLayerBands} onClose={onClose} />
  return null
}
