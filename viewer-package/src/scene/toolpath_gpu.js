// The package's public barrel. The implementation lives in one-job modules; this file only re-exports the
// surface, so consumers and the tests keep a single import path.
//
// It is also reachable as `three-slicer/viewer/toolpath`, which the AGPL package re-exports from here — the
// entry point existing consumers already use did not move when the code did.
export {
  TYPE_COLOR, TYPE_LABEL, TOOL_COLOR, DEFAULT_RANGES_COLORS,
  // The colour primitives were internal while this lived inside the viewer. They cross a package boundary
  //  now, and a consumer building its own legend needs them as much as the viewer's own does.
  packColor, hexToRgb, rangeColorAt,
} from '../core/toolpath_palette.js'
export {
  buildSegmentData, roleRatios,
  // The move-scrub queries, likewise: use_move_scrub.js is on the far side of the boundary now.
  layerMoveCount, topMoveLayer, moveCursor,
} from '../core/toolpath_segments.js'
export { VIEW_TYPES, computeColors } from '../core/toolpath_views.js'
export { VERTEX_DATA, makeToolpath } from './toolpath_mesh.js'
