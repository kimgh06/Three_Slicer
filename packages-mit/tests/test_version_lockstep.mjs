// The two packages ship as a locked pair, as a check rather than a convention.
//   Run: node packages-mit/test_version_lockstep.mjs
//
// three-slicer re-exports three-slicer-viewer (viewer/toolpath, viewer/gcode). If the dependency were a
// RANGE, `three-slicer@0.3.0` would happily resolve a later `0.3.7` of this package, and the first place that
// combination ever got assembled would be a user's node_modules — a pair nobody built and nobody tested.
//
// npm makes the failure permanent rather than embarrassing: a version number can never be reused, and
// unpublish is refused after 72 hours. So this runs before a release, not after one.
//
// The cost of lockstep is that a kernel-only release still bumps this package. That is cosmetic churn traded
// against a correctness failure, which is the right way round.
import assert from 'node:assert'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const permissive = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'))
const agplPath = join(here, '..', 'packages', 'package.json')
// The pair is checked where the pair exists. A standalone checkout (the MIT mirror) has no AGPL half to
//  compare against; the monorepo is where lockstep is enforced, so this is a skip there, not a pass.
if (!existsSync(agplPath)) {
  console.log('skip: standalone checkout — version lockstep is enforced in the monorepo')
  process.exit(0)
}
const agpl = JSON.parse(readFileSync(agplPath, 'utf8'))

let failures = 0
const check = (label, condition, detail = '') => {
  if (condition) console.log(`  ok: ${label}`)
  else { console.log(`  FAIL: ${label}${detail ? ' — ' + detail : ''}`); failures++ }
}

console.log('[lockstep: one version across the pair]')
check('both packages carry the same version', agpl.version === permissive.version,
  `${agpl.name}@${agpl.version} vs ${permissive.name}@${permissive.version}`)

console.log('\n[lockstep: the dependency is an exact pin]')
const declared = agpl.dependencies?.[permissive.name]
check(`${agpl.name} depends on ${permissive.name}`, typeof declared === 'string', String(declared))
if (typeof declared === 'string') {
  // A leading ^ or ~ is the whole failure mode this file exists to prevent, so it is named explicitly
  //  rather than being caught by a generic equality check.
  check('the pin carries no range operator', !/^[\^~><=*]|\s|\|\|/.test(declared), declared)
  check('the pin is exactly the shipped version', declared === permissive.version,
    `${declared} vs ${permissive.version}`)
}

console.log('\n[lockstep: the demo app pins the workspace versions]')
// web/viewer is a workspace member, but a range it declares is still a RANGE: when the pair moved to 0.3.0
//  and the app still said ^0.2.0, npm quietly fetched 0.2.5 from the registry into web/viewer/node_modules
//  and the docker build failed on an export that 0.2.5 does not have. An exact pin cannot drift that way.
const webPath = join(here, '..', 'web', 'viewer', 'package.json')
if (existsSync(webPath)) {
  const web = JSON.parse(readFileSync(webPath, 'utf8'))
  for (const name of [agpl.name, permissive.name])
    check(`web/viewer pins ${name} at ${permissive.version}`, web.dependencies?.[name] === permissive.version,
      String(web.dependencies?.[name]))
}

// The image runs one workspace by NAME, and this package took that name in the split: the web app used to be
//  `three-slicer-viewer` and is `three-slicer-web` now, so the unchanged CMD started resolving to packages-mit
//  and the container restart-looped on a missing `preview` script. The name is not checked by anything npm runs.
const dockerfile = join(here, '..', 'web', 'Dockerfile')
if (existsSync(dockerfile) && existsSync(webPath)) {
  const cmd = readFileSync(dockerfile, 'utf8').match(/CMD \[\s*"npm",\s*"run",\s*"([^"]+)",\s*"-w",\s*"([^"]+)"/)
  const [script, workspace] = cmd ? [cmd[1], cmd[2]] : ['', '']
  const web = JSON.parse(readFileSync(webPath, 'utf8'))
  check(`the Dockerfile runs the web app's workspace`, workspace === web.name, `${workspace} vs ${web.name}`)
  check(`the web app has the '${script}' script the Dockerfile runs`, Boolean(web.scripts?.[script]))
}

console.log('\n[lockstep: the licenses are what the split assumed]')
check(`${permissive.name} is permissively licensed`, permissive.license === 'MIT', permissive.license)
check(`${agpl.name} is still AGPL`, /^AGPL-3\.0/.test(agpl.license || ''), agpl.license)

console.log('\n[lockstep: every re-exported subpath exists on the other side]')
// three-slicer/viewer/toolpath and /viewer/gcode are entry points consumers already depend on. They now
//  resolve THROUGH this package, so a rename here breaks them silently — the AGPL build would still emit a
//  shim, and the shim would export nothing.
const REEXPORTED = { './viewer': '.', './viewer/toolpath': './toolpath', './viewer/gcode': './gcode', './viewer/loaders': './loaders' }
for (const [agplPathKey, permissiveKey] of Object.entries(REEXPORTED)) {
  check(`${agpl.name} publishes ${agplPathKey}`, !!agpl.exports?.[agplPathKey])
  check(`${permissive.name} publishes ${permissiveKey}`, !!permissive.exports?.[permissiveKey])
  const target = permissive.exports?.[permissiveKey]
  const file = typeof target === 'string' ? target : target?.default
  if (file) check(`${permissiveKey} resolves to a file that the build produces (${file})`,
    existsSync(join(here, file)), 'run `npm run build -w three-slicer-viewer` first')
}

console.log('\n[lockstep: the permissive tarball ships what it points at]')
for (const entry of ['dist', 'types', 'LICENSE'])
  check(`files includes ${entry}`, (permissive.files ?? []).includes(entry), (permissive.files ?? []).join(' '))

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL VERSION LOCKSTEP CHECKS PASSED')
assert.equal(failures, 0)
