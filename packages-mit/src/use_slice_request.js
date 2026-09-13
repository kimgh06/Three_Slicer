import { useEffect, useRef } from 'react'

// A slice asked for while one is running cancels it and asks again until the kernel is free, so the LAST request
//  wins. Both ways of asking — the host's sliceRequest prop and the auto re-slice — go through here.
const SLICE_RETRY_MS = 300
// The auto re-slice waits this long after the last settings or model change.
const AUTO_SLICE_DEBOUNCE_MS = 800

// Ours to slice: a scene with objects and no injected plate. An injected plate (G-code or .sl1) is not ours to
//  overwrite, and an empty scene has nothing to slice — both are silently a no-op, matching how the slice bar simply
//  is not pressable then.
const sliceable = (objectCount, gcode, sl1) => objectCount > 0 && gcode == null && sl1 == null

function sliceWhenIdle({ pendingSliceRef, cancelSlice, onSlice, autoTimerRef }) {
  const fire = () => {
    if (pendingSliceRef.current) { cancelSlice(); autoTimerRef.current = setTimeout(fire, SLICE_RETRY_MS); return }
    onSlice('current')
  }
  return fire
}

// The sliceRequest prop: an identity CHANGE requests one slice of the current plate. The ref holds the
//  last seen token so the mount value is inert (a host keeping 0 in state slices nothing until it bumps).
export function useSliceRequest({ sliceRequest, objectCount, gcode, sl1, pendingSliceRef, cancelSlice, onSlice, autoTimerRef }) {
  const seenRef = useRef(sliceRequest)
  useEffect(() => {
    if (sliceRequest === seenRef.current) return
    seenRef.current = sliceRequest
    if (sliceRequest == null || !sliceable(objectCount, gcode, sl1)) return
    sliceWhenIdle({ pendingSliceRef, cancelSlice, onSlice, autoTimerRef })()
  }, [sliceRequest])   // eslint-disable-line react-hooks/exhaustive-deps
}

// G004: auto re-slice — debounced after a settings or model change, for the current plate.
//  If a slice is running it is canceled (G002) and the re-slice waits for it to finish. Thanks to incremental slicing
//  (G003) it usually just re-runs emit (~1s).
//  The first slice used to stay manual (it required a cached plate result). That gate is gone because it made
//  autoSlice unusable without the slice bar: a host that hides the panels has no other way to start one, so
//  "auto" that cannot perform the first slice is just off. Turning it on with a model loaded now slices.
//  The injected-plate guard matters more for .sl1 than it looks: its import writes the archive's own settings through
//  setSettings, which is exactly what wakes this debounce — without the guard the injection would trigger the slice
//  that erases it.
export function useAutoSlice({ autoSlice, settings, plateSettings, objectCount, gcode, sl1, pendingSliceRef, cancelSlice, onSlice, autoTimerRef }) {
  useEffect(() => {
    if (!autoSlice || !sliceable(objectCount, gcode, sl1)) return
    clearTimeout(autoTimerRef.current)
    autoTimerRef.current = setTimeout(sliceWhenIdle({ pendingSliceRef, cancelSlice, onSlice, autoTimerRef }), AUTO_SLICE_DEBOUNCE_MS)
    return () => clearTimeout(autoTimerRef.current)
  }, [settings, plateSettings, autoSlice, objectCount])   // eslint-disable-line react-hooks/exhaustive-deps
}
