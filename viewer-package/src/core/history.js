// Undo/redo for the viewport's OWN state: object transforms, additions, removals, per-object extruder and
// visibility. Not settings — `settings`/`setSettings` are props the host owns (Viewport.jsx), so the boundary is
// drawn by the component's interface and nothing here can reach across it. Painting, the prime tower and the plate
// count are deliberately outside it too: paint restore needs a kernel `prepare` per step, and the other two write
// host settings.
//
// Snapshots, not inverse operations. A snapshot is the whole object list, and the geometry inside it is shared BY
// REFERENCE (`localPos` is immutable — the same property `getSnapshot` already relies on), so an entry costs a few
// hundred bytes per object instead of a copy of the mesh. That buys the property this file is built around: undo
// and redo become the same operation with the two stacks swapped, so there is ONE function and no per-action
// inverse to write and then forget to write. A new scene feature becomes undoable by calling record() at its
// commit point and nothing else.
//
// The same action reaches the scene from up to four places (keyboard, object toolbar, context menu, object list
// row), which is why record() belongs at the action layer and not on the buttons: one call per action covers every
// entry point, and there is no fourth place left to miss.

export function createHistory({ capture, restore, limit = 50, coalesceMs = 500, now = Date.now } = {}) {
  const past = [], future = []
  let lastKind = null, lastAt = 0

  return {
    /** Call immediately BEFORE a scene mutation — what is stored is the state to come back to.
     *  Capturing after the fact instead would need a "current snapshot" mirror kept in step with every path that
     *  can change the scene, and the first path that forgot would make undo restore a state that never existed.
     *  `kind` only drives coalescing: repeats of the same kind inside the window fold into the first one, so a
     *  held arrow key is one undo rather than forty. */
    record(kind = null) {
      const at = now()
      const repeat = kind != null && kind === lastKind && at - lastAt < coalesceMs && past.length > 0
      lastKind = kind; lastAt = at
      if (repeat) return
      past.push(capture())
      if (past.length > limit) past.shift()
      future.length = 0                       // a fresh action abandons the redo branch
    },

    /** The whole of undo and redo: pop one side, push where we are onto the other. `direction` is 'undo'|'redo'. */
    travel(direction) {
      const from = direction === 'undo' ? past : future
      const to   = direction === 'undo' ? future : past
      if (!from.length) return false
      to.push(capture())                      // where we are now is the return ticket
      restore(from.pop())
      lastKind = null                         // never coalesce across a travel
      return true
    },

    can: (direction) => (direction === 'undo' ? past : future).length > 0,
    depth: () => ({ undo: past.length, redo: future.length }),
    clear() { past.length = 0; future.length = 0; lastKind = null },
  }
}
