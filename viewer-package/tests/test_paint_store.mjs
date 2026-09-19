// The per-object paint store (core/paint_store.js): splitting a selector export per object, rebuilding a merge's
//  import from the store, and reading a stored mark's states without a kernel.
//   Run: node viewer-package/tests/test_paint_store.mjs
// The kernel side of the same strings is packages/wasm-core/tests/test_paint_export.mjs ("the viewer store ...").
import assert from 'node:assert'
import { splitPaintByObject, mergedPaint, paintKindFor, storePaint, clonePaint, decodePaintStates, storedPaintStates } from '../src/core/paint_store.js'

const members = [{ id: 3, faceCount: 4 }, { id: 1, faceCount: 2 }, { id: 8, faceCount: 5 }]

// ---- split: merged numbering -> each object's own, every member present ----
{
  const exported = { facets: [0, 3, 4, 7, 10, 11], hex: ['4', '8', '0C', '8', '4', 'F'].join('\n') }
  const split = splitPaintByObject(exported, members)
  assert.deepEqual([...split.get(3)], [[0, '4'], [3, '8']], 'object 3 owns facets 0..3')
  assert.deepEqual([...split.get(1)], [[0, '0C']], 'object 1 starts at 4')
  assert.deepEqual([...split.get(8)], [[1, '8'], [4, '4']], 'object 8 starts at 6; facet 11 names no object')
  // An erased object must come back as an EMPTY map, or the store would keep what the selector no longer has.
  const erased = splitPaintByObject({ facets: [7], hex: '8' }, members)
  assert.equal(erased.get(3).size, 0); assert.equal(erased.get(1).size, 0)
  assert.equal(splitPaintByObject(null, members).get(8).size, 0, 'no export at all empties every member')
  // Order of the export does not matter.
  assert.deepEqual([...splitPaintByObject({ facets: [7, 0], hex: 'C\n4' }, members).get(8)], [[1, 'C']])
}

// ---- store -> merge import, and back ----
{
  const objects = new Map([[3, { id: 3 }], [1, { id: 1, paint: { seam: new Map([[0, '4']]) } }], [8, { id: 8 }]])
  storePaint(objects, splitPaintByObject({ facets: [5, 1, 9], hex: '8\n4\n0C' }, members), 'color')
  assert.equal(objects.get(1).paint.seam.size, 1, 'other annotations of the object are left alone')
  assert.equal(paintKindFor(objects, members), 'color')
  const merged = mergedPaint(objects, members, 'color')
  assert.deepEqual(Array.from(merged.facets), [1, 5, 9], 'ascending, rebased onto the merge')
  assert.equal(merged.hex, '4\n8\n0C')
  // A different merge order (another plate, another extruder sort) rebases the same marks differently.
  const reordered = mergedPaint(objects, [members[2], members[0]], 'color')
  assert.deepEqual(Array.from(reordered.facets), [3, 6], 'object 8 first now: its facet 3 is 3, object 3 facet 1 is 5+1')
  assert.equal(mergedPaint(objects, members, 'supports'), null, 'nothing of that kind -> null')
  assert.equal(paintKindFor(new Map(), members), null)
  // Support paint only -> supports is the kind to load.
  const support = new Map([[3, { paint: { supports: new Map([[0, '4']]) } }]])
  assert.equal(paintKindFor(support, members), 'supports')
}

// ---- a copy owns its own Maps ----
{
  const original = { color: new Map([[2, '8']]), supports: new Map() }
  const copy = clonePaint(original)
  copy.color.set(5, '4')
  assert.equal(original.color.size, 1, 'painting the copy does not paint the original')
  assert.equal(clonePaint(null), null)
}

// ---- states from the hex alone ----
{
  assert.deepEqual([...decodePaintStates('4')], [1])
  assert.deepEqual([...decodePaintStates('8')], [2])
  assert.deepEqual([...decodePaintStates('0C')], [3])
  assert.deepEqual([...decodePaintStates('2C')], [5])
  assert.deepEqual([...decodePaintStates('0')], [], 'NONE is not a paint state')
  // A split node: 1 split side, special side 0, two leaf children (state 2, then state 1). Bits in stream order:
  //  split=01, side=00, leaf 2 = 00 01, leaf 1 = 00 10 -> 1000 0001 0010 (LSB-first per nibble) -> nibbles 1,8,4
  //  read last-first -> "481".
  assert.deepEqual([...decodePaintStates('481')].sort(), [1, 2])
  assert.deepEqual([...decodePaintStates('zz')], [], 'malformed -> nothing, no throw')
  const objects = [{ paint: { color: new Map([[0, '8'], [1, '0C'], [2, '8']]) } }, { paint: null }, { paint: { supports: new Map([[0, '4']]) } }]
  assert.deepEqual(storedPaintStates(objects), { 2: 2, 3: 1 }, 'per state, counted per source facet')
  assert.deepEqual(storedPaintStates(objects, 'supports'), { 1: 1 })
}

console.log('paint_store: ok')
