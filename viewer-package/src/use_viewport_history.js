import { useRef, useState } from 'react'
import { createHistory } from './core/history.js'

// Undo/redo, viewport scope. history.js holds the reasoning and the boundary; this is the React side of it:
//  the stacks live in a ref (they must survive a render without causing one), the DEPTH is state (the toolbar
//  buttons enable off it), and one function takes the direction, because a snapshot history makes undo and redo
//  identical apart from which stack is popped.
// Everything that can undo calls travel(); everything that can be undone calls record() BEFORE it mutates.

/** @param onRestore  runs after the scene is put back — restoring is a move like any other, so the caller still
 *                    has to do a move's commit work (the kernel selector's coordinates, the bed check) or the
 *                    paint overlay is left where the model used to be.
 *  @param isPreview  preview shows toolpaths; there is no object to move there, so travel is refused. */
export function useViewportHistory({ capture, onRestore, isPreview }) {
  const [depth, setDepth] = useState({ undo: 0, redo: 0 })
  const historyRef = useRef(null)
  // Read through refs: createHistory is built once, but both callbacks close over the render that built them.
  const captureRef = useRef(capture); captureRef.current = capture
  const restoreRef = useRef(onRestore); restoreRef.current = onRestore

  if (!historyRef.current) historyRef.current = createHistory({
    capture: () => captureRef.current?.() ?? [],
    restore: (snapshot) => restoreRef.current?.(snapshot),
  })

  const record = (kind) => { historyRef.current.record(kind); setDepth(historyRef.current.depth()) }
  const travel = (direction) => {
    if (isPreview()) return false
    const moved = historyRef.current.travel(direction)
    if (moved) setDepth(historyRef.current.depth())
    return moved
  }
  return { depth, record, travel }
}

/** Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z, for binding on the component's OWN root rather than on window — it is the one
 *  shortcut a host application is likely to own as well (text fields, its own editor), so it must not leak out.
 *  Matched on e.code for the same reason the other shortcuts are: a Korean layout reports 'ㅋ' for the Z key.
 *  Returns the direction to travel, or null when the event is not ours. Exported for its own test. */
export function undoRedoDirection(e) {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null
  const target = e.nativeEvent?.composedPath ? e.nativeEvent.composedPath()[0] : e.target
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return null
  const z = e.code === 'KeyZ' || e.key?.toLowerCase?.() === 'z'
  const y = e.code === 'KeyY' || e.key?.toLowerCase?.() === 'y'
  if (!z && !y) return null
  return (y || e.shiftKey) ? 'redo' : 'undo'
}
