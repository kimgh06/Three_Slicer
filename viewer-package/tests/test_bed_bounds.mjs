// bed_bounds self-check — the verdict must match the kernel's over_bed rule (pass1.cpp prepare_model):
//  outside [-bed/2, bed/2] on either axis, or taller than printable_height when the profile states one.
//   Run: node viewer-package/tests/test_bed_bounds.mjs
import assert from 'node:assert'
import { bedOverflow, overflowText, footprintOverflow } from '../src/core/bed_bounds.js'
import { convexHull } from '../src/core/convex_hull.js'
import { bedShapeLocal, bedCenter } from '../src/settings/bed_frame.js'

const BED_W = 200, BED_D = 200, BED_H = 250
const origin = { x: 0, z: 0 }
// modelBounds() shape. minY/maxY are already bed-Y (three's z, negated) — the caller does not negate again.
const box = (minX, maxX, minY, maxY, height = 10) => ({ minX, maxX, minY, maxY, height })

// ── fits ────────────────────────────────────────────────────────────────────────
assert.strictEqual(bedOverflow(box(-50, 50, -50, 50), origin, BED_W, BED_D, BED_H), null)
// Exactly on the edge is still on the bed — the kernel's test is strict (>), so touching must not warn.
assert.strictEqual(bedOverflow(box(-100, 100, -100, 100), origin, BED_W, BED_D, BED_H), null)
// An empty plate has nothing to be over.
assert.strictEqual(bedOverflow(null, origin, BED_W, BED_D, BED_H), null)

// ── one axis at a time ──────────────────────────────────────────────────────────
assert.deepStrictEqual(bedOverflow(box(-50, 112, -50, 50), origin, BED_W, BED_D, BED_H), { x: 12, y: 0, z: 0 })
assert.deepStrictEqual(bedOverflow(box(-105, 50, -50, 50), origin, BED_W, BED_D, BED_H), { x: 5, y: 0, z: 0 })
assert.deepStrictEqual(bedOverflow(box(-50, 50, -50, 103), origin, BED_W, BED_D, BED_H), { x: 0, y: 3, z: 0 })
assert.deepStrictEqual(bedOverflow(box(-50, 50, -108, 50), origin, BED_W, BED_D, BED_H), { x: 0, y: 8, z: 0 })

// Overflowing both ends of one axis reports the worse end, not their sum.
assert.deepStrictEqual(bedOverflow(box(-130, 110, -50, 50), origin, BED_W, BED_D, BED_H), { x: 30, y: 0, z: 0 })

// ── height ──────────────────────────────────────────────────────────────────────
assert.deepStrictEqual(bedOverflow(box(-50, 50, -50, 50, 260), origin, BED_W, BED_D, BED_H), { x: 0, y: 0, z: 10 })
// printable_height 0 = the profile states no ceiling, so no height is ever too tall (matches the kernel).
assert.strictEqual(bedOverflow(box(-50, 50, -50, 50, 9999), origin, BED_W, BED_D, 0), null)

// ── plate offset ────────────────────────────────────────────────────────────────
// A plate's contents are judged in ITS frame: the same world box that overflows plate 0 fits plate 1.
const plate1 = { x: 210, z: 0 }
assert.strictEqual(bedOverflow(box(160, 260, -50, 50), plate1, BED_W, BED_D, BED_H), null)
assert.deepStrictEqual(bedOverflow(box(160, 260, -50, 50), origin, BED_W, BED_D, BED_H), { x: 160, y: 0, z: 0 })
// The bed-Y conversion adds origin.z (modelBounds already negated three's z) — a shifted plate must not drift.
assert.strictEqual(bedOverflow(box(-50, 50, 110, 210), { x: 0, z: -160 }, BED_W, BED_D, BED_H), null)

// ── message ─────────────────────────────────────────────────────────────────────
assert.strictEqual(overflowText(null), '')
assert.strictEqual(overflowText({ x: 12, y: 0, z: 0 }), 'X 12.0mm')
assert.strictEqual(overflowText({ x: 1.25, y: 3, z: 8 }), 'X 1.3mm · Y 3.0mm · height 8.0mm')

// ── a bed that is not a rectangle ───────────────────────────────────────────────
// A delta's printable_area is a 72-point circle around the printer's (0,0) (Anycubic Predator: r = 185).
const circle = Array.from({ length: 72 }, (_, i) => [185 * Math.cos(i * Math.PI / 36), 185 * Math.sin(i * Math.PI / 36)])
const deltaCenter = bedCenter({ bed_width: 370, bed_depth: 370, bed_origin_x: -185, bed_origin_y: -185 })
const deltaShape = bedShapeLocal(circle, deltaCenter)
assert.ok(deltaShape && deltaShape.length === 72, 'a circular bed has a shape')
assert.strictEqual(bedShapeLocal([[0, 0], [220, 0], [220, 220], [0, 220]], { x: 110, y: 110 }), null, 'a rectangle has none')
assert.strictEqual(bedShapeLocal(undefined, { x: 0, y: 0 }), null, 'no printable_area has none')
// The hull of a square with a point inside it is the four corners.
assert.deepStrictEqual(convexHull([[0, 0], [10, 0], [5, 5], [10, 10], [0, 10]]), [[0, 0], [10, 0], [10, 10], [0, 10]])
// A 40mm square at the centre fits; the same square in the bounding box's corner fits the box but not the circle.
const square = (cx, cy) => [[cx - 20, cy - 20], [cx + 20, cy - 20], [cx + 20, cy + 20], [cx - 20, cy + 20]]
assert.strictEqual(footprintOverflow(square(0, 0), deltaShape), 0, 'a centred square is on a round bed')
const cornerSquare = square(160, 160)
const past = footprintOverflow(cornerSquare, deltaShape)
// Its far corner (180,180) is sqrt(2)*180 from the centre, the circle's radius 185 short of that.
const expectedPast = Math.hypot(180, 180) - 185
assert.ok(Math.abs(past - expectedPast) < 0.5, `the box corner of a round bed is off it (${past.toFixed(1)} vs ${expectedPast.toFixed(1)}mm past the edge)`)
const cornerBox = box(140, 180, 140, 180)
assert.strictEqual(bedOverflow(cornerBox, origin, 370, 370, 0), null, 'the rectangle test alone passes it')
const overRound = bedOverflow(cornerBox, origin, 370, 370, 0, { shape: deltaShape, footprint: cornerSquare })
assert.ok(overRound && Math.abs(overRound.edge - expectedPast) < 0.5, 'the outline test catches it')
assert.ok(/^bed edge \d+\.\dmm$/.test(overflowText(overRound)), overflowText(overRound))

console.log('bed_bounds: all assertions passed')
