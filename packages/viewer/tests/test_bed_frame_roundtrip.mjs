// The printer's bed frame end to end: an object placed in the scene is saved as a 3mf, opened again, sliced, and
//  printed where it was placed. Four beds whose printable_area does not start at (0,0) or is not a rectangle — the
//  cases where the scene's centred frame and the printer's frame differ.
//   scene offset from the bed centre
//   -> write3MFProject (printer frame, upstream's layout)  -> parse3MFProject -> platePlacements (back to the offset)
//   -> the kernel slice of the object at that offset       -> layer 0's extrusions, centred at bed centre + offset
// Stays on the AGPL side because it slices with the kernel.
//   Run: node packages/viewer/tests/test_bed_frame_roundtrip.mjs
import createSlicer from '../../engine/src/slicer_core.js'
import { deriveKernelParams, bedCenter, bedOrigin } from 'three-slicer-viewer/settings'
import { write3MFProject } from '../../../viewer-package/src/core/write_3mf.js'
import { parse3MFProject } from '../../../viewer-package/src/core/parse_3mf.js'
import { platePlacements } from '../../../viewer-package/src/actions/model_load.js'

let failures = 0
const check = (label, condition, detail = '') => {
  if (condition) console.log(`  ok: ${label}`)
  else { console.log(`  FAIL: ${label}${detail ? ' — ' + detail : ''}`); failures++ }
}
const near = (a, b, tolerance) => Math.abs(a - b) <= tolerance

const BOX_MM = 10, BOX_HEIGHT_MM = 2
function boxTris(centerX, centerY) {
  const x0 = centerX - BOX_MM / 2, y0 = centerY - BOX_MM / 2
  const corners = [[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]]
    .map(([x, y, z]) => [x0 + x * BOX_MM, y0 + y * BOX_MM, z * BOX_HEIGHT_MM])
  const quad = (a, b, c, d) => [[a, b, c], [a, c, d]]
  const faces = [...quad(0,3,2,1), ...quad(4,5,6,7), ...quad(0,1,5,4), ...quad(1,2,6,5), ...quad(2,3,7,6), ...quad(3,0,4,7)]
  return Float32Array.from(faces.flatMap(face => face.flatMap(corner => corners[corner])))
}
function stlOf(tris) {
  const facets = tris.length / 9, buffer = Buffer.alloc(84 + facets * 50)
  buffer.writeUInt32LE(facets, 80)
  for (let facet = 0; facet < facets; facet++)
    for (let value = 0; value < 9; value++) buffer.writeFloatLE(tris[facet * 9 + value], 84 + facet * 50 + 12 + value * 4)
  return new Uint8Array(buffer)
}
const rectangle = (minX, minY, maxX, maxY) => [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]]
const circle = (radius, points = 32) => Array.from({ length: points }, (_, index) => {
  const angle = (2 * Math.PI * index) / points
  return [Math.round(radius * Math.cos(angle) * 1000) / 1000, Math.round(radius * Math.sin(angle) * 1000) / 1000]
})

const BEDS = [
  { name: 'rectangle away from the origin', area: rectangle(20, 10, 220, 210) },
  { name: 'negative coordinates', area: rectangle(-100, -80, 100, 80) },
  { name: 'asymmetric about the origin', area: rectangle(-30, 0, 170, 250) },
  { name: 'round, centred on the origin', area: circle(100) },
]
const OFFSET = { x: 23, y: -17 }   // where the object sits relative to the bed centre
const POSITION_TOLERANCE_MM = 0.5  // half a line width: the wall's centre line sits inside the box edge

const slicer = await createSlicer()
for (const bed of BEDS) {
  console.log(`[${bed.name}]`)
  const settings = { printable_area: bed.area, printable_height: 100 }
  const params = deriveKernelParams(settings)
  const origin = bedOrigin(params), center = bedCenter(params)

  // Save: plate 0's origin is the scene origin, so the object's scene coordinates are its offset from the bed centre.
  const object = { id: 1, name: 'box', extruder: 1, plate: 0, plateOriginX: 0, plateOriginY: 0,
                   tris: boxTris(OFFSET.x, OFFSET.y), faceCount: 12, paint: null }
  const bytes = await write3MFProject([object], settings,
    { bedWidth: params.bed_width, bedDepth: params.bed_depth, bedOrigin: origin, plateCount: 1 })
  const { objects, project } = await parse3MFProject(bytes, 'roundtrip')
  const box = objects[0].bbox
  check('the 3mf holds the object in the printer frame',
    near((box.minX + box.maxX) / 2, center.x + OFFSET.x, 1e-3) && near((box.minY + box.maxY) / 2, center.y + OFFSET.y, 1e-3),
    JSON.stringify(box))

  // Open: the loader's own call (model_load.js) with the project's bed.
  const loaded = objects.map((entry, index) => ({ ...entry, id: index + 1 }))
  const [placement] = platePlacements(project.plates, loaded, params.bed_width, params.bed_depth, origin)
  check('opening puts it back at the same offset', placement && near(placement[2], OFFSET.x, 1e-3) && near(placement[3], OFFSET.y, 1e-3),
    JSON.stringify(placement))

  // Slice: the viewer hands the kernel plate-local coordinates, which on plate 0 are the placement itself.
  const result = slicer.slice(stlOf(boxTris(placement[2], placement[3])), JSON.stringify(params), () => {})
  check('slices', !result.error, String(result.error))
  const firstLayer = result.gcode.slice(result.gcode.indexOf('; LAYER 0'), result.gcode.indexOf('; LAYER 1'))
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const move of firstLayer.matchAll(/^G1 X([-\d.]+) Y([-\d.]+) E/gm)) {
    minX = Math.min(minX, +move[1]); maxX = Math.max(maxX, +move[1]); minY = Math.min(minY, +move[2]); maxY = Math.max(maxY, +move[2])
  }
  const printedX = (minX + maxX) / 2, printedY = (minY + maxY) / 2
  check(`the G-code prints it at bed centre + offset (${(center.x + OFFSET.x).toFixed(1)}, ${(center.y + OFFSET.y).toFixed(1)})`,
    near(printedX, center.x + OFFSET.x, POSITION_TOLERANCE_MM) && near(printedY, center.y + OFFSET.y, POSITION_TOLERANCE_MM),
    `printed at (${printedX.toFixed(2)}, ${printedY.toFixed(2)})`)
}

if (failures) {
  console.log(`\n${failures} CHECK(S) FAILED`)
  process.exit(1)
}
console.log('\nALL BED FRAME ROUND-TRIP CHECKS PASSED')
