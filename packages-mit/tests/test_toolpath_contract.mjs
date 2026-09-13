// The toolpath contract, pinned against the CURRENT implementation.
//   Run: node packages/viewer/test_toolpath_contract.mjs
//
// Why this exists: the toolpath renderer is four files (packages/PROVENANCE.md §2) that have to be rewritten
// before the viewer can carry a permissive license, and until now exactly ONE test touched any of it —
// test_move_scrub.mjs, covering three scrub queries. Geometry generation, colouring and the shaders had
// nothing. Rewriting first and testing after would have been a gamble.
//
// So this records what the present implementation DOES, as a black box: it calls the published surface and
// asserts the properties any correct implementation must reproduce. It deliberately does NOT assert exact
// float output — a genuinely independent rewrite differs there and should be allowed to. What it pins is the
// contract: counts, the stride-8 role/tool encoding, per-vertex fanout, bbox, length accounting, colour
// ranges, and the legend metadata.
//
// It also PRINTS a snapshot of the values it saw, so a rewrite can be diffed against a recorded run rather
// than against a reading of the old code.
import assert from 'node:assert'
import { buildSegmentData, roleRatios } from './src/core/toolpath_segments.js'
import { computeColors, VIEW_TYPES } from './src/core/toolpath_views.js'
import { TYPE_COLOR, TYPE_LABEL, TOOL_COLOR, DEFAULT_RANGES_COLORS, packColor, hexToRgb, rangeColorAt }
  from './src/core/toolpath_palette.js'

let failures = 0
const check = (label, condition, detail = '') => {
  if (condition) console.log(`  ok: ${label}`)
  else { console.log(`  FAIL: ${label}${detail ? ' — ' + detail : ''}`); failures++ }
}
const near = (a, b, eps = 1e-4) => Math.abs(a - b) <= eps

// ---- Fixture -------------------------------------------------------------------------------------------
// Two layers. Layer 0: a 10mm wall segment on tool 0, a 10mm sparse-infill segment, and one travel.
// Layer 1: a 20mm wall on tool 1 (so the role field's high bits are exercised) and a 5mm support segment.
// enc = role + tool*16; paths stride 8 = [x0,y0,z0,enc, x1,y1,z1,enc]; one width per segment.
const seg = (x0, y0, z, x1, y1, role, tool = 0) => {
  const enc = role + tool * 16
  return [x0, y0, z, enc, x1, y1, z, enc]
}
const layers = [
  { z: 0.2, paths: Float32Array.from([
      ...seg(0, 0, 0.2, 10, 0, 1),        // wall, 10mm
      ...seg(10, 0, 0.2, 10, 10, 2),      // sparse, 10mm
      ...seg(10, 10, 0.2, 0, 10, 0),      // travel (role 0)
    ]), widths: Float32Array.from([0.42, 0.45, 0]) },
  { z: 0.4, paths: Float32Array.from([
      ...seg(0, 0, 0.4, 20, 0, 1, 1),     // wall on TOOL 1, 20mm
      ...seg(20, 0, 0.4, 20, 5, 5),       // support, 5mm
    ]), widths: Float32Array.from([0.42, 0.35]) },
]
const DEFAULT_WIDTH = 0.4

console.log('[toolpath: buildSegmentData structure]')
const data = buildSegmentData(layers, DEFAULT_WIDTH)
check('layerCount is the input layer count', data.layerCount === 2, `${data.layerCount}`)
check('no NaN reached the stream', data.hasNaN === false)
check('nSeg counts extruding segments only (travel excluded)', data.nSeg === 4, `${data.nSeg}`)
check('nTrav counts the travel move', data.nTrav === 1, `${data.nTrav}`)

// Per-vertex fanout: every per-vertex array must agree with nV, or a shader reads past its attribute.
console.log('\n[toolpath: per-vertex arrays agree with nV]')
const perVertex = { vType: 1, vTool: 1, vWidth: 1, vHeight: 1, vLayer: 1 }
for (const name of Object.keys(perVertex))
  check(`meta.${name}.length === nV`, data.meta[name].length === data.nV, `${data.meta[name].length} vs ${data.nV}`)
// Strides, measured — the published .d.ts types these as bare Float32Array and never said. They are part of
//  the contract a rewrite has to reproduce, because the shader reads them as vec4/vec4 attributes.
check('position is vec4 per vertex', data.position.length === data.nV * 4, `${data.position.length} for nV=${data.nV}`)
check('hwa is vec4 per vertex', data.hwa.length === data.nV * 4, `${data.hwa.length}`)
check('segIndex is 2 per vertex', data.segIndex.length === data.nV * 2, `${data.segIndex.length}`)
check('two vertices per segment', data.nV === data.nSeg * 2, `nV=${data.nV} nSeg=${data.nSeg}`)

console.log('\n[toolpath: the role/tool encoding survives the build]')
// enc = role + tool*16 is THIS repo's contract, not upstream's — role & 15, tool >>> 4.
const types = new Set(data.meta.vType), tools = new Set(data.meta.vTool)
check('vType holds decoded roles, not raw enc', [...types].every(t => t < 16), [...types].join(','))
check('roles present are wall/sparse/support', [1, 2, 5].every(r => types.has(r)), [...types].join(','))
check('tool 1 was decoded out of the high bits', tools.has(1), [...tools].join(','))
check('tool 0 is present too', tools.has(0), [...tools].join(','))

console.log('\n[toolpath: layer indexing]')
check('vLayer spans 0..layerCount-1', Math.min(...data.meta.vLayer) === 0 && Math.max(...data.meta.vLayer) === 1)
check('layerSegPrefix has layerCount+1 entries', data.layerSegPrefix.length === data.layerCount + 1, `${data.layerSegPrefix.length}`)
check('layerSegPrefix starts at 0 and ends at nSeg',
  data.layerSegPrefix[0] === 0 && data.layerSegPrefix[data.layerCount] === data.nSeg,
  `${[...data.layerSegPrefix].join(',')}`)
check('layerSegPrefix is non-decreasing',
  [...data.layerSegPrefix].every((v, i, a) => i === 0 || v >= a[i - 1]))
check('travelPrefix ends at nTrav', data.travelPrefix[data.travelPrefix.length - 1] === data.nTrav)

console.log('\n[toolpath: geometry values]')
// Widths come from the input; the fixture's are all distinct so a mix-up shows.
const widthsSeen = [...new Set(data.meta.vWidth)].sort((a, b) => a - b)
check('the input widths reached the stream', widthsSeen.some(w => near(w, 0.42)) && widthsSeen.some(w => near(w, 0.45)),
  widthsSeen.map(w => w.toFixed(3)).join(' '))
check('every width is positive', [...data.meta.vWidth].every(w => w > 0))
check('every height is positive', [...data.meta.vHeight].every(h => h > 0))
check('maxAbs bounds the coordinates', data.maxAbs >= 20 && Number.isFinite(data.maxAbs), `${data.maxAbs}`)

console.log('\n[toolpath: bbox covers the fixture]')
const { min, max } = data.bbox
check('bbox.min x/y at the origin corner', near(min[0], 0) && near(min[1], 0), `${min.join(',')}`)
check('bbox.max x reaches 20', near(max[0], 20), `${max.join(',')}`)
// z is the bead centre, so it sits within half a layer height of the layer z rather than exactly on it.
check('bbox z stays within a layer height of the input z', min[2] > -0.5 && max[2] <= 0.45, `${min[2]} .. ${max[2]}`)

console.log('\n[toolpath: length accounting]')
check('typeLengths has 16 slots', data.typeLengths.length === 16, `${data.typeLengths.length}`)
check('wall length is 10 + 20', near(data.typeLengths[1], 30, 1e-3), `${data.typeLengths[1]}`)
check('sparse length is 10', near(data.typeLengths[2], 10, 1e-3), `${data.typeLengths[2]}`)
check('support length is 5', near(data.typeLengths[5], 5, 1e-3), `${data.typeLengths[5]}`)
check('travel contributes no extruded length', near(data.typeLengths[0], 0, 1e-9), `${data.typeLengths[0]}`)

console.log('\n[toolpath: roleRatios]')
const ratios = roleRatios(data.typeLengths)
check('one entry per type with length', ratios.length === 3, `${ratios.length}`)
check('descending by pct', ratios.every((r, i, a) => i === 0 || a[i - 1].pct >= r.pct), ratios.map(r => r.pct).join(','))
check('pct sums to 100', near(ratios.reduce((a, r) => a + r.pct, 0), 100, 0.51),
  `${ratios.reduce((a, r) => a + r.pct, 0)}`)
check('wall is the largest share at 30/45', ratios[0].type === 1 && near(ratios[0].pct, 66.7, 0.2), `${ratios[0].pct}`)
check('each entry carries its label and colour', ratios.every(r => r.label === TYPE_LABEL[r.type] && Array.isArray(r.color)))

console.log('\n[toolpath: computeColors per view type]')
const ctx = { speedByType: { 1: 60, 2: 120, 5: 40 }, firstLayerSpeed: 20,
              fanByType: { 1: 100, 2: 100, 5: 0 }, fanFirstLayers: 1, tempNormal: 220, tempFirst: 230 }
for (const view of VIEW_TYPES) {
  const out = computeColors(data, view.key, ctx)
  const ok = out.color.length === data.nV * 4
    && out.viewType === view.key && out.label === view.label && out.unit === view.unit && out.cont === view.cont
    && [...out.color].every(Number.isFinite)
  check(`${view.key}: nV*4 finite colours, legend metadata matches VIEW_TYPES`, ok,
    ok ? '' : `len=${out.color.length} want ${data.nV * 4}`)
  if (!view.cont) check(`${view.key}: categorical view reports no range`, out.min === 0 && out.max === 0, `${out.min}..${out.max}`)
  else check(`${view.key}: continuous view reports min <= max`, out.min <= out.max, `${out.min}..${out.max}`)
}

console.log('\n[toolpath: palette primitives]')
check('packColor is the inverse of hexToRgb for a known colour',
  packColor(hexToRgb('#4c8dff')) === 0x4c8dff, `0x${packColor(hexToRgb('#4c8dff')).toString(16)}`)
check('TYPE_COLOR covers every labelled type', Object.keys(TYPE_LABEL).every(k => Array.isArray(TYPE_COLOR[k])))
check('TOOL_COLOR is non-empty and indexable modulo its length', TOOL_COLOR.length > 0 && Array.isArray(TOOL_COLOR[0]))
check('DEFAULT_RANGES_COLORS is the 11-stop heatmap', DEFAULT_RANGES_COLORS.length === 11, `${DEFAULT_RANGES_COLORS.length}`)
check('rangeColorAt clamps above the high end',
  JSON.stringify(rangeColorAt(99, 0, 10, DEFAULT_RANGES_COLORS)) === JSON.stringify(DEFAULT_RANGES_COLORS[10]))
check('rangeColorAt returns a stop inside the range',
  Array.isArray(rangeColorAt(5, 0, 10, DEFAULT_RANGES_COLORS)))

// Recorded, not asserted: the low end does NOT clamp — it extrapolates past the first stop and returns
//  negative components. Unreachable from computeColors today (it derives lo/hi from the data, so no value
//  is ever below lo), which is why it has never shown. The rewrite must clamp both ends; this prints the
//  present behaviour so the change is visible rather than silent.
const below = rangeColorAt(-5, 0, 10, DEFAULT_RANGES_COLORS)
const clampsLow = JSON.stringify(below) === JSON.stringify(DEFAULT_RANGES_COLORS[0])
console.log(clampsLow
  ? '  ok: rangeColorAt clamps below the low end (the rewrite fixed it)'
  : `  KNOWN DEFECT: rangeColorAt extrapolates below the low end -> [${below.map(v => v.toFixed(3))}] (out of gamut). Latent today; the rewrite must clamp.`)

console.log('\n[toolpath: degenerate input is survived, not crashed]')
const empty = buildSegmentData([], DEFAULT_WIDTH)
check('no layers -> zero counts and a null bbox', empty.nSeg === 0 && empty.layerCount === 0 && empty.bbox === null,
  `nSeg=${empty.nSeg} layerCount=${empty.layerCount} bbox=${empty.bbox}`)
const zeroLen = buildSegmentData([{ z: 0.2, paths: Float32Array.from(seg(5, 5, 0.2, 5, 5, 1)), widths: Float32Array.from([0.4]) }], DEFAULT_WIDTH)
check('a zero-length segment produces no NaN', zeroLen.hasNaN === false)

// ---- Snapshot ------------------------------------------------------------------------------------------
// Printed, not asserted: a rewrite is expected to differ in the exact floats. This is the record to diff
// against, so the comparison is made against a run rather than against a reading of the old code.
console.log('\n[snapshot — for diffing a rewrite, NOT asserted]')
console.log(`  nV=${data.nV} nSeg=${data.nSeg} nTrav=${data.nTrav} verticesPerSegment=${data.nV / data.nSeg}`)
console.log(`  maxAbs=${data.maxAbs.toFixed(4)}`)
console.log(`  bbox=${JSON.stringify(data.bbox)}`)
console.log(`  layerSegPrefix=[${[...data.layerSegPrefix].join(',')}]`)
console.log(`  hwa[0..5]=[${[...data.hwa.slice(0, 6)].map(v => v.toFixed(4)).join(',')}]`)
console.log(`  position[0..5]=[${[...data.position.slice(0, 6)].map(v => v.toFixed(4)).join(',')}]`)
console.log(`  typeLengths(nonzero)=${[...data.typeLengths].map((v, i) => [i, v]).filter(([, v]) => v > 0).map(([i, v]) => `${i}:${v.toFixed(3)}`).join(' ')}`)
console.log(`  roleRatios=${ratios.map(r => `${r.label} ${r.pct.toFixed(1)}%`).join(', ')}`)
for (const view of VIEW_TYPES) {
  const out = computeColors(data, view.key, ctx)
  console.log(`  colours[${view.key}]: min=${out.min} max=${out.max} first=${out.color[0].toFixed(0)}`)
}

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL TOOLPATH CONTRACT CHECKS PASSED')
assert.equal(failures, 0)
