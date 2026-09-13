// Every name a factory destructures is actually handed to it.
//   Run: node packages/viewer/test_wiring.mjs
//
// Viewport.jsx passes the shared refs and setters as one `wiring` object spread into each factory, instead of
// listing 43 of them again at every call site. That trade has exactly one failure mode: add a dep to a factory's
// destructuring block, forget to add it to `wiring`, and it is `undefined` at runtime — no build error, no type
// error, and usually no crash until the one code path that calls it. This is that check.
//
// It reads the source rather than running the component, because running it needs WebGL and a DOM.
import assert from 'node:assert'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const src = join(here, 'src')
const viewport = readFileSync(join(src, 'Viewport.jsx'), 'utf8')

let failures = 0
const check = (label, condition, detail = '') => {
  if (condition) console.log(`  ok: ${label}`)
  else { console.log(`  FAIL: ${label}${detail ? ' — ' + detail : ''}`); failures++ }
}
// Top-level keys of a `{ ... }` literal: shorthand, `key: value`, and `...spread`.
//  Comments come out FIRST, before anything counts a bracket: this codebase writes prose like
//  "(keyboard nudge, plate / re-arrange)," inside these literals, and a comment's stray paren would otherwise
//  shift the depth counter and split a key in half. (Found the hard way — it reported a supplied dep as missing.)
const keysOf = (rawBody) => {
  const body = rawBody.replace(/\/\/[^\n]*/g, '')
  const out = new Set()
  let depth = 0, token = ''
  for (const ch of body) {
    if ('([{'.includes(ch)) depth++
    else if (')]}'.includes(ch)) depth--
    if (ch === ',' && depth === 0) { out.add(token); token = '' } else token += ch
  }
  out.add(token)
  return new Set([...out]
    .map(part => (part.startsWith('...') ? part : part.split(':')[0]).trim())
    .filter(Boolean))
}
// The body of the FIRST `{ … }` whose braces balance, starting at `from`.
const balancedBody = (text, from) => {
  let depth = 0
  for (let i = from; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') { depth--; if (depth === 0) return text.slice(from + 1, i) }
  }
  throw new Error('unbalanced braces')
}

console.log('[wiring: the shared object]')
const wiring = keysOf(balancedBody(viewport, viewport.indexOf('{', viewport.indexOf('const wiring ='))))
check('Viewport.jsx defines `wiring`', wiring.size > 20, `${wiring.size} names`)
// Anything spread in would hide where a name comes from; the point is that this is the one list.
check('`wiring` is a flat literal', ![...wiring].some(k => k.startsWith('...')))

console.log('\n[wiring: every factory gets what it destructures]')
// The factories that take one options object and pull it apart.
const factories = readdirSync(join(src, 'actions'))
  .filter(name => name.endsWith('.js') && name !== 'index.js')
  .concat([]) // scene/use_three_scene.js is handled below with its own path
const sources = new Map(factories.map(name => [`actions/${name}`, readFileSync(join(src, 'actions', name), 'utf8')]))
sources.set('scene/use_three_scene.js', readFileSync(join(src, 'scene', 'use_three_scene.js'), 'utf8'))

for (const [path, text] of sources) {
  // `export function makeX(deps) { const { … } = deps`
  const entry = text.match(/export function (make[A-Z]\w+|use[A-Z]\w+)\s*\(\s*(deps|params|props)\s*\)/)
  if (!entry) continue
  const at = text.indexOf('const {', text.indexOf(entry[0]))
  if (at < 0) continue
  const wanted = [...keysOf(balancedBody(text, text.indexOf('{', at)))]
    .map(k => k.split('=')[0].trim())      // a default (`recordHistory = () => {}`) still names the key
    .filter(Boolean)

  // What the call site in Viewport.jsx hands over, on top of the spread.
  const call = viewport.indexOf(`${entry[1]}({`)
  assert.ok(call > 0, `${path}: ${entry[1]} is never called from Viewport.jsx`)
  const passedRaw = keysOf(balancedBody(viewport, viewport.indexOf('{', call)))
  const passed = new Set([...passedRaw].filter(k => !k.startsWith('...')))
  const spreadsWiring = [...passedRaw].some(k => k === '...wiring')

  const missing = wanted.filter(name => !passed.has(name) && !(spreadsWiring && wiring.has(name)))
  check(`${path}: ${entry[1]} — ${wanted.length} deps, all supplied`, missing.length === 0, `missing: ${missing.join(' ')}`)
}

console.log('\n[wiring: nothing in it is dead]')
// A name nobody destructures is a line that costs a reader and buys nothing — the list has to stay honest.
const allFactorySource = [...sources.values()].join('\n')
const unused = [...wiring].filter(name => !new RegExp(`\\b${name}\\b`).test(allFactorySource))
check('every name in `wiring` is read by at least one factory', unused.length === 0, unused.join(' '))

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL WIRING CHECKS PASSED')
assert.equal(failures, 0)
