// Opening G-code through the viewer's own Open button / drop target, and the colour list a result is drawn in.
//   Run: node viewer-package/tests/test_gcode_open.mjs
// The scene is faked the way test_3mf_project.mjs fakes it; the loader and the parser run for real.
import assert from 'node:assert'
import { makeModelLoad } from '../src/actions/model_load.js'
import { SUPPORTED_EXT } from '../src/scene/model_loaders.js'
import { resultToolColors, exportedGcode, parseGcode } from '../src/core/gcode_parse.js'
import { TOOL_COLOR } from '../src/core/toolpath_palette.js'
import { ROLE, STRIDE } from '../src/core/toolpath_encoding.js'

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

// Issue 63: a Bambu Studio file marks layers and roles with the BBL reserved tags. Two layers, a support run on
//  the second: read with only the compatible spellings it was one or two layers of wall.
{
  const bambu = [
    'M83',   // relative E, as Bambu Lab start G-code sets it
    '; CHANGE_LAYER', '; Z_HEIGHT: 0.2', '; LAYER_HEIGHT: 0.2', '; FEATURE: Outer wall', '; LINE_WIDTH: 0.42',
    'G1 X0 Y0 Z0.2', 'G1 X10 Y0 E1',
    '; CHANGE_LAYER', '; Z_HEIGHT: 0.4', '; FEATURE: Support', '; LINE_WIDTH: 0.5',
    'G1 Z0.4', 'G1 X0 Y5', 'G1 X10 Y5 E1', '',
  ].join('\n')
  const read = parseGcode(bambu)
  assert.deepStrictEqual(read.layers.map(layer => layer.z), [0.2, 0.4], 'CHANGE_LAYER + Z_HEIGHT open the layers at their z')
  const extrusion = read.layers[1].widths.findIndex(width => width > 0)   // travels carry width 0
  assert.strictEqual(read.layers[1].paths[extrusion * STRIDE + 3] & 15, ROLE.SUPPORT, 'FEATURE: names the role')
  assert.strictEqual(read.layers[1].widths[extrusion], 0.5, 'LINE_WIDTH: gives the width')
}
console.log('  ok: Bambu Lab reserved tags (FEATURE / CHANGE_LAYER / Z_HEIGHT / LINE_WIDTH)')

// Word separators: tabs, runs of blanks, a carriage return and a non-ASCII space all read as a single space does
//  (the parser splits ASCII blanks itself and hands any other line to /\s+/), and a layer grows past its first buffer.
{
  const header = ';LAYER_CHANGE\n;Z:0.2\nG1 X0 Y0 Z0.2\n'
  const plain = parseGcode(header + 'G1 X10 Y0 E1\nG1 X10 Y10 E2\n')
  for (const [label, separator] of [['a tab', '\t'], ['two spaces', '  '], ['a non-breaking space', '\u00a0']]) {
    const read = parseGcode(header + `G1${separator}X10${separator}Y0${separator}E1\r\nG1${separator}X10${separator}Y10${separator}E2\r\n`)
    assert.deepStrictEqual(Array.from(read.layers[0].paths), Array.from(plain.layers[0].paths), `${label} separates words`)
    assert.deepStrictEqual(read.stats, plain.stats)
  }
  const MOVES = 5000   // well past one layer's first buffer
  const moves = Array.from({ length: MOVES }, (_unused, index) => `G1 X${index % 2} Y${index + 1} E${index + 1}`)
  const long = parseGcode(header + moves.join('\n'))
  const segments = long.layers[0].widths.length
  assert.strictEqual(long.stats.path_segments, MOVES, 'every extrusion of a long layer is counted')
  assert.strictEqual(segments, MOVES + long.stats.travel_segments, 'and kept, beside the travel to the layer')
  assert.strictEqual(long.layers[0].paths.length, segments * STRIDE)
  assert.strictEqual(long.layers[0].paths[(segments - 1) * STRIDE + 5], MOVES, 'the last segment ends where the last move does')
  assert.ok(long.layers[0].paths instanceof Float32Array && long.layers[0].widths instanceof Float32Array)
}
console.log('  ok: word separators and a layer longer than its first buffer')

// A motion line is read in place when it is plain ("G1 " and words of a letter and a decimal), and the general way
//  otherwise; both have to give what parseFloat gives. Each line below ends at the x it names.
{
  const header = ';LAYER_CHANGE\n;Z:0.2\nG1 X0 Y0 Z0.2\n'
  const endX = (line) => {
    const read = parseGcode(header + line + '\n')
    const paths = read.layers[0].paths
    return paths[paths.length - STRIDE + 4]
  }
  for (const [line, expected] of [
    ['G1 X5 Y1 E1', 5], ['G1 X+5 Y1 E1', 5], ['G1 X-5 Y1 E1', -5], ['G1 X.5 Y1 E1', 0.5], ['G1 X5. Y1 E1', 5],
    ['G1 X1e1 Y1 E1', 10], ['g1 x5 y1 e1', 5], ['G1 X5 Y1 E1*71', 5], ['G1 X5 Y1 E1 ; X9', 5], ['G1 X5;X9', 5],
    ['G1 X0.50000000000000000001 Y1 E1', 0.5], ['G1  X5\tY1 E1', 5], ['G1 X Y1 E1', 0], ['G1 X--5 Y1 E1', 0],
    ['G0 X5 Y1', 5], ['G2 X5 Y0 I2.5 J0 E1', 5], ['G3 X5 Y0 I2.5 J0 E1', 5],
  ]) assert.strictEqual(endX(line), expected, `"${line}" ends at x ${expected}`)
  // The decimals themselves, at double precision: relative E values sum into stats.filament_mm unrounded.
  let seed = 12345
  const nextRandom = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
  const values = Array.from({ length: 3000 }, () => {
    const digits = 1 + Math.floor(nextRandom() * 14), decimals = Math.floor(nextRandom() * (digits + 1))
    let text = ''
    for (let index = 0; index < digits; index++) text += Math.floor(nextRandom() * 10)
    return `${text.slice(0, digits - decimals)}.${text.slice(digits - decimals)}`
  })
  const lines = values.map((value, index) => `G1 X${index + 1} E${value}`)
  const read = parseGcode(header + 'M83\n' + lines.join('\n') + '\n')
  let expected = 0
  for (const value of values) { const parsed = parseFloat(value); if (parsed > 1e-6) expected += parsed }
  assert.strictEqual(read.stats.filament_mm, expected, 'decimals read in place are the doubles parseFloat gives')
}
console.log('  ok: motion lines read in place and the general way agree with parseFloat')

// The read-back keeps its numbers in typed arrays and walks the text line by line: plain arrays and one array of every
//  line put a large plate's read-back on the JS heap, which all of a tab's workers share (measured: a 21.5 MB plate
//  held 265 MB there, and slice-all of a 28-plate project crashed the tab 4 times in 23 runs).
{
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('../src/core/gcode_parse.js', import.meta.url), 'utf8')
  const parser = source.slice(source.indexOf('export function parseGcode'))
  assert.ok(!/text\.split\(/.test(parser), 'parseGcode does not split the whole text into an array of lines')
  assert.ok(!/\.push\([^)]*x0/.test(parser), 'parseGcode does not collect segments in plain arrays')
}
console.log('  ok: the parser holds no per-line or per-number JS array')
console.log('gcode_open: ALL OK')
