// The per-tool filament breakdown, folded onto the reduced stats the card renders.
//
// `filament_mm_by_tool` / `filament_mm_purge` / `filament_mm_purge_by_tool` are kernel stats of the focused plate's
// cached result (the names wasm-core/tests/test.mjs asserts). The `stats` state was reduced in use_slicer/plate_actions
// before those fields existed, so they are picked up from the raw result here instead of reshaping that reduction.
// A kernel that reports none of them leaves all three undefined, and StatsCard then renders exactly the single
// Filament line it always has.
export function withToolBreakdown(stats, kernelStats) {
  if (!stats) return stats
  return {
    ...stats,
    filamentPerTool: Array.isArray(kernelStats?.filament_mm_by_tool) ? kernelStats.filament_mm_by_tool : undefined,
    filamentPurge: Number.isFinite(kernelStats?.filament_mm_purge) ? kernelStats.filament_mm_purge : undefined,
    filamentPurgePerTool: Array.isArray(kernelStats?.filament_mm_purge_by_tool) ? kernelStats.filament_mm_purge_by_tool : undefined,
  }
}
