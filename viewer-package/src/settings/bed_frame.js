// Printer coordinates. Kept apart from settings_core.js because it needs no schema: core/plate_settings.js reads it
// without loading the config schema behind it.
//
// The viewer and the kernel work in a plate frame centred on the bed; the printer's own coordinates start wherever
//  printable_area does. The kernel adds the bed centre to every coordinate it writes (Params::bed_center_x/y), and
//  every stored printer coordinate (wipe_tower_x/y, a 3mf object position, an imported G-code) converts through the
//  same two functions. `params` is deriveKernelParams' output (bed_origin_x/y are present only when the corner is
//  not (0,0)). Most beds start at (0,0), where the centre is half the bed; a delta bed is centred on (0,0) itself
//  (Anycubic Predator: -185..185).
import { BED_FALLBACK } from './kernel_defaults.js'

export function bedOrigin(params) {
  return { x: params?.bed_origin_x ?? 0, y: params?.bed_origin_y ?? 0 }
}
export function bedCenter(params) {
  const origin = bedOrigin(params)
  return { x: origin.x + (params?.bed_width ?? BED_FALLBACK.width) / 2, y: origin.y + (params?.bed_depth ?? BED_FALLBACK.depth) / 2 }
}

// A printable_area that is not an axis-aligned rectangle (a delta bed's circle as 72 points, a cut-corner bed), as
//  plate-local points: printer coordinates minus the bed centre. null for a rectangle, which bed_width/bed_depth
//  already describe exactly.
export function bedShapeLocal(area, center) {
  if (!Array.isArray(area) || area.length < 3) return null
  const xs = new Set(area.map(point => point[0])), ys = new Set(area.map(point => point[1]))
  if (area.length === 4 && xs.size === 2 && ys.size === 2) return null
  return area.map(([x, y]) => [x - center.x, y - center.y])
}
