// The kernel's stats reply -> the shape the viewer keeps (and the names wasm-core/tests/test.mjs asserts).
// Pure, so it lives here rather than beside the worker that produces it: plate_actions consumes it and
// must not reach into the slicing module for a formatter.
// The kernel's stats object, reduced to what the UI reads. One place, because the per-plate path shows the same
//  card from the same fields and the two mappings had already started to drift.
//  overBedBy is measured by the kernel on the EMITTED extrusions, so it includes support, skirt, brim and the raft —
//  none of which exist yet when the viewer runs its own pre-slice bed check against the model's bounding box.
// `throughput` is the one field that does NOT come from the kernel's stats object — it is measured around the
//  call and sits beside them on the result, so it has to be handed in rather than read out of `s`.
export function statsFromKernel(s, throughput = null) {
  return {
    layers: s.layers, segments: s.path_segments, filament: s.filament_mm, timeSec: s.time_estimate,
    engine: s.time_engine, limits: s.machine_limits, throughput,
    overBedBy: { x: s.over_bed_x ?? 0, y: s.over_bed_y ?? 0, z: s.over_bed_z ?? 0 },
    // true = the model itself is off the bed, not just what was printed around it. slice_sla reports only
    //  `over_bed`, which IS the model verdict (prepare_model, before supports exist) — reading the absent
    //  over_bed_model as false there mislabelled a mispositioned model as "support/skirt/brim".
    overBedModel: s.sla ? true : !!s.over_bed_model,
    // A resin slice's own figures ride along; the card switches its filament line on `sla`.
    ...(s.sla ? { sla: true, resinMl: s.resin_ml ?? 0 } : {}),
  }
}
