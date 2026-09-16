// The viewer's own fallbacks: what it draws and writes with when nothing better is known.
//
// No imports on purpose. The toolpath and G-code entries are react-free subpaths a headless consumer loads on its
//  own, and reaching `three-slicer-viewer/settings` from here would pull the whole schema in behind them. The four
//  values below that must equal the kernel derivation's (settings/kernel_defaults.js) are therefore copies, and
//  test_plate_layout.mjs fails if either side moves without the other.

// ---- Must equal the kernel derivation's fallbacks ----
export const DEFAULT_BED = Object.freeze({ width: 200, depth: 200 })   // BED_FALLBACK
export const DEFAULT_LINE_WIDTH = 0.42                                 // AUTO_LINE_WIDTH
export const DEFAULT_LAYER_HEIGHT = 0.2                                // FFF_FALLBACKS.layer_height
export const DEFAULT_FILAMENT_DIAMETER = 1.75                          // FFF_FALLBACKS.filament_diameter

// ---- Viewer-only ----
// A colour the viewer has nothing to read for: a blank filament slot, a swatch past the palette, an unparseable hex,
//  an unpainted facet. One grey, where there used to be four slightly different ones.
export const UNKNOWN_COLOR = '#888888'

// The support-point radius an SLA 3mf record leaves out (Slic3r_PE_sla_support_points version 0 carries none), used
//  by both the reader and the writer so a round trip cannot change it.
export const SLA_POINT_RADIUS = 0.4

// The painting selector's ceiling: upstream's EnforcerBlockerType stops at Extruder16. The kernel itself takes
//  per-extruder vectors of any length, so this is the honest limit for the filament list too.
export const MAX_PAINT_EXTRUDERS = 16

// Default colour per extruder slot, up to MAX_PAINT_EXTRUDERS. A literal table rather than a generated hue ramp
//  because <input type="color"> only accepts hex, so a generated colour would need an hsl->hex conversion written for
//  a value the user immediately overrides anyway. The first two entries are the long-standing T1/T2 defaults — an
//  existing project must not change colour because the list grew.
export const DEFAULT_FILAMENT_COLORS = Object.freeze([
  '#6aa0dc', '#e08a2b', '#e0473b', '#3bb0e0', '#7ad14a', '#b06ad1', '#d1c34a', '#4ad1a8',
  '#d16a9a', '#6a7ad1', '#8fd16a', '#d18f6a', '#6ad1d1', '#c74ad1', '#a8a8a8', '#4a6ad1',
])
