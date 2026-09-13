// slice_sla kernel invariants: contour geometry, generated supports (overhang + floating island), pad,
//  determinism and the layer-sink streaming parity. Runs the committed WASM under plain node, like test.mjs.
import { strict as assert } from 'node:assert'
import createSlicer from '../engine/src/slicer_core.js'

let passed = 0
const ok = (name) => { passed++; console.log('  ok', name) }

// Axis-aligned boxes -> one binary STL (outward winding, same face table test.mjs uses).
function boxTris(x0, y0, z0, sx, sy, sz) {
  const v = [[0,0,0],[sx,0,0],[sx,sy,0],[0,sy,0],[0,0,sz],[sx,0,sz],[sx,sy,sz],[0,sy,sz]]
    .map(([x, y, z]) => [x + x0, y + y0, z + z0])
  const f = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]]
  return f.map(face => face.map(i => v[i]))
}
function writeSTL(tris) {
  const buf = Buffer.alloc(84 + tris.length * 50)
  buf.writeUInt32LE(tris.length, 80)
  tris.forEach((t, i) => {
    let off = 84 + 50 * i + 12
    for (const p of t) for (const c of p) { buf.writeFloatLE(c, off); off += 4 }
  })
  return new Uint8Array(buf)
}

const roleOf = (enc) => enc & 15
const rolesIn = (layer) => {
  const seen = new Set()
  for (let k = 3; k < layer.paths.length; k += 8) seen.add(roleOf(layer.paths[k]))
  return seen
}
const layerNear = (layers, z) => layers.reduce((best, L) => (Math.abs(L.z - z) < Math.abs(best.z - z) ? L : best), layers[0])

const P = (over = {}) => JSON.stringify({ layer_height: 0.05, initial_layer_height: 0.05, bed_width: 120.96, bed_depth: 68.04, ...over })

const M = await createSlicer()
assert.ok(M.slice_sla, 'slice_sla binding present')

// [contours] a cube slices to its exact footprint; volume integrates back; every segment is role 1
{
  const r = M.slice_sla(writeSTL(boxTris(-5, -5, 0, 10, 10, 10)), P(), undefined)
  assert.equal(r.error, undefined)
  assert.equal(r.stats.layers, 200)
  assert.ok(Math.abs(r.stats.volume_mm3 - 1000) < 2, `volume ${r.stats.volume_mm3}`)
  assert.ok(Math.abs(r.stats.resin_ml - 1) < 0.002)
  assert.equal(r.stats.support_points, 0)
  const mid = layerNear(r.layers, 5)
  assert.deepEqual([...rolesIn(mid)], [1])
  assert.equal(mid.paths.length % 8, 0)
  assert.equal(mid.widths.length, mid.paths.length / 8)
  ok('contours: cube layers/volume/roles/stride')
}

// [supports: overhang] a mushroom cap over a thin stem grows pillars under the rim
{
  const tris = [...boxTris(-2, -2, 0, 4, 4, 5), ...boxTris(-10, -10, 5, 20, 20, 2)]
  const r = M.slice_sla(writeSTL(tris), P({ supports_enable: true }), undefined)
  assert.equal(r.error, undefined)
  assert.equal(r.stats.support_slicer_backend, 'generic_mesh_sweep_fallback')
  assert.equal(r.stats.support_slicer_parity_status, 'blocked_dependency')
  assert.equal(r.stats.support_slicer_code, 'SLA_SUPPORT_ANALYTICAL_CACHE_DEPENDENCY_UNAVAILABLE')
  assert.ok(r.stats.support_slicer_cache_misses > 0)
  assert.ok(r.stats.support_points >= 8, `support_points ${r.stats.support_points}`)
  const below = layerNear(r.layers, 2.5)     // between plate and cap: stem contour + pillars
  assert.ok(rolesIn(below).has(5), 'role-5 pillars below the cap')
  assert.ok(rolesIn(below).has(1), 'stem contour still there')
  const off = M.slice_sla(writeSTL(tris), P(), undefined)
  assert.equal(off.stats.support_points, 0)  // switch off -> none
  ok('supports: overhang rim pillared, switch honoured')
}

// [supports: floating island] a part with no path to the plate is mandatory-supported through the gap
{
  const tris = [...boxTris(-5, -5, 0, 10, 10, 2), ...boxTris(-3, -3, 6, 6, 6, 2)]
  const r = M.slice_sla(writeSTL(tris), P({ supports_enable: true }), undefined)
  assert.equal(r.error, undefined)
  assert.ok(r.stats.support_points >= 1, `support_points ${r.stats.support_points}`)
  const gap = layerNear(r.layers, 4)         // the empty band between the two boxes
  assert.ok(rolesIn(gap).has(5), 'pillar crosses the gap')
  assert.ok(!rolesIn(gap).has(1), 'no model contour in the gap')
  assert.ok(r.stats.volume_mm3 > 272, 'support volume counted on top of the two boxes')
  ok('supports: floating island pillared through the gap')
}

// [pad] the ported pad occupies the bottom zone as role 6, disjoint from the model
{
  const r = M.slice_sla(writeSTL(boxTris(-5, -5, 0, 10, 10, 5)), P({ pad_enable: true }), undefined)
  assert.ok(r.stats.pad_layers >= 1)
  const bottom = r.layers[0]
  assert.ok(rolesIn(bottom).has(6), 'pad ring on the bottom layer')
  const top = layerNear(r.layers, 4)
  assert.ok(!rolesIn(top).has(6), 'no pad above the slab')
  ok('pad: ported bottom zone as role 6')
}

// [determinism] same bytes in, same bytes out — including the generated supports
{
  const tris = [...boxTris(-2, -2, 0, 4, 4, 5), ...boxTris(-10, -10, 5, 20, 20, 2)]
  const a = M.slice_sla(writeSTL(tris), P({ supports_enable: true }), undefined)
  const b = M.slice_sla(writeSTL(tris), P({ supports_enable: true }), undefined)
  assert.equal(a.stats.support_points, b.stats.support_points)
  assert.equal(a.layers.length, b.layers.length)
  for (const i of [0, 40, 99, a.layers.length - 1])
    assert.deepEqual(Array.from(a.layers[i].paths), Array.from(b.layers[i].paths), `layer ${i}`)
  ok('determinism: two runs byte-identical (supports included)')
}

// [tree structure] the ported DefaultSupportTree routes every contact and stands feet on the plate
{
  const tris = [...boxTris(-2, -2, 0, 4, 4, 5), ...boxTris(-10, -10, 5, 20, 20, 2)]
  const r = M.slice_sla(writeSTL(tris), P({ supports_enable: true }), undefined)
  assert.equal(r.stats.support_error, undefined)
  assert.ok(r.stats.support_pillars >= 4, `pillars ${r.stats.support_pillars}`)
  assert.ok(r.stats.support_pillars <= r.stats.support_points,
    `${r.stats.support_pillars} pillars for ${r.stats.support_points} contacts`)
  const bottom = r.layers[0]
  assert.ok(rolesIn(bottom).has(5), 'feet on the plate')
  ok('tree: routed pillars, feet present')
}

// [solid meshes] the preview's truth: triangle soup for supports and pad, agreeing with the layer stream
{
  const tris = [...boxTris(-2, -2, 0, 4, 4, 5), ...boxTris(-10, -10, 5, 20, 20, 2)]
  const r = M.slice_sla(writeSTL(tris), P({ supports_enable: true, pad_enable: true }), undefined)
  assert.ok(r.support_mesh instanceof Float32Array)
  assert.ok(r.support_mesh.length > 0 && r.support_mesh.length % 9 === 0, `soup stride (${r.support_mesh.length})`)
  let minZ = Infinity, maxZ = -Infinity, maxR = 0
  for (let i = 0; i < r.support_mesh.length; i += 3) {
    const x = r.support_mesh[i], y = r.support_mesh[i + 1], z = r.support_mesh[i + 2]
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); maxR = Math.max(maxR, Math.abs(x), Math.abs(y))
  }
  assert.ok(minZ >= -1e-6, `mesh below the plate (${minZ})`)
  // Contacts sit under the z=5 cap, and the ported pad lifts the whole scene by its 2mm zone.
  assert.ok(maxZ <= 5.2 + 2, `support mesh above the cap underside + pad zone (${maxZ})`)
  assert.ok(minZ >= 2 - 0.35, `support feet below the pad top (${minZ})`)
  assert.ok(maxR <= 10 + 4, `mesh outside the model + base radius (${maxR})`)
  assert.ok(r.pad_mesh.length > 0 && r.pad_mesh.length % 9 === 0)
  const off = M.slice_sla(writeSTL(tris), P(), undefined)
  assert.equal(off.support_mesh.length, 0)
  const again = M.slice_sla(writeSTL(tris), P({ supports_enable: true, pad_enable: true }), undefined)
  assert.deepEqual(Array.from(again.support_mesh), Array.from(r.support_mesh))
  ok('meshes: support/pad soup bounded, gated, deterministic')
}

// [elevation] the object rises by support_object_elevation; the zone below holds only supports
{
  const tris = [...boxTris(-5, -5, 0, 10, 10, 4)]
  const r = M.slice_sla(writeSTL(tris), P({ supports_enable: true, support_object_elevation: 3 }), undefined)
  assert.equal(r.stats.elevation_layers, 60)
  assert.equal(r.stats.layers, 80 + 60)                     // 4mm model + 3mm elevation at 0.05
  const inZone = layerNear(r.layers, 1.5)                   // inside the elevation zone
  assert.ok(rolesIn(inZone).has(5), 'pillars fill the elevation zone')
  assert.ok(!rolesIn(inZone).has(1), 'no model below the elevation')
  const model = layerNear(r.layers, 4.5)                    // the (lifted) model body
  assert.ok(rolesIn(model).has(1), 'model present above the elevation')
  assert.ok(r.stats.support_points > 0)
  ok('elevation: object lifted onto its supports')
}

// [streaming] the layer sink receives exactly the batch layers; the result then carries stats only
{
  const stl = writeSTL(boxTris(-5, -5, 0, 10, 10, 3))
  const batch = M.slice_sla(stl, P(), undefined)
  const streamed = []
  M.set_layer_sink((z, idx, gcode, paths, widths) => streamed.push({ z, idx, paths, widths }))
  const r = M.slice_sla(stl, P(), undefined)
  M.clear_layer_sink()
  assert.equal(r.stats.streamed, true)
  assert.equal(r.layers, undefined)
  assert.equal(streamed.length, batch.layers.length)
  assert.deepEqual(Array.from(streamed[0].paths), Array.from(batch.layers[0].paths))
  assert.ok(Math.abs(streamed[streamed.length - 1].z - 3) < 1e-9)
  ok('streaming: sink parity with batch')
}

console.log(`test_sla_kernel: ${passed} checks passed`)
