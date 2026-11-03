import { useEffect, useState } from 'react'
import { arrowEdit, DEFAULT_ROTATE_STEP_DEGREES } from '../core/fine_adjust.js'

const REFRESH_MS = 150   // the panel's numbers follow gizmo drags and undo, which report nothing to React

// Fine adjust lasts while Alt (Option on a Mac) is held, or until the panel's Hold button is released. A field that takes
//  focus keeps the panel open after the key is up too, because typing cannot be done with Alt held: Option changes what
//  the digits type.
export function useFineAdjust({ apiRef, selectedPlateRef, gizmoMode, available }) {
  const [held, setHeld] = useState(false)
  const [editing, setEditing] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [rotateStep, setRotateStep] = useState(DEFAULT_ROTATE_STEP_DEGREES)
  const [values, setValues] = useState(null)
  const [uniform, setUniform] = useState(true)
  const open = (held || editing || pinned) && available
  const fine = () => apiRef.current?.fine
  const origin = () => apiRef.current?.platePos(selectedPlateRef.current)
  const refresh = () => {
    const next = fine()?.read(origin()) ?? null
    setValues(current => {
      if (JSON.stringify(current) === JSON.stringify(next)) return current
      return next
    })
  }

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Alt' && !event.ctrlKey && !event.metaKey) setHeld(true)
    }
    // Windows moves focus to the browser's menu on a bare Alt release.
    const onKeyUp = (event) => {
      if (event.key !== 'Alt') return
      event.preventDefault()
      setHeld(false)
    }
    // Alt+Tab leaves with the key down, and its release goes to the other window.
    const onBlur = () => setHeld(false)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  useEffect(() => {
    fine()?.setSnap(open)
    if (!open) return undefined
    refresh()
    const timer = setInterval(refresh, REFRESH_MS)
    return () => { clearInterval(timer); fine()?.setSnap(false) }
  }, [open])   // eslint-disable-line react-hooks/exhaustive-deps

  const edit = (run) => (...args) => { run(...args); refresh() }
  // The arrow keys follow the gizmo's mode, in fine steps while the mode is on. False leaves the key to the plain nudge:
  //  a brush or tool is open, or the prime tower is selected, whose place is a setting.
  const onArrow = (right, down, shift) => {
    const current = available ? fine()?.read(origin()) : null
    if (!current) return false
    const change = arrowEdit(gizmoMode, right, down, shift, open)
    if (!change) return true
    if (change.kind === 'move') change.deltas.forEach((delta, axis) => { if (delta) fine().move(axis, current.position[axis] + delta, origin()) })
    if (change.kind === 'rotate') fine().rotate(change.axis, change.degrees)
    if (change.kind === 'scale') fine().resize(0, current.sizes[0] * change.ratio, true)
    refresh()
    return true
  }
  return {
    open, values, gizmoMode, uniform, setUniform, onArrow,
    onMove: edit((axis, value) => fine()?.move(axis, value, origin())),
    onHeight: edit(value => fine()?.setHeight(value)),
    onRotate: edit((axis, degrees) => fine()?.rotate(axis, degrees)),
    onResize: edit((axis, size) => fine()?.resize(axis, size, uniform)),
    onReset: edit(kind => fine()?.reset(kind)),
    rotateStep, setRotateStep, setEditing, pinned, setPinned,
  }
}
