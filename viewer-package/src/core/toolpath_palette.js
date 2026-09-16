// Toolpath colour primitives: the palettes, the pack/unpack pair, and the heatmap lookup.
//
// Written from viewer/TOOLPATH_SPEC.md §5. Colour VALUES are a free choice — nothing outside this file
// depends on a specific hue, only on the shape of these exports — so they are picked here for legibility:
// the structural roles (wall, solid) sit at the warm end, the filler roles cooler, and support/skirt stay
// desaturated so they read as scaffolding rather than as part of the object.

import { UNKNOWN_COLOR } from './viewer_defaults.js'

/** Toolpath role -> [r,g,b] in 0..1. Role 0 is travel and is drawn as a line, not a bead. */
export const TYPE_COLOR = {
  0: [0.35, 0.38, 0.44],   // travel
  1: [0.98, 0.45, 0.16],   // wall
  2: [0.36, 0.72, 0.94],   // sparse infill
  3: [0.20, 0.55, 0.86],   // solid infill
  4: [0.62, 0.66, 0.72],   // skirt / brim
  5: [0.50, 0.54, 0.60],   // support
  6: [0.42, 0.46, 0.52],   // raft
  7: [0.96, 0.76, 0.22],   // gap fill
  8: [0.88, 0.55, 0.30],   // thin wall
  9: [0.30, 0.80, 0.62],   // bridge
  10: [0.80, 0.42, 0.72],  // ironing
  11: [0.58, 0.50, 0.88],  // prime tower
}

export const TYPE_LABEL = {
  0: 'Travel', 1: 'Wall', 2: 'Sparse', 3: 'Solid', 4: 'Skirt', 5: 'Support',
  6: 'Raft', 7: 'Gap', 8: 'Thin', 9: 'Bridge', 10: 'Ironing', 11: 'Prime',
}

/** Categorical per-extruder colours for the Filament view. The stream carries a tool index and nothing about
 *  the material, and a machine may have more extruders than entries — so index this MODULO its length. */
export const TOOL_COLOR = [
  [0.90, 0.26, 0.30], [0.27, 0.60, 0.93], [0.36, 0.78, 0.42], [0.98, 0.72, 0.20],
  [0.72, 0.42, 0.90], [0.20, 0.78, 0.80], [0.95, 0.50, 0.72], [0.60, 0.60, 0.64],
]

/** '#rrggbb' (or 'rrggbb') -> [r,g,b] in 0..1. Anything unparseable comes back as UNKNOWN_COLOR rather than NaN:
 *  a bad colour must not become a NaN that propagates into an attribute buffer. */
export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? '').trim())
  if (!m) return hexToRgb(UNKNOWN_COLOR)
  const n = parseInt(m[1], 16)
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]
}

/** [r,g,b] in 0..1 -> r<<16 | g<<8 | b, the form the shader unpacks. Exact in float32 below 2^24, which
 *  0xffffff is, so a colour survives the round trip through a Float32Array attribute unchanged. */
export function packColor(c) {
  const q = (v) => Math.max(0, Math.min(255, Math.round((Number(v) || 0) * 255)))
  return q(c?.[0]) * 65536 + q(c?.[1]) * 256 + q(c?.[2])
}

/** An 11-stop blue -> cyan -> green -> yellow -> red ramp for the continuous views. */
export const DEFAULT_RANGES_COLORS = [
  [0.043, 0.173, 0.478], [0.055, 0.325, 0.639], [0.067, 0.478, 0.800], [0.078, 0.631, 0.961],
  [0.118, 0.749, 0.804], [0.157, 0.867, 0.647], [0.376, 0.902, 0.400], [0.667, 0.898, 0.157],
  [0.988, 0.976, 0.012], [0.988, 0.663, 0.012], [0.580, 0.149, 0.086],
]

/**
 * Value -> colour, linearly interpolated between adjacent stops.
 *
 * CLAMPS BOTH ENDS. The previous implementation clamped only the high end and extrapolated below the low
 * one, which returns negative components — out of gamut, and a NaN input indexed the palette out of bounds
 * and threw. Both were latent because computeColors derives lo/hi from the data itself, so nothing was ever
 * outside the range; a caller that passes its own bounds would have hit them.
 */
export function rangeColorAt(v, lo, hi, palette = DEFAULT_RANGES_COLORS) {
  const last = palette.length - 1
  if (last < 0) return [0, 0, 0]
  if (!Number.isFinite(v) || !Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return palette[0]
  if (v <= lo) return palette[0]
  if (v >= hi) return palette[last]
  const t = (v - lo) / (hi - lo) * last
  const i = Math.min(last - 1, Math.floor(t))
  const f = t - i
  const a = palette[i], b = palette[i + 1]
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]
}
