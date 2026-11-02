// What the Measure tool reports for two picked surface points. Points and normals are in model coordinates (z up).
const toDegrees = (radians) => radians * 180 / Math.PI

export function measureBetween(first, second) {
  const delta = [0, 1, 2].map(axis => second.point[axis] - first.point[axis])
  const dot = first.normal.reduce((sum, value, axis) => sum + value * second.normal[axis], 0)
  return {
    distance: Math.hypot(...delta),
    delta,
    // Between the two faces' normals; clamped because a dot of unit vectors can land just past 1.
    angle: toDegrees(Math.acos(Math.min(1, Math.max(-1, dot)))),
  }
}

/** three world (y up) -> model (z up), the convention buildMergedSTL uses. */
export const worldToModel = ([x, y, z]) => [x, -z, y]
