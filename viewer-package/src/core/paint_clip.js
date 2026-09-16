// The section plane, in the two frames that have to agree about it.
//
// Upstream's object clipper (Alt + wheel over the canvas) is the only way a brush reaches an interior surface: the
// plane cuts the model away in front of the camera, and both the RENDERER and the SELECTOR have to clip against the
// same half-space. They disagree by construction — three.js keeps `normal·p + constant >= 0` in VIEWER coordinates
// (Y-up, plate-relative), the kernel clips `normal·p - offset > 0` in KERNEL coordinates (Z-up, plate-local) — so
// the conversion is where a sign error hides: the visible cut would look right while the brush painted the half
// that was cut away.
//
// The viewer -> kernel map is the one `paintAt` uses on every stroke (scene/paint_input.js):
//   kx = vx - cx      ky = -vz - cy      kz = vy - minz
// which is linear, so a plane maps to a plane. Substituting v back in gives
//   n·v = nx·kx - nz·ky + ny·kz + (nx·cx + ny·minz - nz·cy)
// and the kernel's inequality runs the other way, so the normal is negated and the shift folds into the offset.

export function kernelClipPlane(normal, constant, xform) {
  const { cx = 0, cy = 0, minz = 0 } = xform ?? {}
  const [nx, ny, nz] = normal
  return {
    normal: [-nx, nz, -ny],
    offset: constant + (nx * cx + ny * minz - nz * cy),
  }
}

// Where the plane sits for a given scrub position. `ratio` runs 0..1 across the model's extent along the plane
// normal, the way upstream's `set_position_by_ratio` does; below 0 the plane is off (upstream resets with -1).
// `bounds` is the model's world-space bbox as {min:[x,y,z], max:[x,y,z]}.
export function clipConstantForRatio(normal, bounds, ratio) {
  if (!(ratio >= 0)) return null
  const [nx, ny, nz] = normal
  // The bbox corner furthest along the normal in each direction. Projecting all eight corners is the same thing as
  //  taking the min/max coordinate per axis by the sign of that axis's normal component.
  const lo = nx * (nx > 0 ? bounds.min[0] : bounds.max[0])
           + ny * (ny > 0 ? bounds.min[1] : bounds.max[1])
           + nz * (nz > 0 ? bounds.min[2] : bounds.max[2])
  const hi = nx * (nx > 0 ? bounds.max[0] : bounds.min[0])
           + ny * (ny > 0 ? bounds.max[1] : bounds.min[1])
           + nz * (nz > 0 ? bounds.max[2] : bounds.min[2])
  // A little slack at each end so ratio 0 and ratio 1 are "nothing cut" and "everything cut" rather than a plane
  //  exactly tangent to the bbox, where floating point decides which it is.
  const slack = Math.max(1e-3, (hi - lo) * 0.01)
  const along = (lo - slack) + ((hi + slack) - (lo - slack)) * ratio
  return -along   // three.js keeps normal·p + constant >= 0, so the plane through `along` has constant -along
}
