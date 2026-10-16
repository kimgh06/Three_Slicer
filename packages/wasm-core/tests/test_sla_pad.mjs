import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import createSlicer from '../../engine/src/slicer_core.js'
import { outwardBoxTriangles, trianglesToSTLBytes } from './stl_fixtures.mjs'

const here = join(dirname(fileURLToPath(import.meta.url)), '..')   // the package root, one above tests/
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

// A 10x10x5 box centred on the origin.
function boxSTL() {
  return trianglesToSTLBytes(outwardBoxTriangles(-5, -5, 0, 10, 10, 5))
}

// A slab on a central leg: the slab's underside is a plate-reaching overhang, so embed-mode supports
// really exist and their feet keep the around-object pad from being redundant.
function tableSTL() {
  return trianglesToSTLBytes([...outwardBoxTriangles(-2, -2, 0, 4, 4, 5), ...outwardBoxTriangles(-6, -6, 5, 12, 12, 2)])
}

const params = overrides => JSON.stringify({
  layer_height: 0.05,
  initial_layer_height: 0.05,
  bed_width: 120.96,
  bed_depth: 68.04,
  ...overrides,
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
  const padOff = slicer.slice_sla(boxSTL(), params({ pad_enable: false }), undefined)
  assert.equal(padOff.stats.pad_layers, 0)
  assert.equal(padOff.pad_mesh.length, 0)
  assert.ok(padOff.layers.every(layer => roleSegments(layer, 6).length === 0))

  // Given: pad enabled, supports off (default 2mm-thick flat pad).
  // Then: the ported pad occupies the bottom pad zone, the MODEL rises above it, and the layer count grows
  // by exactly the pad zone.
  const padOn = slicer.slice_sla(boxSTL(), params({ pad_enable: true }), undefined)
  assert.equal(padOn.stats.pad_capability, 'supported')
  assert.equal(padOn.stats.pad_code, 'SLA_PAD_SUPPORTED')
  assert.equal(padOn.stats.pad_backend, 'prusa_port')
  assert.equal(padOn.stats.pad_parity_status, 'upstream')
  assert.equal(padOn.stats.pad_error, undefined)
  assert.ok(padOn.pad_mesh.length > 0 && padOn.pad_mesh.length % 9 === 0)
  const padZone = 40 // ceil(pad_wall_thickness 2mm / 0.05)
  assert.equal(padOn.stats.layers, padOff.stats.layers + padZone)
  assert.equal(padOn.stats.pad_layers, padZone)
  const padLayerIndexes = padOn.layers.flatMap((layer, index) => {
    if (roleSegments(layer, 6).length) return [index]
    return []
  })
  assert.deepEqual(padLayerIndexes, Array.from({ length: padZone }, (_, index) => index),
    'role-6 fills exactly the pad zone at the bottom')
  assert.ok(padOn.layers.slice(0, padZone).every(layer => roleSegments(layer, 1).length === 0),
    'no model contour inside the pad zone')
  assert.ok(roleSegments(padOn.layers[padZone], 1).length > 0, 'the model starts right above the pad')
  // The pad mesh itself sits on the plate and is exactly full_height tall.
  let zmin = Infinity, zmax = -Infinity
  for (let index = 2; index < padOn.pad_mesh.length; index += 3) {
    zmin = Math.min(zmin, padOn.pad_mesh[index])
    zmax = Math.max(zmax, padOn.pad_mesh[index])
  }
  assert.ok(Math.abs(zmin) < 1e-4 && Math.abs(zmax - 2) < 1e-4, `pad z range [${zmin}, ${zmax}]`)
  // Brim: the pad silhouette reaches beyond the model footprint.
  let xmax = 0
  for (let index = 0; index < padOn.pad_mesh.length; index += 3) xmax = Math.max(xmax, Math.abs(padOn.pad_mesh[index]))
  assert.ok(xmax > 5.5, `pad reaches ${xmax}, expected beyond the 5mm footprint + brim`)

  // Given: pad + supports. Then: the feet stand ON the pad (support paths never below the pad zone top),
  // and the whole stack is pad + elevation + model.
  const supported = slicer.slice_sla(boxSTL(),
    params({ pad_enable: true, supports_enable: true, support_object_elevation: 5 }), undefined)
  assert.equal(supported.stats.pad_layers, padZone)
  assert.equal(supported.stats.layers, padOff.stats.layers + padZone + 100) // + elevation 5mm / 0.05
  assert.ok(supported.stats.support_points > 0)
  assert.ok(supported.support_mesh.length > 0 && supported.pad_mesh.length > 0)
  let supportZmin = Infinity
  for (let index = 2; index < supported.support_mesh.length; index += 3)
    supportZmin = Math.min(supportZmin, supported.support_mesh[index])
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
  assert.equal(embedFlat.stats.layers, padOff.stats.layers, 'an empty embed pad must not lift the stack')

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
    embedZmin = Math.min(embedZmin, embed.pad_mesh[index])
    embedZmax = Math.max(embedZmax, embed.pad_mesh[index])
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
  assert.equal(everywhere.stats.layers, padOff.stats.layers + padZone)

  // Given: a pad request that cannot be satisfied (supports on but enforcers-only filters every point, so
  // nothing reaches the plate to blueprint). Then: the SLICE fails — upstream's SlicingError semantics —
  // instead of silently emitting a scene lifted by a pad zone with nothing underneath.
  const unpaddable = slicer.slice_sla(boxSTL(),
    params({ pad_enable: true, supports_enable: true, support_object_elevation: 5, support_enforcers_only: true }), undefined)
  assert.match(unpaddable.error ?? '', /pad/, `expected a pad slicing error, got: ${unpaddable.error}`)

  // Determinism: the ported pad produces identical bytes across runs.
  const again = slicer.slice_sla(boxSTL(), params({ pad_enable: true }), undefined)
  assert.deepEqual(again.pad_mesh, padOn.pad_mesh)

  console.log('test_sla_pad: ported pad geometry, lifted layer frame, feet-on-pad, embed/everywhere, and pad-off isolation passed')
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
