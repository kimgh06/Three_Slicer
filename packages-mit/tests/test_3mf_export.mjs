// 3MF project EXPORT: write a project, read it straight back with the importer, and check that what comes out
// is what went in. A writer can only be wrong in ways its own reader hides, so every assertion here goes through
// parse3MFProject / normalizeProjectSettings / platePlacements — the code that reads a MakerWorld file — rather
// than re-parsing the XML the writer just produced.
import { write3MFProject, writeSTL } from './src/core/write_3mf.js'
import { rebasePaintOntoSubset } from './src/actions/export_actions.js'
import { parse3MFProject } from './src/core/parse_3mf.js'
import { normalizeProjectSettings, deriveKernelParams, serializeProjectSettings } from './src/settings/index.js'
import { platePlacements } from './src/actions/model_load.js'
import { plateStep, plateCols } from './src/core/plate_layout.js'

let failures = 0
const check = (name, cond, detail = '') => {
  if (cond) console.log('ok  ' + name)
  else { console.log('FAIL ' + name + (detail ? '  — ' + detail : '')); failures++ }
}
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
const near = (name, got, want, tol = 1e-3) =>
  check(name, Math.abs(got - want) <= tol, `got ${got}, want ${want} (±${tol})`)

// A tetrahedron at a given XY, in MODEL coordinates (z up), the shape exportObjects returns.
function tetra(atX, atY, size = 10) {
  const v = [[0, 0, 0], [size, 0, 0], [0, size, 0], [0, 0, size]].map(([x, y, z]) => [x + atX, y + atY, z])
  const faces = [[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]]
  return Float32Array.from(faces.flatMap(f => f.flatMap(i => v[i])))
}

// The viewer's own plate origin in model coords — the value exportObjects reports (plate_layout's grid).
function viewerPlateOrigin(plate, plateCount, bedW, bedD) {
  const cols = plateCols(plateCount)
  return { x: (plate % cols) * plateStep(bedW), y: -(Math.floor(plate / cols) * plateStep(bedD)) }
}

const BED_W = 256, BED_D = 256

// ---- 1. geometry + per-object state round trip --------------------------------------------------------------
{
  const objects = [
    { id: 1, name: 'left', extruder: 1, plate: 0, ...viewerPlateOriginOf(0), tris: tetra(-30, 5), faceCount: 4, paint: null },
    { id: 2, name: 'right', extruder: 2, plate: 0, ...viewerPlateOriginOf(0), tris: tetra(20, -10), faceCount: 4, paint: null },
  ]
  const bytes = await write3MFProject(objects, { layer_height: 0.2 }, { bedWidth: BED_W, bedDepth: BED_D, plateCount: 1 })
  const { objects: read, project } = await parse3MFProject(bytes, 'roundtrip')

  eq('two objects survive the round trip', read.length, 2)
  eq('facet counts survive', read.map(o => o.tris.length / 9), [4, 4])
  eq('names come back off model_settings.config', [...project.objectMeta.values()].map(m => m.name), ['left', 'right'])
  eq('extruder assignment comes back', [...project.objectMeta.values()].map(m => m.extruder), ['1', '2'])
  eq('one plate is recorded', project.plates.length, 1)
  eq('the plate lists both objects', project.plates[0].objectIds.length, 2)

  // Vertices must be identical, not merely close: the writer rounds to 6 decimals and the parser reads decimal
  //  text, so any drift here is a real coordinate bug rather than float noise.
  const wroteX = [...objects[0].tris].filter((_, i) => i % 3 === 0)
  const readX = [...read[0].tris].filter((_, i) => i % 3 === 0)
  const shiftX = readX[0] - wroteX[0]
  check('the object is rigidly shifted, not distorted', readX.every((x, i) => Math.abs(x - wroteX[i] - shiftX) < 1e-4))
}

function viewerPlateOriginOf(plate, plateCount = 1) {
  const origin = viewerPlateOrigin(plate, plateCount, BED_W, BED_D)
  return { plateOriginX: origin.x, plateOriginY: origin.y }
}

// ---- 2. the plate grid: written under UPSTREAM's rule, decoded back to the same offsets ---------------------
// This is the assertion that matters most, because the two grids only coincide at a 200mm bed — a 256mm bed is
// exactly where a wrong constant stops being visible in a single-plate test.
{
  const PLATES = 3
  const wanted = [                                 // [plate, offset from the plate centre, in mm]
    [0, -40, 25],
    [1, 15, -30],
    [2, 0, 0],
  ]
  const objects = wanted.map(([plate, dx, dy], at) => {
    const origin = viewerPlateOrigin(plate, PLATES, BED_W, BED_D)
    return {
      id: at + 1, name: `p${plate}`, extruder: 1, plate,
      plateOriginX: origin.x, plateOriginY: origin.y,
      tris: tetra(origin.x + dx, origin.y + dy, 6), faceCount: 4, paint: null,
    }
  })
  const bytes = await write3MFProject(objects, {}, { bedWidth: BED_W, bedDepth: BED_D, plateCount: PLATES })
  const { objects: read, project } = await parse3MFProject(bytes, 'plates')

  eq('every plate is written', project.plates.map(p => p.index), [0, 1, 2])
  // platePlacements is the importer's own decode — if it falls back to group re-centring, the absolute decode
  //  failed, which is precisely the bug this test exists to catch.
  const placements = platePlacements(project.plates, read, BED_W, BED_D)
  eq('one placement per object', placements.length, 3)
  for (const [at, [, plate, offsetX, offsetY]] of placements.entries()) {
    const [wantPlate, dx, dy] = wanted[at]
    // The offsets are of the object's bbox CENTRE, and a tetrahedron's centre is +size/3 from its corner.
    eq(`object ${at} decodes onto its own plate`, plate, wantPlate)
    near(`object ${at} x offset survives`, offsetX, dx + 3, 0.01)
    near(`object ${at} y offset survives`, offsetY, dy + 3, 0.01)
  }
}

// ---- 3. settings: every JS type back to a string and back again ---------------------------------------------
{
  const settings = {
    layer_height: 0.2,
    enable_support: false,            // the "0" trap: !!"0" is true, so a bool must survive as a real false
    spiral_mode: true,
    printable_area: [[0, 0], [256, 0], [256, 256], [0, 256]],   // the "XxY" point trap
    filament_colour: ['#FF0000', '#00FF00'],
    sparse_infill_density: 15,
    filament_type: ['PLA', 'ABS'],
  }
  const objects = [{ id: 1, name: 'a', extruder: 1, plate: 0, ...viewerPlateOriginOf(0), tris: tetra(0, 0), faceCount: 4, paint: null }]
  const bytes = await write3MFProject(objects, settings, { bedWidth: BED_W, bedDepth: BED_D, plateCount: 1 })
  const { project } = await parse3MFProject(bytes, 'settings')

  check('project_settings.config is written', !!project.settings)
  check('every value is written as a string', Object.values(project.settings)
    .every(v => typeof v === 'string' || (Array.isArray(v) && v.every(e => typeof e === 'string'))))
  eq('a false bool is written as "0"', project.settings.enable_support, '0')
  eq('a point is written as "XxY"', project.settings.printable_area[1], '256x0')

  const back = normalizeProjectSettings(project.settings).settings
  eq('layer_height survives', back.layer_height, 0.2)
  eq('a false bool comes back false', back.enable_support, false)
  eq('a true bool comes back true', back.spiral_mode, true)
  eq('the bed polygon comes back as pairs', back.printable_area, settings.printable_area)
  eq('filament colours survive', back.filament_colour, settings.filament_colour)
  eq('filament types survive', back.filament_type, settings.filament_type)
  // The bed is what a wrong point coercion destroys most visibly (measured upstream: 2mm x NaN).
  const bed = deriveKernelParams(back)
  eq('the bed reads back at full size', [bed.bed_width, bed.bed_depth], [256, 256])
  // Keys the schema does not define must not be smuggled through — the reader would drop them anyway.
  eq('a non-schema key is dropped', serializeProjectSettings({ not_a_real_option: 1 }), {})
}

// ---- 4. painting: kernel facet indices rebased per object, and back through the parser ----------------------
{
  // Two objects of 4 facets: merged facet 5 is object 1's facet 1, merged facet 2 is object 0's facet 2.
  const objects = [
    { id: 1, name: 'a', extruder: 1, plate: 0, ...viewerPlateOriginOf(0), tris: tetra(-20, 0), faceCount: 4, paint: null },
    { id: 2, name: 'b', extruder: 2, plate: 0, ...viewerPlateOriginOf(0), tris: tetra(20, 0), faceCount: 4, paint: null },
  ]
  const paintExport = { facets: [2, 5], hex: '8\n0C' }        // Extruder2 and Extruder3, upstream's own spelling
  const bytes = await write3MFProject(objects, {}, { bedWidth: BED_W, bedDepth: BED_D, plateCount: 1, paintExport })
  const { objects: read } = await parse3MFProject(bytes, 'paint')

  eq('object 0 keeps one painted facet', read[0].paint?.color.size, 1)
  eq('...at its own facet 2', [...read[0].paint.color.entries()], [[2, '8']])
  eq('object 1 keeps one painted facet', read[1].paint?.color.size, 1)
  eq('...rebased from merged facet 5 to local facet 1', [...read[1].paint.color.entries()], [[1, '0C']])

  // A facet index past the end of every object must be dropped, not folded onto the last one — a mis-rebased
  //  facet paints a different part of the model, which is worse than losing the mark.
  const overflow = await write3MFProject(objects, {}, { bedWidth: BED_W, bedDepth: BED_D, plateCount: 1,
    paintExport: { facets: [99], hex: '8' } })
  const { objects: readOverflow } = await parse3MFProject(overflow, 'overflow')
  check('an out-of-range facet is dropped', readOverflow.every(o => !o.paint))

  // Support painting goes into its own annotation — the import side reads paint_supports separately.
  const supports = await write3MFProject(objects, {}, { bedWidth: BED_W, bedDepth: BED_D, plateCount: 1,
    paintExport: { facets: [0], hex: '4' }, paintKind: 'supports' })
  const { objects: readSupports } = await parse3MFProject(supports, 'supports')
  eq('support paint lands in paint_supports', [...(readSupports[0].paint?.supports ?? new Map()).entries()], [[0, '4']])
  eq('...and not in paint_color', readSupports[0].paint?.color.size, 0)
}

// ---- 5. paint that was IMPORTED survives a save with no kernel export ---------------------------------------
// The kernel only has marks when a selector exists this session. Opening a painted project and saving it again
// without ever entering a brush must not quietly strip the painting.
{
  const imported = { color: new Map([[3, '0C']]), supports: new Map(), seam: new Map(), fuzzy: new Map() }
  const objects = [{ id: 1, name: 'a', extruder: 1, plate: 0, ...viewerPlateOriginOf(0), tris: tetra(0, 0), faceCount: 4, paint: imported }]
  const bytes = await write3MFProject(objects, {}, { bedWidth: BED_W, bedDepth: BED_D, plateCount: 1, paintExport: null })
  const { objects: read } = await parse3MFProject(bytes, 'imported-paint')
  eq('imported painting is re-written verbatim', [...read[0].paint.color.entries()], [[3, '0C']])
}

// ---- 6. STL --------------------------------------------------------------------------------------------------
{
  const tris = tetra(0, 0)
  const stl = writeSTL(tris)
  eq('binary STL is 84 + 50 per facet', stl.byteLength, 84 + 4 * 50)
  const view = new DataView(stl.buffer, stl.byteOffset, stl.byteLength)
  eq('the facet count is in the header', view.getUint32(80, true), 4)
  // First vertex of the first facet, past the 12-byte normal.
  near('the first vertex survives', view.getFloat32(84 + 12, true), tris[0])
  near('...and its y', view.getFloat32(84 + 16, true), tris[1])
  eq('the attribute byte count is 0', view.getUint16(84 + 48, true), 0)
  check('the header is not mistakable for an ASCII STL',
    !new TextDecoder().decode(stl.subarray(0, 5)).startsWith('solid'))
}
// Facet normals, the one place the writer differed from upstream's its_write_stl_binary. A known winding must
// produce a known unit normal — zeros would still load in most tools, which is exactly why nothing caught it.
{
  // CCW seen from +z: (0,0,0) -> (10,0,0) -> (0,10,0). (v1-v0)x(v2-v1) points at +z.
  const stl = writeSTL(Float32Array.from([0, 0, 0, 10, 0, 0, 0, 10, 0]))
  const view = new DataView(stl.buffer, stl.byteOffset, stl.byteLength)
  const normal = [view.getFloat32(84, true), view.getFloat32(88, true), view.getFloat32(92, true)]
  eq('a CCW facet gets a +z unit normal', normal.map(v => Math.round(v * 1000) / 1000), [0, 0, 1])
  // Reversed winding must flip it, or the normal is decoration rather than data.
  const flipped = writeSTL(Float32Array.from([0, 0, 0, 0, 10, 0, 10, 0, 0]))
  const flippedView = new DataView(flipped.buffer, flipped.byteOffset, flipped.byteLength)
  eq('reversing the winding flips the normal', Math.round(flippedView.getFloat32(92, true) * 1000) / 1000, -1)
  // A degenerate triangle has no direction; it must stay zero rather than become NaN.
  const degenerate = writeSTL(Float32Array.from([1, 1, 1, 1, 1, 1, 1, 1, 1]))
  const degenerateView = new DataView(degenerate.buffer, degenerate.byteOffset, degenerate.byteLength)
  eq('a degenerate facet keeps a zero normal, not NaN',
    [0, 4, 8].map(o => degenerateView.getFloat32(84 + o, true)), [0, 0, 0])
}

// ---- 7. exporting a SUBSET rebases the kernel's facet numbering ----------------------------------------------
// The kernel numbers facets across every visible object's merge. Handing that numbering to a file containing only
// some of those objects would paint the wrong triangles — silently, and on the model the user is looking at.
{
  const all = [
    { id: 1, faceCount: 4 },
    { id: 2, faceCount: 4 },
    { id: 3, faceCount: 4 },
  ]
  // merged facet 9 is object 3's facet 1; merged facet 2 is object 1's facet 2.
  const kernelPaint = { facets: [2, 5, 9], hex: '8\n4\n0C' }

  const middleOnly = rebasePaintOntoSubset(kernelPaint, all, [all[1]])
  eq('only the marks of the exported object survive', middleOnly.facets, [1])
  eq('...with its own hex', middleOnly.hex, '4')

  const firstAndLast = rebasePaintOntoSubset(kernelPaint, all, [all[0], all[2]])
  // object 1 keeps base 0, object 3 now starts at 4 — so its facet 1 becomes 5.
  eq('a gap in the middle renumbers what follows it', firstAndLast.facets, [2, 5])
  eq('...and each hex rides with its own facet', firstAndLast.hex, '8\n0C')

  eq('exporting everything is the identity', rebasePaintOntoSubset(kernelPaint, all, all).facets, [2, 5, 9])
  eq('a subset with no marks yields nothing', rebasePaintOntoSubset(kernelPaint, all, [{ id: 9, faceCount: 4 }]), null)
  eq('no kernel paint yields nothing', rebasePaintOntoSubset(null, all, all), null)
}

console.log(failures ? `\n${failures} FAILED` : '\n3mf export passed')
process.exit(failures ? 1 : 0)
