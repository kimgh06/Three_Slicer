// bed_bounds self-check — the verdict must match the kernel's over_bed rule (pass1.cpp prepare_model):
//  outside [-bed/2, bed/2] on either axis, or taller than printable_height when the profile states one.
//   Run: node packages/viewer/test_bed_bounds.mjs
import assert from 'node:assert'
import { bedOverflow, overflowText } from './src/core/bed_bounds.js'

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

console.log('bed_bounds: all assertions passed')
