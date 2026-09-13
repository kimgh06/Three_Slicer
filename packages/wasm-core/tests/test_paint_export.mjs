// selector_export_paint: reading the kernel's painting back out as the hex a 3mf stores — the reverse of
// selector_import_paint (test_paint_import.mjs covers that direction and documents the encoding).
// What this has to prove is that the two are genuinely inverse: upstream's own 3mf reader is on the other side of
// this string, so "our writer agrees with our reader" is not enough — the SPELLING has to be upstream's.
// (get_triangle_as_string, slicer/src/libslic3r/Model.cpp:3542: four bits per digit, most significant nibble first.)
import createSlicer from '../engine/src/slicer_core.js'

function boxTris(ox, oy, oz, sx, sy, sz) {
  const c = [[0,0,0],[sx,0,0],[sx,sy,0],[0,sy,0],[0,0,sz],[sx,0,sz],[sx,sy,sz],[0,sy,sz]].map(v => [v[0]+ox, v[1]+oy, v[2]+oz])
  const q = (a,b,cc,d) => [[c[a],c[b],c[cc]],[c[a],c[cc],c[d]]]
  return [...q(0,1,2,3), ...q(4,5,6,7), ...q(0,1,5,4), ...q(1,2,6,5), ...q(2,3,7,6), ...q(3,0,4,7)]
}
function trisToSTL(tris) {
  const buf = Buffer.alloc(84 + tris.length * 50); buf.writeUInt32LE(tris.length, 80)
  let off = 84
  for (const t of tris) { off += 12; for (const p of t) { buf.writeFloatLE(p[0],off); buf.writeFloatLE(p[1],off+4); buf.writeFloatLE(p[2],off+8); off += 12 } buf.writeUInt16LE(0,off); off += 2 }
  return buf
}
const cubeSTL = trisToSTL(boxTris(0, 0, 0, 20, 20, 20))   // 12 facets

const HEX = { 1: '4', 2: '8', 3: '0C', 4: '1C', 5: '2C' }   // state -> unsplit-facet hex

const M = await createSlicer()
let fail = 0
const ok = (cond, msg) => { console.log((cond ? '  ok: ' : '  FAIL: ') + msg); if (!cond) fail++ }
const prepare = () => M.selector_prepare(new Uint8Array(cubeSTL))
const importPaint = (facets, hexes) => M.selector_import_paint(Int32Array.from(facets), hexes.join('\n'))
const counts = (...states) => states.map(s => M.selector_painted_count_state(s))
// The binding returns {facets, hex} with hex newline-joined, the same pairing the import takes.
const exportPaint = () => {
  const out = M.selector_export_paint()
  const facets = Array.from(out.facets)
  const hex = out.hex === '' ? [] : out.hex.split('\n')
  return { facets, hex, pairs: facets.map((f, i) => [f, hex[i]]) }
}

console.log('[nothing painted]')
prepare()
ok(exportPaint().facets.length === 0, 'a clean selector exports nothing')

console.log('\n[import -> export is the identity]')
// Every state form: the one-nibble states 1/2 and the two-nibble prefix form 3..5. If the writer got the nibble
// ORDER wrong, "0C" would come back "C0" — which upstream's reader would decode as a different tree entirely.
prepare()
importPaint([1, 3, 5, 7, 9], [HEX[1], HEX[2], HEX[3], HEX[4], HEX[5]])
const roundTrip = exportPaint()
ok(JSON.stringify(roundTrip.facets) === JSON.stringify([1, 3, 5, 7, 9]),
   `the facet list comes back as written (got ${JSON.stringify(roundTrip.facets)})`)
ok(JSON.stringify(roundTrip.hex) === JSON.stringify([HEX[1], HEX[2], HEX[3], HEX[4], HEX[5]]),
   `every hex string comes back verbatim (got ${JSON.stringify(roundTrip.hex)})`)

console.log('\n[export -> import -> export is stable]')
// Feeding the export straight back in must reproduce it. This is what a save/reload cycle does, and a codec that
// drifts by one nibble per pass would still look right on the first one.
prepare()
const applied = M.selector_import_paint(Int32Array.from(roundTrip.facets), roundTrip.hex.join('\n'))
ok(applied === 5, `re-importing the export applies every facet (got ${applied})`)
const second = exportPaint()
ok(JSON.stringify(second.pairs) === JSON.stringify(roundTrip.pairs), 'a second export is byte-identical to the first')
ok(counts(1, 2, 3, 4, 5).join() === '1,1,1,1,1', 'each state still owns exactly one facet')

console.log('\n[ascending facet order]')
// upstream's own reader binary-searches triangles_to_split, so the list must be ascending regardless of the order
// the marks were made in. The import sorts; the export must not undo that.
prepare()
importPaint([9, 2, 6], [HEX[1], HEX[2], HEX[3]])
const sorted = exportPaint()
ok(JSON.stringify(sorted.facets) === JSON.stringify([2, 6, 9]),
   `facets are exported in ascending order (got ${JSON.stringify(sorted.facets)})`)
ok(sorted.hex.join() === [HEX[2], HEX[3], HEX[1]].join(), 'each hex string stays with its own facet through the sort')

console.log('\n[brush strokes, not just imported marks]')
// The whole reason this binding exists: paint made in the viewer lives only in the selector. A brushed facet is
// usually SPLIT, so its tree is several nibbles rather than one — the export must carry the whole bitstream.
prepare()
M.selector_paint_state(0, 3, 3, 0, 0, 0, 100, 6, 2)   // sphere brush at a corner of the bottom face, state 2
const brushed = exportPaint()
ok(brushed.facets.length > 0, `a brush stroke exports facets (got ${brushed.facets.length})`)
ok(brushed.hex.every(h => /^[0-9A-F]+$/.test(h)), 'every exported string is uppercase hex')
const painted2 = M.selector_painted_count_state(2)
// Re-importing must reproduce the painted AREA, which is the thing a user would notice — the facet count of a
// split tree, not just the number of source triangles carrying marks.
prepare()
M.selector_import_paint(Int32Array.from(brushed.facets), brushed.hex.join('\n'))
ok(M.selector_painted_count_state(2) === painted2,
   `the brushed area survives a round trip (${painted2} painted facets both times)`)
ok(JSON.stringify(exportPaint().pairs) === JSON.stringify(brushed.pairs), 'and re-exports identically')

console.log('\n[a split tree is more than one nibble]')
ok(brushed.hex.some(h => h.length > 2),
   `at least one brushed facet carries a split tree (longest ${Math.max(...brushed.hex.map(h => h.length))} nibbles)`)

console.log('\n[the "anything painted" shortcut stays exact]')
// The export skips serialize() when the bridge's flag says nothing was ever marked. The flag is deliberately
// conservative — erasing does not clear it — so these two check the answer is still right in both directions:
// a selector that never had a mark, and one whose marks were all erased or cleared away.
prepare()
M.selector_paint_state(0, 3, 3, 0, 0, 0, 100, 6, 2)
ok(exportPaint().facets.length > 0, 'a painted selector exports something (flag set)')
M.selector_erase(0, 3, 3, 0, 0, 0, 100, 60)     // radius large enough to wipe the stroke back to NONE
ok(M.selector_painted_count_state(2) === 0, 'the stroke is erased')
ok(exportPaint().facets.length === 0, 'an erased-clean selector exports nothing, flag notwithstanding')
prepare()
M.selector_paint_state(0, 3, 3, 0, 0, 0, 100, 6, 3)
M.selector_clear()
ok(exportPaint().facets.length === 0, 'a cleared selector exports nothing')
ok(M.selector_facet_count() === 12, 'and the mesh is still registered after the clear')

console.log('\n[export survives a move]')
// selector_reprepare rebuilds on new coordinates and carries the marks by facet index. A save after a drag must
// still get them — this is the same guarantee the overlay depends on, checked through the export path.
prepare()
importPaint([1, 4], [HEX[2], HEX[3]])
const beforeMove = exportPaint()
const movedSTL = trisToSTL(boxTris(30, 15, 0, 20, 20, 20))   // same topology, elsewhere
ok(M.selector_reprepare(new Uint8Array(movedSTL)) === true, 'the move keeps the paint')
ok(JSON.stringify(exportPaint().pairs) === JSON.stringify(beforeMove.pairs), 'and the export is unchanged by it')

console.log(fail ? `\n${fail} FAILED` : '\npaint export passed')
process.exit(fail ? 1 : 0)
