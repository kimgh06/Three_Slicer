import { useRef } from 'react'

// The slicer that never slices — what <Viewport/> runs on when no kernel is attached (the permissive package
// on its own). It hands back exactly the shape useSlicer does, so every consumer keeps working without a
// guard: the refs start at the real hook's initial values, getWorker() returns a worker that swallows
// messages rather than null (support_paint posts to it unguarded), and runSlice REJECTS the way a failed
// kernel slice does — plate_actions handles failure in its catch, and a resolved empty result would be stored
// and announced as a successful slice. Nothing here throws; nothing here downloads a kernel.
const DEAD_WORKER = Object.freeze({
  postMessage() {}, addEventListener() {}, removeEventListener() {}, terminate() {},
})
const NO_SLICER = 'No slicer is attached to this viewer'

export function useNoopSlicer() {
  const pendingSliceRef = useRef(null)
  const downgradeRef = useRef(false)
  const kernelKindRef = useRef(null)
  const progressSinkRef = useRef(null)
  return {
    getWorker: () => DEAD_WORKER,
    cancelSlice: () => {},
    runSlice: async () => { throw new Error(NO_SLICER) },
    pendingSliceRef, downgradeRef,
    createPoolContext: () => ({ cancel() {}, terminate() {} }),
    kernelKindRef, progressSinkRef,
  }
}
