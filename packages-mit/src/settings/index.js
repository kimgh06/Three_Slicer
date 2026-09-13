// three-slicer-viewer/settings — the catalog-free settings surface. See settings_core.js.
export * from './settings_core.js'
// The derivation's own fallbacks, for callers that need the same numbers (frozen; see kernel_defaults.js).
export { FFF_FALLBACKS, SLA_FALLBACKS, AUTO_LINE_WIDTH, BED_FALLBACK, MACHINE_LIMITS } from './kernel_defaults.js'
