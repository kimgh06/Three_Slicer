// Task 11 — the hollowing capability gate at the KERNEL boundary. The request layer (test_sla_request.mjs)
//  and the 3mf record round-trip (test_sla_3mf.mjs) are covered elsewhere; what this pins is the legacy
//  params path the viewer actually drives: a settings map asking for a hollow must reach the kernel as
//  hollowing_enable=true (deriveSlaParams passthrough) and the kernel must REFUSE with the typed code —
//  a solid slice answered to a hollow request would be mislabeled hollowed.
import assert from 'node:assert/strict'
import createSlicer from '../../engine/src/slicer_core.js'
import { deriveSlaParams } from '../../engine/src/settings.js'
import { outwardBoxTriangles, trianglesToSTLBytes } from './stl_fixtures.mjs'

// A 10x10x5 box centred on the origin.
function boxSTL() {
  return trianglesToSTLBytes(outwardBoxTriangles(-5, -5, 0, 10, 10, 5))
}

// deriveSlaParams: the key must pass through as a real boolean — absent means false, never omitted, so the
//  kernel default cannot drift out from under the viewer.
assert.equal(deriveSlaParams({ hollowing_enable: true }).hollowing_enable, true)
assert.equal(deriveSlaParams({}).hollowing_enable, false)

const slicer = await createSlicer()
const params = overrides => JSON.stringify({ layer_height: 0.05, bed_width: 120.96, bed_depth: 68.04, ...overrides })

// The gate: typed error, no layers, and it must fire before any slicing work claims progress.
const hollow = slicer.slice_sla(boxSTL(), params({ hollowing_enable: true }), undefined)
assert.match(hollow.error ?? '', /^SLA_UNSUPPORTED_HOLLOWING/, `expected the typed code, got: ${hollow.error}`)
assert.equal(hollow.layers, undefined)

// The gate is a gate, not a regression: false and absent both slice normally.
for (const paramsJson of [params({ hollowing_enable: false }), params({})]) {
  const result = slicer.slice_sla(boxSTL(), paramsJson, undefined)
  assert.equal(result.error, undefined)
  assert.ok(result.stats.layers > 0)
}

console.log('test_sla_hollowing: kernel typed refusal, deriveSlaParams passthrough, and the false/absent path passed')
