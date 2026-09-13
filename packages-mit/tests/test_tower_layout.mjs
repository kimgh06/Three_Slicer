// Prime tower placement — the stand-in must land where the slicer will actually put the tower.
//   Run: node packages/viewer/test_tower_layout.mjs
import assert from 'node:assert'
import { towerBoxes, chosenTowerCoord, usesMultipleTools, towerResultStats } from './src/core/tower_layout.js'
import { platePosition } from './src/core/plate_layout.js'

const BED = { bedWidth: 200, bedDepth: 200 }
const SIZE = 15                                   // the fallback ring's footprint
const plateOrigin = (plate) => platePosition(plate, 4, BED.bedWidth, BED.bedDepth)
// A 20mm cube in the middle of plate `p`, in the world coordinates modelBounds reports.
const cubeOn = (plate) => {
  const o = plateOrigin(plate)
  return { minX: o.x - 10, maxX: o.x + 10, minY: -o.z - 10, maxY: -o.z + 10, height: 20 }
}

// ---- reading the setting: per-plate array, legacy scalar, and "not chosen" ----
assert.ok(Number.isNaN(chosenTowerCoord({}, 'wipe_tower_x', 0)), 'absent = auto')
assert.ok(Number.isNaN(chosenTowerCoord({ wipe_tower_x: '' }, 'wipe_tower_x', 0)), 'empty string = auto')
assert.ok(Number.isNaN(chosenTowerCoord({ wipe_tower_x: [10, null] }, 'wipe_tower_x', 1)), 'a hole = auto for that plate only')
assert.equal(chosenTowerCoord({ wipe_tower_x: [10, 20] }, 'wipe_tower_x', 1), 20)
assert.equal(chosenTowerCoord({ wipe_tower_x: 30 }, 'wipe_tower_x', 2), 30, 'a legacy scalar applies to every plate')
assert.equal(chosenTowerCoord({ wipe_tower_x: '42' }, 'wipe_tower_x', 0), 42, 'settings arrive as strings from a 3mf')

// ---- no model on a plate -> no box for it; no model anywhere -> null ----
assert.equal(towerBoxes({ plateCount: 2, size: SIZE, ...BED, settings: {}, modelBounds: () => null, plateOrigin }), null)
{
  const boxes = towerBoxes({ plateCount: 3, size: SIZE, ...BED, settings: {}, plateOrigin,
    modelBounds: (plate) => (plate === 1 ? cubeOn(1) : null) })
  assert.equal(boxes.length, 1)
  assert.equal(boxes[0].plate, 1, 'the box carries the plate it belongs to')
}

// ---- auto: one 5mm gap to the model's LEFT, level with the model's middle ----
{
  const [box] = towerBoxes({ plateCount: 1, size: SIZE, ...BED, settings: {}, plateOrigin,
    modelBounds: () => cubeOn(0) })
  //  model minX = -10, gap 5, half the footprint 7.5  ->  -22.5
  assert.equal(box.x, -22.5)
  assert.equal(box.y, 0, 'level with the middle of a centred model')
  assert.equal(box.height, 20)
  assert.equal(box.size, SIZE)
}

// ---- auto placement is clamped to the bed rather than running off it ----
{
  const [box] = towerBoxes({ plateCount: 1, size: SIZE, ...BED, settings: {}, plateOrigin,
    modelBounds: () => ({ minX: -100, maxX: -80, minY: 95, maxY: 105, height: 20 }) })
  assert.equal(box.x, -100 + SIZE / 2, 'clamped to the left bed edge, not past it')
  assert.equal(box.y, 100 - SIZE / 2, 'clamped to the far bed edge')
}

// ---- a chosen position is a BED coordinate (corner origin), the box is world-centred ----
{
  const [box] = towerBoxes({ plateCount: 1, size: SIZE, ...BED, settings: { wipe_tower_x: 0, wipe_tower_y: 0 },
    plateOrigin, modelBounds: () => cubeOn(0) })
  //  (0,0) is the bed's near-left CORNER, so the box centre sits half a footprint in from it.
  assert.equal(box.x, -100 + SIZE / 2)
  assert.equal(box.y, -100 + SIZE / 2)
}
{
  // Dead centre of the bed = corner coordinate (100 - size/2).
  const centre = 100 - SIZE / 2
  const [box] = towerBoxes({ plateCount: 1, size: SIZE, ...BED,
    settings: { wipe_tower_x: centre, wipe_tower_y: centre }, plateOrigin, modelBounds: () => cubeOn(0) })
  assert.equal(box.x, 0); assert.equal(box.y, 0)
}

// ---- per plate: the plate's own origin is the only conversion, so plate 1's tower is plate 1's ----
{
  const boxes = towerBoxes({ plateCount: 2, size: SIZE, ...BED, settings: {}, plateOrigin,
    modelBounds: (plate) => cubeOn(plate) })
  const origin1 = plateOrigin(1)
  assert.equal(boxes[0].x, -22.5)
  assert.equal(boxes[1].x, origin1.x - 22.5, 'the same offset, measured from plate 1s own origin')
  assert.equal(boxes[1].y, -origin1.z, 'model y maps to three -z')
}
{
  // A hole in the array leaves that plate on auto while the other keeps its chosen spot.
  const boxes = towerBoxes({ plateCount: 2, size: SIZE, ...BED, plateOrigin,
    settings: { wipe_tower_x: [0, null], wipe_tower_y: [0, null] }, modelBounds: (plate) => cubeOn(plate) })
  assert.equal(boxes[0].x, -100 + SIZE / 2, 'plate 0 keeps its chosen corner')
  assert.equal(boxes[1].x, plateOrigin(1).x - 22.5, 'plate 1 falls back to auto')
}

// ---- a flat model still gets a box tall enough to see ----
{
  const [box] = towerBoxes({ plateCount: 1, size: SIZE, ...BED, settings: {}, plateOrigin,
    modelBounds: () => ({ minX: -10, maxX: 10, minY: -10, maxY: 10, height: 0 }) })
  assert.equal(box.height, 2)
}

// ---- the real WipeTower footprint is wider, and the auto gap follows it ----
{
  const [box] = towerBoxes({ plateCount: 1, size: 30, ...BED, settings: {}, plateOrigin,
    modelBounds: () => cubeOn(0) })
  assert.equal(box.size, 30)
  assert.equal(box.x, -10 - 5 - 15)
}

// ---- a tower exists for a TOOL CHANGE, not for a second filament being loaded ----
// The stand-in used to draw whenever two filaments existed, so a single model on T1 printed beside a green box
//  the slice would never build: `extruder_count` stays 1, no `T` command is emitted, no tower is generated.
{
  const onT1 = [{ extruder: 1, visible: true }, { extruder: 1, visible: true }]
  assert.equal(usesMultipleTools(onT1, {}), false, 'everything on one extruder switches nothing')
  assert.equal(usesMultipleTools([{ extruder: 1, visible: true }, { extruder: 2, visible: true }], {}), true,
    'two objects on different extruders do')
  // A hidden object is not sliced, so it cannot cause a tool change either.
  assert.equal(usesMultipleTools([{ extruder: 1, visible: true }, { extruder: 2, visible: false }], {}), false,
    'a hidden object on the second extruder does not')
  // Material paint assigns tools per facet, which whole-object assignment cannot see — state s addresses
  //  extruder s, and state 1 IS the default tool, so only 2 and up are a switch.
  assert.equal(usesMultipleTools(onT1, { 1: 500 }), false, 'painting in state 1 alone is still the default tool')
  assert.equal(usesMultipleTools(onT1, { 2: 12 }), true, 'paint reaching extruder 2 does')
  assert.equal(usesMultipleTools(onT1, { 3: 0 }), false, 'a state with no painted facets does not')
  // An unassigned object defaults to T1 rather than to "unknown", which would otherwise read as a second tool.
  assert.equal(usesMultipleTools([{ visible: true }, { extruder: 1, visible: true }], {}), false,
    'an object with no extruder set counts as T1')
  assert.equal(usesMultipleTools([], {}), false, 'an empty plate switches nothing')
  assert.equal(usesMultipleTools(undefined, undefined), false, 'missing inputs do not throw')
}

{
  // The tower's result, read off the last slice. Tool changes come from the G-CODE, not from the stats block: the
  // kernel only reports them when the (opt-in) stats are switched on, and the card must render either way.
  const gcode = 'G1 X1\nT0\nG1 X2\nT1\nG1 X3\nT0\nM104 S200\n'
  const stats = towerResultStats({ stats: { filament_mm_purge: 1197.9 }, gcode },
                                 { prime_tower_x: 170, prime_tower_y: 170 })
  assert.deepEqual(stats, { purge: 1197.9, changes: 3, x: 170, y: 170 })
  // `T0` has to be anchored: an `M104 T0` or an `;T0` comment is not a tool change.
  assert.equal(towerResultStats({ stats: { filament_mm_purge: 0 }, gcode: 'M104 S200 T0\n;T1\n' }, {}).changes, 0)
  // No purge number means no tower ran — the card shows its settings and no result, rather than a zeroed one.
  assert.equal(towerResultStats({ stats: {}, gcode }, {}), null)
  assert.equal(towerResultStats(undefined, undefined), null)
}

console.log('tower_layout: ok')
