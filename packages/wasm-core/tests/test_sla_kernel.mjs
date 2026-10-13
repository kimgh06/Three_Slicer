// slice_sla kernel invariants: contour geometry, generated supports (overhang + floating island), pad,
//  determinism and the layer-sink streaming parity. Runs the committed WASM under plain node, like test.mjs.
import { strict as assert } from 'node:assert'
import createSlicer from '../../engine/src/slicer_core.js'

let passed = 0
const ok = (name) => { passed++; console.log('  ok', name) }

// Axis-aligned boxes -> one binary STL (outward winding, same face table test.mjs uses).
function boxTris(x0, y0, z0, sizeX, sizeY, sizeZ) {
  const corners = [[0,0,0],[sizeX,0,0],[sizeX,sizeY,0],[0,sizeY,0],[0,0,sizeZ],[sizeX,0,sizeZ],[sizeX,sizeY,sizeZ],[0,sizeY,sizeZ]]
    .map(([x, y, z]) => [x + x0, y + y0, z + z0])
  const faces = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]]
  return faces.map(face => face.map(cornerIndex => corners[cornerIndex]))
}
function writeSTL(tris) {
  const buffer = Buffer.alloc(84 + tris.length * 50)
  buffer.writeUInt32LE(tris.length, 80)
  tris.forEach((triangle, triangleIndex) => {
    let offset = 84 + 50 * triangleIndex + 12
    for (const point of triangle) for (const coordinate of point) {
      buffer.writeFloatLE(coordinate, offset)
      offset += 4
    }
  })
  return new Uint8Array(buffer)
}

const roleOf = (encoded) => encoded & 15
const rolesIn = (layer) => {
  const seen = new Set()
  for (let k = 3; k < layer.paths.length; k += 8) seen.add(roleOf(layer.paths[k]))
  return seen
}
const layerNear = (layers, z) => layers.reduce((best, layer) => {
  if (Math.abs(layer.z - z) < Math.abs(best.z - z)) return layer
  return best
}, layers[0])

const params = (overrides = {}) => JSON.stringify({ layer_height: 0.05, initial_layer_height: 0.05, bed_width: 120.96, bed_depth: 68.04, ...overrides })

const slicer = await createSlicer()
assert.ok(slicer.slice_sla, 'slice_sla binding present')

// [contours] a cube slices to its exact footprint; volume integrates back; every segment is role 1
{
  const result = slicer.slice_sla(writeSTL(boxTris(-5, -5, 0, 10, 10, 10)), params(), undefined)
  assert.equal(result.error, undefined)
  assert.equal(result.stats.layers, 200)
  assert.ok(Math.abs(result.stats.volume_mm3 - 1000) < 2, `volume ${result.stats.volume_mm3}`)
  assert.ok(Math.abs(result.stats.resin_ml - 1) < 0.002)
  assert.equal(result.stats.support_points, 0)
  const middle = layerNear(result.layers, 5)
  assert.deepEqual([...rolesIn(middle)], [1])
  assert.equal(middle.paths.length % 8, 0)
  assert.equal(middle.widths.length, middle.paths.length / 8)
  ok('contours: cube layers/volume/roles/stride')
}

// [supports: overhang] a mushroom cap over a thin stem grows pillars under the rim
{
  const tris = [...boxTris(-2, -2, 0, 4, 4, 5), ...boxTris(-10, -10, 5, 20, 20, 2)]
  const result = slicer.slice_sla(writeSTL(tris), params({ supports_enable: true }), undefined)
  assert.equal(result.error, undefined)
  assert.equal(result.stats.support_slicer_backend, 'generic_mesh_sweep_fallback')
  assert.equal(result.stats.support_slicer_parity_status, 'blocked_dependency')
  assert.equal(result.stats.support_slicer_code, 'SLA_SUPPORT_ANALYTICAL_CACHE_DEPENDENCY_UNAVAILABLE')
  assert.ok(result.stats.support_slicer_cache_misses > 0)
  assert.ok(result.stats.support_points >= 8, `support_points ${result.stats.support_points}`)
  const below = layerNear(result.layers, 2.5)     // between plate and cap: stem contour + pillars
  assert.ok(rolesIn(below).has(5), 'role-5 pillars below the cap')
  assert.ok(rolesIn(below).has(1), 'stem contour still there')
  const withoutSupports = slicer.slice_sla(writeSTL(tris), params(), undefined)
  assert.equal(withoutSupports.stats.support_points, 0)  // switch off -> none
  ok('supports: overhang rim pillared, switch honoured')
}

// [supports: floating island] a part with no path to the plate is mandatory-supported through the gap
{
  const tris = [...boxTris(-5, -5, 0, 10, 10, 2), ...boxTris(-3, -3, 6, 6, 6, 2)]
  const result = slicer.slice_sla(writeSTL(tris), params({ supports_enable: true }), undefined)
  assert.equal(result.error, undefined)
  assert.ok(result.stats.support_points >= 1, `support_points ${result.stats.support_points}`)
  const gap = layerNear(result.layers, 4)         // the empty band between the two boxes
  assert.ok(rolesIn(gap).has(5), 'pillar crosses the gap')
  assert.ok(!rolesIn(gap).has(1), 'no model contour in the gap')
  assert.ok(result.stats.volume_mm3 > 272, 'support volume counted on top of the two boxes')
  ok('supports: floating island pillared through the gap')
}

// [pad] the ported pad occupies the bottom zone as role 6, disjoint from the model
{
  const result = slicer.slice_sla(writeSTL(boxTris(-5, -5, 0, 10, 10, 5)), params({ pad_enable: true }), undefined)
  assert.ok(result.stats.pad_layers >= 1)
  const bottom = result.layers[0]
  assert.ok(rolesIn(bottom).has(6), 'pad ring on the bottom layer')
  const top = layerNear(result.layers, 4)
  assert.ok(!rolesIn(top).has(6), 'no pad above the slab')
  ok('pad: ported bottom zone as role 6')
}

// [determinism] same bytes in, same bytes out — including the generated supports
{
  const tris = [...boxTris(-2, -2, 0, 4, 4, 5), ...boxTris(-10, -10, 5, 20, 20, 2)]
  const first = slicer.slice_sla(writeSTL(tris), params({ supports_enable: true }), undefined)
  const second = slicer.slice_sla(writeSTL(tris), params({ supports_enable: true }), undefined)
  assert.equal(first.stats.support_points, second.stats.support_points)
  assert.equal(first.layers.length, second.layers.length)
  for (const i of [0, 40, 99, first.layers.length - 1])
    assert.deepEqual(Array.from(first.layers[i].paths), Array.from(second.layers[i].paths), `layer ${i}`)
  ok('determinism: two runs byte-identical (supports included)')
}

// [tree structure] the ported DefaultSupportTree routes every contact and stands feet on the plate
{
  const tris = [...boxTris(-2, -2, 0, 4, 4, 5), ...boxTris(-10, -10, 5, 20, 20, 2)]
  const result = slicer.slice_sla(writeSTL(tris), params({ supports_enable: true }), undefined)
  assert.equal(result.stats.support_error, undefined)
  assert.ok(result.stats.support_pillars >= 4, `pillars ${result.stats.support_pillars}`)
  assert.ok(result.stats.support_pillars <= result.stats.support_points,
    `${result.stats.support_pillars} pillars for ${result.stats.support_points} contacts`)
  const bottom = result.layers[0]
  assert.ok(rolesIn(bottom).has(5), 'feet on the plate')
  ok('tree: routed pillars, feet present')
}

// [solid meshes] the preview's truth: triangle soup for supports and pad, agreeing with the layer stream
{
  const tris = [...boxTris(-2, -2, 0, 4, 4, 5), ...boxTris(-10, -10, 5, 20, 20, 2)]
  const result = slicer.slice_sla(writeSTL(tris), params({ supports_enable: true, pad_enable: true }), undefined)
  assert.ok(result.support_mesh instanceof Float32Array)
  assert.ok(result.support_mesh.length > 0 && result.support_mesh.length % 9 === 0, `soup stride (${result.support_mesh.length})`)
  let minZ = Infinity, maxZ = -Infinity, maxRadius = 0
  for (let i = 0; i < result.support_mesh.length; i += 3) {
    const x = result.support_mesh[i], y = result.support_mesh[i + 1], z = result.support_mesh[i + 2]
    minZ = Math.min(minZ, z)
    maxZ = Math.max(maxZ, z)
    maxRadius = Math.max(maxRadius, Math.abs(x), Math.abs(y))
  }
  assert.ok(minZ >= -1e-6, `mesh below the plate (${minZ})`)
  // Contacts sit under the z=5 cap, and the ported pad lifts the whole scene by its 2mm zone.
  assert.ok(maxZ <= 5.2 + 2, `support mesh above the cap underside + pad zone (${maxZ})`)
  assert.ok(minZ >= 2 - 0.35, `support feet below the pad top (${minZ})`)
  assert.ok(maxRadius <= 10 + 4, `mesh outside the model + base radius (${maxRadius})`)
  assert.ok(result.pad_mesh.length > 0 && result.pad_mesh.length % 9 === 0)
  const withoutSupports = slicer.slice_sla(writeSTL(tris), params(), undefined)
  assert.equal(withoutSupports.support_mesh.length, 0)
  const again = slicer.slice_sla(writeSTL(tris), params({ supports_enable: true, pad_enable: true }), undefined)
  assert.deepEqual(Array.from(again.support_mesh), Array.from(result.support_mesh))
  ok('meshes: support/pad soup bounded, gated, deterministic')
}

// [elevation] the object rises by support_object_elevation; the zone below holds only supports
{
  const tris = [...boxTris(-5, -5, 0, 10, 10, 4)]
  const result = slicer.slice_sla(writeSTL(tris), params({ supports_enable: true, support_object_elevation: 3 }), undefined)
  assert.equal(result.stats.elevation_layers, 60)
  assert.equal(result.stats.layers, 80 + 60)                     // 4mm model + 3mm elevation at 0.05
  const inZone = layerNear(result.layers, 1.5)                   // inside the elevation zone
  assert.ok(rolesIn(inZone).has(5), 'pillars fill the elevation zone')
  assert.ok(!rolesIn(inZone).has(1), 'no model below the elevation')
  const model = layerNear(result.layers, 4.5)                    // the (lifted) model body
  assert.ok(rolesIn(model).has(1), 'model present above the elevation')
  assert.ok(result.stats.support_points > 0)
  ok('elevation: object lifted onto its supports')
}

// [streaming] the layer sink receives exactly the batch layers; the result then carries stats only
{
  const stl = writeSTL(boxTris(-5, -5, 0, 10, 10, 3))
  const batch = slicer.slice_sla(stl, params(), undefined)
  const streamed = []
  slicer.set_layer_sink((z, layerIndex, gcode, paths, widths) => streamed.push({ z, layerIndex, paths, widths }))
  const result = slicer.slice_sla(stl, params(), undefined)
  slicer.clear_layer_sink()
  assert.equal(result.stats.streamed, true)
  assert.equal(result.layers, undefined)
  assert.equal(streamed.length, batch.layers.length)
  assert.deepEqual(Array.from(streamed[0].paths), Array.from(batch.layers[0].paths))
  assert.ok(Math.abs(streamed[streamed.length - 1].z - 3) < 1e-9)
  ok('streaming: sink parity with batch')
}

console.log(`test_sla_kernel: ${passed} checks passed`)
