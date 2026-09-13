// buildMergedSTL / exportObjects — the single owner of the kernel's facet numbering (AGENTS.md).
//   Run: node packages/viewer/test_merge_stl.mjs
// The body moved out of use_three_scene.js verbatim; these assertions are what stops it drifting from here on.
import assert from 'node:assert'
import * as THREE from 'three'
import { buildMergedSTL, exportObjects, sortByExtruder, plateOfObject } from './src/core/model_geometry.js'
import { platePosition } from './src/core/plate_layout.js'

const GRID = { plateCount: 4, bedWidth: 200, bedDepth: 200 }

// One axis-aligned triangle per call, so facet counts stay countable by hand.
const tri = (i) => [0, 0, 0, 1 + i, 0, 0, 0, 1 + i, 0]
const makeObject = (id, { extruder = 1, faces = 1, at = [0, 0, 0], paint = null, name = `obj${id}` } = {}) => {
  const localPos = new Float32Array([].concat(...Array.from({ length: faces }, (_, k) => tri(k))))
  const matrixWorld = new THREE.Matrix4().makeTranslation(at[0], at[1], at[2])
  return { id, name, extruder, localPos, paint, matrixWorld }
}
const stlTriangleCount = (buf) => new DataView(buf).getUint32(80, true)
// The first vertex of facet `t` in the binary STL: 84 header + 50/facet, 12 of which are the normal.
const stlVertex = (buf, t) => {
  const dv = new DataView(buf), o = 84 + t * 50 + 12
  return [dv.getFloat32(o, true), dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true)]
}

// ---- empty in, null out (the slicer treats that as "nothing on this plate") ----
assert.equal(buildMergedSTL([], { plateIndex: 0, ...GRID }), null)
assert.equal(buildMergedSTL([makeObject(1, { at: [0, 0, 0] })], { plateIndex: 2, ...GRID }), null)

// ---- the STL container: 84-byte header, count at offset 80, 50 bytes per facet ----
{
  const merged = buildMergedSTL([makeObject(1, { faces: 3 })], { plateIndex: 0, ...GRID })
  assert.equal(stlTriangleCount(merged.buf), 3)
  assert.equal(merged.buf.byteLength, 84 + 3 * 50)
  assert.equal(merged.extruders, 1)
}

// ---- three(x,y,z) -> model(x,-z,y): the frame the kernel slices in ----
{
  // A single vertex at three (5, 7, 9) must come out as model (5, -9, 7).
  const o = makeObject(1)
  o.localPos = new Float32Array([5, 7, 9, 5, 7, 9, 5, 7, 9])
  const merged = buildMergedSTL([o], { plateIndex: 0, ...GRID })
  assert.deepEqual(stlVertex(merged.buf, 0), [5, -9, 7])
}

// ---- the slice frame is the PLATE, not the model: the plate origin is subtracted ----
{
  const origin = platePosition(3, GRID.plateCount, GRID.bedWidth, GRID.bedDepth)   // {x:240, z:240}
  const o = makeObject(1, { at: [origin.x, 0, origin.z] })
  const merged = buildMergedSTL([o], { plateIndex: 3, ...GRID })
  // Placed exactly on plate 3's origin, so in plate-local coordinates it sits back at (0,0).
  assert.deepEqual(stlVertex(merged.buf, 0), [0, -0, 0])
  assert.equal(merged.plate, 3)
  assert.equal(merged.offX, origin.x)          // toolpath display offset puts the plate back where it lives
  assert.equal(merged.offZ, origin.z)
  // Position invariance: the same object on plate 0 slices to the same local coordinates.
  const onPlate0 = buildMergedSTL([makeObject(1)], { plateIndex: 0, ...GRID })
  assert.deepEqual(stlVertex(onPlate0.buf, 0), stlVertex(merged.buf, 0))
}

// ---- plateIndex null falls back to the selected plate, and skips the plate filter ----
{
  const far = makeObject(1, { at: [240, 0, 240] })       // on plate 3
  const near = makeObject(2, { at: [0, 0, 0] })          // on plate 0
  const merged = buildMergedSTL([far, near], { plateIndex: null, selectedPlate: 1, ...GRID })
  assert.equal(stlTriangleCount(merged.buf), 2, 'no plate filter when plateIndex is null')
  assert.equal(merged.plate, 1, 'the selected plate is what the result reports')
}

// ---- extruder sort + one boundary PER change, with the real tool number of each group ----
{
  // Deliberately out of order, and with T2 unused: upstream folds nothing, tools carries 0 and 2.
  const objects = [makeObject(1, { extruder: 3, faces: 2 }), makeObject(2, { extruder: 1, faces: 5 })]
  const merged = buildMergedSTL(objects, { plateIndex: 0, ...GRID })
  assert.deepEqual(merged.tools, [0, 2], 'tools are 0-based real extruders, not group indices')
  assert.deepEqual(merged.splits, [5], 'the boundary sits after T1s 5 facets')
  assert.equal(merged.split, 5, 'the legacy scalar is the start of the first extruder >= 2')
  assert.equal(merged.extruders, 2)
  // T1 sorts first regardless of input order.
  assert.equal(merged.topology, '2:1:5|1:3:2')
}
{
  // Three tools -> two boundaries. A single boundary would print T3 with T2's material.
  const objects = [makeObject(1, { extruder: 1, faces: 1 }), makeObject(2, { extruder: 2, faces: 2 }), makeObject(3, { extruder: 3, faces: 4 })]
  const merged = buildMergedSTL(objects, { plateIndex: 0, ...GRID })
  assert.deepEqual(merged.tools, [0, 1, 2])
  assert.deepEqual(merged.splits, [1, 3])
  assert.equal(merged.split, 1)
}

// ---- topology: the key the paint selector is kept or dropped on. A MOVE must not change it. ----
{
  const still = buildMergedSTL([makeObject(7, { extruder: 2, faces: 3 })], { plateIndex: 0, ...GRID })
  const moved = buildMergedSTL([makeObject(7, { extruder: 2, faces: 3, at: [10, 0, 10] })], { plateIndex: 0, ...GRID })
  assert.equal(still.topology, moved.topology, 'a move must not renumber facets, so it must not cost the paint')
  assert.equal(still.topology, '7:2:3')
}

// ---- 3mf paint rebasing: per-object facet indices -> the merged numbering, in merge order ----
{
  const painted = (id, extruder, faces, colorPairs) => makeObject(id, {
    extruder, faces, paint: { color: new Map(colorPairs), supports: new Map() },
  })
  // T1 object has 5 facets, so the T3 object's local facet 0 becomes merged facet 5.
  const objects = [painted(1, 3, 2, [[0, '0C'], [1, '04']]), painted(2, 1, 5, [[3, '08']])]
  const merged = buildMergedSTL(objects, { plateIndex: 0, ...GRID })
  assert.deepEqual([...merged.paint.color.facets], [3, 5, 6])
  assert.equal(merged.paint.color.hex, '08\n0C\n04')     // hex order follows the facet order
  assert.equal(merged.paint.supports, null, 'an unpainted slot is null, not an empty pair')
}

// ---- the content box, in slice coordinates ----
{
  const o = makeObject(1)
  o.localPos = new Float32Array([0, 0, 0, 10, 0, 0, 0, 0, -4])   // model y = -z, so z=-4 -> y=+4
  const merged = buildMergedSTL([o], { plateIndex: 0, ...GRID })
  assert.equal(merged.minX, 0); assert.equal(merged.maxX, 10)
  assert.equal(merged.minY, 0); assert.equal(merged.maxY, 4)
}

// ---- exportObjects: same sort and same frame, but per object and NOT merged ----
{
  const objects = [makeObject(1, { extruder: 2, faces: 2 }), makeObject(2, { extruder: 1, faces: 3, at: [240, 0, 0] })]
  const out = exportObjects(objects, GRID)
  assert.deepEqual(out.map(o => o.id), [2, 1], 'the same extruder sort buildMergedSTL applies')
  assert.deepEqual(out.map(o => o.faceCount), [3, 2], 'facet counts stay per object')
  assert.equal(out[0].plate, 1, 'plate membership from the world position')
  assert.equal(out[0].plateOriginX, 240)
  assert.equal(out[0].plateOriginY, -0)
  // Coordinates are world MODEL space here — the plate origin is NOT subtracted (the writer does that itself).
  assert.equal(out[0].tris[3], 240 + 1)
}

// ---- shared helpers ----
assert.deepEqual(sortByExtruder([{ extruder: 3 }, { extruder: undefined }, { extruder: 2 }]).map(o => o.extruder),
  [undefined, 2, 3], 'a missing extruder counts as 1')
assert.equal(plateOfObject(makeObject(1, { at: [240, 0, 240] }), GRID), 3)

// ---- heterogeneous beds: membership and the plate origin follow plateDims ----
{
  // 330 plate beside a 180 plate: plate 1's centre is at x = 330/2 + 40 + 180/2 = 295, not the uniform 240.
  const dims = [{ w: 330, d: 330 }, { w: 180, d: 180 }]
  const grid = { plateCount: 2, bedWidth: 330, bedDepth: 330, plateDims: dims }
  assert.equal(plateOfObject(makeObject(1, { at: [295, 0, 0] }), grid), 1)
  assert.equal(plateOfObject(makeObject(1, { at: [140, 0, 0] }), grid), 0)
  const merged = buildMergedSTL([makeObject(1, { at: [295, 0, 0] })], { plateIndex: 1, ...grid })
  assert.equal(merged.offX, 295, 'display offset is the hetero origin')
  // Plate-local: the object sits AT the hetero origin, so its slice-frame x centres near 0
  assert.ok(Math.abs((merged.minX + merged.maxX) / 2) < 1, 'plate-local frame centred on the hetero origin')
  // Without dims the same call uses the uniform origin (240 + step math) — the two must differ
  const uniform = buildMergedSTL([makeObject(1, { at: [295, 0, 0] })], { plateIndex: 1, plateCount: 2, bedWidth: 330, bedDepth: 330 })
  assert.notEqual(uniform.offX, merged.offX)
}

console.log('merge_stl: ok')
