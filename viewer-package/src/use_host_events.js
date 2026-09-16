import { useEffect, useRef } from 'react'

// The `onEvent` channel: every value this component owns but the host may want to mirror, pushed out as
// {type, value}. Effects rather than wrapped setters, because these values are written from five different
// modules (model_load, plate_actions, use_slicer, support_paint, object_actions) and one effect per value covers
// every writer at once — a wrapped setter would have to be threaded through all five and would still miss the
// sixth. The mount pass is skipped throughout: the host already knows the initial values, it passed them.

/** One value, one event type. Fires on change only. */
function useEmit(onEventRef, type, value) {
  const isMount = useRef(true)
  useEffect(() => {
    if (isMount.current) { isMount.current = false; return }
    onEventRef.current?.({ type, value })
  }, [value])   // eslint-disable-line react-hooks/exhaustive-deps
}

/** Every host notification in one place. `values` is read fresh each render; `onEventRef` is a ref so a host
 *  that swaps its callback does not need this to re-subscribe. */
export function useHostEvents(onEventRef, values) {
  useEmit(onEventRef, 'canvasMode', values.canvasMode)
  useEmit(onEventRef, 'objects', values.objects)
  useEmit(onEventRef, 'selectedPlate', values.selectedPlate)
  useEmit(onEventRef, 'plateCount', values.plateCount)
  useEmit(onEventRef, 'extruderColors', values.extruderColors)
  useEmit(onEventRef, 'autoSlice', values.autoSlice)
  useEmit(onEventRef, 'slicing', values.slicing)
  useEmit(onEventRef, 'progress', values.progress)   // fires several times a second while slicing — throttle on the host side if that matters
  useEmit(onEventRef, 'sliceRate', values.sliceRate) // same cadence, and 0 between slices
  useEmit(onEventRef, 'viewType', values.viewType)
  useEmit(onEventRef, 'paintMode', values.paintMode)
  useEmit(onEventRef, 'layerCount', values.layerCount)
  useEmit(onEventRef, 'error', values.error)
  useEmit(onEventRef, 'notice', values.notice)
  // The dual slider is two values, so it emits as one object built from PRIMITIVE deps — an object dep would be a
  //  fresh reference every render and fire on every one of them.
  const isRangeMount = useRef(true)
  useEffect(() => {
    if (isRangeMount.current) { isRangeMount.current = false; return }
    onEventRef.current?.({ type: 'layerRange', value: { lo: values.layerLo, hi: values.layerHi } })
  }, [values.layerLo, values.layerHi])   // eslint-disable-line react-hooks/exhaustive-deps
}
