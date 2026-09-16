// Binary STL: an 80-byte header, a uint32 triangle count, then one 50-byte record per triangle (a float32 normal,
//  three float32 vertices, a uint16 attribute). The engine's SLA contour fallback (packages/engine/src/sla_core.js)
//  is a standalone worker and keeps its own copy.
export const STL_HEADER_BYTES = 80
export const STL_DATA_OFFSET = 84          // header + the triangle count
export const STL_TRIANGLE_BYTES = 50
export const stlByteLength = triangles => STL_DATA_OFFSET + triangles * STL_TRIANGLE_BYTES
