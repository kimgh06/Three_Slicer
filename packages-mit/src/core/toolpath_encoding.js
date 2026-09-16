// The toolpath stream's layout: what the kernel emits and every reader here decodes. TOOLPATH_SPEC.md is the
//  contract; the kernel (C++) and the engine's SLA contour fallback (packages/engine/src/sla_core.js, a standalone
//  worker that cannot import this) hold their own copies of the same numbers.
//
// A segment is STRIDE floats, [x0,y0,z0,enc, x1,y1,z1,enc]. `enc` packs the role and the tool: roles only reach 11,
//  so the tool rides in the spare high bits instead of a 9th float (+12.5% on the largest array the viewer holds).
//  Anything reading `enc` must mask it.
export const STRIDE = 8
export const ROLE_MASK = 15
export const TOOL_SHIFT = 4

export const ROLE = Object.freeze({
  TRAVEL: 0, WALL: 1, SPARSE: 2, SOLID: 3, SKIRT: 4, SUPPORT: 5,
  RAFT: 6,       // the SLA stream puts its pad here, as it puts support trees on SUPPORT
  GAP: 7, THIN: 8, BRIDGE: 9, IRONING: 10, PRIME: 11,
})

export const encodeRole = (role, tool) => role + (tool << TOOL_SHIFT)
export const roleOf = enc => enc & ROLE_MASK
export const toolOf = enc => enc >>> TOOL_SHIFT
