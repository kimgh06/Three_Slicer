// The scene camera's depth range. 1..3000 mm is the measured default (use_three_scene.js, 22-fix(H3)): a far/near ratio of
//  3000 keeps the 24-bit depth buffer fine enough that sub-surface infill does not poke through the surface. A plate
//  layout reaching further than 3000 mm from the camera was clipped at the far plane and its far plates drew as the
//  background (28 plates on a 256 mm bed: a 6 x 5 grid, 1.8 x 1.5 m). The far plane grows to the far side of the layout
//  and the near plane grows with it, so the ratio, and the precision per distance, stays the measured one.
export const DEPTH_NEAR = 1
export const DEPTH_FAR = 3000
const DEPTH_RATIO = DEPTH_FAR / DEPTH_NEAR
// Objects stand above the plates; the layout radius covers the footprint only.
const FAR_MARGIN = 1.1

export function cameraDepthRange(distanceToLayoutCentre, layoutRadius) {
  const far = Math.max(DEPTH_FAR, (distanceToLayoutCentre + layoutRadius) * FAR_MARGIN)
  return { near: far / DEPTH_RATIO, far }
}
