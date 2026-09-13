// The bed grid's arithmetic — upstream Bed_2D's cell ladder and the corner-origin layout.
//   Run: node packages/viewer/test_bed_grid.mjs
import assert from 'node:assert'
import { gridCellSize, bedGridLines } from './src/core/bed_grid.js'

// ---- the spacing ladder, keyed on the SHORTER edge ----
assert.equal(gridCellSize(200, 200), 10)
assert.equal(gridCellSize(256, 256), 10)
assert.equal(gridCellSize(600, 600), 20)
assert.equal(gridCellSize(1200, 1200), 50)
assert.equal(gridCellSize(6000, 6000), 100)
assert.equal(gridCellSize(6000, 200), 10, 'the shorter side decides, not the longer')
assert.equal(gridCellSize(599, 599), 10, 'the ladder steps at 600, not below it')

// ---- a 200x200 bed: 21 lines each way (0..200 at 10mm), every 5th bold ----
{
  const { thin, bold } = bedGridLines(200, 200)
  const segments = (a) => a.length / 6      // 6 floats per segment (two xyz points)
  assert.equal(segments(thin) + segments(bold), 21 + 21)
  // i = 0, 5, 10, 15, 20 are bold on each axis -> 5 per axis
  assert.equal(segments(bold), 10)
  assert.equal(segments(thin), 32)
}

// ---- centred on the plate's own origin: the grid spans -w/2..+w/2 exactly ----
{
  const { thin, bold } = bedGridLines(200, 200)
  const xs = [], zs = []
  for (const a of [thin, bold]) for (let i = 0; i < a.length; i += 3) { xs.push(a[i]); zs.push(a[i + 2]) }
  assert.equal(Math.min(...xs), -100); assert.equal(Math.max(...xs), 100)
  assert.equal(Math.min(...zs), -100); assert.equal(Math.max(...zs), 100)
  assert.ok([thin, bold].every(a => { for (let i = 1; i < a.length; i += 3) if (a[i] !== 0) return false; return true }),
    'the grid is flat on the bed plane')
}

// ---- a non-square bed spans its own width and depth ----
{
  const { thin, bold } = bedGridLines(300, 100)
  const xs = [], zs = []
  for (const a of [thin, bold]) for (let i = 0; i < a.length; i += 3) { xs.push(a[i]); zs.push(a[i + 2]) }
  assert.equal(Math.min(...xs), -150); assert.equal(Math.max(...xs), 150)
  assert.equal(Math.min(...zs), -50); assert.equal(Math.max(...zs), 50)
}

// ---- an edge that is not a whole number of cells: the grid stops inside the bed, never over it ----
{
  const { thin, bold } = bedGridLines(205, 205)
  // Vertical lines are the segments whose two endpoints share an x.
  const verticalXs = []
  for (const a of [thin, bold]) for (let i = 0; i < a.length; i += 6) if (a[i] === a[i + 3]) verticalXs.push(a[i])
  assert.equal(Math.min(...verticalXs), -102.5, 'the first line is on the bed edge')
  assert.equal(Math.max(...verticalXs), 97.5, 'the last one lands a cell short rather than overhanging')
  // Nothing anywhere in the grid reaches past the bed rectangle.
  const all = []
  for (const a of [thin, bold]) for (let i = 0; i < a.length; i += 3) all.push(a[i], a[i + 2])
  assert.ok(Math.max(...all) <= 102.5 && Math.min(...all) >= -102.5)
}

console.log('bed_grid: ok')
