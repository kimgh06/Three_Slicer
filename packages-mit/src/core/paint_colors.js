import { UNKNOWN_COLOR } from './viewer_defaults.js'

// What colour a painted selector state is drawn in.
//
// One facet holds one integer (upstream's EnforcerBlockerType — see actions/support_paint.js), so the state number
// alone cannot say whether a mark means "support enforcer" or "print with T1". The ACTIVE BRUSH decides, and two
// places now have to agree on the answer: the overlay mesh that shows what is already painted, and the brush cursor
// that shows what the next stroke will paint. A cursor in a colour the stroke will not produce is worse than no
// cursor, so the mapping lives here rather than twice.

export const SUPPORT_OVERLAY_COLOR = { 1: '#2b6cff', 2: '#e23b3b' }   // enforcer=blue, blocker=red
export const UNPAINTED_COLOR = UNKNOWN_COLOR   // no filament colour to read (or the eraser)

// `material` is the brush kind, not the state: state 1 is blue under the support brush and T1's own filament colour
// under the material brush.
export function paintStateColor(state, material, extruderColors) {
  if (material) return extruderColors?.[state - 1] ?? UNPAINTED_COLOR
  return SUPPORT_OVERLAY_COLOR[state] ?? UNPAINTED_COLOR
}
