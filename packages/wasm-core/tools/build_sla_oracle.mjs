#!/usr/bin/env node
// Establishes the reproducible input/provenance manifest for a separately-built Prusa SLA oracle adapter.
// It deliberately does not build PrusaSlicer: that build belongs outside packages/ and may not alter slicers/.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

function arg(name) {
  const index = process.argv.indexOf(name)
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing ${name}`)
  return resolve(process.argv[index + 1])
}

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
const stable = (value) => `${JSON.stringify(value, null, 2)}\n`

const source = arg('--prusa-source')
const out = arg('--out')
const versionFile = join(source, 'version.inc')
const versionText = readFileSync(versionFile, 'utf8')
const version = /set\(SLIC3R_VERSION "([^"]+)"\)/.exec(versionText)?.[1]
if (version !== '2.9.6') throw new Error(`Expected PrusaSlicer 2.9.6, found ${version ?? 'no SLIC3R_VERSION'} in ${versionFile}`)

let revision
try {
  revision = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
} catch {
  throw new Error(`Prusa source must be a Git checkout so the oracle revision can be pinned: ${source}`)
}

const sourceFiles = ['version.inc', 'src/libslic3r/SLAPrintSteps.cpp', 'src/libslic3r/Format/SL1.cpp']
  .map((relative) => ({ relative, sha256: sha256(join(source, relative)) }))

mkdirSync(out, { recursive: true })
const manifest = {
  schema: 'three-slicer.sla-native-oracle-manifest.v1',
  fixtureDirectory: join(dirname(fileURLToPath(import.meta.url)), 'fixtures/sla'),
  prusa: { source: basename(source), version, revision, sourceFiles },
  adapter: {
    required: true,
    path: 'sla-oracle-adapter',
    protocol: 'three-slicer.sla-native-oracle-observable.v1',
    invocation: ['sla-oracle-adapter', '--prusa-bin', '<PRUSA_SLICER_BIN>', '--fixture', '<fixture.json>', '--out', '<observable.json>'],
  },
  deterministicEnvironment: { LC_ALL: 'C', LANG: 'C', OMP_NUM_THREADS: '1', PRUSA_SLA_ORACLE_SEED: '0' },
  profile: { printer_model: 'SL1', printer_preset: 'Original Prusa SL1', sla_archive_format: 'SL1' },
  normalization: {
    layerPolygons: 'canonicalized closed loops, sorted by layer then signed area then coordinates',
    supportPoints: 'sorted by object, layer, x, y, z, type',
    rolePaths: 'role-5 and role-6 segment counts and canonical paths',
    meshBounds: 'min/max xyz or null for an empty mesh',
    decodedMasks: 'PNG pixels, not PNG or ZIP bytes',
    archiveMembers: 'member name plus uncompressed SHA-256; ZIP metadata/timestamps excluded',
  },
}
writeFileSync(join(out, 'manifest.json'), stable(manifest))
console.log(join(out, 'manifest.json'))
