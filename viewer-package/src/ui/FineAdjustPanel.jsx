import React, { useState } from 'react'
import { FINE_MOVE_SNAP_MM } from '../core/fine_adjust.js'

// The numbers behind the gizmo, for the mode it is in. Props in, markup out: hooks/use_fine_adjust.js does the rest.
const AXES = ['X', 'Y', 'Z']
const LARGE_STEP = 10

// Applies on Enter or on leaving the field, and Escape puts the value back. The up and down keys step right away, and
//  Shift steps ten times as far.
function NumberField({ value, step, onCommit, testId }) {
  const [draft, setDraft] = useState(null)
  const apply = () => {
    const typed = Number(draft)
    if (draft !== null && draft.trim() && Number.isFinite(typed) && typed !== value) onCommit(typed)
    setDraft(null)
  }
  const onKeyDown = (event) => {
    if (event.key === 'Enter') event.target.blur()
    else if (event.key === 'Escape') { event.stopPropagation(); setDraft(null); event.target.blur() }
    else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault()
      event.stopPropagation()
      const direction = { ArrowUp: 1, ArrowDown: -1 }[event.key]
      const size = { true: step * LARGE_STEP, false: step }[event.shiftKey]
      onCommit(Number(draft ?? value) + direction * size)
      setDraft(null)
    }
  }
  return (
    <input className="fine-number" inputMode="decimal" value={draft ?? value.toFixed(2)} data-testid={testId}
      onChange={event => setDraft(event.target.value)} onBlur={apply} onKeyDown={onKeyDown} />
  )
}

function MoveRows({ values, onMove, onHeight }) {
  return (
    <>
      {values.position.map((value, axis) => (
        <label className="fine-row" key={AXES[axis]}>{AXES[axis]}
          <NumberField value={value} step={FINE_MOVE_SNAP_MM} onCommit={next => onMove(axis, next)} testId={`fine-move-${AXES[axis]}`} /> mm
        </label>
      ))}
      {values.keepsHeight && (
        <label className="fine-row">Z
          <NumberField value={values.height} step={FINE_MOVE_SNAP_MM} onCommit={onHeight} testId="fine-move-Z" /> mm
        </label>
      )}
    </>
  )
}

function RotateRows({ values, step, setStep, onRotate, onReset }) {
  return (
    <>
      <label className="fine-row">Step
        <NumberField value={step} step={1} onCommit={setStep} testId="fine-rotate-step" /> °
      </label>
      {AXES.map((axis, index) => (
        <div className="fine-row" key={axis}>{axis}
          {values.degrees && <NumberField value={values.degrees[index]} step={1} onCommit={next => onRotate(index, next - values.degrees[index])} testId={`fine-angle-${axis}`} />}
          <button className="ctl-btn" onClick={() => onRotate(index, -step)} data-testid={`fine-rotate-${axis}-minus`}>−{step}°</button>
          <button className="ctl-btn" onClick={() => onRotate(index, step)} data-testid={`fine-rotate-${axis}-plus`}>+{step}°</button>
        </div>
      ))}
      {values.percents && <button className="bp-close" onClick={() => onReset('rotate')} data-testid="fine-reset">Reset rotation</button>}
    </>
  )
}

function ScaleRows({ values, uniform, setUniform, onResize, onReset }) {
  const { sizes, percents } = values
  return (
    <>
      {percents && <label className="tool-check"><input type="checkbox" checked={uniform} onChange={event => setUniform(event.target.checked)} data-testid="fine-uniform" /> Keep proportions</label>}
      {sizes.map((size, axis) => (
        <label className="fine-row" key={AXES[axis]}>{AXES[axis]}
          <NumberField value={size} step={FINE_MOVE_SNAP_MM} onCommit={next => onResize(axis, next)} testId={`fine-size-${AXES[axis]}`} /> mm
          {percents && <NumberField value={percents[axis]} step={1} onCommit={next => onResize(axis, size * next / percents[axis])} testId={`fine-percent-${AXES[axis]}`} />}
          {percents && ' %'}
        </label>
      ))}
      {percents && <button className="bp-close" onClick={() => onReset('scale')} data-testid="fine-reset">Reset scale</button>}
    </>
  )
}

const TITLES = { translate: 'Move', rotate: 'Rotate', scale: 'Scale' }
const ARROW_HINTS = {
  translate: 'Arrow keys move 0.1 mm, Shift 1 mm',
  rotate: 'Arrow keys turn 1°, Shift 10°. Ring drags run at a quarter speed.',
  scale: 'Up and down keys scale 1%, Shift 10%',
}

export default function FineAdjustPanel({ values, gizmoMode, uniform, setUniform, rotateStep, setRotateStep, setEditing, pinned, setPinned, onMove, onHeight, onRotate, onResize, onReset }) {
  // A field with focus keeps the panel open past the key. Focus moving on inside the panel is not the end of that.
  const onFocus = (event) => { if (event.target.matches('input.fine-number')) setEditing(true) }
  const onBlur = (event) => { if (!event.relatedTarget?.matches?.('input.fine-number')) setEditing(false) }
  return (
    <div className="brush-panel fine-panel" data-testid="fine-panel" onFocus={onFocus} onBlur={onBlur}>
      <div className="fine-title">
        <span className="bp-title">Fine adjust: {TITLES[gizmoMode]}</span>
        <button className={`ctl-btn${{ true: ' on', false: '' }[pinned]}`} aria-pressed={pinned} title="Keep fine adjust on after Alt is released"
          onClick={() => setPinned(!pinned)} data-testid="fine-hold">Hold</button>
      </div>
      {!values && <div className="tool-hint">Select an object</div>}
      {values && gizmoMode === 'translate' && <MoveRows values={values} onMove={onMove} onHeight={onHeight} />}
      {values && gizmoMode === 'rotate' && <RotateRows values={values} step={rotateStep} setStep={setRotateStep} onRotate={onRotate} onReset={onReset} />}
      {values && gizmoMode === 'scale' && <ScaleRows values={values} uniform={uniform} setUniform={setUniform} onResize={onResize} onReset={onReset} />}
      <div className="tool-hint">{ARROW_HINTS[gizmoMode]}</div>
      <div className="tool-hint">Gizmo drags snap to fine steps while this panel is open. Click a field to type.</div>
    </div>
  )
}
