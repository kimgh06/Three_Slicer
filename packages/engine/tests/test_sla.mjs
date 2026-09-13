// SLA contour slicer invariants (sla_core.js) + the SLA settings derivation (settings.js).
//  Runs under plain node — the whole point of the pure-JS SLA path is that nothing here needs a browser or WASM.
import { strict as assert } from 'node:assert'
import { sliceSla, parseBinarySTL } from './src/sla_core.js'
import { deriveSlaParams, printerTechnology, schemaDefault } from './src/settings.js'

let passed = 0
const ok = (name) => { passed++; console.log('  ok', name) }

// ---- binary STL writer (test-local) ----
function writeSTL(tris) {
  const buf = new ArrayBuffer(84 + 50 * tris.length)
  const dv = new DataView(buf)
  dv.setUint32(80, tris.length, true)
  tris.forEach((t, i) => {
    const base = 84 + 50 * i + 12          // normal left zero — the slicer recomputes from winding
    t.flat().forEach((v, f) => dv.setFloat32(base + 4 * f, v, true))
  })
  return new Uint8Array(buf)
}
const quad = (a, b, c, d) => [[a, b, c], [a, c, d]]   // CCW seen from outside

// Axis-aligned closed box, outward winding.
function boxTris(x0, y0, z0, x1, y1, z1) {
  const v = (x, y, z) => [x, y, z]
  return [
    ...quad(v(x0, y0, z0), v(x1, y0, z0), v(x1, y0, z1), v(x0, y0, z1)),   // -Y
    ...quad(v(x1, y1, z0), v(x0, y1, z0), v(x0, y1, z1), v(x1, y1, z1)),   // +Y
    ...quad(v(x0, y1, z0), v(x0, y0, z0), v(x0, y0, z1), v(x0, y1, z1)),   // -X
    ...quad(v(x1, y0, z0), v(x1, y1, z0), v(x1, y1, z1), v(x1, y0, z1)),   // +X
    ...quad(v(x0, y1, z0), v(x1, y1, z0), v(x1, y0, z0), v(x0, y0, z0)),   // -Z
    ...quad(v(x0, y0, z1), v(x1, y0, z1), v(x1, y1, z1), v(x0, y1, z1)),   // +Z
  ]
}

// Square tube (10x10 outer, 4x4 hole, height 5) — a manifold with a through-hole, for net-area orientation.
function tubeTris() {
  const h = 5
  const O = [[0, 0], [10, 0], [10, 10], [0, 10]]
  const I = [[3, 3], [7, 3], [7, 7], [3, 7]]
  const tris = []
  for (let k = 0; k < 4; k++) {
    const [ax, ay] = O[k], [bx, by] = O[(k + 1) % 4]
    tris.push(...quad([ax, ay, 0], [bx, by, 0], [bx, by, h], [ax, ay, h]))                 // outer wall
    const [cx, cy] = I[(k + 1) % 4], [dx, dy] = I[k]
    tris.push(...quad([cx, cy, 0], [dx, dy, 0], [dx, dy, h], [cx, cy, h]))                 // inner wall (reversed ring)
    tris.push(...quad([ax, ay, h], [bx, by, h], [cx, cy, h], [dx, dy, h]))                 // top annulus (+Z)
    tris.push(...quad([dx, dy, 0], [cx, cy, 0], [bx, by, 0], [ax, ay, 0]))                 // bottom annulus (-Z)
  }
  return tris
}

const netArea = (layer) => layer.area

// [format] the layer stream is the kernel's own contract: stride 8, enc = role+tool*16, one width per segment
{
  const r = sliceSla(writeSTL(boxTris(0, 0, 0, 10, 10, 10)), { layer_height: 0.05 })
  assert.equal(r.error, undefined)
  assert.equal(r.stats.layers, 200)
  assert.equal(r.layers.length, 200)
  for (const L of [r.layers[0], r.layers[99], r.layers[199]]) {
    assert.equal(L.paths.length % 8, 0)
    assert.equal(L.widths.length, L.paths.length / 8)
    for (let k = 3; k < L.paths.length; k += 4) assert.equal(L.paths[k], 1)   // role wall, tool 0
  }
  assert.ok(Math.abs(r.layers[0].z - 0.05) < 1e-9)
  assert.ok(Math.abs(r.layers[199].z - 10) < 1e-9)
  ok('format: stride 8, enc, layer count and z ladder')
}

// [geometry] a vertical cube slices to its own footprint on every layer; volume integrates back
{
  const r = sliceSla(writeSTL(boxTris(0, 0, 0, 10, 10, 10)), { layer_height: 0.05 })
  for (const L of r.layers) assert.ok(Math.abs(netArea(L) - 100) < 1e-6, `area ${netArea(L)} at z=${L.z}`)
  assert.ok(Math.abs(r.stats.volume_mm3 - 1000) < 1e-3)
  assert.ok(Math.abs(r.stats.resin_ml - 1) < 1e-6)
  ok('geometry: cube area 100 per layer, volume 1000')
}

// [holes] the tube's hole loop runs opposite the outer loop, so the summed shoelace is the NET cross-section
{
  const r = sliceSla(writeSTL(tubeTris()), { layer_height: 0.05 })
  assert.equal(r.stats.layers, 100)
  for (const L of r.layers) {
    assert.ok(Math.abs(netArea(L) - 84) < 1e-6, `net area ${netArea(L)} at z=${L.z}`)
    assert.equal(L.paths.length / 8, 16)  // 8 walls, each quad split into 2 triangles -> 2 collinear segments per wall
  }
  assert.equal(r.stats.open_chains_dropped, 0)
  ok('holes: net area = outer - hole, closed loops only')
}

// [determinism] same bytes in, same bytes out — the property the golden discipline needs from this module
{
  const stl = writeSTL(boxTris(0, 0, 0, 10, 10, 10))
  const a = sliceSla(stl.slice(), { layer_height: 0.07 })
  const b = sliceSla(stl.slice(), { layer_height: 0.07 })
  assert.equal(a.layers.length, b.layers.length)
  for (let i = 0; i < a.layers.length; i++) {
    assert.deepEqual(Array.from(a.layers[i].paths), Array.from(b.layers[i].paths))
    assert.deepEqual(Array.from(a.layers[i].widths), Array.from(b.layers[i].widths))
  }
  ok('determinism: two runs byte-identical')
}

// [streaming] onLayer delivers exactly the batch layers, result carries stats only (the kernel's streamed shape)
{
  const stl = writeSTL(boxTris(0, 0, 0, 10, 10, 10))
  const batch = sliceSla(stl.slice(), { layer_height: 0.1 })
  const streamed = []
  const progress = []
  const r = sliceSla(stl.slice(), { layer_height: 0.1 }, {
    onLayer: (L) => streamed.push(L),
    onProgress: (done, total) => progress.push([done, total]),
  })
  assert.equal(r.layers, undefined)
  assert.equal(r.stats.streamed, true)
  assert.equal(streamed.length, batch.layers.length)
  for (let i = 0; i < streamed.length; i++) {
    assert.equal(streamed[i].z, batch.layers[i].z)
    assert.deepEqual(Array.from(streamed[i].paths), Array.from(batch.layers[i].paths))
  }
  assert.ok(progress.length >= 1)
  assert.deepEqual(progress[progress.length - 1], [batch.layers.length, batch.layers.length])
  ok('streaming: layer parity + final progress')
}

// [time model] exposure fades from initial to regular over the faded band, plus per-layer overhead
{
  const r = sliceSla(writeSTL(boxTris(0, 0, 0, 2, 2, 1)), {
    layer_height: 0.1, exposure_time: 2, initial_exposure_time: 20, faded_layers: 0, sla_layer_overhead: 3,
  })
  assert.equal(r.stats.layers, 10)
  assert.equal(r.stats.time_estimate, 10 * 3 + 10 * 2)   // faded 0 -> every layer at the regular exposure
  ok('time model: overhead + exposure')
}

// [errors] malformed input reports instead of throwing — the worker turns the field into an error message
{
  assert.ok(sliceSla(new Uint8Array(10), {}).error)
  assert.ok(parseBinarySTL(new Uint8Array(200)).error)   // length mismatch
  const flat = sliceSla(writeSTL([[[0, 0, 0], [1, 0, 0], [0, 1, 0]]]), {})
  assert.ok(flat.error)                                   // zero height
  ok('errors: malformed STL and flat geometry report, not throw')
}

// [derive] the SLA parameter derivation: resin defaults, map-only reads for keys the FFF schema would shadow
{
  const empty = deriveSlaParams({})
  assert.equal(empty.layer_height, 0.05)                 // NOT the FFF schema default 0.2
  // Schema-present since the SLA extraction pass; falls back to layer_height only when the schema drops it.
  const schemaInitial = Number(schemaDefault('initial_layer_height'))
  assert.equal(empty.initial_layer_height, Number.isFinite(schemaInitial) && schemaInitial > 0 ? schemaInitial : 0.05)
  assert.equal(empty.display_pixels_x, 2560)
  // Schema-present keys keep the schema default (the package convention); only schema-absent ones use the SL1 values.
  const schemaWidth = Number(schemaDefault('display_width'))
  assert.equal(empty.display_width, Number.isFinite(schemaWidth) && schemaWidth > 0 ? schemaWidth : 120.96)
  const set = deriveSlaParams({ layer_height: 0.1, initial_layer_height: 0.2, display_pixels_x: 1620, exposure_time: 9 })
  assert.equal(set.layer_height, 0.1)
  assert.equal(set.initial_layer_height, 0.2)
  assert.equal(set.display_pixels_x, 1620)
  assert.equal(set.exposure_time, 9)
  assert.equal(deriveSlaParams({ faded_layers: 0 }).faded_layers, 0)   // zero = no fade band, not "unset"
  ok('deriveSlaParams: defaults and overrides')
}

// [routing] the technology switch normalizes and defaults to FFF
{
  assert.equal(printerTechnology({}), 'FFF')
  assert.equal(printerTechnology({ printer_technology: 'SLA' }), 'SLA')
  assert.equal(printerTechnology({ printer_technology: 'sla' }), 'SLA')
  assert.equal(printerTechnology({ printer_technology: 'FFF' }), 'FFF')
  ok('printerTechnology: SLA/FFF routing')
}

// [printers] the resin machines ship in the catalog, marked by vendor, and their profile carries the technology —
//  so picking one flips the routing by itself
{
  const { printerSettings, printerTechByVendor } = await import('./src/settings.js')
  assert.equal(printerTechByVendor.PrusaResearchSLA, 'SLA')
  assert.equal(printerTechByVendor.AnycubicSLA, 'SLA')
  const sl1 = printerSettings('Original Prusa SL1')
  assert.ok(sl1, 'SL1 profile present')
  assert.equal(sl1.printer_technology, 'SLA')
  assert.equal(sl1.display_width, 120.96)
  assert.equal(sl1.display_pixels_x, 2560)
  assert.equal(printerTechnology(sl1), 'SLA')
  ok('printers: SLA vendors marked, SL1 profile routes itself')
}

// [materials] the resin catalog ships, the SL1 pick carries its default material's exposure (upstream layering:
//  exposure lives in the sla_material preset, supports in sla_print — the two never touch each other's keys)
{
  const { printerSettings, resinCatalog, resinSettingsFor } = await import('./src/settings.js')
  assert.ok(resinCatalog.length > 400, `catalog ${resinCatalog.length}`)
  const sl1 = printerSettings('Original Prusa SL1')
  assert.equal(sl1.exposure_time, 6)                       // Prusament Tough Orange, not the code default 10
  assert.equal(sl1.initial_exposure_time, 35)
  assert.equal(sl1.sla_material_settings_id, 'Prusament Resin Tough Prusa Orange @0.05')
  const vals = resinSettingsFor('Prusament Resin Tough Prusa Orange @0.05')
  assert.equal(vals.exposure_time, 6)
  assert.equal(vals.initial_exposure_time, 35)
  assert.equal(resinSettingsFor('no such resin'), null)
  const p = deriveSlaParams(sl1)
  assert.equal(p.exposure_time, 6)                         // flows through the derive untouched
  assert.ok(!('support_pillar_diameter' in vals))          // a material never carries support keys
  ok('materials: catalog + SL1 default exposure 6/35 applied')
}

console.log(`test_sla: ${passed} checks passed`)
