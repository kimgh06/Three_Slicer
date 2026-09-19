// 3MF project EXPORT: write a project, read it straight back with the importer, and check that what comes out
// is what went in. A writer can only be wrong in ways its own reader hides, so every assertion here goes through
// parse3MFProject / normalizeProjectSettings / platePlacements — the code that reads a MakerWorld file — rather
// than re-parsing the XML the writer just produced.
import { write3MFProject, writeSTL, VIEWER_SETTINGS_MEMBER } from '../src/core/write_3mf.js'
import { parse3MFProject } from '../src/core/parse_3mf.js'
import { normalizeProjectSettings, deriveKernelParams, serializeProjectSettings } from '../src/settings/index.js'
import { platePlacements } from '../src/actions/model_load.js'
import { plateStep, plateCols } from '../src/core/plate_layout.js'

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

// ---- shared by 4b, 5, 5b and 6: a one-object project on plate 0 of a `plateCount`-plate session ----
const TETRA_FACETS = 4
const oneObjectOnPlateZero = (plateCount = 1) =>
  [{ id: 1, name: 'a', extruder: 1, plate: 0, ...viewerPlateOriginOf(0, plateCount), tris: tetra(0, 0), faceCount: TETRA_FACETS, paint: null }]
const LAYER_HEIGHT_MM = 0.2

// ---- 4b. each object's material and support paint under its own attribute ----------------------------------
{
  const HEX_STATE_2 = '8', HEX_STATE_3 = '0C', HEX_STATE_1 = '4'
  const paintedObject = (id, paint) => ({ ...oneObjectOnPlateZero()[0], id, name: `o${id}`, tris: tetra(id * 30, 0), paint })
  const readBack = async (objects, options = {}) => {
    const { objects: read } = await parse3MFProject(await write3MFProject(objects, { layer_height: LAYER_HEIGHT_MM },
      { bedWidth: BED_W, bedDepth: BED_D, plateCount: 1, ...options }), 'kinds')
    return read.map(o => [o.paint?.color?.size ?? 0, o.paint?.supports?.size ?? 0])
  }
  // Material paint on one object, support paint on another — whatever brush was used last.
  const mixed = () => [paintedObject(1, { color: new Map([[0, HEX_STATE_2], [1, HEX_STATE_3]]) }), paintedObject(2, { supports: new Map([[2, HEX_STATE_1]]) })]
  eq('mixed kinds keep their own attribute (last brush material)', await readBack(mixed(), { paintKind: 'color' }), [[2, 0], [0, 1]])
  eq('mixed kinds keep their own attribute (last brush support)', await readBack(mixed(), { paintKind: 'supports' }), [[2, 0], [0, 1]])
  // An EMPTY support map must not shadow the object's material paint.
  eq('an empty map is no paint', await readBack([paintedObject(1, { color: new Map([[0, HEX_STATE_2]]), supports: new Map() })], { paintKind: 'supports' }), [[1, 0]])
  // Both annotations on one facet, as upstream allows.
  eq('both annotations on one facet', await readBack([paintedObject(1, { color: new Map([[0, HEX_STATE_2]]), supports: new Map([[0, HEX_STATE_1]]) })]), [[1, 1]])
}

// ---- 5. what upstream has no place for: per-plate overrides and the viewer knobs, in our own member -----------
{
  const SESSION_PLATES = 3
  const OVERRIDDEN_PLATE = 1, EMPTIED_PLATE = 2, DELETED_PLATE = 5   // DELETED_PLATE >= SESSION_PLATES
  const OVERRIDE_TOWER_WIDTH_MM = 40, OVERRIDE_LAYER_HEIGHT_MM = 0.3
  const overrideOfPlate = { enable_prime_tower: false, prime_tower_width: OVERRIDE_TOWER_WIDTH_MM, wipe_tower_real: false }
  const settings = { layer_height: LAYER_HEIGHT_MM, wipe_tower_real: true, enable_prime_tower: true }
  const plateSettings = {
    [OVERRIDDEN_PLATE]: overrideOfPlate,
    [EMPTIED_PLATE]: {},                                         // an emptied override is not a plate override
    [DELETED_PLATE]: { layer_height: OVERRIDE_LAYER_HEIGHT_MM },  // a plate that no longer exists is not written
  }
  const bytes = await write3MFProject(oneObjectOnPlateZero(SESSION_PLATES), settings,
    { bedWidth: BED_W, bedDepth: BED_D, plateCount: SESSION_PLATES, plateSettings })
  const { project } = await parse3MFProject(bytes, 'sidecar')
  eq('the per-plate overrides come back, keyed by plate, with their JS types', project.plateSettings, { [OVERRIDDEN_PLATE]: overrideOfPlate })
  eq('the non-schema knobs of the global map come back', project.viewerSettings, { wipe_tower_real: true })
  check('project_settings.config still carries only schema keys', !('wipe_tower_real' in project.settings))

  // No overrides and no knobs: no member at all, so a plain project is the file it always was.
  const plain = await parse3MFProject(await write3MFProject(oneObjectOnPlateZero(), { layer_height: LAYER_HEIGHT_MM },
    { bedWidth: BED_W, bedDepth: BED_D, plateCount: 1 }), 'plain')
  eq('nothing to carry -> no sidecar', [plain.project.plateSettings, plain.project.viewerSettings], [null, null])
}

// ---- 5b. an array with holes: strings only for upstream, the holes kept for us --------------------------------
{
  const SESSION_PLATES = 3
  // Upstream's schema defaults for wipe_tower_x/y — what a hole is written as (settingRaw({}, key)).
  const UPSTREAM_TOWER_X_DEFAULT = '15', UPSTREAM_TOWER_Y_DEFAULT = '220'
  const CHOSEN_X_MM = 160, CHOSEN_Y_MM = 150, Z_HOP_MM = 0.4
  // Plate 0 automatic, plate 1 chosen: the shape writeTowerPosition produces (x is sparse, y holds an explicit null).
  const towerX = []; towerX[1] = CHOSEN_X_MM
  const settings = { layer_height: LAYER_HEIGHT_MM, z_hop: Z_HOP_MM, wipe_tower_x: towerX, wipe_tower_y: [null, CHOSEN_Y_MM] }
  const bytes = await write3MFProject(oneObjectOnPlateZero(SESSION_PLATES), settings, { bedWidth: BED_W, bedDepth: BED_D, plateCount: SESSION_PLATES })
  const { project } = await parse3MFProject(bytes, 'holes')
  // Upstream's parse_str_arr accepts an array only when every entry is a string; anything else ends its key loop.
  const isStringArrayOrScalar = (value) => !Array.isArray(value) || value.every(entry => typeof entry === 'string')
  check('every array entry in project_settings.config is a string', Object.values(project.settings).every(isStringArrayOrScalar))
  eq('a hole is written as the schema default', [project.settings.wipe_tower_x, project.settings.wipe_tower_y],
     [[UPSTREAM_TOWER_X_DEFAULT, String(CHOSEN_X_MM)], [UPSTREAM_TOWER_Y_DEFAULT, String(CHOSEN_Y_MM)]])
  eq('keys after it are still there for upstream', project.settings.z_hop, String(Z_HOP_MM))
  // The import lays the sidecar over project_settings.config, so the plate is automatic again here.
  const restored = { ...normalizeProjectSettings(project.settings).settings, ...project.viewerSettings }
  eq('the hole comes back as a hole', [restored.wipe_tower_x[0] == null, restored.wipe_tower_x[1]], [true, CHOSEN_X_MM])
  eq('...on both axes', [restored.wipe_tower_y[0], restored.wipe_tower_y[1]], [null, CHOSEN_Y_MM])
}

// ---- 6. the sidecar is read defensively: a file from anywhere costs only itself ----------------------------
{
  const { zipSync, unzipSync, strToU8 } = await import('three/examples/jsm/libs/fflate.module.js')
  const base = await write3MFProject(oneObjectOnPlateZero(), { layer_height: LAYER_HEIGHT_MM }, { bedWidth: BED_W, bedDepth: BED_D, plateCount: 1 })
  const withMember = (text) => { const files = unzipSync(base); files[VIEWER_SETTINGS_MEMBER] = strToU8(text); return zipSync(files) }
  const broken = await parse3MFProject(withMember('{ not json'), 'broken')
  eq('malformed JSON -> nothing, and the geometry still loads', [broken.project.plateSettings, broken.objects.length], [null, 1])
  const VALID_PLATE = 1, VALID_OVERRIDE = { layer_height: 0.3 }
  const oddSidecar = { version: 1, viewer: [1], plates: { '-1': { a: 1 }, x: { a: 1 }, 0: [1], [VALID_PLATE]: VALID_OVERRIDE } }
  const odd = await parse3MFProject(withMember(JSON.stringify(oddSidecar)), 'odd')
  eq('only plain maps under plate indices survive', [odd.project.plateSettings, odd.project.viewerSettings], [{ [VALID_PLATE]: VALID_OVERRIDE }, null])
}

console.log(failures ? `\n${failures} FAILED` : '\n3mf export passed')
process.exit(failures ? 1 : 0)
