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

/** Which annotation one object's paint is: material paint when it has any, else support paint, else none. One
 *  facet holds one state, so the two cannot share a selector (the import-time rule, support_paint.js). */
export function storedPaintKind(paint) {
  if (paint?.color?.size) return 'color'
  if (paint?.supports?.size) return 'supports'
  return null
}

/** The same choice for a whole merge: material paint if any member has it, else support paint. */
export function paintKindFor(objectsById, members) {
  const has = (kind) => members.some(member => objectsById.get(member.id)?.paint?.[kind]?.size > 0)
  if (has('color')) return 'color'
  if (has('supports')) return 'supports'
  return null
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
  if (!facets.length) return null
  return { facets: Int32Array.from(facets), hex: hex.join('\n') }
}

/** A brush hit's facet in the selector's numbering. A raycast reports the facet in the HIT OBJECT's own numbering,
 *  and the selector numbers across the whole merge, so only the merge's first object used to paint where it was
 *  hit: a stroke on any later one seeded the kernel's flood at the first object's facet of that number, outside
 *  the brush, and marked nothing. Null when the selector does not hold the object (another plate, hidden). */
export function mergedFacetOf(members, objectId, localFacet) {
  let base = 0
  for (const member of members ?? []) {
    if (member.id === objectId) {
      if (!(localFacet >= 0 && localFacet < member.faceCount)) return null
      return base + localFacet
    }
    base += member.faceCount
  }
  return null
}

/** What a pool worker must do to its selector before slicing a plate: 'load' the plate's stored paint, 'clear' the
 *  paint the previous plate left behind (slicing never resets the selector), or nothing. */
export function poolPaintAction(storedPaint, workerHoldsPaint) {
  if (storedPaint) return 'load'
  if (workerHoldsPaint) return 'clear'
  return 'none'
}

/** The extruder count a slice's paint asks for: the highest painted state, since selector state s addresses
 *  extruder s (ENFORCER==Extruder1). Only MATERIAL paint counts — a support blocker is state 2 as well, and read
 *  as a tool it sent a single-filament plate down the multi-material path with a prime tower. 0 means "no ask".
 *  Paint for a filament that is not configured (T3 painted, then the list cut to two) is not counted: the selector
 *  worker only ever reported the configured states and a pool worker reports all of them, so the same plate got
 *  two extruder counts depending on which worker sliced it. */
export function paintedExtruderCount(counts, kind, filamentCount = Infinity) {
  if (kind !== 'color') return 0
  const paintedStates = paintedStatesOf(counts).filter(state => state <= filamentCount)
  if (!paintedStates.length) return 0
  return Math.max(...paintedStates)
}

/** The painted material states above the configured filaments — what paintedExtruderCount leaves out. */
export function paintBeyondFilaments(counts, kind, filamentCount) {
  if (kind !== 'color') return []
  return paintedStatesOf(counts).filter(state => state > filamentCount)
}

const paintedStatesOf = (counts) =>
  Object.entries(counts ?? {}).filter(([, facetCount]) => facetCount > 0).map(([state]) => Number(state))

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
  const copyOf = (marks) => {
    if (marks instanceof Map) return new Map(marks)
    return marks
  }
  return Object.fromEntries(Object.entries(paint).map(([kind, marks]) => [kind, copyOf(marks)]))
}

/** An object's paint handed out to the parts it was split into. `partFacets[part]` lists the parent facets that
 *  part holds, in the part's own facet order; every annotation follows its facet. A part with no marks gets null. */
export function splitPaintByParts(paint, partFacets) {
  const partOf = new Map()
  partFacets.forEach((facets, part) => facets.forEach((parentFacet, localFacet) => partOf.set(parentFacet, [part, localFacet])))
  const parts = partFacets.map(() => null)
  for (const [kind, marks] of Object.entries(paint ?? {})) {
    if (!(marks instanceof Map)) continue
    for (const [parentFacet, hex] of marks) {
      const owner = partOf.get(parentFacet)
      if (!owner) continue
      const [part, localFacet] = owner
      parts[part] ??= {}
      parts[part][kind] ??= new Map()
      parts[part][kind].set(localFacet, hex)
    }
  }
  return parts
}

// Upstream's split-tree encoding (TriangleSelector::serialize, FacetsAnnotation::get_triangle_as_string): the hex
//  is read LAST digit first, each digit least significant bit first. A node starts with the number of split sides;
//  a split node then names its special side and is followed by (split sides + 1) children, in REVERSE index order;
//  a leaf names its state, where the marker value means "the state is in the next bits, offset by the marker".
const BITS_PER_HEX_DIGIT = 4
const SPLIT_SIDES_BITS = 2
const SPECIAL_SIDE_BITS = 2
const STATE_BITS = 2
const EXTENDED_STATE_MARKER = 3      // 0b11: the state did not fit in STATE_BITS
const EXTENDED_STATE_BITS = 4
const EXTENDED_STATE_OFFSET = 3      // the extended field stores (state - 3)
const MAX_SPLIT_DEPTH = 32           // a guard against a malformed string, far past any real subdivision
const FLOATS_PER_FACET = 9           // three vertices of x, y, z

/** Walk one facet's split tree. `onLeaf(state, triangle)` is called for every painted leaf (NONE is skipped);
 *  `rootTriangle` (three [x, y, z]) is subdivided along the way when given, and null when only states matter.
 *  A malformed string stops at the damage and reports what came before it. */
function walkSplitTree(hex, rootTriangle, onLeaf) {
  const digits = String(hex)
  const bits = []
  for (let digitIndex = digits.length - 1; digitIndex >= 0; digitIndex--) {
    const digitValue = parseInt(digits[digitIndex], 16)
    if (Number.isNaN(digitValue)) break
    for (let bitIndex = 0; bitIndex < BITS_PER_HEX_DIGIT; bitIndex++) bits.push((digitValue >> bitIndex) & 1)
  }
  let readPosition = 0
  const readBits = (bitCount) => {
    let value = 0
    for (let bitIndex = 0; bitIndex < bitCount; bitIndex++) value |= (bits[readPosition++] ?? 0) << bitIndex
    return value
  }
  const visitNode = (triangle, depth) => {
    if (readPosition >= bits.length || depth > MAX_SPLIT_DEPTH) return
    const splitSides = readBits(SPLIT_SIDES_BITS)
    if (splitSides) {
      const specialSide = readBits(SPECIAL_SIDE_BITS)
      let childTriangles = null
      if (triangle) childTriangles = splitTriangle(triangle, splitSides, specialSide)
      for (let childIndex = splitSides; childIndex >= 0; childIndex--) visitNode(childTriangles?.[childIndex] ?? null, depth + 1)
      return
    }
    let state = readBits(STATE_BITS)
    if (state === EXTENDED_STATE_MARKER) state = readBits(EXTENDED_STATE_BITS) + EXTENDED_STATE_OFFSET
    if (state) onLeaf(state, triangle)
  }
  visitNode(rootTriangle, 0)
}

const midpoint = (first, second) => [(first[0] + second[0]) / 2, (first[1] + second[1]) / 2, (first[2] + second[2]) / 2]

/** Upstream's TriangleSelector::perform_split: the vertices rotated to start at the special side, a split edge cut
 *  at its exact midpoint, and the children in upstream's index order. */
function splitTriangle(triangle, splitSides, specialSide) {
  const first = triangle[specialSide % 3], second = triangle[(specialSide + 1) % 3], third = triangle[(specialSide + 2) % 3]
  if (splitSides === 1) {
    const thirdSecondMid = midpoint(third, second)
    return [[first, second, thirdSecondMid], [thirdSecondMid, third, first]]
  }
  if (splitSides === 2) {
    const secondFirstMid = midpoint(second, first), firstThirdMid = midpoint(first, third)
    return [[first, secondFirstMid, firstThirdMid], [secondFirstMid, second, firstThirdMid], [second, third, firstThirdMid]]
  }
  const secondFirstMid = midpoint(second, first), thirdSecondMid = midpoint(third, second), firstThirdMid = midpoint(first, third)
  return [[first, secondFirstMid, firstThirdMid], [secondFirstMid, second, thirdSecondMid],
          [thirdSecondMid, third, firstThirdMid], [secondFirstMid, thirdSecondMid, firstThirdMid]]
}

/** The selector states one split-tree hex string uses. NONE (0) is not a paint state and is not reported. */
export function decodePaintStates(hex, into = new Set()) {
  walkSplitTree(hex, null, (state) => into.add(state))
  return into
}

/** Painted facet count per state across some objects' stored paint of one kind — the shape the brush reports
 *  (`paintStateCounts`), counted per source facet rather than per sub-facet. Enough to answer "does this plate
 *  change tools", which is all a plate the selector does not hold needs it for. */
//  A stored marks Map is never mutated (a write-back, a copy and a split each put a NEW Map on the object), so the
//  counts are cached per Map: the tower box asks on every brush stroke, and decoding 200k stored marks took 23ms.
const statesOfMarks = new WeakMap()
export function storedPaintStates(objects, kind = 'color') {
  const counts = {}
  for (const object of objects ?? []) {
    const marks = object?.paint?.[kind]
    if (!marks?.size) continue
    let marksCounts = statesOfMarks.get(marks)
    if (!marksCounts) {
      marksCounts = {}
      for (const hex of marks.values()) for (const state of decodePaintStates(hex)) marksCounts[state] = (marksCounts[state] ?? 0) + 1
      statesOfMarks.set(marks, marksCounts)
    }
    for (const [state, count] of Object.entries(marksCounts)) counts[state] = (counts[state] ?? 0) + count
  }
  return counts
}

/** The painted sub-triangles of one object's stored marks, per state, in the object's LOCAL frame — what the
 *  kernel's overlay draws for the plate the selector holds, rebuilt here for every other plate so a plate's paint
 *  stays on screen when another one is being painted (the split rule is splitTriangle's, upstream's own).
 *  `localPos` is the object's flat vertex array (FLOATS_PER_FACET per facet, the order the merge sends the kernel).
 *  Returns Map(state -> Float32Array of triangle vertices). */
export function paintTriangles(localPos, marks) {
  const verticesByState = new Map()
  for (const [facet, hex] of marks ?? []) {
    const facetStart = facet * FLOATS_PER_FACET
    if (!(facetStart >= 0 && facetStart + FLOATS_PER_FACET <= localPos.length)) continue
    const vertexAt = (vertexIndex) => [localPos[facetStart + vertexIndex * 3], localPos[facetStart + vertexIndex * 3 + 1], localPos[facetStart + vertexIndex * 3 + 2]]
    walkSplitTree(hex, [vertexAt(0), vertexAt(1), vertexAt(2)], (state, triangle) => {
      let vertices = verticesByState.get(state)
      if (!vertices) verticesByState.set(state, vertices = [])
      for (const vertex of triangle) vertices.push(vertex[0], vertex[1], vertex[2])
    })
  }
  return new Map([...verticesByState].map(([state, vertices]) => [state, Float32Array.from(vertices)]))
}
