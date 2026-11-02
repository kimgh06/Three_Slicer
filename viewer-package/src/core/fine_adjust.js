// The fine adjust mode's numbers: the snap a gizmo drag takes while it is on, and what an edited size does to the scale.
export const FINE_MOVE_SNAP_MM = 0.1
export const FINE_ROTATE_SNAP_DEGREES = 1
export const FINE_SCALE_SNAP = 0.01
export const DEFAULT_ROTATE_STEP_DEGREES = 90
export const FINE_RING_SPEED = 0.25     // a ring drag with Alt held: at 1:1 one pixel was over a degree, and the snap skipped 3 and 8
const MODEL_Z_AXIS = 2
const MODEL_X_AXIS = 0
// [plain, Shift] per gizmo mode: mm, degrees and percent. Shift is the finer step in everyday use (Prusa's nudge), and the
//  coarser one in fine adjust, as in the panel's number fields.
const ARROW_STEPS = {
  everyday: { translate: [10, 1], rotate: [15, 5], scale: [5, 1] },
  fine: { translate: [FINE_MOVE_SNAP_MM, 1], rotate: [FINE_ROTATE_SNAP_DEGREES, 10], scale: [1, 10] },
}

// What an arrow key does, by gizmo mode. `right` and `down` are -1, 0 or 1 on the screen's keys.
// Move: left and right on model X, up and down on model Y. Rotate: left and right turn on the bed, up and down tip over X.
// Scale: up and down, with proportions kept. Left and right do nothing there.
export function arrowEdit(mode, right, down, shift, fine) {
  let steps = ARROW_STEPS.everyday[mode]
  if (fine) steps = ARROW_STEPS.fine[mode]
  let step = steps[0]
  if (shift) step = steps[1]
  if (mode === 'translate') return { kind: 'move', deltas: [right * step, -down * step] }
  if (mode === 'rotate' && right) return { kind: 'rotate', axis: MODEL_Z_AXIS, degrees: -right * step }
  if (mode === 'rotate') return { kind: 'rotate', axis: MODEL_X_AXIS, degrees: down * step }
  if (mode === 'scale' && down) return { kind: 'scale', ratio: 1 - down * step / 100 }
  return null
}

export function wrapAngle(radians) {
  return Math.atan2(Math.sin(radians), Math.cos(radians))
}

// A rotation's share about one unit axis (swing-twist). It reads a turn about a single axis exactly, past 90 degrees too,
//  where Euler angles do not: a turn of 100 degrees about scene Y comes back as [-180, 80, -180].
export function twistDegrees(quaternion, [x, y, z]) {
  return 2 * Math.atan2(quaternion.x * x + quaternion.y * y + quaternion.z * z, quaternion.w) * 180 / Math.PI
}

export function resizedScales(scales, sizes, axis, size, uniform) {
  const ratio = size / sizes[axis]
  if (uniform) return scales.map(scale => scale * ratio)
  const resized = [...scales]
  resized[axis] *= ratio
  return resized
}
