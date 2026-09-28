// The vendor catalog half of the settings surface — everything that reads printers.json, processes.js and
// filaments.js (OrcaSlicer's own profile bundles, AGPL). The catalog-free transforms live in settings_core.js
// and are re-exported below, so consumers keep importing `three-slicer/settings` for both.
import { printers, loadProcesses, loadFilaments } from './data.js'
export * from 'three-slicer-viewer/settings'

// printers.json is stored column-oriented (see its .d.ts). These two hide that layout so no consumer decodes it.

/** Every option key a printer profile can set — what to clear before applying a different printer. */
export const printerKeys = printers.keys

/** Vendor -> profile name -> `[nozzle, setIndex, model]`, straight from the data (for building a picker). */
export const printersByVendor = printers.byVendor

/** Vendor -> slicing technology. Absent means FFF — only the resin vendor bundles are marked, so a printer
 *  picker can keep FFF machines and SLA machines apart with one lookup. */
export const printerTechByVendor = printers.techByVendor ?? {}

/** The resin material catalog (SLA vendor bundles, inherits flattened): {name, bundle, type, vendor, colour,
 *  exposure_time, initial_exposure_time, initial_layer_height, layerHeight}. layerHeight is the preset's
 *  compatibility condition reduced to a number — the picker filters on it without an expression engine. */
export const resinCatalog = printers.resins ?? []

/** The settings a resin material applies, ready to merge — the exposure family plus the remembered pick.
 *  `null` when unknown. The material never touches support/pad keys (upstream keeps those in sla_print). */
export function resinSettingsFor(name) {
  const entry = resinCatalog.find(r => r.name === name)
  if (!entry) return null
  const out = { sla_material_settings_id: name }
  for (const key of ['exposure_time', 'initial_exposure_time', 'initial_layer_height'])
    if (Number.isFinite(entry[key])) out[key] = entry[key]
  return out
}

// One row of a preset table -> the settings it applies. Multi-line text (custom G-code, notes) is stored once in
//  `text` and a row holds its index, for the columns listed in `textKeys` (web/extract_all.py _intern_text).
function rowSettings(data, row) {
  const textKeys = new Set(data.textKeys ?? [])
  const out = {}
  data.keys.forEach((key, i) => {
    if (row[i] == null) return
    if (textKeys.has(key)) { out[key] = data.text[row[i]]; return }
    out[key] = row[i]
  })
  return out
}

// Process (print) presets live in the ~800 KB processes.json, so they load on demand — the first call fetches,
//  later ones reuse the same promise. Returns a small facade so no caller has to know the column layout.
let processesPromise = null
export function processPresets() {
  processesPromise ??= loadProcesses().then(data => ({
    /** Every key a process preset can set — clear these before applying a different one */
    keys: data.keys,
    /** Preset names compatible with a printer profile, in upstream order */
    listFor: (printerProfileName) =>
      (data.byPrinter[printerProfileName] ?? []).map(i => data.presets[i][0]),
    /** The settings a preset applies, ready to merge. `null` when unknown. */
    settingsFor: (presetName) => {
      const preset = data.presets.find(([name]) => name === presetName)
      if (!preset) return null
      return rowSettings(data, data.sets[preset[1]])
    },
  }))
  return processesPromise
}

// Filament (material) presets — same lazy facade as the process presets above, over the ~540 KB filaments.js.
//  Entries come out as objects rather than bare names because a material picker groups by type, and the type
//  label only exists in this file. Both lists are in upstream order: byPrinter is the compatible set,
//  defaultsByModel the vendor's recommendation (a subset, so the two overlap by design).
let filamentsPromise = null
export function filamentPresets() {
  filamentsPromise ??= loadFilaments().then(data => {
    // type/vendor are empty strings when the profile chain declares neither — the picker buckets those itself
    const view = i => { const [name, , type, vendor] = data.presets[i]; return { name, type, vendor } }
    return {
      /** Every key a filament preset can set — clear these before applying a different material */
      keys: data.keys,
      /** Every material in the catalog — for a picker shown before any printer is chosen */
      all: () => data.presets.map((_, i) => view(i)),
      /** Materials compatible with a printer profile, as `{name, type, vendor}` */
      listFor: (printerProfileName) => (data.byPrinter[printerProfileName] ?? []).map(view),
      /** The vendor's recommended materials for that printer's model, same shape as listFor.
       *  Filtered to the compatible set, which is not redundant: the recommendation is declared on the machine
       *  *model* and so is nozzle-agnostic, while its entries name nozzle-specific presets ("… @Kobra 3 0.4 nozzle").
       *  On a 0.2 nozzle profile 41% of the raw entries (1749 of 4259 across all printers) name a material whose
       *  own compatible list excludes it — offering those would apply a preset upstream considers incompatible. */
      recommendedFor: (printerProfileName) => {
        const compatible = new Set(data.byPrinter[printerProfileName] ?? [])
        return (data.defaultsByModel[printerEntry(printerProfileName)?.[2] ?? ''] ?? [])
          .filter(i => compatible.has(i)).map(view)
      },
      /** The settings a material applies, ready to merge. `null` when unknown. */
      settingsFor: (presetName) => {
        const preset = data.presets.find(([name]) => name === presetName)
        if (!preset) return null
        return rowSettings(data, data.sets[preset[1]])
      },
    }
  })
  return filamentsPromise
}

function printerEntry(profileName) {
  for (const models of Object.values(printers.byVendor)) {
    const entry = models[profileName]
    if (entry) return entry
  }
  return null
}

/** The settings a printer profile applies, ready to merge into the settings map. `null` when unknown. */
export function printerSettings(profileName) {
  const entry = printerEntry(profileName)
  if (!entry) return null
  return rowSettings(printers, printers.sets[entry[1]])
}

/** The vendor's recommended process preset for a printer, or '' when the profile names none. */
export function printerDefaultPreset(profileName) { return printerEntry(profileName)?.[3] ?? '' }

/** The bed type the printer's model defaults to ("Textured PEI Plate"), or '' when the model names none. Upstream
 *  writes it to curr_bed_type when the printer is picked; the first-layer bed temperature follows it. */
export function printerDefaultBedType(profileName) { return printerEntry(profileName)?.[4] ?? '' }

// ---- The catalog as one object -------------------------------------------------------------------------------
// What `three-slicer-viewer`'s `<Viewport catalog>` takes: the ten lookups above, bundled. The permissive package
//  ships no catalog (these are OrcaSlicer's profile bundles); `three-slicer/viewer` passes this one by default.
export const bundledCatalog = Object.freeze({
  printerKeys, printerSettings, printersByVendor, printerTechByVendor, printerDefaultPreset, printerDefaultBedType,
  processPresets, filamentPresets, resinCatalog, resinSettingsFor,
})
