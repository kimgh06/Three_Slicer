// The plate grid — the one rule the scene, the 3mf writer and the G-code injection all have to agree on.
//   Run: node packages/viewer/test_plate_layout.mjs
// Characterization: every expectation below is the value the closure in use_three_scene.js produced before the
//  grid moved into this module, so a change to either function has to be a deliberate one.
import assert from 'node:assert'
import {
  PLATE_GAP, MAX_PLATES, plateStep, plateCols, platePosition, plateIndexAtXZ, plateLayoutHetero, UPSTREAM_PLATE_GAP_RATIO,
  PLACE_GAP, nextPlacement,
} from './src/core/plate_layout.js'

// ---- the constants other modules encode into files ----
assert.equal(PLATE_GAP, 40)
assert.equal(MAX_PLATES, 9)
assert.equal(UPSTREAM_PLATE_GAP_RATIO, 1 / 5)   // write_3mf/model_load re-encode upstream's grid with this
assert.equal(plateStep(200), 240)
assert.equal(plateStep(256), 296)               // the Bambu bed — 296 here vs upstream's 307.2 (see AGENTS.md)

// ---- column count: upstream PartPlate.hpp compute_colum_count, cols ~= ceil(sqrt(n)) ----
assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9].map(plateCols), [1, 2, 2, 2, 3, 3, 3, 3, 3])

// ---- plate 0 is the world origin, so a single-plate project needs no offset at all ----
assert.deepEqual(platePosition(0, 1, 200, 200), { x: 0, z: 0 })

// ---- the grid fills columns first, then rows (rows grow along +z) ----
const grid4 = [0, 1, 2, 3].map(i => platePosition(i, 4, 200, 200))
assert.deepEqual(grid4, [{ x: 0, z: 0 }, { x: 240, z: 0 }, { x: 0, z: 240 }, { x: 240, z: 240 }])

// A non-square bed steps by its own edge on each axis — x by the width, z by the depth.
assert.deepEqual(platePosition(3, 4, 300, 100), { x: 340, z: 140 })

// ---- plateIndexAtXZ is the inverse: every plate centre maps back to its own index ----
for (const count of [1, 2, 3, 4, 5, 9]) {
  for (const [bedWidth, bedDepth] of [[200, 200], [256, 256], [300, 100]]) {
    for (let i = 0; i < count; i++) {
      const p = platePosition(i, count, bedWidth, bedDepth)
      assert.equal(plateIndexAtXZ(p.x, p.z, count, bedWidth, bedDepth), i,
        `round trip failed: plate ${i} of ${count} on ${bedWidth}x${bedDepth}`)
    }
  }
}

// Nearest centre, not containment: anywhere inside a plate's own half-step belongs to it.
assert.equal(plateIndexAtXZ(119, 0, 4, 200, 200), 0)    // just short of the halfway point (120)
assert.equal(plateIndexAtXZ(121, 0, 4, 200, 200), 1)    // just past it

// ---- out of range clamps into the grid rather than returning a plate that does not exist ----
assert.equal(plateIndexAtXZ(-5000, -5000, 4, 200, 200), 0)
assert.equal(plateIndexAtXZ(5000, 5000, 4, 200, 200), 3)
assert.equal(plateIndexAtXZ(5000, 5000, 3, 200, 200), 2)   // 3 plates in a 2-col grid: the last one, not row*cols+col=3
assert.equal(plateIndexAtXZ(0, 0, 1, 200, 200), 0)

// ---- heterogeneous layout: uniform dims reduce EXACTLY to the closed-form grid ----
for (const count of [1, 2, 3, 4, 5, 6, 9]) {
  for (const [w, d] of [[200, 200], [256, 256], [300, 100]]) {
    const layout = plateLayoutHetero(Array.from({ length: count }, () => ({ w, d })))
    for (let i = 0; i < count; i++) {
      assert.deepEqual(layout.position(i), platePosition(i, count, w, d), `hetero position != uniform: plate ${i}/${count} ${w}x${d}`)
    }
    for (const [x, z] of [[0, 0], [119, 0], [121, 0], [-5000, -5000], [5000, 5000], [w + PLATE_GAP, d + PLATE_GAP], [w / 2 + 1, 3]])
      assert.equal(layout.indexAt(x, z), plateIndexAtXZ(x, z, count, w, d), `hetero membership != uniform at (${x},${z}) ${count} plates ${w}x${d}`)
  }
}

// ---- heterogeneous case: a 330 plate beside a 180 plate ----
{
  const layout = plateLayoutHetero([{ w: 330, d: 330 }, { w: 180, d: 180 }])
  assert.deepEqual(layout.position(0), { x: 0, z: 0 })
  // centre-to-centre: 330/2 + 40 + 180/2 = 295
  assert.deepEqual(layout.position(1), { x: 295, z: 0 })
  // membership boundary is the midpoint between centres (147.5), NOT the uniform half-step
  assert.equal(layout.indexAt(147, 0), 0)
  assert.equal(layout.indexAt(148, 0), 1)
  assert.equal(layout.indexAt(10000, 0), 1)
  assert.deepEqual(layout.dims(1), { w: 180, d: 180 })
}
// 4 plates, two rows, mixed depths: the second row's z step uses the FIRST row's deepest plate
{
  const layout = plateLayoutHetero([{ w: 200, d: 300 }, { w: 200, d: 100 }, { w: 200, d: 150 }, { w: 200, d: 150 }])
  // rowD[0]=300, rowD[1]=150 -> z step = 150 + 40 + 75 = 265
  assert.deepEqual(layout.position(2), { x: 0, z: 265 })
  assert.equal(layout.indexAt(0, 264 / 2 + 1), 2)   // past the z midpoint (132.5) belongs to row 1
}

// ---- where a loaded model lands: the first one on the plate's CENTRE, the rest queued to its right ----
{
  // A baked mesh's position is its XZ centre, so "centred" means x == the plate's own x.
  const one = nextPlacement(0, 0, 20)
  assert.equal(one.x, 0, 'a single model must land on the plate centre, not half its width off it')
  assert.equal(one.cursor, 10 + PLACE_GAP)

  // Three models in a row: touching faces are PLACE_GAP apart and the row grows to the right of the centre.
  const widths = [20, 30, 10]
  let cursor = 0, placed = []
  for (const w of widths) { const r = nextPlacement(cursor, 0, w); placed.push({ x: r.x, w }); cursor = r.cursor }
  assert.deepEqual(placed.map(p => p.x), [0, 10 + PLACE_GAP + 15, 10 + PLACE_GAP + 30 + PLACE_GAP + 5])
  for (let i = 1; i < placed.length; i++)
    assert.equal((placed[i].x - placed[i].w / 2) - (placed[i - 1].x + placed[i - 1].w / 2), PLACE_GAP, `gap ${i}`)

  // Several plates: the cursor is plate-relative (the scene zeroes it on a plate switch), so the first model of
  //  each plate lands exactly on THAT plate's centre — for the uniform grid and for a heterogeneous one.
  for (const count of [1, 2, 4, 9]) {
    for (let i = 0; i < count; i++) {
      const pp = platePosition(i, count, 200, 200)
      assert.equal(nextPlacement(0, pp.x, 40).x, pp.x, `plate ${i}/${count} centre`)
    }
  }
  const hetero = plateLayoutHetero([{ w: 330, d: 330 }, { w: 180, d: 180 }])
  assert.equal(nextPlacement(0, hetero.position(1).x, 40).x, 295)
  // ...and a model placed on a plate stays on it: the membership test agrees with the plate it was placed for.
  for (const count of [2, 4, 9]) {
    for (let i = 0; i < count; i++) {
      const pp = platePosition(i, count, 200, 200)
      const r = nextPlacement(0, pp.x, 60)
      assert.equal(plateIndexAtXZ(r.x, pp.z, count, 200, 200), i, `placed model left plate ${i}/${count}`)
      assert.equal(plateIndexAtXZ(nextPlacement(r.cursor, pp.x, 60).x, pp.z, count, 200, 200), i, `2nd model left plate ${i}/${count}`)
    }
  }
}

console.log('plate_layout: ok')
