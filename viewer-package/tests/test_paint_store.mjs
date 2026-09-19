// The per-object paint store (core/paint_store.js): splitting a selector export per object, rebuilding a merge's
//  import from the store, and reading a stored mark's states without a kernel.
//   Run: node viewer-package/tests/test_paint_store.mjs
// The kernel side of the same strings is packages/wasm-core/tests/test_paint_export.mjs ("the viewer store ...").
import assert from 'node:assert'
import { splitPaintByObject, mergedPaint, paintKindFor, storePaint, clonePaint, decodePaintStates, storedPaintStates, poolPaintAction, splitPaintByParts, paintedExtruderCount } from '../src/core/paint_store.js'
import { splitComponentFacets, facetPositions } from '../src/scene/model_loaders.js'

// An unsplit facet's hex per state, as upstream writes it (test_paint_export.mjs pins these against the kernel).
const HEX_OF_STATE = { 1: '4', 2: '8', 3: '0C', 5: '2C' }
const HEX_NONE = '0'
// A facet split once (1 split side, special side 0) into two leaves, state 2 then state 1, in stream order:
//  split=01, side=00, leaf 2 = 00 01, leaf 1 = 00 10 -> nibbles 1,8,4 (LSB first) -> read last-first -> "481".
const HEX_SPLIT_STATES_1_AND_2 = '481'
const HEX_MALFORMED = 'zz'

// Three objects in merge order, and where each one starts in the merged numbering.
const FIRST = { id: 3, faceCount: 4 }, SECOND = { id: 1, faceCount: 2 }, THIRD = { id: 8, faceCount: 5 }
const members = [FIRST, SECOND, THIRD]
const SECOND_BASE = FIRST.faceCount, THIRD_BASE = FIRST.faceCount + SECOND.faceCount
const PAST_THE_END = THIRD_BASE + THIRD.faceCount   // a merged facet no member owns
const joined = (...hexes) => hexes.join('\n')

// ---- split: merged numbering -> each object's own, every member present ----
{
  const exported = {
    facets: [0, FIRST.faceCount - 1, SECOND_BASE, THIRD_BASE + 1, THIRD_BASE + 4, PAST_THE_END],
    hex: joined(HEX_OF_STATE[1], HEX_OF_STATE[2], HEX_OF_STATE[3], HEX_OF_STATE[2], HEX_OF_STATE[1], 'F'),
  }
  const split = splitPaintByObject(exported, members)
  assert.deepEqual([...split.get(FIRST.id)], [[0, HEX_OF_STATE[1]], [FIRST.faceCount - 1, HEX_OF_STATE[2]]], 'the first object owns its own facets')
  assert.deepEqual([...split.get(SECOND.id)], [[0, HEX_OF_STATE[3]]], 'the second object starts after the first')
  assert.deepEqual([...split.get(THIRD.id)], [[1, HEX_OF_STATE[2]], [4, HEX_OF_STATE[1]]], 'the third one after both; a facet past the end names no object')
  // An erased object must come back as an EMPTY map, or the store would keep what the selector no longer has.
  const erased = splitPaintByObject({ facets: [THIRD_BASE + 1], hex: HEX_OF_STATE[2] }, members)
  assert.equal(erased.get(FIRST.id).size, 0); assert.equal(erased.get(SECOND.id).size, 0)
  assert.equal(splitPaintByObject(null, members).get(THIRD.id).size, 0, 'no export at all empties every member')
  // Order of the export does not matter.
  const reversed = splitPaintByObject({ facets: [THIRD_BASE + 1, 0], hex: joined('C', HEX_OF_STATE[1]) }, members)
  assert.deepEqual([...reversed.get(THIRD.id)], [[1, 'C']])
}

// ---- store -> merge import, and back ----
{
  const seamOnly = new Map([[0, HEX_OF_STATE[1]]])
  const objects = new Map([[FIRST.id, { id: FIRST.id }], [SECOND.id, { id: SECOND.id, paint: { seam: seamOnly } }], [THIRD.id, { id: THIRD.id }]])
  const firstLocal = 1, secondLocal = 1, thirdLocal = 3
  const exported = { facets: [SECOND_BASE + secondLocal, firstLocal, THIRD_BASE + thirdLocal], hex: joined(HEX_OF_STATE[2], HEX_OF_STATE[1], HEX_OF_STATE[3]) }
  storePaint(objects, splitPaintByObject(exported, members), 'color')
  assert.equal(objects.get(SECOND.id).paint.seam.size, 1, 'other annotations of the object are left alone')
  assert.equal(paintKindFor(objects, members), 'color')
  const merged = mergedPaint(objects, members, 'color')
  assert.deepEqual(Array.from(merged.facets), [firstLocal, SECOND_BASE + secondLocal, THIRD_BASE + thirdLocal], 'ascending, rebased onto the merge')
  assert.equal(merged.hex, joined(HEX_OF_STATE[1], HEX_OF_STATE[2], HEX_OF_STATE[3]))
  // A different merge order (another plate, another extruder sort) rebases the same marks differently.
  const reordered = mergedPaint(objects, [THIRD, FIRST], 'color')
  assert.deepEqual(Array.from(reordered.facets), [thirdLocal, THIRD.faceCount + firstLocal], 'the third object first now, the first one after it')
  assert.equal(mergedPaint(objects, members, 'supports'), null, 'nothing of that kind -> null')
  assert.equal(paintKindFor(new Map(), members), null)
  // Support paint only -> supports is the kind to load.
  const supportOnly = new Map([[FIRST.id, { paint: { supports: new Map([[0, HEX_OF_STATE[1]]]) } }]])
  assert.equal(paintKindFor(supportOnly, members), 'supports')
}

// ---- a copy owns its own Maps ----
{
  const original = { color: new Map([[2, HEX_OF_STATE[2]]]), supports: new Map() }
  const copy = clonePaint(original)
  copy.color.set(5, HEX_OF_STATE[1])
  assert.equal(original.color.size, 1, 'painting the copy does not paint the original')
  assert.equal(clonePaint(null), null)
}

// ---- states from the hex alone ----
{
  for (const [state, hex] of Object.entries(HEX_OF_STATE)) assert.deepEqual([...decodePaintStates(hex)], [Number(state)])
  assert.deepEqual([...decodePaintStates(HEX_NONE)], [], 'NONE is not a paint state')
  assert.deepEqual([...decodePaintStates(HEX_SPLIT_STATES_1_AND_2)].sort(), [1, 2])
  assert.deepEqual([...decodePaintStates(HEX_MALFORMED)], [], 'malformed -> nothing, no throw')
  const objects = [
    { paint: { color: new Map([[0, HEX_OF_STATE[2]], [1, HEX_OF_STATE[3]], [2, HEX_OF_STATE[2]]]) } },
    { paint: null },
    { paint: { supports: new Map([[0, HEX_OF_STATE[1]]]) } },
  ]
  assert.deepEqual(storedPaintStates(objects), { 2: 2, 3: 1 }, 'per state, counted per source facet')
  assert.deepEqual(storedPaintStates(objects, 'supports'), { 1: 1 })
}

// ---- what a pool worker does to its selector before a plate: slicing never resets it ----
{
  const stored = { facets: Int32Array.of(0), hex: HEX_OF_STATE[2] }
  const HOLDS_PAINT = true, EMPTY = false
  assert.equal(poolPaintAction(stored, EMPTY), 'load')
  assert.equal(poolPaintAction(stored, HOLDS_PAINT), 'load', 'a load replaces what was there')
  assert.equal(poolPaintAction(null, HOLDS_PAINT), 'clear', "an unpainted plate after a painted one clears the leftover")
  assert.equal(poolPaintAction(null, EMPTY), 'none')
}

// ---- only material paint widens the extruder count; a support blocker is state 2 too, and is not T2 ----
{
  const BLOCKER_STATE = 2, ENFORCER_STATE = 1, T3_STATE = 3, PAINTED_FACETS = 4
  assert.equal(paintedExtruderCount({ [ENFORCER_STATE]: PAINTED_FACETS, [BLOCKER_STATE]: PAINTED_FACETS }, 'supports'), 0, 'support paint asks for no tool')
  assert.equal(paintedExtruderCount({ [BLOCKER_STATE]: PAINTED_FACETS }, null), 0, 'an unknown annotation asks for none either')
  assert.equal(paintedExtruderCount({ [BLOCKER_STATE]: PAINTED_FACETS, [T3_STATE]: 0 }, 'color'), BLOCKER_STATE, 'material paint asks for its highest painted tool')
  assert.equal(paintedExtruderCount(null, 'color'), 0)
}

// ---- a split hands each mark to the part that holds its facet, at that part's own index ----
{
  // Two tetrahedra, far apart, with their facets interleaved so a part's local index differs from the parent's.
  const TETRA = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]]
  const TETRA_FACES = [[0, 2, 1], [0, 1, 3], [1, 2, 3], [0, 3, 2]]
  const APART_MM = 10
  const facetOf = (shift, face) => face.flatMap(corner => TETRA[corner].map((coordinate, axis) => coordinate + (axis === 0) * shift))
  const parentFacets = TETRA_FACES.flatMap(face => [facetOf(0, face), facetOf(APART_MM, face)])
  const localPos = Float32Array.from(parentFacets.flat())
  const partFacets = splitComponentFacets(localPos)
  assert.equal(partFacets.length, 2)
  const parts = partFacets.map(faces => facetPositions(localPos, faces))
  const MARKED_COLOR = 5, MARKED_SUPPORT = 2, MARKED_SEAM = 7
  const paint = { color: new Map([[MARKED_COLOR, HEX_OF_STATE[3]]]), supports: new Map([[MARKED_SUPPORT, HEX_OF_STATE[1]]]), seam: new Map([[MARKED_SEAM, HEX_OF_STATE[2]]]) }
  const partPaint = splitPaintByParts(paint, partFacets)
  const FLOATS_PER_FACET = 9
  const positionsOfPart = (part, facet) => Array.from(parts[part].subarray(facet * FLOATS_PER_FACET, (facet + 1) * FLOATS_PER_FACET))
  for (const [kind, marks] of Object.entries(paint)) {
    const [[parentFacet, hex]] = marks
    const owner = partPaint.findIndex(part => part?.[kind]?.size)
    const [[localFacet, movedHex]] = partPaint[owner][kind]
    assert.equal(movedHex, hex, `${kind}: the mark keeps its split tree`)
    assert.deepEqual(positionsOfPart(owner, localFacet), parentFacets[parentFacet], `${kind}: the mark lands on the same triangle`)
  }
  assert.equal(splitPaintByParts(null, partFacets).every(part => part === null), true, 'an unpainted parent gives unpainted parts')
}

console.log('paint_store: ok')
