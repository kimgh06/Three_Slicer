// The per-object paint store. The kernel's selector holds ONE merged mesh at a time — the selected plate's — and
//  used to be the only place a brush stroke lived, so painting one plate and then another cost the first plate its
//  paint, and a copy on another plate whose merge happened to be byte-identical inherited it outright (measured:
//  the original sliced single-material, the copy printed both). Upstream keeps paint on each ModelVolume
//  (Model.hpp:869 `mmu_segmentation_facets`), and this is that: `object.paint` holds each object's marks in its OWN
//  facet numbering — the shape a 3mf import already produced (parse_3mf.js emptyPaint: one Map per annotation,
//  local facet -> split-tree hex) — and the selector is loaded from it and written back to it.
//
// Pure: no worker, no scene. `members` is a merge's object order, [{id, faceCount}] as buildMergedSTL lists it —
//  the selector numbers facets across exactly that order.

// The annotations a merge can carry into the selector. Seam and fuzzy-skin paint ride along on the object untouched.
export const PAINT_KINDS = ['color', 'supports']

/** Split a selector export ({facets, hex}: merged numbering, hex newline-joined) back onto each member's own facet
 *  numbering. Every member gets a Map, empty when nothing of it is painted — an erased object must overwrite what
 *  its store held, not keep it. Marks outside every member are dropped: they name no object. */
export function splitPaintByObject(exported, members) {
  const byObject = new Map(members.map(member => [member.id, new Map()]))
  const facets = exported?.facets ?? [], hexLines = String(exported?.hex ?? '').split('\n')
  let at = 0, base = 0
  // Facets arrive ascending (the kernel's serialize walks facets in order), so one pass over the members does it.
  const order = Array.from(facets.keys()).sort((a, b) => facets[a] - facets[b])
  for (const index of order) {
    const facet = facets[index]
    while (at < members.length && facet >= base + members[at].faceCount) { base += members[at].faceCount; at++ }
    if (at >= members.length) break
    if (facet < base || !hexLines[index]) continue
    byObject.get(members[at].id).set(facet - base, hexLines[index])
  }
  return byObject
}

/** Which annotation a merge's paint is loaded from: material paint if any member has it, else support paint. One
 *  facet holds one state, so the two cannot share a selector (the import-time rule, support_paint.js). */
export function paintKindFor(objectsById, members) {
  const has = (kind) => members.some(member => objectsById.get(member.id)?.paint?.[kind]?.size > 0)
  return has('color') ? 'color' : has('supports') ? 'supports' : null
}

/** The store's marks of one kind, rebased onto the merge's numbering — what the worker's importPaint takes. Null
 *  when nothing of that kind is painted. `triangles_to_split` must be ascending, which walking members in merge
 *  order and each object's facets sorted gives. */
export function mergedPaint(objectsById, members, kind) {
  if (!kind) return null
  const facets = [], hex = []
  let base = 0
  for (const member of members) {
    const marks = objectsById.get(member.id)?.paint?.[kind]
    if (marks?.size) for (const local of [...marks.keys()].sort((a, b) => a - b)) {
      if (local >= 0 && local < member.faceCount) { facets.push(base + local); hex.push(marks.get(local)) }
    }
    base += member.faceCount
  }
  return facets.length ? { facets: Int32Array.from(facets), hex: hex.join('\n') } : null
}

/** Write a split export back into the store under `kind`, leaving every other annotation of the object alone. */
export function storePaint(objectsById, byObject, kind) {
  for (const [id, marks] of byObject) {
    const object = objectsById.get(id)
    if (!object) continue
    object.paint = { ...(object.paint ?? {}), [kind]: marks }
  }
}

/** A deep copy of an object's paint, for a copy/duplicate — the copy must not share the original's Maps. */
export function clonePaint(paint) {
  if (!paint) return null
  return Object.fromEntries(Object.entries(paint).map(([kind, marks]) => [kind, marks instanceof Map ? new Map(marks) : marks]))
}

/** The selector states one split-tree hex string uses. Upstream's encoding (TriangleSelector::serialize,
 *  FacetsAnnotation::get_triangle_as_string): the hex is read last digit first, each digit least significant bit
 *  first; a node is 2 bits of split count, then either 2 bits of special side and split+1 children, or — a leaf —
 *  2 bits of state, where 0b11 means 4 more bits of (state - 3). NONE (0) is not a paint state and is not reported.
 *  A malformed string reports what it decoded before the damage. */
export function decodePaintStates(hex, into = new Set()) {
  const bits = []
  for (let i = String(hex).length - 1; i >= 0; i--) {
    const digit = parseInt(hex[i], 16)
    if (Number.isNaN(digit)) return into
    for (let bit = 0; bit < 4; bit++) bits.push((digit >> bit) & 1)
  }
  let at = 0
  const read = (count) => { let value = 0; for (let bit = 0; bit < count; bit++) value |= (bits[at++] ?? 0) << bit; return value }
  const node = (depth) => {
    if (at >= bits.length || depth > 32) return
    const splits = read(2)
    if (splits) { read(2); for (let child = 0; child <= splits; child++) node(depth + 1); return }
    let state = read(2)
    if (state === 3) state = read(4) + 3
    if (state) into.add(state)
  }
  node(0)
  return into
}

/** Painted facet count per state across some objects' stored paint of one kind — the shape the brush reports
 *  (`paintStateCounts`), counted per source facet rather than per sub-facet. Enough to answer "does this plate
 *  change tools", which is all a plate the selector does not hold needs it for. */
export function storedPaintStates(objects, kind = 'color') {
  const counts = {}
  for (const object of objects ?? []) {
    const marks = object?.paint?.[kind]
    if (!marks?.size) continue
    for (const hex of marks.values()) for (const state of decodePaintStates(hex)) counts[state] = (counts[state] ?? 0) + 1
  }
  return counts
}

/** The painted sub-triangles of one object's stored marks, per state, in the object's LOCAL frame — what the
 *  kernel's overlay draws for the plate the selector holds, rebuilt here for every other plate so a plate's paint
 *  stays on screen when another one is being painted. The split rule is upstream's own
 *  (TriangleSelector::perform_split): a split edge gets its exact midpoint, the vertices are rotated to start at the
 *  special side, and the children of 1, 2 or 3 split sides are the ones listed below; the stream holds the children
 *  in REVERSE index order (serialize walks child_idx down to 0, deserialize reads them back that way).
 *  `localPos` is the object's flat vertex array (9 floats per facet, the order the merge sends the kernel).
 *  Returns Map(state -> Float32Array of triangle vertices). */
export function paintTriangles(localPos, marks) {
  const out = new Map()
  const push = (state, tri) => {
    let list = out.get(state); if (!list) out.set(state, list = [])
    for (const vertex of tri) list.push(vertex[0], vertex[1], vertex[2])
  }
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]
  const children = (verts, splits, side) => {
    const v = [verts[side % 3], verts[(side + 1) % 3], verts[(side + 2) % 3]]
    if (splits === 1) { const m = mid(v[2], v[1]); return [[v[0], v[1], m], [m, v[2], v[0]]] }
    if (splits === 2) { const ab = mid(v[1], v[0]), ac = mid(v[0], v[2]); return [[v[0], ab, ac], [ab, v[1], ac], [v[1], v[2], ac]] }
    const ab = mid(v[1], v[0]), bc = mid(v[2], v[1]), ca = mid(v[0], v[2])
    return [[v[0], ab, ca], [ab, v[1], bc], [bc, v[2], ca], [ab, bc, ca]]
  }
  for (const [facet, hex] of marks ?? []) {
    const base = facet * 9
    if (!(base >= 0 && base + 9 <= localPos.length)) continue
    const bits = []
    for (let i = String(hex).length - 1; i >= 0; i--) {
      const digit = parseInt(hex[i], 16)
      if (Number.isNaN(digit)) { bits.length = 0; break }
      for (let bit = 0; bit < 4; bit++) bits.push((digit >> bit) & 1)
    }
    let at = 0
    const read = (count) => { let value = 0; for (let bit = 0; bit < count; bit++) value |= (bits[at++] ?? 0) << bit; return value }
    const node = (verts, depth) => {
      if (at >= bits.length || depth > 32) return
      const splits = read(2)
      if (splits) {
        const side = read(2)
        const kids = children(verts, splits, side)
        for (let child = splits; child >= 0; child--) node(kids[child], depth + 1)
        return
      }
      let state = read(2)
      if (state === 3) state = read(4) + 3
      if (state) push(state, verts)
    }
    node([[localPos[base], localPos[base + 1], localPos[base + 2]], [localPos[base + 3], localPos[base + 4], localPos[base + 5]],
          [localPos[base + 6], localPos[base + 7], localPos[base + 8]]], 0)
  }
  return new Map([...out].map(([state, list]) => [state, Float32Array.from(list)]))
}
