import { splitConnectedComponents } from '../scene/model_loaders.js'
import { clonePaint } from '../core/paint_store.js'

// Object actions (duplicate/copy/paste/delete/split + gizmo mode) — bound to the object toolbar, the
//  context menu and the keyboard shortcuts.
// The component keeps owning the refs/state; this factory only receives what it uses and is rebuilt each render.
export function makeObjectActions(deps) {
  const {
    apiRef, objectsRef, clipboardRef, paintModeRef, flushPaintRef, selectorGeomRef, registerSelectorRef,
    setPaintMode, removeObject, refreshObjects, setError, setSliceNotice,
    recordHistory = () => {},
  } = deps
  // Undo entries are taken HERE rather than on the buttons: each of these runs from the keyboard, the object
  //  toolbar, the context menu and (for delete/split) the object list row, so recording per entry point would mean
  //  four calls per action and one of them eventually missing. Recorded before the mutation, and only once the
  //  action is going to happen — an empty selection returns early above, and a no-op must not cost an undo step.

  // Stage 33: instead of silently ignoring an empty selection, say why (pressing the toolbar button used to look like nothing happened).
  // A copy carries the original's paint, as upstream's does (a ModelVolume's mmu_segmentation_facets are copied
  //  with it). The paint is read from the per-object store AFTER the selector's strokes are written back to it, and
  //  every spawn gets its own Maps — painting a copy must not paint the original, or another paste of it.
  const paintOf = (id) => clonePaint(objectsRef.current.find(o => o.id === id)?.paint)
  const spawnWithPaint = (snap, paint) => {
    const added = apiRef.current?.spawnSnapshot(snap)
    const object = added && objectsRef.current.find(o => o.id === added.id)
    if (object && paint) object.paint = paint
    refreshObjects()
    // The selector holds the plate's merge; a new object changes it, so it is re-registered to include the copy —
    //  and a copy that carries paint registers one, which is also what draws that paint (support_paint.js).
    if (selectorGeomRef?.current || paint) registerSelectorRef?.current?.()
  }
  async function duplicateSelected() {
    const id = apiRef.current?.selectedObjectId()
    if (!id) { setError('Select an object to duplicate first'); return }
    // The object as it is NOW, not after the flush: the flush can take a worker round trip.
    const snap = apiRef.current?.getSnapshot(id)
    if (!snap) return
    await flushPaintRef?.current?.()
    recordHistory(); spawnWithPaint(snap, paintOf(id)); setError('')
  }
  async function copySelected() {
    const id = apiRef.current?.selectedObjectId()
    if (!id) { setError('Select an object to copy first'); return }
    const snap = apiRef.current?.getSnapshot(id)
    await flushPaintRef?.current?.()
    clipboardRef.current = snap && { ...snap, paint: paintOf(id) }; setError('')
    setSliceNotice('Object copied (paste with Ctrl+V)')
  }
  function pasteClipboard() {
    if (!clipboardRef.current) return
    recordHistory(); spawnWithPaint(clipboardRef.current, clonePaint(clipboardRef.current.paint))
  }
  function deleteSelected() {
    const id = apiRef.current?.selectedObjectId()
    if (!id) { setError('Select an object to delete first'); return }
    recordHistory(); removeObject(id); setError('')
  }
  // Stage 33: delete all (upstream Ctrl+D / Delete all). Empties every object from the scene.
  function deleteAllObjects() {
    const ids = objectsRef.current.map(o => o.id)
    if (!ids.length) return
    recordHistory()
    for (const id of ids) apiRef.current?.removeObject(id)
    refreshObjects()
    setSliceNotice(`Deleted all ${ids.length} object(s)`)
  }
  // Stage 33: split to objects (upstream Split to objects). Turns every connected component into its own object.
  //  Each component keeps the original coordinates, so it is re-aligned with the same rules as bakeLocal
  //  (centered in XZ, minY=0) before registration, letting spawnMesh's placement cursor position it properly.
  function splitSelected() {
    const id = apiRef.current?.selectedObjectId()
    if (!id) { setError('Select an object to split first'); return }
    const snap = apiRef.current?.getSnapshot(id); if (!snap) return
    let parts
    try { parts = splitConnectedComponents(snap.localPos) }
    catch (e) { setError('Split failed: ' + (e?.message || e)); return }
    if (!parts || parts.length < 2) { setError('No separate parts to split — this is a single connected mesh'); return }
    // Each component's coordinates stay in the parent's local frame. Inheriting the parent's position/rotation/scale as-is
    //  keeps the on-screen position unchanged after the split (same as the upstream Split — parts stay put).
    //  Re-aligning them and laying them out with the placement cursor would put 21 pieces in a row, off the bed (measured).
    const base = String(snap.name || 'object').replace(/\.[^.]+$/, '')
    recordHistory()
    removeObject(id)
    parts.forEach((p, i) => apiRef.current?.spawnSnapshot(
      { name: `${base}_${i + 1}`, localPos: p, rot: snap.rot, scale: snap.scale, pos: snap.pos }, true))
    refreshObjects()
    setError('')
    setSliceNotice(`Split into ${parts.length} objects`)
  }
  function setGizmo(m) { if (paintModeRef.current !== 'off') setPaintMode('off'); apiRef.current?.setMode(m) }   // leave paint mode first (same path as the toolbar)

  return { duplicateSelected, copySelected, pasteClipboard, deleteSelected, deleteAllObjects, splitSelected, setGizmo }
}
