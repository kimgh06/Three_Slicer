// The license boundary, from the permissive side: this package carries no AGPL.
//   Run: node packages-mit/test_license_boundary.mjs
//
// The split only means something if this holds. A single import of `three-slicer` from here would make the
// tarball a combined work, and the MIT grant on it would be one nobody had the right to give. It lives in
// THIS package so a standalone checkout (the mirror repo) proves its own boundary; the monorepo's
// packages/viewer/test_license_boundary.mjs runs it and adds what only the monorepo can check (the
// provenance list, the version lockstep).
import assert from 'node:assert'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve, sep } from 'node:path'

const PACKAGE = dirname(fileURLToPath(import.meta.url))

let failures = 0
const check = (label, condition, detail = '') => {
  if (condition) console.log(`  ok: ${label}`)
  else { console.log(`  FAIL: ${label}${detail ? ' — ' + detail : ''}`); failures++ }
}
// Comments are dropped before an import scan, never string literals: an import path IS a string literal, and
//  the version that stripped them saw an empty list and passed everything.
const dropComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const isAgpl = (spec) => spec === 'three-slicer' || spec.startsWith('three-slicer/')

console.log('[license: the manifest declares no AGPL]')
const manifest = JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf8'))
check('declares a permissive license', manifest.license === 'MIT', manifest.license)
const deps = { ...manifest.dependencies, ...manifest.peerDependencies, ...manifest.optionalDependencies }
const agplDeps = Object.keys(deps).filter(isAgpl)
check('depends on nothing AGPL', agplDeps.length === 0, agplDeps.join(' '))

console.log('\n[license: no source reaches the AGPL package or outside this one]')
// Every surface a reverse dependency could ride in on, not only .js/.jsx: type-only imports in .d.ts, CSS
//  @import/url(), string values in JSON, and worker URLs. The reviewer of the split named each of these as a
//  gap; the monorepo's negative tests plant one of each.
const sources = []
const walk = (dir, prefix) => {
  for (const entry of readdirSync(join(PACKAGE, dir), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) { if (entry.name !== 'node_modules' && entry.name !== 'dist') walk(join(dir, entry.name), rel) }
    else if (/\.(jsx?|mjs|ts|css|json)$/.test(entry.name))
      sources.push([rel, readFileSync(join(PACKAGE, dir, entry.name), 'utf8')])
  }
}
for (const top of ['src', 'types', 'data']) if (existsSync(join(PACKAGE, top))) walk(top, top)
sources.push(['styles.css', readFileSync(join(PACKAGE, 'styles.css'), 'utf8')])
check('has sources', sources.length > 0, `${sources.length}`)
// A `// from 'three-slicer/x'` in prose cannot trip this (comments dropped).
for (const [rel, text] of sources) {
  const code = dropComments(text)
  // import/export … from, dynamic import(), require(), type-only imports (same syntax), worker URLs, and
  //  CSS @import / url(). JSON has no comments, so every string value is a candidate.
  const specs = rel.endsWith('.json')
    ? [...code.matchAll(/"((?:three-slicer)[^"]*)"/g)].map(m => m[1])
    : [...code.matchAll(/(?:from|import|require|new\s+URL|@import|url)\s*\(?\s*['"]([^'"]+)['"]/g)].map(m => m[1])
  const bad = specs.filter(isAgpl)
  check(`${rel}: imports no AGPL package`, bad.length === 0, bad.join(' '))
  const escapes = specs.filter(spec => spec.startsWith('.') && !resolve(join(PACKAGE, dirname(rel)), spec).startsWith(PACKAGE + sep))
  check(`${rel}: reaches nothing outside the package`, escapes.length === 0, escapes.join(' '))
}

console.log('\n[license: the shipped bundle carries no AGPL]')
// What SHIPS is dist/, not src/: a source import that the bundler resolves gets inlined, and only tree-shaking
//  stood between an AGPL import in use_slicer.js and an AGPL bundle. Skipped, not failed, with no build to scan.
const dist = join(PACKAGE, 'dist')
if (existsSync(dist)) {
  for (const name of readdirSync(dist).filter(n => n.endsWith('.js'))) {
    const built = readFileSync(join(dist, name), 'utf8')
    const specs = [...built.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map(m => m[1])
    const bad = specs.filter(isAgpl)
    const inlined = /slicer_core|printers\.sets|loadProcesses|loadFilaments/.test(built)
    check(`dist/${name}: no AGPL import and no inlined kernel or catalog code`, bad.length === 0 && !inlined,
      bad.join(' ') || (inlined ? 'AGPL code was bundled in' : ''))
  }
} else console.log('  skip: dist not built — the shipped bundle was not scanned')

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL LICENSE BOUNDARY CHECKS PASSED')
assert.equal(failures, 0)
