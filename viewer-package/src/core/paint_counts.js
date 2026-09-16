// Painted facets per extruder chip (0-based), for the material brush's panel and the filament rows.
//
// The worker's per-state `counts` is the real source: measured, a T3 stroke replies {enf:0, blk:0, counts:{3:3762}},
// so reading enf/blk alone (which ARE states 1 and 2, and nothing else) pins every tool above T2 at zero. enf/blk
// stay as the fallback for the two slots they do describe, so a worker predating `counts` shows T1/T2 exactly as it
// did instead of collapsing to nothing.
export function materialPaintCounts(extruderCount, paintStateCounts, paintCounts) {
  const perState = paintStateCounts ?? {}
  const legacy = paintCounts ?? {}
  return Array.from({ length: Math.max(0, extruderCount | 0) }, (_value, extruderIndex) => {
    const count = perState[extruderIndex + 1]
    if (Number.isFinite(count)) return count
    if (extruderIndex === 0) return Number.isFinite(legacy.enf) ? legacy.enf : 0
    if (extruderIndex === 1) return Number.isFinite(legacy.blk) ? legacy.blk : 0
    return 0
  })
}
