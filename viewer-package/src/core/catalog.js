// The vendor catalog, as an injectable. This package ships NO catalog: the printer, process, filament and resin
// presets are OrcaSlicer's own profile bundles (AGPL) and live in `three-slicer`, which hands its
// `bundledCatalog` in through the `catalog` prop. On its own, this viewer runs on the empty catalog below —
// every lookup misses, nothing throws, and the preset pickers simply have nothing to list. An industrial host
// with its own fleet passes its own; a partial object is merged over the empty one.

/** A catalog that knows nothing. Nothing throws: a viewer with no catalog still loads models, slices with the
 *  settings it was handed, and draws the result. */
export const emptyCatalog = Object.freeze({
  printerKeys: [],
  printerSettings: () => null,
  printersByVendor: {},
  printerTechByVendor: {},
  printerDefaultPreset: () => null,
  processPresets: async () => ({ keys: [], listFor: () => [], settingsFor: () => null }),
  filamentPresets: async () => ({ keys: [], listFor: () => [], recommendedFor: () => [], settingsFor: () => null }),
  resinCatalog: [],
  resinSettingsFor: () => null,
})

/** Fill a partial catalog from the empty one. Nothing passed means no presets — there is no bundled default in
 *  this package; `three-slicer/viewer` is the one that supplies it. */
export function resolveCatalog(catalog) {
  if (!catalog) return emptyCatalog
  return Object.freeze({ ...emptyCatalog, ...catalog })
}
