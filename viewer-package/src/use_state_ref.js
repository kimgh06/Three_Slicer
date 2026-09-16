import { useCallback, useRef, useState } from 'react'

// A value that React renders AND callbacks read synchronously.
//
// Half this component's state needs both: the scene installs its pointer/key handlers once, so they cannot read
// state (they would capture the first render's value), while the panels have to re-render when it changes. The
// long-standing answer was a state/ref pair written by hand at every call site — `setViewType(v); viewTypeRef.current = v` —
// which is correct exactly as long as nobody adds a fourteenth call site and writes only one of the two.
//
// So the setter writes the ref FIRST and then the state, which is the same order and the same timing the manual
// pairs already had. The ref is handed back as well, because it is what the other modules are given.
//
// Deliberately NOT an external store (useSyncExternalStore): several of these refs are written from OUTSIDE
// React by design — `setPlates` writes plateCountRef/selectedPlateRef synchronously so plate origins are computed
// against the new grid before the state lands, and support_paint writes paintModeRef. Under a subscribing store
// those imperative writes would each schedule a render. Here they stay plain ref writes and nothing changes.
export function useStateRef(initial) {
  const [value, setValue] = useState(initial)
  const ref = useRef(value)
  const set = useCallback((next) => {
    ref.current = typeof next === 'function' ? next(ref.current) : next
    setValue(ref.current)
  }, [])
  return [value, set, ref]
}
