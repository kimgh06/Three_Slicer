#!/usr/bin/env node
// Regenerates goldens only through a native adapter. Never imports or invokes this project's SLA implementation.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

function arg(name) {
  const index = process.argv.indexOf(name)
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing ${name}`)
  return resolve(process.argv[index + 1])
}

const fixtures = arg('--fixtures')
const binary = process.env.PRUSA_SLICER_BIN
const oracle = process.env.PRUSA_NATIVE_ORACLE
if (!binary) throw new Error('PRUSA_SLICER_BIN is required for SLA oracle regeneration; no kernel fallback exists.')
if (!oracle) throw new Error('PRUSA_NATIVE_ORACLE is required for SLA oracle regeneration; run build_sla_oracle.mjs first.')

const manifestPath = join(oracle, 'manifest.json')
if (!existsSync(manifestPath)) throw new Error(`Missing native oracle manifest: ${manifestPath}`)
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
if (manifest.schema !== 'three-slicer.sla-native-oracle-manifest.v1' || manifest.prusa?.version !== '2.9.6')
  throw new Error(`Invalid Prusa 2.9.6 oracle manifest: ${manifestPath}`)
const version = execFileSync(binary, ['--version'], { encoding: 'utf8', env: { ...process.env, ...manifest.deterministicEnvironment } })
if (!version.includes('2.9.6')) throw new Error(`PRUSA_SLICER_BIN must report 2.9.6; got ${JSON.stringify(version.trim())}`)

const adapter = join(oracle, manifest.adapter.path)
if (!existsSync(adapter)) {
  throw new Error(`Missing native SLA oracle adapter: ${adapter}. The Prusa CLI alone cannot emit support points, role paths, or decoded masks; do not substitute the current kernel.`)
}

const canonical = (value) => `${JSON.stringify(value, null, 2)}\n`
const hash = (value) => createHash('sha256').update(canonical(value)).digest('hex')
for (const entry of readdirSync(fixtures).sort()) {
  const fixtureDir = join(fixtures, entry)
  if (!statSync(fixtureDir).isDirectory()) continue
  const fixture = join(fixtureDir, 'fixture.json')
  const baseline = join(fixtureDir, 'baseline.json')
  if (!existsSync(fixture) || !existsSync(baseline)) continue
  const output = join(fixtureDir, 'oracle.json')
  execFileSync(adapter, ['--prusa-bin', binary, '--fixture', fixture, '--out', output], {
    env: { ...process.env, ...manifest.deterministicEnvironment }, stdio: 'inherit',
  })
  const observable = JSON.parse(readFileSync(output, 'utf8'))
  if (observable.schema !== manifest.adapter.protocol) throw new Error(`Adapter wrote an invalid observable for ${entry}`)
  writeFileSync(join(fixtureDir, 'oracle.sha256'), `${hash(observable)}  oracle.json\n`)
}
console.log(`Regenerated SLA oracle fixtures from ${binary}`)
