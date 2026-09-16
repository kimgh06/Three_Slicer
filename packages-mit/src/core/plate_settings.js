// Per-plate settings: a sparse override map per plate, merged over the global map at slice time.
//
// The contract mirrors upstream's PartPlate::m_config (a DynamicPrintConfig holding only deviations, applied
// over the resolved preset config in BackgroundSlicingProcess::apply) and this repo's own omission rule:
// "follow the global value" is expressed by the KEY BEING ABSENT, never by a default written into the
// override. A host that wants a plate back on the global value deletes the key.
//
// Plate identity is the plate INDEX — the same contract every existing per-plate store uses
// (plateResultsRef, wipe_tower_x/y, the 3mf plater_id). Only the LAST plate is ever deletable
// (plate_actions.js deletePlate), so truncation IS the erase and no middle-of-the-list remap exists.
// If middle deletion is ever added, ownership must move with the plate content, not stay at the raw index.

/**
 * Keys a plate override may never carry. EMPTY since the heterogeneous-bed stage: `printable_area`/
 * `printable_height` were blocked while the plate grid was uniform (an override would have sliced with a frame
 * the screen does not show), and `printer_technology` before that; now a bed override resizes its own plate
 * cell (plate_layout.js plateLayoutHetero) and each plate routes by its own effective technology
 * (use_slicer.js). The gate machinery stays: what cannot be REPRESENTED — a mixed-technology or mixed-bed
 * project's 3mf — is refused with a typed error at export rather than blocked at edit time, and this list is
 * where a future scene-global key would go back in.
 */
export const PLATE_SETTING_BLOCKED_KEYS = []

/** The technology plate `plate` actually slices with — its effective map's declared routing. */
export function plateTechnology(settings, plateSettings, plate) {
  const map = effectiveSettings(settings, plateSettings, plate)
  return map.printer_technology === 'SLA' ? 'SLA' : 'FFF'
}

/**
 * THE description of what plate `plate` prints with — the one place a per-plate fact is derived, so that no
 * consumer has to choose between the global map and the plate's own. `dims` injects the two derivations
 * (`fffDims` = deriveKernelParams, `slaDims` = deriveSlaParams) so this stays a pure module.
 *
 *   effective   the map it slices with (global ⊕ override; the global map BY IDENTITY when there is no override)
 *   tech        'FFF' | 'SLA', from that map
 *   params      the derived parameters of that technology
 *   bedW/bedD/bedH   the frame the kernel enforces: the resin display (height 0 — it states no ceiling) or the bed
 *   nozzle      the nozzle diameter (FFF), undefined under SLA
 *
 * Pass `plateSettings` null for the GLOBAL frame — what is laid out once (the uniform grid cell, a project
 * import's fallback bed, the 3mf plate stride). Everything else is per plate, and reading the global frame for
 * it is the bug class this replaced: the grid, the tower boxes, the bed check, the nozzle and bed rows each
 * read the global kp in turn and each was wrong for the one plate whose override differed.
 */
export function plateContext(settings, plateSettings, plate, { fffDims, slaDims }) {
  const effective = effectiveSettings(settings, plateSettings, plate)
  const tech = effective.printer_technology === 'SLA' ? 'SLA' : 'FFF'
  if (tech === 'SLA') {
    const params = slaDims?.(effective) ?? {}
    return { effective, tech, params, bedW: params.display_width, bedD: params.display_height, bedH: 0 }
  }
  const params = fffDims?.(effective) ?? {}
  return { effective, tech, params, bedW: params.bed_width, bedD: params.bed_depth, bedH: params.bed_height ?? 0, nozzle: params.nozzle_diameter }
}

/**
 * The printable bounds plate `plate` is judged against (the pre-slice bed check) — plateContext's frame as a
 * `{bedW, bedD, bedH}`, with `globalBounds` filling whatever the injected derivation does not state (a test
 * stub, or an SLA plate whose map holds no display size).
 */
export function plateBedBounds(settings, plateSettings, plate, globalBounds, slaDims, fffDims) {
  const frame = plateContext(settings, plateSettings, plate, { fffDims, slaDims })
  if (!(frame.bedW > 0 && frame.bedD > 0)) return globalBounds
  return { bedW: frame.bedW, bedD: frame.bedD, bedH: frame.bedH ?? globalBounds?.bedH ?? 0 }
}

/**
 * The grid cell dims per plate ([{w, d}]): an FFF bed override resizes its own cell, and an SLA plate's cell
 * IS its resin display — the plate stands at its real printable size beside its FFF neighbours. (This
 * replaced the mixed-tech stage's overlay-on-a-global-cell compromise once the heterogeneous grid existed to
 * carry it.) Feed to plateLayoutHetero when non-uniform.
 */
export function plateDimsList(settings, plateSettings, plateCount, globalDims, fffDims, slaDims) {
  const out = []
  for (let plate = 0; plate < plateCount; plate++) {
    const bounds = plateBedBounds(settings, plateSettings, plate, null, slaDims, fffDims)
    out.push(bounds ? { w: bounds.bedW, d: bounds.bedD } : globalDims)
  }
  return out
}

/** Do all plates share one cell size? (True -> the closed-form uniform grid keeps serving.) */
export function uniformPlateDims(dims) {
  return dims.every(d => d.w === dims[0].w && d.d === dims[0].d)
}

/**
 * The settings map plate `plate` actually slices with: the global map with that plate's sparse override
 * merged over it. No override (or an empty one) returns the global map BY IDENTITY, which is what keeps the
 * no-override path byte-identical to the pre-feature behaviour — nothing downstream can tell the feature exists.
 *
 * `plateSettings` is `{ [plateIndex]: sparseMap }` (an array works too — both index the same way).
 * An `undefined` override value is treated as "key absent" so a host clearing with `{key: undefined}` does not
 * accidentally override the global value with undefined.
 */
export function effectiveSettings(settings, plateSettings, plate) {
  const override = plateSettings?.[plate]
  if (!override) return settings ?? {}
  let merged = null
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined || PLATE_SETTING_BLOCKED_KEYS.includes(key)) continue
    if (!merged) merged = { ...(settings ?? {}) }
    merged[key] = value
  }
  return merged ?? (settings ?? {})
}

/**
 * The keys plate `plate` actually overrides — what the UI badges and the PlateBar dot report. Blocked keys
 * are filtered even if a host wrote them into the map: the merge ignores them, so showing them as active
 * overrides would claim an effect that does not exist.
 */
export function overriddenPlateKeys(plateSettings, plate) {
  return Object.keys(plateSettings?.[plate] ?? {})
    .filter(key => !PLATE_SETTING_BLOCKED_KEYS.includes(key) && plateSettings[plate][key] !== undefined)
}

/**
 * Write a panel edit back into the plate's override — the per-plate mirror of FilamentCard's setPanelSettings:
 * the panel edited the plate's EFFECTIVE map (`before` -> `after`), and only what it CHANGED becomes an
 * override. A key the panel removed (its per-option reset) clears the override when one exists — back to
 * "follow the global value" — and is otherwise ignored: plate scope cannot delete a global key. An override
 * map emptied this way is dropped whole, so the plate reads as "no override" again everywhere (the PlateBar
 * dot, the staleness watcher, the merge identity). Returns the same reference when nothing changed.
 *
 * `forceKeys` breaks the diff rule for one caller and one reason: a PROFILE pick (a printer picked in plate
 * scope) is a set of values that belong together, not a set of independent edits. Recorded as a diff, the keys
 * that happened to equal the global machine's are left out — and the next global printer change moves them,
 * leaving the plate on a mixture of two machines that is neither one. The picked profile's own keys are
 * therefore written whole, so the plate keeps the machine it was given.
 */
export function writePlateOverride(plateSettings, plate, before, after, forceKeys = []) {
  const current = plateSettings?.[plate] ?? {}
  const next = { ...current }
  let touched = false
  for (const key of Object.keys(after)) {
    if (PLATE_SETTING_BLOCKED_KEYS.includes(key)) continue
    const forced = forceKeys.includes(key)
    if (!forced && JSON.stringify(after[key]) === JSON.stringify(before[key])) continue
    if (forced && key in next && JSON.stringify(next[key]) === JSON.stringify(after[key])) continue
    next[key] = after[key]; touched = true
  }
  for (const key of Object.keys(before)) {
    if (key in after || !(key in next)) continue
    delete next[key]; touched = true
  }
  if (!touched) return plateSettings ?? {}
  const out = { ...(plateSettings ?? {}) }
  if (Object.keys(next).length) out[plate] = next; else delete out[plate]
  return out
}

/**
 * The scoped read/write pair a settings-editing card binds to. Inactive scope returns the global pair
 * untouched; active plate scope returns the plate's effective map and a setter that diffs edits back into
 * the override (writePlateOverride above). One helper because two cards (Process, Printer) bind the same way
 * and a third copy of this closure is how the two would drift.
 */
export function scopedSettings(settings, setSettings, plateSettings, setPlateSettings, plate, active) {
  if (!active) return { settings: settings ?? {}, setSettings, overriddenKeys: [], onRevertKey: null, plateScope: false }
  return {
    plateScope: true,
    settings: effectiveSettings(settings, plateSettings, plate),
    setSettings: (updater, forceKeys) => setPlateSettings(ps => {
      const before = effectiveSettings(settings, ps, plate)
      const after = typeof updater === 'function' ? updater(before) : updater
      return writePlateOverride(ps, plate, before, after, forceKeys)
    }),
    overriddenKeys: overriddenPlateKeys(plateSettings, plate),
    onRevertKey: (key) => setPlateSettings(ps => revertPlateKey(ps, plate, key)),
  }
}

/**
 * The Global|Plate switch every settings card carries, as the scoped pair the card binds to. Plate scope needs the
 * switch on it, more than one plate, and a card that can take it: `available` is the card's own condition (a setter
 * for the overrides by default; the Process card also needs its panel slot to be a function).
 */
export function cardScope({ settings, setSettings, plateSettings, setPlateSettings, plateCount = 1, selectedPlate = 0, settingsScope = 'global' },
  available = !!setPlateSettings) {
  const active = settingsScope === 'plate' && plateCount > 1 && available
  return scopedSettings(settings, setSettings, plateSettings, setPlateSettings, selectedPlate, active)
}

/** Drop one key from a plate's override — the badge's "follow the global value again". */
export function revertPlateKey(plateSettings, plate, key) {
  const current = plateSettings?.[plate]
  if (!current || !(key in current)) return plateSettings ?? {}
  const next = { ...current }; delete next[key]
  const out = { ...plateSettings }
  if (Object.keys(next).length) out[plate] = next; else delete out[plate]
  return out
}

/**
 * A mixed-technology project cannot be represented in a 3mf: the format (and this writer) holds ONE
 * `project_settings.config`, and upstream cannot express "plate 2 is resin" at all. Following this repo's rule
 * that what cannot be represented is refused rather than approximated (the SLA kernel's typed
 * SLA_UNSUPPORTED_* codes), the project export throws this typed error instead of writing a file that would
 * come back as a different project. Same shape as the engine's SlaRequestError: instanceof + `.code`.
 */
export class MixedTechExportError extends Error {
  constructor(plates) {
    super(`Plates ${plates.map(p => Number(p) + 1).join(', ')} use a different technology than the project — a 3mf cannot represent a mixed-technology project. Clear those plates' technology overrides to save, or export each plate's G-code/.sl1 instead.`)
    this.name = 'MixedTechExportError'
    this.code = 'UNSUPPORTED_MIXED_TECH_3MF'
    this.plates = plates.map(Number)
  }
}

/** Throws MixedTechExportError when any plate's effective technology differs from the global one. */
export function assertUniformTechnology(settings, plateSettings) {
  const base = settings?.printer_technology === 'SLA' ? 'SLA' : 'FFF'
  const mixed = Object.keys(plateSettings ?? {}).filter(index => plateTechnology(settings, plateSettings, index) !== base)
  if (mixed.length) throw new MixedTechExportError(mixed)
}

/** Same refusal for heterogeneous beds: upstream's plate grid strides by ONE bed size, so a project whose
 *  plates sit on different beds has no 3mf encoding (write_3mf re-encodes positions under that grid). */
export class MixedBedExportError extends Error {
  constructor(plates) {
    super(`Plates ${plates.map(p => Number(p) + 1).join(', ')} override the bed size — a 3mf lays every plate out on one bed and cannot represent this project. Clear those bed overrides to save, or export each plate's output instead.`)
    this.name = 'MixedBedExportError'
    this.code = 'UNSUPPORTED_MIXED_BED_3MF'
    this.plates = plates.map(Number)
  }
}
export function assertHomogeneousBeds(plateSettings) {
  const mixed = Object.keys(plateSettings ?? {}).filter(index => {
    const override = plateSettings[index]
    return override && ('printable_area' in override || 'printable_height' in override)
  })
  if (mixed.length) throw new MixedBedExportError(mixed)
}

/**
 * Ownership on plate delete. Only the last plate is deletable, so the erase is a truncation — the exact rule
 * wipe_tower_x/y already follow (plate_actions.js): a stale trailing entry would come back as the wrong
 * plate's settings the moment a plate is re-added. Returns the SAME reference when nothing is dropped, so a
 * no-op delete does not read as a settings change to the staleness watcher.
 */
export function truncatePlateSettings(plateSettings, plateCount) {
  if (!plateSettings) return plateSettings
  const stale = Object.keys(plateSettings).filter(key => Number(key) >= plateCount)
  if (!stale.length) return plateSettings
  const kept = { ...plateSettings }
  for (const key of stale) delete kept[key]
  return kept
}

/**
 * The plate overrides a GLOBAL technology switch leaves without a technology. A plate-scope profile pick always
 * writes `printer_technology` (PrinterCard.apply), so an override that declares one describes its own machine and
 * stays; one without it is hand-edited values authored against the technology that just went away — the Resin
 * card's `layer_height` is an FFF key too, so under FFF they would shadow every later pick on that plate. Those are
 * dropped. Returns `{ plateSettings, dropped }` — the same map by identity when nothing is dropped.
 */
export function dropStaleTechOverrides(plateSettings) {
  const dropped = Object.keys(plateSettings ?? {})
    .filter(plate => { const o = plateSettings[plate]; return o && Object.keys(o).length && !o.printer_technology })
  if (!dropped.length) return { plateSettings: plateSettings ?? {}, dropped: [] }
  const kept = { ...plateSettings }
  for (const plate of dropped) delete kept[plate]
  return { plateSettings: kept, dropped: dropped.map(Number) }
}
