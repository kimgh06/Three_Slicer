// Where the prime tower stands, per plate — the same rules the slicer applies, so the drawn stand-in and the
//  sliced tower are the same tower. Pure arithmetic on settings + the plate's model bounds, kept out of the
//  component because "the box shows where it will actually print" is a claim only an assertion can hold up.

/**
 * Will this plate actually change tools — the question the tower exists to answer.
 *
 * Loading a second filament is not it. A prime tower purges the nozzle ACROSS a tool change, so with two filaments
 * loaded and everything printing on T1 the slice never emits a `T` command and never builds a tower — but the
 * stand-in used to draw for the whole session anyway, a green box beside a model that would print without it.
 *
 * The two conditions are the ones `buildParams` raises `extruder_count` on (use_slicer.js), which is in turn what
 * the kernel gates its multi-tool path on: whole-object assignment to more than one extruder, or material paint
 * reaching extruder 2 or higher. Selector state 1 is the default tool (ENFORCER == Extruder1), so painting in
 * state 1 alone switches nothing.
 *
 * `support_filament` is deliberately not a third condition: on its own it does not raise `extruder_count`, so the
 * kernel emits no tool change for it either, and a box drawn for it would promise a tower the slice will not build.
 *
 * @param objects the object list as the component holds it (`{extruder, visible}`)
 * @param paintStateCounts painted facet count per selector state, as the paint brush reports it
 */
export function usesMultipleTools(objects, paintStateCounts) {
  const assigned = new Set((objects ?? []).filter(o => o?.visible !== false).map(o => Number(o?.extruder) || 1))
  if (assigned.size > 1) return true
  return Object.entries(paintStateCounts ?? {})
    .some(([state, facets]) => facets > 0 && Number(state) >= 2)
}

/** Read a per-plate tower coordinate out of the settings map. `wipe_tower_x`/`_y` are upstream's per-plate
 *  ARRAYS, so each plate reads its own entry — a hole (null) means auto for that plate only. A legacy scalar
 *  still applies to every plate alike. NaN means "not chosen", which is what turns on auto placement. */
export function chosenTowerCoord(settings, key, plate) {
  const raw = settings?.[key]
  const value = Array.isArray(raw) ? raw[plate] : raw
  const asNumber = Number(value)
  return (value != null && value !== '' && Number.isFinite(asNumber)) ? asNumber : NaN
}

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi)
const AUTO_GAP = 5   // mm between the model and an auto-placed tower

/** One box per plate that gets a tower, in the bed-centred world coordinates the objects use.
 *  Every plate slices with its own tower (the kernel is per-plate), so every plate with objects gets one.
 *  An empty plate gets none: the kernel has nothing to slice there, so a box would promise a tower that
 *  never prints.
 *  `modelBounds(plate)` and `plateOrigin(plate)` are the scene's; everything else is arithmetic.
 *  Returns null when there is no tower at all, which is what the scene takes as "remove them". */
export function towerBoxes({ plateCount, size, bedWidth, bedDepth, bedOf, settings, modelBounds, plateOrigin }) {
  const boxes = []
  for (let plate = 0; plate < plateCount; plate++) {
    const box = modelBounds(plate)
    if (!box) continue
    // Each plate is clamped to ITS bed (`bedOf(plate)`, the plate context); the scalars remain for a uniform caller.
    const { w: bedW = bedWidth, d: bedD = bedDepth } = bedOf?.(plate) ?? {}
    const setX = chosenTowerCoord(settings, 'wipe_tower_x', plate)
    const setY = chosenTowerCoord(settings, 'wipe_tower_y', plate)
    const auto = !Number.isFinite(setX)
    // The box is drawn in world coordinates and a bed coordinate is plate-local, so the plate's own origin is
    //  the one conversion between them — the same origin the slice frame subtracts.
    const origin = plateOrigin(plate) ?? { x: 0, z: 0 }
    // Auto mirrors use_slicer's placement exactly: one gap to the model's left, level with the model's middle,
    //  clamped to the bed. Both read the same box in the same frame, so the drawn tower is the sliced one.
    const x = auto ? origin.x + clamp(box.minX - origin.x - AUTO_GAP - size / 2, -bedW / 2 + size / 2, bedW / 2 - size / 2)
                   : origin.x + setX - bedW / 2 + size / 2
    const y = auto ? -origin.z + clamp((box.minY + box.maxY) / 2 + origin.z, -bedD / 2 + size / 2, bedD / 2 - size / 2)
                   : -origin.z + setY - bedD / 2 + size / 2
    boxes.push({ plate, x, y, size, height: Math.max(2, box.height) })
  }
  return boxes.length ? boxes : null
}

// The tower's own outcome, so the card can show settings and result together. Tool changes are counted from the
// G-CODE rather than read from the stats block: the kernel reports them only in the (opt-in) stats, and the card
// must not depend on that being switched on. `params` is the last slice's kernel parameters — the placement the
// tower was actually built at, which may be the auto one rather than anything the user typed.
export function towerResultStats(result, params) {
  const stats = result?.stats
  if (!stats || !Number.isFinite(stats.filament_mm_purge)) return null
  return {
    purge: stats.filament_mm_purge,
    changes: (result.gcode?.match(/^T\d+$/gm) ?? []).length,
    x: params?.prime_tower_x, y: params?.prime_tower_y,
  }
}
