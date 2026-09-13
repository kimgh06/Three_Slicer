// The src/ layer boundary, as a check rather than a convention.
//   Run: node packages/viewer/test_layers.mjs
//
// src/ is laid out by ONE question — "can this run under node?" — because that is the only line that was already
// real in this package: every test here covers something on the pure side of it, and nothing covers the other.
//
//   core/     no React, no DOM, no renderer. three.js MATH is fine (Matrix4/Vector3 run under node, which is why
//             scale_box and model_geometry are testable at all); WebGLRenderer and friends are not.
//   scene/    the three.js/DOM shell. Untestable here by nature — so it should stay thin.
//   actions/  use cases: they take refs + the scene's apiRef and decide what happens.
//   ui/       presentational React. Props in, markup out.
//   src/      the entry (Viewport.jsx), its own hooks, and the worker entry points the build resolves by path.
//
// Without this file the layout is decoration: nothing stops an `import * as THREE from 'three'` landing in
// bed_bounds.js, and the first one that does silently ends that file's testability.
import assert from 'node:assert'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const src = join(here, 'src')
const sourcesIn = (dir) => readdirSync(join(src, dir))
  .filter(name => name.endsWith('.js') || name.endsWith('.jsx'))
  .map(name => [name, readFileSync(join(src, dir, name), 'utf8')])

let failures = 0
const check = (label, condition, detail = '') => {
  if (condition) console.log(`  ok: ${label}`)
  else { console.log(`  FAIL: ${label}${detail ? ' — ' + detail : ''}`); failures++ }
}

console.log('[layers: core/ stays runnable under node]')
const core = sourcesIn('core')
check('core/ has files', core.length > 5, `${core.length}`)
// A comment may well say "document"; an import or a member access is what actually needs a browser.
const usesDom = (text) => /\b(document|window|navigator)\s*\./.test(text.replace(/\/\/[^\n]*/g, ''))
for (const [name, text] of core) {
  check(`core/${name}: no React`, !/from ['"]react/.test(text))
  check(`core/${name}: no DOM`, !usesDom(text))
  // fflate ships inside three's examples, so "imports three" cannot be the test — the renderer is.
  check(`core/${name}: no renderer`, !/WebGLRenderer|three\/examples\/jsm\/(controls|loaders)/.test(text))
}

console.log('\n[layers: ui/ is presentational]')
for (const [name, text] of sourcesIn('ui')) {
  // A card may hold its own form state; what it must not do is reach into the scene or the kernel.
  check(`ui/${name}: does not drive the scene`, !/apiRef|objectsRef|from ['"]\.\.\/scene\//.test(text))
}

console.log('\n[layers: the barrels do not fold back into their own folder]')
// ui/ and actions/ each expose an index.js because they have exactly ONE consumer outside the folder
//  (Viewport.jsx, importing fifteen and eight files from them) — that is what makes a barrel a pure win.
//  core/ and scene/ deliberately have none, and the reason is NOT bundle size: measured, a core/ barrel routed
//  through the parse_3mf worker entry left every chunk byte-identical (rollup shakes `export *` fine). It is the
//  consumer count. core/ is imported by 17 files across every layer, so a barrel there is not one caller's
//  convenience but a mandatory front door for the whole codebase — and 12 of those 17 import a single symbol
//  each, so they would save no line at all and only lose the file the symbol lives in. scene/ would save
//  exactly one line, and it already publishes a barrel of its own (toolpath_gpu.js, a vite lib entry): a second
//  one over the same modules leaves a reader guessing which is the API.
for (const folder of ['ui', 'actions']) {
  const inside = sourcesIn(folder).filter(([name]) => name !== 'index.js')
  check(`${folder}/index.js exists`, readdirSync(join(src, folder)).includes('index.js'))
  const selfImporters = inside.filter(([, text]) => /from ['"]\.\/index\.js['"]/.test(text)).map(([name]) => name)
  check(`nothing inside ${folder}/ imports its own barrel`, selfImporters.length === 0, selfImporters.join(' '))
}
check('core/ has no barrel (the worker imports it directly)', !readdirSync(join(src, 'core')).includes('index.js'))

console.log('\n[layers: the entry stays an entry]')
const viewport = readFileSync(join(src, 'Viewport.jsx'), 'utf8')
// It is a wiring hub by design; the thing worth pinning is that the work does NOT come back into it.
check('Viewport.jsx does not import three directly', !/from ['"]three['"]/.test(viewport))
check('Viewport.jsx stays under 900 lines', viewport.split('\n').length < 900, `${viewport.split('\n').length}`)
const scene = readFileSync(join(src, 'scene', 'use_three_scene.js'), 'utf8')
check('use_three_scene.js stays under 900 lines', scene.split('\n').length < 900, `${scene.split('\n').length}`)

// The build resolves these two by path (vite lib entry / the `cp` in the package build script), so a move that
//  looks harmless from inside src/ would break the published tarball instead of a test.
console.log('\n[layers: a per-plate fact is read from plateContext, never from the global map]')
// The bug class the plate context replaced: Viewport derived `kp` from the GLOBAL map and the grid, the tower
//  boxes, the bed check and the nozzle/bed rows each read it — each wrong for the one plate whose override
//  differed. The global frame is `plateContext(settings, null, ...)`; nothing else derives it.
const viewportSrc = readFileSync(join(src, 'Viewport.jsx'), 'utf8')
for (const token of ['deriveKernelParams(settings)', 'deriveSlaParams(settings)', 'kp.', 'kpRef', 'plateBedBounds('])
  check(`Viewport.jsx does not read the global map for a plate fact (${token})`, !viewportSrc.includes(token))
for (const dir of ['ui', 'actions']) for (const name of readdirSync(join(src, dir)).filter(n => /\.jsx?$/.test(n))) {
  const text = readFileSync(join(src, dir, name), 'utf8')
  check(`${dir}/${name} carries no global kp`, !/\bkp\.|kpRef/.test(text))
}

console.log('\n[layers: the worker entries stay where the build looks for them]')
const root = readdirSync(src)
for (const name of ['make_worker.js', 'parse_3mf.worker.js', 'Viewport.jsx'])
  check(`src/${name} is at the root of src/`, root.includes(name))

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL LAYER CHECKS PASSED')
assert.equal(failures, 0)
