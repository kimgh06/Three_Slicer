import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const manifest = JSON.parse(readFileSync(join(here, 'slasupport_port/SOURCE_MANIFEST.json'), 'utf8'))
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex')

assert.equal(manifest.schemaVersion, 1)
assert.equal(manifest.upstream.revision, 'b028299c770b8380ee81c921a2867d522f288123')
assert.deepEqual(manifest.build.compileFlags, ['-O2', '-std=c++17', '-DNDEBUG', '-DCGAL_DISABLE_ROUNDING_MATH_CHECK', '-DCGAL_DISABLE_GMP=1'])
assert.deepEqual(manifest.build.forbiddenFlags, ['-flto', '-ffast-math', '-Ofast'])

const copied = manifest.translationUnits.filter(unit => unit.kind === 'copied-upstream')
assert.equal(copied.length, 24)
assert.deepEqual(manifest.build.sourceOrder, manifest.translationUnits.map(unit => unit.localPath))
assert.equal(new Set(manifest.build.sourceOrder).size, manifest.build.sourceOrder.length)

for (const [index, unit] of manifest.translationUnits.entries()) {
  assert.equal(unit.dependencyProbe.sourceOrder, index)
  assert.equal(sha256(join(here, unit.localPath)), unit.localSha256)
  assert.match(unit.localPath, /^(?:slasupport_(?:bridge(?:_validate)?|slicer_fallback)\.cpp|slasupport_port\/)/)
  if (unit.kind === 'copied-upstream') {
    assert.equal(unit.upstreamPath, `src/${unit.localPath.replace(/^slasupport_port\//, '')}`)
    assert.equal(unit.upstreamRevision, manifest.upstream.revision)
  }
}

for (const target of manifest.deferredDependencyProbes) {
  assert.equal(target.copied, false)
  assert.match(target.upstreamPath, /^src\/libslic3r\/SLA\//)
  assert.ok(target.requiredLocalUnits?.length > 0 || target.missingDependencies?.length > 0)
}

const build = readFileSync(join(here, 'build.sh'), 'utf8')
const sourceMatch = build.match(/^SLA_SRC="([^"]+)"/m)
assert.ok(sourceMatch)
assert.deepEqual(sourceMatch[1].trim().split(/\s+/), manifest.build.sourceOrder)
for (const flag of manifest.build.forbiddenFlags) {
  assert.doesNotMatch(sourceMatch[0], new RegExp(flag.replace('-', '\\-')))
}

const output = execFileSync('bash', [join(here, 'probe_sla_source_group.sh')], {
  cwd: here,
  encoding: 'utf8'
}).trim()
assert.match(output, /sla_source_probe: 27 translation units; dependencies isolated; relocatable link passed/)

console.log('test_sla_source_manifest: provenance, hashes, deterministic flags/order, deferred probes, and dependency isolation passed')
