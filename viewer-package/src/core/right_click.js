// A right press and release count as a click, not a camera pan, when the pointer stayed within this distance.
const CLICK_SLOP_PX = 4

export const isRightClick = (press, release) => !!press && Math.hypot(release.x - press.x, release.y - press.y) <= CLICK_SLOP_PX
