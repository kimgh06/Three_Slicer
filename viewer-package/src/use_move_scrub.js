import { useEffect, useState } from 'react'
import { layerMoveCount, moveCursor, topMoveLayer } from 'three-slicer-viewer'

// The move scrub — the horizontal counterpart of the layer slider, and upstream's sequential view
// (GCodeViewer's update_sequential_view_current) in this viewer's terms: the vertical slider picks WHICH layers
// are shown, this one picks how far into the TOP one the print has got. The top layer is cut at move `at` —
// extrusions and travels together, in emission order — and the nozzle marker goes where that move ended, with a
// ghost where the layer ends.
//
// FFF only, and that is not an omission: mSLA cures a whole layer in one exposure, so a resin layer has no
// intra-layer order for this bar to walk. An imported .sl1 briefly shows raster planes that an exposure ramp
// could have filled in, but the mask reconstruction replaces them with a solid mesh in a few hundred
// milliseconds (measured: 400ms on a 6-layer archive), so that mode would exist only for a state nobody sees.
// Upstream reaches the same conclusion — PrusaSlicer's SLA preview has a layer slider and no horizontal one.
//
// `at === null` means "the whole layer", which is the state everything is in until someone drags the bar.

export function useMoveScrub({ layerLo = 0, layerHi, layerCount, canvasMode, apiRef, toolpathRef, plateOffset, onEventRef }) {
  const [at, setAt] = useState(null)

  // The scrub's domain is the top layer's own move count, so a layer change invalidates the value rather than
  //  carrying it into a layer where the same number means a different point in the print.
  useEffect(() => { setAt(null) }, [layerLo, layerHi, layerCount])
  // Leaving Preview drops it too: in Prepare there is no toolpath to cut and no nozzle to place.
  useEffect(() => { if (canvasMode !== 'preview') setAt(null) }, [canvasMode])

  const control = toolpathRef?.current
  const data = control?.data
  // The scrub's own layer, not layerHi: the kernel's trailing empty layer sits at the top of the slider on
  //  every fresh slice, and pinned to it the bar would read 0 / 0 (which is exactly what it did).
  const scrubLayer = data ? topMoveLayer(data, layerLo, layerHi) : 0
  const max = data ? layerMoveCount(data, scrubLayer) : 0

  useEffect(() => {
    const api = apiRef?.current
    if (!api) return
    const ctl = toolpathRef?.current
    if (!ctl?.setMoveRange) return
    const cursor = ctl.setMoveRange(at)
    if (at == null || !cursor?.point) { api.setNozzle?.(null); return }
    // The ghost sits where this layer ends — the same cursor at the layer's last move.
    const end = moveCursor(ctl.data, cursor.layer, layerMoveCount(ctl.data, cursor.layer))
    api.setNozzle?.({ current: cursor.point, end: end?.point ?? null, ...(plateOffset || {}) })
  }, [at, layerLo, layerHi, canvasMode, control])   // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (at == null) return
    onEventRef?.current?.({ type: 'moveScrub', value: { at, max } })
  }, [at])   // eslint-disable-line react-hooks/exhaustive-deps

  // The nozzle position, for the bar's own readout — recomputed here rather than stashed in state, so it can
  //  never disagree with what the scene was told.
  const point = (at != null && data) ? moveCursor(data, scrubLayer, at).point : null

  return { at, max, point, onScrub: (v) => setAt(v == null ? null : Math.max(0, Math.min(max, v | 0))) }
}
