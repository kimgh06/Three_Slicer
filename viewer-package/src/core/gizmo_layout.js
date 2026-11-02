// The gizmo stands around the selection instead of over it: its handles sit past the selection's box, sized by the
//  selection. `low` and `high` are the distances from the gizmo's origin to the box's faces, per axis, in mm.
const HEAD_PER_RADIUS = 0.12      // handle size against the selection's radius
const MARGIN_PER_RADIUS = 0.06    // gap between the box and a handle, up close
const MIN_HEAD_PX = 18            // a handle stays big enough to hit on a selection far away
const MIN_GAP_PX = 28             // in screen pixels, so in mm it grows with the camera's distance
const HEAD_UNITS = { translate: 0.1, scale: 0.16 }   // what one handle measures in TransformControls' units: a scale cube fills more than an arrow
const RING_UNITS = 0.5

export function gizmoLayout({ low, high, pixelsPerMm, mode }) {
  const reach = low.map((distance, axis) => Math.max(distance, high[axis]))
  const radius = Math.hypot(...reach)
  const gap = Math.max(radius * MARGIN_PER_RADIUS, MIN_GAP_PX / pixelsPerMm)
  if (mode === 'rotate') return { scale: (radius + gap) / RING_UNITS, margin: gap, low, high }
  const head = Math.max(radius * HEAD_PER_RADIUS, MIN_HEAD_PX / pixelsPerMm)
  // A handle is placed by its middle, so the gap is counted from its near end.
  return { scale: head / HEAD_UNITS[mode], margin: gap + head, low, high }
}

// Where a handle goes, from where TransformControls drew it. `centre` is its middle in handle units; an axis it does
//  not lean along stays at 0. Each axis it leans along puts it past that side's face.
export function handleOffset(centre, { scale, margin, low, high }) {
  return centre.map((unit, axis) => {
    if (Math.abs(unit) < 1e-6) return 0
    if (unit > 0) return high[axis] + margin - unit * scale
    return -(low[axis] + margin) - unit * scale
  })
}
