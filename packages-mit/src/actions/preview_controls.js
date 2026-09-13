// The preview card's controls: the dual layer slider, single-layer mode, the view type and the travel toggle.
//  Rebuilt each render like the other factories, so `layerCount` and `singleLayer` are the render's own.
export function makePreviewControls(deps) {
  const {
    layerCount, singleLayer, setSingleLayer, setViewType, setShowTravel, applyLayerRange, applyViewColors,
    setLayerLo, setLayerHi, layerLoRef, layerHiRef, layersDataRef, plateResultsRef, selectedPlateRef, plateTpRef, apiRef,
  } = deps

  // Stage 25 S6: dual slider (lo/hi) — in single-layer mode both thumbs move together.
  function setRange(lo, hi) {
    const max = Math.max(0, layerCount - 1)
    lo = Math.max(0, Math.min(max, lo)); hi = Math.max(0, Math.min(max, hi))
    if (lo > hi) { const t = lo; lo = hi; hi = t }
    setLayerLo(lo); setLayerHi(hi); applyLayerRange()
    // A resin preview is solid meshes, so the slider becomes a section cut: clip below the lower layer's
    //  bottom and above the upper layer's top. Fully-open ends pass null (no plane on that side).
    const L = layersDataRef.current
    const slaRes = plateResultsRef.current[selectedPlateRef.current]
    if (L && slaRes?.stats?.sla) {
      // Until an imported SL1's mesh is reconstructed, the slider shows ONE mask (the upper thumb) instead of
      //  a section cut; once r.modelIndexed exists the solid path's clipping takes over like any sliced result.
      if (slaRes.slaRaster && !slaRes.modelIndexed && !slaRes.modelSTL) apiRef.current?.setSlaRasterLayer?.(hi)
      else apiRef.current?.setSlaClip?.(lo <= 0 ? null : (L[lo - 1]?.z ?? null),
                                        hi >= L.length - 1 ? null : (L[hi]?.z ?? null))
    }
  }
  function onLo(e) { const v = parseInt(e.target.value, 10); if (singleLayer) setRange(v, v); else setRange(v, layerHiRef.current) }
  function onHi(e) { const v = parseInt(e.target.value, 10); if (singleLayer) setRange(v, v); else setRange(layerLoRef.current, v) }
  function toggleSingle() {
    const next = !singleLayer; setSingleLayer(next)
    if (next) setRange(layerHiRef.current, layerHiRef.current)   // single layer = the upper-bound layer only
  }
  function onViewType(e) { setViewType(e.target.value); applyViewColors() }
  function onToggleTravel(e) { const v = e.target.checked; setShowTravel(v); for (const p of Object.values(plateTpRef.current)) p.ctl.setTravelVisible(v) }

  return { setRange, onLo, onHi, toggleSingle, onViewType, onToggleTravel }
}
