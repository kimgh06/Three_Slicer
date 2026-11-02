// A press and release count as a click, not a camera drag, when the pointer stayed within this distance.
const CLICK_SLOP_PX = 4

export const isClick = (press, release) => !!press && Math.hypot(release.x - press.x, release.y - press.y) <= CLICK_SLOP_PX
