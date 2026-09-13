// Task 11 — the hollowing capability gate at the KERNEL boundary. The request layer (test_sla_request.mjs)
//  and the 3mf record round-trip (test_sla_3mf.mjs) are covered elsewhere; what this pins is the legacy
//  params path the viewer actually drives: a settings map asking for a hollow must reach the kernel as
//  hollowing_enable=true (deriveSlaParams passthrough) and the kernel must REFUSE with the typed code —
//  a solid slice answered to a hollow request would be mislabeled hollowed.
import assert from 'node:assert/strict'
import createSlicer from '../engine/src/slicer_core.js'
import { deriveSlaParams } from '../engine/src/settings.js'

function boxSTL() {
  const vertices = [[-5,-5,0],[5,-5,0],[5,5,0],[-5,5,0],[-5,-5,5],[5,-5,5],[5,5,5],[-5,5,5]]
  const faces = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]]
  const buffer = Buffer.alloc(84 + faces.length * 50)
  buffer.writeUInt32LE(faces.length, 80)
  faces.forEach((face, index) => {
    let offset = 84 + index * 50 + 12
    for (const vertexIndex of face) for (const value of vertices[vertexIndex]) {
      buffer.writeFloatLE(value, offset)
      offset += 4
    }
  })
  return new Uint8Array(buffer)
}

// deriveSlaParams: the key must pass through as a real boolean — absent means false, never omitted, so the
//  kernel default cannot drift out from under the viewer.
assert.equal(deriveSlaParams({ hollowing_enable: true }).hollowing_enable, true)
assert.equal(deriveSlaParams({}).hollowing_enable, false)

const slicer = await createSlicer()
const params = over => JSON.stringify({ layer_height: 0.05, bed_width: 120.96, bed_depth: 68.04, ...over })

// The gate: typed error, no layers, and it must fire before any slicing work claims progress.
const hollow = slicer.slice_sla(boxSTL(), params({ hollowing_enable: true }), undefined)
assert.match(hollow.error ?? '', /^SLA_UNSUPPORTED_HOLLOWING/, `expected the typed code, got: ${hollow.error}`)
assert.equal(hollow.layers, undefined)

// The gate is a gate, not a regression: false and absent both slice normally.
for (const p of [params({ hollowing_enable: false }), params({})]) {
  const r = slicer.slice_sla(boxSTL(), p, undefined)
  assert.equal(r.error, undefined)
  assert.ok(r.stats.layers > 0)
}

console.log('test_sla_hollowing: kernel typed refusal, deriveSlaParams passthrough, and the false/absent path passed')
