// Opening G-code through the viewer's own Open button / drop target, and the colour list a result is drawn in.
//   Run: node viewer-package/tests/test_gcode_open.mjs
// The scene is faked the way test_3mf_project.mjs fakes it; the loader and the parser run for real.
import assert from 'node:assert'
import { makeModelLoad } from '../src/actions/model_load.js'
import { SUPPORTED_EXT } from '../src/scene/model_loaders.js'
import { resultToolColors, exportedGcode, parseGcode } from '../src/core/gcode_parse.js'
import { TOOL_COLOR } from '../src/core/toolpath_palette.js'

const PRINTABLE = ';LAYER_CHANGE\n;Z:0.2\nG1 X0 Y0 Z0.2\nG1 X10 Y0 E1\n'
const SELECTED_PLATE = 2

function fakeLoader({ withGcodePath = true } = {}) {
  const opened = [], errors = []
  const refs = { selectedPlateRef: { current: SELECTED_PLATE } }
  const own = { setError: message => { if (message) errors.push(message) } }
  if (withGcodePath) own.openGcodePlates = (plates, name) => opened.push({ plates, name })
  const deps = new Proxy(own, {
    get: (target, key) => {
      if (key in target) return target[key]
      if (String(key).endsWith('Ref')) return refs[key] ?? { current: null }
      if (key === 'openGcodePlates') return undefined
      return () => {}
    },
    has: () => true,
  })
  return { loader: makeModelLoad(deps), opened, errors }
}

// A .gcode opens on the selected plate through openGcodePlates, as a .gcode.3mf does.
{
  const { loader, opened, errors } = fakeLoader()
  await loader.loadFiles([new File([PRINTABLE], 'job.gcode')])
  assert.deepStrictEqual(errors, [], 'no error for a printable file')
  assert.strictEqual(opened.length, 1, 'opened once')
  assert.deepStrictEqual(opened[0], { plates: [{ index: SELECTED_PLATE, gcode: PRINTABLE }], name: 'job.gcode' })
}
// The aliases open too; with several, the last one (one plate holds one print job).
{
  const { loader, opened } = fakeLoader()
  await loader.loadFiles([new File([PRINTABLE], 'a.gco'), new File([PRINTABLE], 'b.g')])
  assert.deepStrictEqual(opened.map(job => job.name), ['b.g'], '.gco/.g accepted, last one opened')
}
// A file with no printable move is refused before it opens: an opened job makes the viewer preview-only.
{
  const { loader, opened, errors } = fakeLoader()
  await loader.loadFiles([new File(['hello\nnot gcode\n'], 'bad.gcode')])
  assert.strictEqual(opened.length, 0, 'nothing opened')
  assert.match(errors[0] ?? '', /bad\.gcode: no printable moves/, 'the error names the file')
}
// A host without the G-code path rejects the file instead of dropping it silently.
{
  const { loader, errors } = fakeLoader({ withGcodePath: false })
  await loader.loadFiles([new File([PRINTABLE], 'job.gcode')])
  assert.match(errors[0] ?? '', /^Supported formats: /, 'the file is rejected')
  assert.doesNotMatch(errors[0], /G-code/, 'and G-code is not offered as a format')
}
// The format list is read from SUPPORTED_EXT, so a format registerLoader() adds is named too (STEP, in the demo).
{
  const { loader, errors } = fakeLoader()
  SUPPORTED_EXT.push('step')
  try { await loader.loadFiles([new File(['x'], 'notes.txt')]) } finally { SUPPORTED_EXT.pop() }
  assert.match(errors[0] ?? '', /\/STEP\//, 'a registered format is listed')
}
console.log('  ok: Open/drop routes .gcode/.gco/.g to openGcodePlates, refuses a non-G-code file')

// The colour list: the file's own, then the session's, then the categorical stand-in — one entry per tool used.
const hexOf = rgb => '#' + rgb.map(channel => Math.round(channel * 255).toString(16).padStart(2, '0')).join('')
{
  const threeTools = parseGcode(PRINTABLE + 'T1\nG1 X20 Y0 E1\nT2\nG1 X30 Y0 E1\n').stats
  assert.deepStrictEqual(resultToolColors(threeTools, ['#AAAAAA', '#BBBBBB']), ['#AAAAAA', '#BBBBBB', hexOf(TOOL_COLOR[2])],
    'a tool the session has no filament for gets the stand-in computeColors draws')
  assert.deepStrictEqual(resultToolColors({ ...threeTools, colors: [null, '#123456'] }, ['#AAAAAA']),
    ['#AAAAAA', '#123456', hexOf(TOOL_COLOR[2])], 'file first, session for its holes')
  assert.deepStrictEqual(resultToolColors(null, null), [], 'nothing to colour')
  const saved = exportedGcode({ gcode: PRINTABLE, stats: threeTools }, ['#AAAAAA', '#BBBBBB'])
  assert.deepStrictEqual(parseGcode(saved).stats.colors, ['#AAAAAA', '#BBBBBB', hexOf(TOOL_COLOR[2]).toUpperCase()],
    'an export states the list it was drawn in')
}
console.log('  ok: one colour list for toolpath, legends and export')
console.log('gcode_open: ALL OK')
