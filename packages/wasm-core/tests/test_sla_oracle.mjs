import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const here = new URL('.', import.meta.url).pathname
const root = resolve(here, '../..')
const fixtures = join(here, 'fixtures/sla')
const source = join(root, 'slicers/PrusaSlicer')
const out = mkdtempSync(join(tmpdir(), 'three-slicer-sla-oracle-'))

try {
  // Given: the pinned Prusa source and deterministic fixtures.
  // When: the manifest builder runs without a native binary.
  execFileSync(process.execPath, [join(here, 'build_sla_oracle.mjs'), '--prusa-source', source, '--out', out])

  // Then: the manifest records the exact source provenance and every fixture has a committed baseline.
  const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'))
  assert.equal(manifest.prusa.version, '2.9.6')
  assert.equal(manifest.adapter.required, true)
  assert.equal(manifest.fixtureDirectory, fixtures)
  for (const fixture of ['cube-support-off-pad-off', 'mushroom-support-off-pad-off']) {
    const baseline = JSON.parse(readFileSync(join(fixtures, fixture, 'baseline.json'), 'utf8'))
    assert.equal(baseline.observable.supportPoints, 0, fixture)
    assert.equal(baseline.observable.role5Paths, 0, fixture)
    assert.equal(baseline.observable.role6Paths, 0, fixture)
    assert.equal(baseline.observable.supportMeshBounds, null, fixture)
    assert.equal(baseline.observable.padMeshBounds, null, fixture)
  }

  // Given: no native oracle binary or adapter.
  // When: regeneration is requested.
  // Then: it fails clearly rather than substituting the current kernel.
  assert.throws(() => execFileSync(process.execPath, [join(here, 'generate_sla_oracle.mjs'), '--fixtures', fixtures], {
    env: { ...process.env, PRUSA_SLICER_BIN: '', PRUSA_NATIVE_ORACLE: out },
    stdio: 'pipe',
  }), /PRUSA_SLICER_BIN/)
  console.log('test_sla_oracle: 3 checks passed')
} finally {
  rmSync(out, { recursive: true, force: true })
}
