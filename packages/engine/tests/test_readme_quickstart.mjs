// Gates the FIRST code block a newcomer copies: the headless quick start in packages/README.md.
//
// The docs audit found that only machine-checked docs stayed true — every drifted claim lived in an
// ungated file. This extracts the "Quick Start: Headless Slicing" block from the README verbatim and
// RUNS it against the engine, so a renamed export, a changed param key, or a reshaped result breaks the
// build instead of the first reader's afternoon.
//   run: node packages/engine/test_readme_quickstart.mjs
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const readme = readFileSync(join(here, '..', 'README.md'), 'utf8')

const section = readme.slice(readme.indexOf('## Quick Start: Headless Slicing'))
const block = section.match(/```js\n([\s\S]*?)```/)?.[1]
if (!block || !block.includes('createSlicer')) {
  console.log('  FAIL: could not find the headless quick-start js block in packages/README.md')
  process.exit(1)
}

// The block references `stlArrayBuffer` without defining it (the reader supplies a model). The harness
// supplies a 20mm cube, injected after the block's own imports so the module stays valid ESM.
const cube = (() => {
  const S = 10
  const corners = [[-S, -S, 0], [S, -S, 0], [S, S, 0], [-S, S, 0], [-S, -S, 2 * S], [S, -S, 2 * S], [S, S, 2 * S], [-S, S, 2 * S]]
  const faces = [[0, 1, 2], [0, 2, 3], [4, 6, 5], [4, 7, 6], [0, 4, 5], [0, 5, 1], [1, 5, 6], [1, 6, 2], [2, 6, 7], [2, 7, 3], [3, 7, 4], [3, 4, 0]]
  const view = new DataView(new ArrayBuffer(84 + faces.length * 50))
  view.setUint32(80, faces.length, true)
  faces.forEach(([a, b, c], t) => {
    const o = 84 + t * 50
    ;[corners[a], corners[b], corners[c]].flat().forEach((x, i) => view.setFloat32(o + 12 + i * 4, x, true))
  })
  return Buffer.from(view.buffer).toString('base64')
})()

const lines = block.split('\n')
const lastImport = lines.reduce((last, line, i) => line.startsWith('import ') ? i : last, -1)
lines.splice(lastImport + 1, 0,
  `const stlArrayBuffer = Uint8Array.from(Buffer.from('${cube}', 'base64')).buffer`)
lines.push(
  // the assertions — `result` and `slicer` are the block's own top-level consts
  "if (!(result.stats.layers > 0)) throw new Error('quick start sliced zero layers')",
  "if (!/\\bG1\\b/.test(result.gcode)) throw new Error('quick start produced no G-code moves')",
)

// Written inside the workspace so the block's `from 'three-slicer'` resolves through the workspace link —
// exactly the specifier a real consumer uses.
const tmp = join(here, '.quickstart_tmp.mjs')
writeFileSync(tmp, lines.join('\n'))
const quiet = console.log
console.log = () => {}   // the block prints the whole G-code; the test output should not
try {
  await import(tmp)
  console.log = quiet
  console.log('  ok: the headless quick-start block runs as written (sliced a cube, emitted G-code)')
  console.log('\nALL README-QUICKSTART CHECKS PASSED\n')
} catch (err) {
  console.log = quiet
  console.log(`  FAIL: the quick-start block no longer runs — ${err.message}`)
  console.log('\n1 CHECK FAILED\n')
  process.exitCode = 1
} finally {
  try { unlinkSync(tmp) } catch {}
}
