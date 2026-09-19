// Is a mesh's facet winding consistent — every edge walked once in each direction by the facets that share it?
//
// The mesh-direct SLA mask (sl1_parity_gpu.js) counts the surfaces above a pixel signed by each FACET's own facing,
//  NonZero; the kernel builds its contours from oriented loops and reverses a loop assembled mostly backwards
//  (slice_planes.h chain_polys). The two agree whenever the winding is consistent — including a fully inverted mesh
//  and coincident copies — and part ways when only SOME facets are flipped: measured on a table whose top faces were
//  flipped, the mask lit 6400 px at a height where the slice (and its supports) hold only the 256 px leg. So the
//  export uses the mesh-direct mask only for a consistent mesh, and rasterizes the kernel's own contours otherwise.
//  An open mesh (a boundary edge walked once) reads as inconsistent too, which sends it the same safe way.
//
// Pure: a binary STL in, a boolean out. Vertices are identified by their float32 bit patterns, the same key the 3mf
//  writer welds by.

const STL_COUNT_OFFSET = 80
const STL_FACETS_OFFSET = 84
const STL_FACET_BYTES = 50
const STL_NORMAL_BYTES = 12
const STL_VERTEX_BYTES = 12
const STL_FLOAT_BYTES = 4
// Two vertex ids form one numeric edge key; ids stay below this, so the key stays an exact integer.
const VERTEX_ID_SPAN = 2 ** 26

export function meshWindingConsistent(stlBytes) {
  const bytes = stlBytes instanceof Uint8Array ? stlBytes : new Uint8Array(stlBytes)
  if (bytes.byteLength < STL_FACETS_OFFSET) return false
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const facetCount = view.getUint32(STL_COUNT_OFFSET, true)
  if (bytes.byteLength < STL_FACETS_OFFSET + facetCount * STL_FACET_BYTES) return false
  const vertexIds = new Map()
  const vertexIdAt = (offset) => {
    const key = `${view.getUint32(offset, true)},${view.getUint32(offset + STL_FLOAT_BYTES, true)},${view.getUint32(offset + 2 * STL_FLOAT_BYTES, true)}`
    let id = vertexIds.get(key)
    if (id === undefined) { id = vertexIds.size; vertexIds.set(key, id) }
    return id
  }
  // Each undirected edge sums +1 for a walk from its lower id to its higher one and -1 for the reverse.
  const edgeBalance = new Map()
  for (let facet = 0; facet < facetCount; facet++) {
    const firstVertex = STL_FACETS_OFFSET + facet * STL_FACET_BYTES + STL_NORMAL_BYTES
    const corners = [0, 1, 2].map(corner => vertexIdAt(firstVertex + corner * STL_VERTEX_BYTES))
    if (vertexIds.size >= VERTEX_ID_SPAN) return false
    for (let corner = 0; corner < 3; corner++) {
      const from = corners[corner], to = corners[(corner + 1) % 3]
      if (from === to) continue   // a degenerate facet's collapsed edge walks nowhere
      let key = to * VERTEX_ID_SPAN + from, step = -1
      if (from < to) { key = from * VERTEX_ID_SPAN + to; step = 1 }
      edgeBalance.set(key, (edgeBalance.get(key) ?? 0) + step)
    }
  }
  for (const balance of edgeBalance.values()) if (balance !== 0) return false
  return true
}
