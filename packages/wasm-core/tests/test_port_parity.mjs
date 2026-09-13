// The arachne_port and treesupport_port trees are two snapshots of the same OrcaSlicer
// generation, kept as separate copies because each compile group resolves headers
// file-relative (see build.sh). Same-named files are byte-identical by construction —
// EXCEPT the deliberate stub/real divergences listed below. This test turns that
// duplication from a drift hazard into a checked invariant: patching one copy of a
// shared file without the other fails here, as does adding a new divergence (or
// removing one) without updating the list.
import { strict as assert } from 'node:assert'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

// The deliberate divergences: the arachne group compiles against stub PrintConfig/Print/
// Preset headers while the treesupport group uses the real ones, and a handful of sources
// carry documented per-group edits (build.sh stage 17/18 notes).
const EXPECTED_DIVERGENT = new Set([
  'libslic3r/Arachne/SkeletalTrapezoidation.cpp',
  'libslic3r/CutUtils.hpp',
  'libslic3r/ExtrusionEntity.cpp',
  'libslic3r/Fill/FillBase.cpp',
  'libslic3r/Flow.hpp',
  'libslic3r/Geometry/VoronoiUtilsCgal.cpp',
  'libslic3r/MultiMaterialSegmentation.hpp',
  'libslic3r/Point.hpp',
  'libslic3r/Preset.hpp',
  'libslic3r/Print.hpp',
  'libslic3r/PrintConfig.hpp',
  'libslic3r/SVG.hpp',
  'libslic3r/Semver.hpp',
  'libslic3r/Support/SupportCommon.cpp',
  'libslic3r/Support/SupportLayer.hpp',
  'libslic3r/Utils.hpp',
  'libslic3r/libslic3r.h',
])

const listFiles = root => {
  const out = []
  const walk = dir => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (!entry.includes('.bak')) out.push(relative(root, full))
    }
  }
  walk(root)
  return out
}

const arachneRoot = join(here, 'arachne_port')
const treeRoot = join(here, 'treesupport_port')
const treeFiles = new Set(listFiles(treeRoot).filter(f => !f.endsWith('.wasm')))

let shared = 0
const divergent = new Set()
for (const rel of listFiles(arachneRoot)) {
  if (!treeFiles.has(rel)) continue
  shared += 1
  if (!readFileSync(join(arachneRoot, rel)).equals(readFileSync(join(treeRoot, rel)))) divergent.add(rel)
}

// A near-empty tree must not pass vacuously. (278 shared today; ~53 pairs are dead
// upstream leftovers scheduled for deletion, so the floor sits below that.)
assert.ok(shared >= 200, `expected the two port trees to share 200+ files, found ${shared}`)

const unexpected = [...divergent].filter(f => !EXPECTED_DIVERGENT.has(f)).sort()
assert.deepEqual(unexpected, [], `shared port files drifted apart (patch both copies or add to the divergence list): ${unexpected.join(', ')}`)

const stale = [...EXPECTED_DIVERGENT].filter(f => existsSync(join(arachneRoot, f)) && existsSync(join(treeRoot, f)) && !divergent.has(f)).sort()
assert.deepEqual(stale, [], `divergence list entries are now byte-identical (remove them): ${stale.join(', ')}`)

// The kernel's own clipper build keeps a local copy of Int128.hpp (see the WASM patch
// note in clipper.cpp); it must stay in lockstep with the copy the ports compile against.
const int128 = readFileSync(join(here, 'Int128.hpp'))
for (const port of [arachneRoot, treeRoot]) {
  const copy = join(port, 'libslic3r/Int128.hpp')
  if (existsSync(copy)) assert.ok(int128.equals(readFileSync(copy)), `Int128.hpp drifted from ${relative(here, copy)}`)
}

console.log(`test_port_parity: ${shared} shared files in lockstep, ${divergent.size} documented divergences, Int128.hpp trio matched`)
