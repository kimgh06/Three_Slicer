// The organic tree support's branches made outside the kernel (support_phase.h), driven as the worker drives it:
//  CAPTURE stops a slice at its support tips and hands out what the branches are made from; RESUME finishes that slice
//  with upstream's own support and must give the plain slice's G-code byte for byte (it is what a caller whose GPU
//  failed gets, and it proves the layers kept between the two calls are the ones PASS1 made); INJECT finishes it with
//  the support body it is given, on the tree support the capture left (the overhangs are not detected and the tips not
//  placed a second time: measured on one 1086-layer plate, st, 1130 of INJECT's 1600 ms of support). So it also pins:
//  the same capture and body give the same G-code twice and on st and mt; an INJECT that does not follow its own
//  capture is the plain slice; and a capture's tips are the ones a capture with every volume precalculated places
//  (CAPTURE makes only the volumes the tips read: no Slow avoidance, no wall restrictions, one radius).
//   Run: node packages/wasm-core/tests/test_support_phase.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import createSlicer from '../../engine/src/slicer_core.js'
import createSlicerMt from '../../engine/src/slicer_core.mt.js'
import { outwardBoxTriangles, trianglesToSTLBytes } from './stl_fixtures.mjs'

const PHASE_OFF = 0, PHASE_CAPTURE = 1, PHASE_RESUME = 3
// A tower with a wide roof: the roof's underside needs support all around the tower.
const model = trianglesToSTLBytes([
  ...outwardBoxTriangles(-4, -4, 0, 8, 8, 20),
  ...outwardBoxTriangles(-20, -20, 20, 40, 40, 1.2),
])
const baseParams = {
  layer_height: 0.2, first_layer_height: 0.2, line_width: 0.42, wall_loops: 2, infill_density: 0.15,
  bed_width: 180, bed_depth: 180, printable_height: 180, skirt_loops: 0,
  enable_support: true, support_style: 'tree', tree_style: 'organic', gcode_role_tags: true,
}
const params = JSON.stringify(baseParams)
const supportLength = (gcode) => {
  // extruded millimetres written under a support role tag
  let inSupport = false, x = 0, y = 0, total = 0
  for (const line of gcode.split('\n')) {
    if (line.startsWith(';TYPE:')) { inSupport = /support/i.test(line); continue }
    if (!line.startsWith('G1 ')) continue
    const nextX = Number(/X(-?[\d.]+)/.exec(line)?.[1] ?? x), nextY = Number(/Y(-?[\d.]+)/.exec(line)?.[1] ?? y)
    if (inSupport && / E[\d.]/.test(line)) total += Math.hypot(nextX - x, nextY - y)
    x = nextX; y = nextY
  }
  return total
}

// A taller tower under the same roof: another layer count, for the INJECT that follows the wrong capture.
const otherModel = trianglesToSTLBytes([
  ...outwardBoxTriangles(-4, -4, 0, 8, 8, 24),
  ...outwardBoxTriangles(-20, -20, 24, 40, 40, 1.2),
])
const injectedByKind = {}
for (const [kind, create] of [['st', createSlicer], ['mt', createSlicerMt]]) {
  const slicer = await create()
  assert.equal(typeof slicer.support_phase_mode, 'function', `${kind}: the kernel has the support phase`)
  const plain = slicer.slice(model, params, () => {})
  assert.ok(!plain.error && supportLength(plain.gcode) > 100, `${kind}: the plain slice has support`)

  // CAPTURE: stops at the tips
  slicer.support_phase_mode(PHASE_CAPTURE)
  const captured = slicer.slice(model, params, () => {})
  assert.equal(captured.supportCaptured, true, `${kind}: the slice stops at its support tips`)
  const request = slicer.support_phase_request()
  const tips = Float32Array.from(request.tips), outlineStarts = Uint32Array.from(request.outlines.layerRingStart)
  assert.ok(tips.length >= 4 && tips.length % 4 === 0, `${kind}: tips are handed out`)
  assert.equal(outlineStarts.length, captured.layers + 1, `${kind}: one outline entry per layer`)
  assert.equal(request.layerZ.length, captured.layers)
  for (let at = 0; at < tips.length; at += 4) {
    assert.ok(Math.abs(tips[at]) <= 21 && Math.abs(tips[at + 1]) <= 21, `${kind}: a tip lies under the roof`)
    assert.ok(tips[at + 2] > 50 && tips[at + 2] < 100, `${kind}: a tip sits just under the roof (layer ${tips[at + 2]})`)
    assert.ok(tips[at + 3] > 0, `${kind}: a tip has a radius`)
  }
  assert.ok(request.xyDistance > 0 && request.maxMove > 0 && request.branchRadius > request.minRadius && request.tipLayers > 0, `${kind}: the branch settings are handed out`)
  assert.ok(request.bedMaxX > request.bedMinX && request.bedMaxY > request.bedMinY, `${kind}: the bed is handed out`)

  // the tips do not depend on which volumes the capture precalculated
  slicer.support_phase_mode(PHASE_OFF)
  slicer.support_phase_mode(PHASE_CAPTURE)
  slicer.support_phase_full_volumes(true)
  assert.equal(slicer.slice(model, params, () => {}).supportCaptured, true)
  assert.deepEqual(Float32Array.from(slicer.support_phase_request().tips), tips, `${kind}: the tips are the ones placed with every volume precalculated`)

  // RESUME: the kept layers and upstream's own support give the plain slice
  slicer.support_phase_mode(PHASE_RESUME)
  const resumed = slicer.slice(model, params, () => {})
  assert.ok(!resumed.error, `${kind}: resume slices (${resumed.error})`)
  assert.equal(resumed.gcode, plain.gcode, `${kind}: a resumed slice is the plain slice byte for byte`)

  // INJECT: one square column per layer under the roof, beside the tower
  slicer.support_phase_mode(PHASE_CAPTURE)
  assert.equal(slicer.slice(model, params, () => {}).supportCaptured, true)
  const supportLayers = slicer.support_phase_request().supportLayers
  const layerRingStart = new Uint32Array(captured.layers + 1), ringStart = [0], points = []
  for (let layer = 0; layer < captured.layers; layer++) {
    if (layer < supportLayers - 2) {
      points.push(10, 10, 16, 10, 16, 16, 10, 16)
      ringStart.push(points.length / 2)
    }
    layerRingStart[layer + 1] = ringStart.length - 1
  }
  const inject = () => slicer.support_phase_inject(layerRingStart, Uint32Array.from(ringStart), Float32Array.from(points))
  inject()
  const injected = slicer.slice(model, params, () => {})
  assert.ok(!injected.error, `${kind}: inject slices (${injected.error})`)
  const injectedLength = supportLength(injected.gcode)
  assert.ok(injectedLength > 100, `${kind}: the injected body is printed (${injectedLength.toFixed(0)} mm)`)
  assert.notEqual(injected.gcode, plain.gcode, `${kind}: the injected support is not upstream's`)
  injectedByKind[kind] = injected.gcode
  slicer.support_phase_mode(PHASE_OFF)

  // the same capture and body again: nothing of the first round is left in the kernel
  slicer.support_phase_mode(PHASE_CAPTURE)
  assert.equal(slicer.slice(model, params, () => {}).supportCaptured, true)
  inject()
  assert.equal(slicer.slice(model, params, () => {}).gcode, injected.gcode, `${kind}: a second capture and inject give the same G-code`)
  slicer.support_phase_mode(PHASE_OFF)

  // an INJECT that follows another model's capture: what was kept is dropped, and the slice is the plain one
  const otherPlain = slicer.slice(otherModel, params, () => {})
  slicer.support_phase_mode(PHASE_CAPTURE)
  assert.equal(slicer.slice(model, params, () => {}).supportCaptured, true)
  inject()
  const mismatched = slicer.slice(otherModel, params, () => {})
  assert.equal(mismatched.gcode, otherPlain.gcode, `${kind}: an INJECT after another model's capture is the plain slice`)
  slicer.support_phase_mode(PHASE_OFF)
  const after = slicer.slice(model, params, () => {})
  assert.equal(after.gcode, plain.gcode, `${kind}: OFF is the kernel as it was`)
  console.log(`  ok ${kind}: capture hands out ${tips.length / 4} tips; resume equals the plain slice (${plain.gcode.length} bytes); inject prints ${injectedLength.toFixed(0)} mm of support (upstream ${supportLength(plain.gcode).toFixed(0)} mm)`)
}
assert.equal(injectedByKind.mt, injectedByKind.st, 'the injected slice is the same G-code on st and mt')
console.log('  ok the injected slice is byte-identical on st and mt')

// Both port copies carry the phase, and INJECT goes through the kept group rather than through generate_support_areas.
const portSource = (port) => readFileSync(new URL(`../${port}/libslic3r/Support/TreeSupport3D.cpp`, import.meta.url), 'utf8')
assert.equal(portSource('arachne_port'), portSource('treesupport_port'), 'TreeSupport3D.cpp is the same file in both ports')
assert.ok(!/support_phase::mode == support_phase::INJECT/.test(portSource('treesupport_port')), 'generate_support_areas has no INJECT branch: INJECT finishes the kept group')
console.log('  ok INJECT finishes the group the capture kept')
console.log('\nsupport_phase: ok')
process.exit(0)
