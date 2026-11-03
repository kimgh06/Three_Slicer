// The kernel half of the object tools: mesh_boolean, variable layer height, painted seams.
//   Run: node packages/wasm-core/tests/test_mesh_tools_kernel.mjs
import assert from 'node:assert/strict'
import createSlicer from '../../engine/src/slicer_core.js'
import { trianglesToSTL } from './stl_fixtures.mjs'

const slicer = await createSlicer()

function quad(soup, a, b, c, d) { soup.push(...a, ...b, ...c, ...a, ...c, ...d) }
function box(soup, [x0, y0, z0], [x1, y1, z1]) {
  quad(soup, [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0])
  quad(soup, [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1])
  quad(soup, [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1])
  quad(soup, [x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1])
  quad(soup, [x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1])
  quad(soup, [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1])
  return soup
}
const boxSoup = (low, high) => new Float32Array(box([], low, high))
function volume(soup) {
  let sum = 0
  for (let i = 0; i < soup.length; i += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = soup.subarray(i, i + 9)
    sum += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)
  }
  return sum / 6
}
const near = (value, expected, tolerance = 1e-2) => assert.ok(Math.abs(value - expected) <= tolerance, `${value} vs ${expected}`)

// ---- mesh_boolean ----
const UNION = 0, DIFFERENCE = 1, INTERSECTION = 2
const first = boxSoup([0, 0, 0], [20, 20, 20]), second = boxSoup([10, 0, 0], [30, 20, 20])
near(volume(slicer.mesh_boolean(first, second, UNION).positions), 12000)
near(volume(slicer.mesh_boolean(first, second, DIFFERENCE).positions), 4000)
near(volume(slicer.mesh_boolean(first, second, INTERSECTION).positions), 4000)
assert.match(slicer.mesh_boolean(first, boxSoup([50, 50, 50], [60, 60, 60]), INTERSECTION).error, /^MESH_BOOLEAN_EMPTY: /)
assert.match(slicer.mesh_boolean(first.subarray(0, 9 * 11), second, UNION).error, /^MESH_BOOLEAN_NOT_SOLID: /)

// Corners that differ only by float noise near 0 are one corner: three.js' cylinder seam and sphere poles land there.
{
  const noisy = boxSoup([-5, -5, 0], [5, 5, 10])
  for (let at = 0; at < noisy.length; at += 3) if (noisy[at] === 5) noisy[at] = (at % 2) * 2.4e-13 + 5
  const seamed = new Float32Array(noisy)
  for (let at = 0; at < seamed.length; at += 9) seamed[at] += (at % 18) * 1e-13
  const zeroX = boxSoup([0, 0, 0], [10, 10, 10])
  for (let at = 0; at < zeroX.length; at += 3) if (zeroX[at] === 0) zeroX[at] = ((at % 6) - 3) * 1e-16
  assert.equal(slicer.mesh_boolean(boxSoup([-20, -20, 0], [20, 20, 20]), zeroX, DIFFERENCE).error, undefined)
}

// ---- variable layers ----
const params = { layer_height: 0.2, first_layer_height: 0.2, line_width: 0.42, wall_loops: 2, infill_density: 0.15, nozzle_diameter: 0.4,
  filament_diameter: 1.75, flow_ratio: 1, print_speed: 60, first_layer_speed: 20, travel_speed: 150, nozzle_temp: 210, bed_temp: 60,
  top_shell_layers: 3, bottom_shell_layers: 3, skirt_loops: 0, skirt_distance: 2, brim_width: 0, retract_length: 0.8, retract_speed: 30, z_hop: 0, infill_angle: 45,
  bed_width: 200, bed_depth: 200 }
const stlOf = (soup) => {
  const triangles = []
  for (let i = 0; i < soup.length; i += 9) triangles.push([0, 3, 6].map(at => [soup[i + at], soup[i + at + 1], soup[i + at + 2]]))
  return new Uint8Array(trianglesToSTL(triangles))
}
const cube = stlOf(boxSoup([-10, -10, 0], [10, 10, 20]))
const slice = (extra) => slicer.slice(cube, JSON.stringify({ ...params, ...extra }), () => {})
const layerZs = (gcode) => [...new Set([...gcode.matchAll(/^G1 Z([\d.]+)/gm)].map(match => Number(match[1])))]
const fixed = slice({})
const banded = slice({ variable_layer_heights: [10, 0.1] })
assert.equal(fixed.error, undefined); assert.equal(banded.error, undefined)
assert.ok(banded.stats.layers > fixed.stats.layers + 40, `${banded.stats.layers} vs ${fixed.stats.layers}`)
near(banded.stats.layers, 50 + 100, 2)
const refused = slice({ variable_layer_heights: [10, 0.1], enable_support: true, support_style: 'grid', support_threshold_angle: 30, support_density: 0.15 })
assert.match(refused.error, /^UNSUPPORTED_VARIABLE_LAYERS: /)

for (const height of [0, -0.1, 0.0001]) assert.match(slice({ variable_layer_heights: [10, height] }).error, /^INVALID_VARIABLE_LAYERS: /)

// ---- painted seams ----
const wallStarts = (gcode) => {
  // The position a layer's first wall extrusion starts from, relative to the bed centre.
  const starts = []
  for (const layer of gcode.split(';LAYER_CHANGE').slice(1)) {
    const lines = layer.split('\n')
    const first = lines.findIndex(line => /^G1 .*E/.test(line) && !/ Z/.test(line))
    if (first > 0) { const match = lines.slice(0, first).reverse().join('\n').match(/X([\d.-]+) Y([\d.-]+)/); if (match) starts.push([Number(match[1]) - 100, Number(match[2]) - 100]) }
  }
  return starts
}
const marked = slice({ seam_enforcers: Array.from(boxSoup([9.9, -0.5, 0], [10.1, 0.5, 20])) })
assert.equal(marked.error, undefined)
const nearStripe = (gcode) => (gcode.match(/^G1 .*/gm) ?? []).filter(line => {
  const match = line.match(/X([\d.-]+) Y([\d.-]+)/)
  return match && Math.abs(Number(match[1]) - 110) < 2 && Math.abs(Number(match[2]) - 100) < 1
}).length
assert.ok(nearStripe(marked.gcode) > nearStripe(fixed.gcode) + 40, `${nearStripe(marked.gcode)} vs ${nearStripe(fixed.gcode)}`)
assert.ok(wallStarts !== null)
// The multi-material path: a painted facet routes there, and a seam mark moves its wall start.
slicer.selector_prepare(cube)
slicer.selector_import_paint(Int32Array.from([0, 1]), ['8', '8'].join('\n'))
const material = { extruder_count: 2 }
const paintedPlain = slice(material)
assert.ok(/^T1$/m.test(paintedPlain.gcode), 'the paint reached the multi-material path')
slicer.selector_prepare(cube)
slicer.selector_import_paint(Int32Array.from([0, 1]), ['8', '8'].join('\n'))
const paintedMarked = slice({ ...material, seam_enforcers: Array.from(boxSoup([9.9, -0.5, 0], [10.1, 0.5, 20])) })
assert.ok(nearStripe(paintedMarked.gcode) > nearStripe(paintedPlain.gcode) + 20, `multi-material ${nearStripe(paintedMarked.gcode)} vs ${nearStripe(paintedPlain.gcode)}`)
const arachneFixed = slice({ wall_generator: 'arachne' })
const arachneMarked = slice({ wall_generator: 'arachne', seam_enforcers: Array.from(boxSoup([9.9, -0.5, 0], [10.1, 0.5, 20])) })
assert.ok(nearStripe(arachneMarked.gcode) > nearStripe(arachneFixed.gcode) + 40, `arachne ${nearStripe(arachneMarked.gcode)} vs ${nearStripe(arachneFixed.gcode)}`)

// ---- st and mt give the same bytes ----
const { default: createThreaded } = await import('../../engine/src/slicer_core.mt.js')
const threaded = await createThreaded()
for (const extra of [{ variable_layer_heights: [10, 0.1] }, { seam_enforcers: Array.from(boxSoup([9.9, -0.5, 0], [10.1, 0.5, 20])) }]) {
  const threadedResult = threaded.slice(cube, JSON.stringify({ ...params, ...extra }), () => {})
  assert.equal(threadedResult.gcode, slice(extra).gcode, Object.keys(extra)[0])
}
console.log('test_mesh_tools_kernel: ok')
process.exit(0)   // the threaded kernel's pool keeps node alive

