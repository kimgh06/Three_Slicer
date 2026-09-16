// What the scene needs to draw a resin result as solid meshes, from a cached plate result and its plate offset.
// One place, because the focused (clipped) preview and the static previews of the other resin plates must
// agree on it — a lift read one way here and another way there is a support tree floating above its model.
export function slaPreviewPayload(r, off = {}) {
  if (!r || r.error || !r.stats?.sla) return null
  // A raster import shows as meshes once it HAS any: the scene sidecar's originals arrive with the file, a
  //  reconstruction lands seconds later. Until then, and if reconstruction failed, there is nothing solid to draw.
  if (r.slaRaster && !r.modelIndexed && !r.modelSTL) return null
  return {
    source: r,   // identity — a static preview is rebuilt only when the result object changes
    modelSTL: r.modelSTL, modelIndexed: r.modelIndexed, supportMesh: r.support_mesh, padMesh: r.pad_mesh,
    // lift_layers = pad zone + elevation (the kernel's whole-scene lift). elevation_layers alone is the pre-pad
    //  fallback for results sliced by an older kernel.
    lift: (r.stats.lift_layers ?? r.stats.elevation_layers ?? 0) * (r.stats.layer_height || 0.05),
    offX: off.offX ?? 0, offZ: off.offZ ?? 0,
  }
}
