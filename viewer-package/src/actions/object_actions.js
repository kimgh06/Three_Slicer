import { splitComponentFacets, facetPositions } from '../scene/model_loaders.js'
import { clonePaint, splitPaintByParts } from '../core/paint_store.js'

// A delete in flight per component (keyed by its objectsRef, which lives as long as the component): a delete waits
//  for the paint write-back before it records history, so a double press or key repeat used to start a second one
//  meanwhile and record a second undo entry for the same state.
const deleting = new WeakSet()

// Object actions (duplicate/copy/paste/delete/split + gizmo mode) — bound to the object toolbar, the
//  context menu and the keyboard shortcuts.
// The component keeps owning the refs/state; this factory only receives what it uses and is rebuilt each render.
export function makeObjectActions(deps) {
  const {
    apiRef, objectsRef, clipboardRef, paintModeRef, flushPaintRef, selectorGeomRef, registerSelectorRef,
    setPaintMode, removeObject, refreshObjects, setError, setSliceNotice, clearError,
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
    recordHistory(); spawnWithPaint(snap, paintOf(id)); clearError()
  }
  // The copy waits for the paint write-back before it fills the clipboard, so a paste pressed meanwhile waits for
  //  the copy (`clipboardRef.copying`) — it used to paste the previous clipboard, or nothing after a first copy.
  function copySelected() {
    const id = apiRef.current?.selectedObjectId()
    if (!id) { setError('Select an object to copy first'); return }
    const snap = apiRef.current?.getSnapshot(id)
    const copying = Promise.resolve(flushPaintRef?.current?.()).then(() => {
      clipboardRef.current = snap && { ...snap, paint: paintOf(id) }; clearError()
      setSliceNotice('Object copied (paste with Ctrl+V)')
    })
    clipboardRef.copying = copying
    return copying
  }
  async function pasteClipboard() {
    await clipboardRef.copying
    if (!clipboardRef.current) return
    recordHistory(); spawnWithPaint(clipboardRef.current, clonePaint(clipboardRef.current.paint))
  }
  // One delete at a time (see `deleting` above): the flush first, then one undo entry, then the removal.
  async function deleteOnce(remove) {
    if (deleting.has(objectsRef)) return
    deleting.add(objectsRef)
    try {
      await flushPaintRef?.current?.()
      recordHistory(); remove()
    } finally { deleting.delete(objectsRef) }
  }
  // Deleting flushes first so the undo snapshot carries the object's latest paint (history.js restores a deleted
  //  object with the paint it had; the store is the only place a plate's paint lives once the selector moves on).
  function deleteSelected() {
    const id = apiRef.current?.selectedObjectId()
    if (!id) { setError('Select an object to delete first'); return }
    return deleteOnce(() => { removeObject(id); clearError() })
  }
  // The object list's row button: the same guard, for a given id.
  function deleteObject(id) { return deleteOnce(() => removeObject(id)) }
  // Stage 33: delete all (upstream Ctrl+D / Delete all). Empties every object from the scene.
  function deleteAllObjects() {
    if (!objectsRef.current.length) return
    return deleteOnce(() => {
      const ids = objectsRef.current.map(o => o.id)
      for (const id of ids) apiRef.current?.removeObject(id)
      refreshObjects()
      setSliceNotice(`Deleted all ${ids.length} object(s)`)
    })
  }
  // Stage 33: split to objects (upstream Split to objects). Turns every connected component into its own object.
  //  Each component keeps the original coordinates, so it is re-aligned with the same rules as bakeLocal
  //  (centered in XZ, minY=0) before registration, letting spawnMesh's placement cursor position it properly.
  //  The parent's paint follows its facets onto the parts (upstream splits a volume's facet annotations the same
  //  way), read from the store after the selector's strokes are written back.
  async function splitSelected() {
    const id = apiRef.current?.selectedObjectId()
    if (!id) { setError('Select an object to split first'); return }
    const snap = apiRef.current?.getSnapshot(id); if (!snap) return
    let partFacets
    try { partFacets = splitComponentFacets(snap.localPos) }
    catch (e) { setError('Split failed: ' + (e?.message || e)); return }
    if (!partFacets || partFacets.length < 2) { setError('No separate parts to split — this is a single connected mesh'); return }
    const parts = partFacets.map(faces => facetPositions(snap.localPos, faces))
    await flushPaintRef?.current?.()
    const partPaint = splitPaintByParts(objectsRef.current.find(o => o.id === id)?.paint, partFacets)
    // Each component's coordinates stay in the parent's local frame. Inheriting the parent's position/rotation/scale as-is
    //  keeps the on-screen position unchanged after the split (same as the upstream Split — parts stay put).
    //  Re-aligning them and laying them out with the placement cursor would put 21 pieces in a row, off the bed (measured).
    const base = String(snap.name || 'object').replace(/\.[^.]+$/, '')
    recordHistory()
    removeObject(id)
    parts.forEach((p, i) => {
      const added = apiRef.current?.spawnSnapshot(
        { name: `${base}_${i + 1}`, localPos: p, rot: snap.rot, scale: snap.scale, pos: snap.pos }, true)
      const object = added && objectsRef.current.find(o => o.id === added.id)
      if (object && partPaint[i]) object.paint = partPaint[i]
    })
    refreshObjects()
    if (selectorGeomRef?.current || partPaint.some(Boolean)) registerSelectorRef?.current?.()
    clearError()
    setSliceNotice(`Split into ${parts.length} objects`)
  }
  function setGizmo(m) { if (paintModeRef.current !== 'off') setPaintMode('off'); apiRef.current?.setMode(m) }   // leave paint mode first (same path as the toolbar)

  return { duplicateSelected, copySelected, pasteClipboard, deleteSelected, deleteObject, deleteAllObjects, splitSelected, setGizmo }
}
