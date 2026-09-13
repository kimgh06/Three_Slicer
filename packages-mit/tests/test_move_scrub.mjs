// The move scrub's data half: extrusions and travels are drawn from two lists but performed in ONE order, and
// moveCursor is what recovers that order. The property worth pinning is exactly that — walking a layer move by
// move must reproduce the sequence the paths array was built in, and the nozzle point must be each move's own
// endpoint. A bug here does not throw; it shows every extrusion first and the travels afterwards.
import assert from 'node:assert'
import { buildSegmentData, moveCursor, layerMoveCount, topMoveLayer } from './src/core/toolpath_segments.js'

let checks = 0
const ok = (what) => { checks++; console.log('  ok', what) }

// stride 8: x0,y0,z0,role,x1,y1,z1,spare — role 0 is a travel, anything else extrudes.
const move = (role, x0, y0, z, x1, y1) => [x0, y0, z, role, x1, y1, z, 0]
const layerOf = (z, moves) => ({ z, paths: new Float32Array(moves.flat()), widths: null })

// A layer that interleaves the two kinds: travel, extrude, extrude, travel, extrude, travel.
const SCRIPT = [
  [0, 0, 0, 10, 0],    // travel  -> (10,0)
  [1, 10, 0, 20, 0],   // extrude -> (20,0)
  [1, 20, 0, 20, 10],  // extrude -> (20,10)
  [0, 20, 10, 5, 5],   // travel  -> (5,5)
  [2, 5, 5, 5, 15],    // extrude -> (5,15)
  [0, 5, 15, 0, 0],    // travel  -> (0,0)
]
const Z = 0.2
const data = buildSegmentData([layerOf(Z, SCRIPT.map(([r, x0, y0, x1, y1]) => move(r, x0, y0, Z, x1, y1)))], 0.42)

// [range] the scrub's domain is every move of the layer, both kinds
{
  assert.equal(layerMoveCount(data, 0), SCRIPT.length)
  assert.equal(data.nSeg, SCRIPT.filter(m => m[0] !== 0).length)
  assert.equal(data.nTrav, SCRIPT.filter(m => m[0] === 0).length)
  ok('range: layerMoveCount counts extrusions and travels together')
}

// [order] walking move by move reproduces the emission order — the actual interleaving, not both lists in blocks
{
  const kinds = [], points = []
  for (let k = 1; k <= SCRIPT.length; k++) {
    const c = moveCursor(data, 0, k)
    kinds.push(c.onTravel ? 0 : 1)
    points.push(c.point.slice(0, 2))
    // the two counts always partition k
    assert.equal(c.segCount + c.travCount, k, `counts partition k=${k}`)
  }
  assert.deepEqual(kinds, SCRIPT.map(m => (m[0] === 0 ? 0 : 1)), 'kind per move')
  assert.deepEqual(points, SCRIPT.map(([, , , x1, y1]) => [x1, y1]), 'endpoint per move')
  ok('order: move-by-move matches the emission order, point is that move\'s endpoint')
}

// [bounds] k=0 is "nothing yet", k past the end clamps to the whole layer
{
  const zero = moveCursor(data, 0, 0)
  assert.equal(zero.point, null)
  assert.equal(zero.segCount + zero.travCount, 0)
  const over = moveCursor(data, 0, 999)
  assert.equal(over.segCount + over.travCount, SCRIPT.length)
  assert.deepEqual(over.point.slice(0, 2), [0, 0])   // the last move's endpoint
  assert.deepEqual(moveCursor(data, 0, -5).point, null)
  ok('bounds: 0 is empty, past the end clamps to the full layer')
}

// [z] the nozzle point carries the real z, not the diamond-centre z the position array stores
{
  const c = moveCursor(data, 0, 2)               // ends on an extrusion
  assert.ok(!c.onTravel)
  assert.ok(Math.abs(c.point[2] - Z) < 1e-6, `extrusion z ${c.point[2]} != ${Z}`)
  const t = moveCursor(data, 0, 1)               // ends on a travel
  assert.ok(t.onTravel && Math.abs(t.point[2] - Z) < 1e-6)
  ok('z: the point is the real bead z on both lists')
}

// [layers] each layer scrubs in its own domain, and its counts are layer-local
{
  const two = buildSegmentData([
    layerOf(0.2, [move(1, 0, 0, 0.2, 10, 0), move(0, 10, 0, 0.2, 0, 5)]),           // 2 moves
    layerOf(0.4, [move(0, 0, 5, 0.4, 3, 3), move(1, 3, 3, 0.4, 8, 8), move(1, 8, 8, 0.4, 9, 9)]),  // 3 moves
  ], 0.42)
  assert.equal(layerMoveCount(two, 0), 2)
  assert.equal(layerMoveCount(two, 1), 3)
  const c = moveCursor(two, 1, 1)
  assert.ok(c.onTravel, 'layer 1 starts with a travel')
  assert.deepEqual(c.point.slice(0, 2), [3, 3])
  // layer 1's second move is its FIRST extrusion, but the global segment list already holds layer 0's
  const e = moveCursor(two, 1, 2)
  assert.equal(e.segCount, 1, 'segCount is layer-local')
  assert.deepEqual(e.point.slice(0, 2), [8, 8])
  ok('layers: counts and points are layer-local')
}

// [travel-only] a layer that never extrudes (an SLA-ish or a lift-only layer) still scrubs
{
  const t = buildSegmentData([layerOf(0.2, [move(0, 0, 0, 0.2, 5, 5), move(0, 5, 5, 0.2, 9, 1)])], 0.42)
  assert.equal(layerMoveCount(t, 0), 2)
  const c = moveCursor(t, 0, 2)
  assert.ok(c.onTravel && c.segCount === 0 && c.travCount === 2)
  assert.deepEqual(c.point.slice(0, 2), [9, 1])
  ok('travel-only: a layer with no extrusion scrubs to its last travel')
}

// [empty top layer] the case a real slice always has: the kernel streams one more layer than it prints, so the
//  layer slider's top position carries no moves. Pinned there the scrub reads 0 / 0 — measured on a 20mm cube
//  before topMoveLayer existed — so it walks the topmost layer that HAS moves instead.
{
  const d = buildSegmentData([
    layerOf(0.2, [move(0, 0, 0, 0.2, 5, 5), move(1, 5, 5, 0.2, 15, 5)]),
    layerOf(0.4, [move(1, 15, 5, 0.4, 15, 15), move(1, 15, 15, 0.4, 5, 15)]),
    { z: 0.6, paths: new Float32Array(0), widths: null },      // the kernel's trailing empty layer
  ], 0.42)
  assert.equal(layerMoveCount(d, 2), 0, 'the trailing layer really is empty')
  assert.equal(topMoveLayer(d, 0, 2), 1, 'the scrub drops to the last layer with moves')
  assert.equal(layerMoveCount(d, topMoveLayer(d, 0, 2)), 2, 'and that layer has a range to walk')
  // Below the empty one nothing changes
  assert.equal(topMoveLayer(d, 0, 1), 1)
  assert.equal(topMoveLayer(d, 0, 0), 0)
  // An all-empty range has nothing to fall back to and says so by staying put
  const empty = buildSegmentData([{ z: 0.2, paths: new Float32Array(0), widths: null }], 0.42)
  assert.equal(topMoveLayer(empty, 0, 0), 0)
  assert.equal(layerMoveCount(empty, 0), 0)
  ok('empty top layer: the scrub walks the topmost layer that has moves')
}

console.log(`test_move_scrub: ${checks} checks passed`)
