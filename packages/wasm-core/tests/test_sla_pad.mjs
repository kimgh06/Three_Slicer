import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import createSlicer from '../engine/src/slicer_core.js'

const here = dirname(fileURLToPath(import.meta.url))
const temporary = mkdtempSync(join(tmpdir(), 'sla-pad-'))

// Given: the SLA source group. When: the pad capability is audited. Then: the upstream Pad group
// (Pad.cpp + ConcaveHull + Tesselate) is linked and the capability is the supported prusa_port backend.
const build = readFileSync(join(here, 'build.sh'), 'utf8')
const sourceMatch = build.match(/^SLA_SRC="([^"]+)"/m)
assert.ok(sourceMatch, 'build.sh must declare SLA_SRC')
const linked = sourceMatch[1].split(/\s+/)
for (const unit of ['SLA/Pad.cpp', 'SLA/ConcaveHull.cpp', 'Tesselate.cpp'])
  assert.ok(linked.some(path => path.endsWith(unit)), `${unit} must be linked`)
assert.match(build, /glu-libtess/)
const notes = readFileSync(join(here, 'slasupport_port/PORT_NOTES.md'), 'utf8')
assert.match(notes, /Pad \(Pad\.cpp \+ ConcaveHull \+ Tesselate\/glu-libtess, LINKED\)/)
assert.match(notes, /pad_around_object/)
assert.match(notes, /is_zero_elevation/)

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

// A slab on a central leg: the slab's underside is a plate-reaching overhang, so embed-mode supports
// really exist and their feet keep the around-object pad from being redundant.
function tableSTL() {
  const boxFaces = (v) => [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]]
    .map(face => face.map(index => v[index]))
  const box = (x0, y0, z0, x1, y1, z1) => boxFaces([
    [x0,y0,z0],[x1,y0,z0],[x1,y1,z0],[x0,y1,z0],[x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1]])
  const triangles = [...box(-2, -2, 0, 2, 2, 5), ...box(-6, -6, 5, 6, 6, 7)]
  const buffer = Buffer.alloc(84 + triangles.length * 50)
  buffer.writeUInt32LE(triangles.length, 80)
  triangles.forEach((tri, index) => {
    let offset = 84 + index * 50 + 12
    for (const vertex of tri) for (const value of vertex) { buffer.writeFloatLE(value, offset); offset += 4 }
  })
  return new Uint8Array(buffer)
}

const params = over => JSON.stringify({
  layer_height: 0.05,
  initial_layer_height: 0.05,
  bed_width: 120.96,
  bed_depth: 68.04,
  ...over,
})

const roleSegments = (layer, role) => {
  const segments = []
  for (let index = 0; index < layer.paths.length; index += 8) {
    if ((layer.paths[index + 3] & 15) !== role) continue
    segments.push([
      [layer.paths[index], layer.paths[index + 1]],
      [layer.paths[index + 4], layer.paths[index + 5]],
    ])
  }
  return segments
}

try {
  // Given: the plain-data bridge alone. Then: pad_capability() is the supported prusa_port backend.
  const source = join(temporary, 'capability.cpp')
  const binary = join(temporary, 'capability')
  writeFileSync(source, String.raw`
#include "slasupport_bridge.h"
#include <cassert>
#include <iostream>
#include <string>
using namespace slasupport_bridge;
int main() {
  const PadCapability capability = pad_capability();
  assert(capability.status == PadCapabilityStatus::supported);
  assert(std::string(capability.code) == "SLA_PAD_SUPPORTED");
  assert(std::string(capability.backend) == "prusa_port");
  std::cout << capability.code << ' ' << capability.backend << '\n';
}
`)
  execFileSync('c++', ['-std=c++17', '-Wall', '-Wextra', '-Werror', '-I', here,
    source, join(here, 'slasupport_bridge_validate.cpp'), '-o', binary], { stdio: 'inherit' })
  assert.equal(execFileSync(binary, { encoding: 'utf8' }).trim(), 'SLA_PAD_SUPPORTED prusa_port')

  const slicer = await createSlicer()

  // Given: pad disabled. Then: no role-6 output of any kind (byte-identical disabled behavior).
  const off = slicer.slice_sla(boxSTL(), params({ pad_enable: false }), undefined)
  assert.equal(off.stats.pad_layers, 0)
  assert.equal(off.pad_mesh.length, 0)
  assert.ok(off.layers.every(layer => roleSegments(layer, 6).length === 0))

  // Given: pad enabled, supports off (default 2mm-thick flat pad).
  // Then: the ported pad occupies the bottom pad zone, the MODEL rises above it, and the layer count grows
  // by exactly the pad zone.
  const on = slicer.slice_sla(boxSTL(), params({ pad_enable: true }), undefined)
  assert.equal(on.stats.pad_capability, 'supported')
  assert.equal(on.stats.pad_code, 'SLA_PAD_SUPPORTED')
  assert.equal(on.stats.pad_backend, 'prusa_port')
  assert.equal(on.stats.pad_parity_status, 'upstream')
  assert.equal(on.stats.pad_error, undefined)
  assert.ok(on.pad_mesh.length > 0 && on.pad_mesh.length % 9 === 0)
  const padZone = 40 // ceil(pad_wall_thickness 2mm / 0.05)
  assert.equal(on.stats.layers, off.stats.layers + padZone)
  assert.equal(on.stats.pad_layers, padZone)
  const padLayerIndexes = on.layers.flatMap((layer, index) => roleSegments(layer, 6).length ? [index] : [])
  assert.deepEqual(padLayerIndexes, Array.from({ length: padZone }, (_, index) => index),
    'role-6 fills exactly the pad zone at the bottom')
  assert.ok(on.layers.slice(0, padZone).every(layer => roleSegments(layer, 1).length === 0),
    'no model contour inside the pad zone')
  assert.ok(roleSegments(on.layers[padZone], 1).length > 0, 'the model starts right above the pad')
  // The pad mesh itself sits on the plate and is exactly full_height tall.
  let zmin = Infinity, zmax = -Infinity
  for (let index = 2; index < on.pad_mesh.length; index += 3) {
    zmin = Math.min(zmin, on.pad_mesh[index]); zmax = Math.max(zmax, on.pad_mesh[index])
  }
  assert.ok(Math.abs(zmin) < 1e-4 && Math.abs(zmax - 2) < 1e-4, `pad z range [${zmin}, ${zmax}]`)
  // Brim: the pad silhouette reaches beyond the model footprint.
  let xmax = 0
  for (let index = 0; index < on.pad_mesh.length; index += 3) xmax = Math.max(xmax, Math.abs(on.pad_mesh[index]))
  assert.ok(xmax > 5.5, `pad reaches ${xmax}, expected beyond the 5mm footprint + brim`)

  // Given: pad + supports. Then: the feet stand ON the pad (support paths never below the pad zone top),
  // and the whole stack is pad + elevation + model.
  const sup = slicer.slice_sla(boxSTL(),
    params({ pad_enable: true, supports_enable: true, support_object_elevation: 5 }), undefined)
  assert.equal(sup.stats.pad_layers, padZone)
  assert.equal(sup.stats.layers, off.stats.layers + padZone + 100) // + elevation 5mm / 0.05
  assert.ok(sup.stats.support_points > 0)
  assert.ok(sup.support_mesh.length > 0 && sup.pad_mesh.length > 0)
  let supportZmin = Infinity
  for (let index = 2; index < sup.support_mesh.length; index += 3)
    supportZmin = Math.min(supportZmin, sup.support_mesh[index])
  assert.ok(supportZmin > 2 - 0.35, `support mesh bottom ${supportZmin} must stand on the 2mm pad top`)

  // Given: pad_around_object (embed / zero elevation) on a FLAT-BOTTOMED object with no supports needed.
  // Then: upstream validate_pad semantics — the ring survives only where supports stand, so the pad is
  // legally EMPTY, nothing lifts, and the object prints directly on the plate. Even a requested elevation
  // is forced to zero (is_zero_elevation).
  const embedFlat = slicer.slice_sla(boxSTL(),
    params({ pad_enable: true, pad_around_object: true, supports_enable: true, support_object_elevation: 5 }), undefined)
  assert.equal(embedFlat.error, undefined, `embed(flat) errored: ${embedFlat.error}`)
  assert.equal(embedFlat.pad_mesh.length, 0, 'no supports -> the ring is redundant everywhere -> empty pad')
  assert.equal(embedFlat.stats.pad_layers, 0)
  assert.equal(embedFlat.stats.elevation_layers, 0, 'embed forces zero elevation')
  assert.equal(embedFlat.stats.layers, off.stats.layers, 'an empty embed pad must not lift the stack')

  // Given: embed on an OVERHANG model (slab on a leg) whose supports really stand on the plate.
  // Then: the pad exists (feet pads + the ring), the stack grows by exactly the pad zone, the object is
  // not elevated, and the pad mesh occupies the [0, full_height] plate band.
  const table = tableSTL()
  const embed = slicer.slice_sla(table,
    params({ pad_enable: true, pad_around_object: true, supports_enable: true, support_object_elevation: 5 }), undefined)
  assert.equal(embed.error, undefined, `embed(overhang) errored: ${embed.error}`)
  assert.equal(embed.stats.pad_error, undefined)
  assert.ok(embed.stats.support_points > 0, 'the slab underside must demand supports')
  assert.ok(embed.pad_mesh.length > 0 && embed.pad_mesh.length % 9 === 0)
  assert.equal(embed.stats.pad_layers, padZone)
  assert.equal(embed.stats.elevation_layers, 0, 'embed forces zero elevation')
  const tableOff = slicer.slice_sla(table, params({}), undefined)
  assert.equal(embed.stats.layers, tableOff.stats.layers + padZone, 'embed lifts by the pad zone only')
  assert.ok(roleSegments(embed.layers[padZone], 1).length > 0, 'the model sits directly on the pad')
  let embedZmin = Infinity, embedZmax = -Infinity
  for (let index = 2; index < embed.pad_mesh.length; index += 3) {
    embedZmin = Math.min(embedZmin, embed.pad_mesh[index]); embedZmax = Math.max(embedZmax, embed.pad_mesh[index])
  }
  assert.ok(Math.abs(embedZmin) < 1e-4 && Math.abs(embedZmax - 2) < 1e-4,
    `embed pad z range [${embedZmin}, ${embedZmax}] must be the [0, full_height] plate band`)

  // Given: embed + everywhere on the flat cube. Then: the pad spreads under the whole footprint (a
  // BrimPadSkeleton), so it exists even with no supports, and the pad zone lifts the stack.
  const everywhere = slicer.slice_sla(boxSTL(),
    params({ pad_enable: true, pad_around_object: true, pad_around_object_everywhere: true }), undefined)
  assert.equal(everywhere.error, undefined, `everywhere pad errored: ${everywhere.error}`)
  assert.ok(everywhere.pad_mesh.length > 0)
  assert.equal(everywhere.stats.pad_layers, padZone)
  assert.equal(everywhere.stats.layers, off.stats.layers + padZone)

  // Given: a pad request that cannot be satisfied (supports on but enforcers-only filters every point, so
  // nothing reaches the plate to blueprint). Then: the SLICE fails — upstream's SlicingError semantics —
  // instead of silently emitting a scene lifted by a pad zone with nothing underneath.
  const unpaddable = slicer.slice_sla(boxSTL(),
    params({ pad_enable: true, supports_enable: true, support_object_elevation: 5, support_enforcers_only: true }), undefined)
  assert.match(unpaddable.error ?? '', /pad/, `expected a pad slicing error, got: ${unpaddable.error}`)

  // Determinism: the ported pad produces identical bytes across runs.
  const again = slicer.slice_sla(boxSTL(), params({ pad_enable: true }), undefined)
  assert.deepEqual(again.pad_mesh, on.pad_mesh)

  console.log('test_sla_pad: ported pad geometry, lifted layer frame, feet-on-pad, embed/everywhere, and pad-off isolation passed')
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
