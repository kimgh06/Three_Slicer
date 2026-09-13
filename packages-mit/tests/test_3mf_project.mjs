// 3MF **project** import: painted facets + Metadata/*.config. The geometry half is covered by test_loaders.mjs;
// this covers everything a slicer-written 3mf carries next to the mesh.
// The fixture is built here rather than committed because the painting encoding is the point of the test — a
// checked-in binary would prove the parser agrees with itself, not that it agrees with upstream's format.
import { zipSync, strToU8 } from 'three/examples/jsm/libs/fflate.module.js'
import { parse3MFProject } from './src/core/parse_3mf.js'
import { normalizeProjectSettings, deriveKernelParams } from './src/settings/index.js'
import { leanSchema as schema } from './src/settings/data.js'
import { platePlacements } from './src/actions/model_load.js'

let failures = 0
const check = (name, cond, detail = '') => {
  if (cond) console.log('ok  ' + name)
  else { console.log('FAIL ' + name + (detail ? '  — ' + detail : '')); failures++ }
}
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)

// ---- the painting encoding ---------------------------------------------------------------------------------
// A facet that was painted but never split is one nibble: `state << 2`, except states 3..16 which use the 0b1100
// prefix plus a second nibble holding state-3. get_triangle_as_string writes nibbles most-significant FIRST, so
// the two-nibble form reads "0C" for Extruder3 — the same shape as upstream's own "1C0C2C0C1C13" example
// (slicer/src/libslic3r/Model.cpp:3153).
const HEX_ENFORCER = '4'    // state 1 == Extruder1
const HEX_BLOCKER = '8'     // state 2 == Extruder2
const HEX_EXTRUDER3 = '0C'  // state 3
const HEX_EXTRUDER4 = '1C'  // state 4

// ---- fixture -----------------------------------------------------------------------------------------------
// One tetrahedron per object, 4 facets each, so a facet index is small enough to state by hand.
const TETRA_VERTS = [[0, 0, 0], [10, 0, 0], [0, 10, 0], [0, 0, 10]]
const TETRA_TRIS = [[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]]

function objectXml(id, paintByTri) {
  const vertices = TETRA_VERTS.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')
  const triangles = TETRA_TRIS.map(([a, b, c], i) => {
    const attrs = Object.entries(paintByTri[i] || {}).map(([k, v]) => ` ${k}="${v}"`).join('')
    return `<triangle v1="${a}" v2="${b}" v3="${c}"${attrs}/>`
  }).join('')
  return `<object id="${id}" type="model"><mesh><vertices>${vertices}</vertices><triangles>${triangles}</triangles></mesh></object>`
}

// The point values below are verbatim from a real MakerWorld project (haaland.3mf, Bambu X2D 0.2 nozzle) —
//  they are the shape that produced a 2mm-wide bed before points were coerced.
const PROJECT_SETTINGS = {
  layer_height: '0.25',
  spiral_mode: '0',                 // the case that matters: !!"0" is true, so a raw import would enable it
  enable_support: '1',
  sparse_infill_density: '42%',
  nozzle_diameter: ['0.4', '0.6'],
  filament_type: ['PLA', 'PETG'],
  outer_wall_speed: ['', '80'],     // an empty per-extruder slot must not become 0
  printable_area: ['0x0', '256x0', '256x256', '0x256'],
  start_end_points: ['30x-3', '54x245'],                                   // negative coordinate
  extruder_offset: ['0x0', '0x0'],
  bed_exclude_area: [],
  extruder_printable_area: ['0x0,256x0,256x256,0x256', '20.5x0,256x0,256x256,20.5x256'],
  best_object_pos: '0.3,0.5',       // a coPoint written with a COMMA, not the usual 'x'
  version: '2.1.0.0',               // not a config-schema key -> dropped
  different_settings_to_system: ['layer_height'],
}

const MODEL_SETTINGS = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <object id="1">
    <metadata key="name" value="Alpha"/>
    <metadata key="extruder" value="2"/>
    <part id="1" subtype="normal_part">
      <metadata key="name" value="inner part that must not win"/>
    </part>
  </object>
  <object id="2">
    <metadata key="name" value="Beta"/>
    <metadata key="extruder" value="1"/>
    <metadata key="sparse_infill_density" value="80"/>
  </object>
  <plate>
    <metadata key="plater_id" value="1"/>
    <model_instance><metadata key="object_id" value="1"/><metadata key="instance_id" value="0"/></model_instance>
  </plate>
  <plate>
    <metadata key="plater_id" value="2"/>
    <model_instance><metadata key="object_id" value="2"/></model_instance>
  </plate>
</config>`

function buildFixture(extraFiles = {}) {
  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
 <resources>
  ${objectXml(1, { 1: { paint_color: HEX_ENFORCER }, 3: { paint_color: HEX_EXTRUDER3 } })}
  ${objectXml(2, { 0: { paint_supports: HEX_BLOCKER }, 2: { paint_color: HEX_EXTRUDER4, paint_seam: '4' } })}
 </resources>
 <build><item objectid="1"/><item objectid="2" transform="1 0 0 0 1 0 0 0 1 300 25 0"/></build>
</model>`
  return zipSync({
    '3D/3dmodel.model': strToU8(model),
    'Metadata/project_settings.config': strToU8(JSON.stringify(PROJECT_SETTINGS)),
    'Metadata/model_settings.config': strToU8(MODEL_SETTINGS),
    ...extraFiles,
  })
}

// ---- painting extraction -----------------------------------------------------------------------------------
const { objects, project } = await parse3MFProject(buildFixture(), 'fixture')

eq('two build items become two objects', objects.length, 2)
eq('object 1 keeps its 4 facets', objects[0].tris.length / 9, 4)
eq('object 1 paint_color is keyed by facet index', [...objects[0].paint.color], [[1, HEX_ENFORCER], [3, HEX_EXTRUDER3]])
eq('object 1 has no support paint', objects[0].paint.supports.size, 0)
eq('object 2 paint_supports survives', [...objects[1].paint.supports], [[0, HEX_BLOCKER]])
eq('object 2 paint_color survives', [...objects[1].paint.color], [[2, HEX_EXTRUDER4]])
eq('object 2 seam paint is collected (so it can be reported as dropped)', [...objects[1].paint.seam], [[2, '4']])
eq('build item objectid is carried for the metadata join', objects.map(o => o.objectid), ['1', '2'])

// Facet indices are per OBJECT here; the merge into one selector mesh rebases them (use_three_scene buildMergedSTL).
check('paint indices are object-local, not global', objects[1].paint.color.has(2) && !objects[1].paint.color.has(6))

// ---- the file's own layout ---------------------------------------------------------------------------------
// The build item transform has to reach the vertices AND be recorded, because that box is the only trace of where
// the author put the object: the scene's bakeLocal centres every object's geometry and the placement cursor then
// drops it wherever it likes. Losing it is what made an imported 6-plate project come out as one long row of
// objects marching across the plate boundaries.
eq('the untransformed object keeps its own box', objects[0].bbox, { minX: 0, minY: 0, maxX: 10, maxY: 10 })
eq('a build item translation lands in the box', objects[1].bbox, { minX: 300, minY: 25, maxX: 310, maxY: 35 })
check('the translation reached the vertices too', objects[1].tris[0] >= 300)

// ---- placement: upstream's grid rule ------------------------------------------------------------------------
// A slicer-written 3mf stores ABSOLUTE coordinates and lays its plates out in world space, so an object's position
// already says where on its plate it sits — but under UPSTREAM's grid, not this viewer's:
//   upstream (PartPlate.cpp compute_shape_position / plate_stride_x, LOGICAL_PART_PLATE_GAP = 1/5):
//     origin = (col*W*1.2, -row*D*1.2), at the plate's CORNER, rows growing along -y
//   here (plate_layout.js): origin = (col*(W+40), +row*(D+40)), at the plate's CENTRE
// platePlacements decodes with the first and emits offsets for the second. At W=200 the two strides coincide
// (200*1.2 == 200+40), which is why the fixture below uses 200 for the decode and the real-world 256 case — where
// they are 307.2 vs 296 — is the one that actually bit.
const at = (plate, ids) => ({ index: plate, objectIds: ids })
const obj = (objectid, id, cx, cy) => ({ objectid, id, bbox: { minX: cx - 5, maxX: cx + 5, minY: cy - 5, maxY: cy + 5 } })
const STRIDE = 200 * 1.2   // upstream stride for a 200mm bed

// cols for 2 plates is 2 (compute_colum_count / plateCols), so plate 1 is col 1, row 0.
eq('an object keeps its position on its own plate',
   platePlacements([at(0, ['a']), at(1, ['b'])], [obj('a', 1, 50, 60), obj('b', 2, STRIDE + 150, 30)], 200, 200),
   [[1, 0, 50 - 100, 60 - 100], [2, 1, 150 - 100, 30 - 100]])

// The column count comes from how many plates the project has, so an empty plate still has to be in the list —
// which it is, since every <plate> element is parsed whether or not anything sits on it.
// cols for 3 plates is 2, so plate 2 is col 0 row 1 — and upstream's rows grow along NEGATIVE y.
eq('a second row decodes from negative y',
   platePlacements([at(0, []), at(1, []), at(2, ['c'])], [obj('c', 3, 40, -STRIDE + 80)], 200, 200),
   [[3, 2, 40 - 100, 80 - 100]])

// If the decode does not land on the plate the file claims, the whole file falls back to group re-centring rather
// than scattering objects off the bed — a project written under a different grid rule must not silently explode.
// Here plate 1 is col 1, so its origin is at x=240 and an object at x=50 decodes to -190: off its own plate.
eq('coordinates that do not decode fall back to group re-centring',
   platePlacements([at(0, []), at(1, ['d'])], [obj('d', 4, 50, 60)], 200, 200),
   [[4, 1, 0, 0]])
eq('two objects keep their relative arrangement in the fallback',
   platePlacements([at(0, []), at(1, ['e', 'f'])], [obj('e', 5, 0, 0), obj('f', 6, 40, 0)], 200, 200),
   [[5, 1, -20, 0], [6, 1, 20, 0]])
eq('no bed means no decode is possible, so the fallback is used',
   platePlacements([at(0, ['g'])], [obj('g', 7, 50, 60)], 0, 0),
   [[7, 0, 0, 0]])

// ---- Metadata/model_settings.config ------------------------------------------------------------------------
eq('object metadata is read', project.objectMeta.get('1').name, 'Alpha')
eq('a <part>\'s own metadata does not overwrite the object\'s', project.objectMeta.get('1').name, 'Alpha')
eq('per-object extruder is read', project.objectMeta.get('2').extruder, '1')
eq('plates are 0-based (plater_id is 1-based)', project.plates.map(p => p.index), [0, 1])
eq('plate membership is read', project.plates.map(p => p.objectIds), [['1'], ['2']])

// ---- Metadata/project_settings.config ----------------------------------------------------------------------
const { settings, applied, skipped } = normalizeProjectSettings(project.settings)
eq('coFloat becomes a number', settings.layer_height, 0.25)
check('coBool "0" becomes false, not truthy "0"', settings.spiral_mode === false, `got ${JSON.stringify(settings.spiral_mode)}`)
check('coBool "1" becomes true', settings.enable_support === true)
eq('coPercent drops the % sign', settings.sparse_infill_density, 42)
eq('coFloats map elementwise', settings.nozzle_diameter, [0.4, 0.6])
eq('coStrings are left alone', settings.filament_type, ['PLA', 'PETG'])
eq('an empty vector slot stays empty rather than becoming 0', settings.outer_wall_speed, ['', 80])
check('a non-schema key is dropped', !('version' in settings) && skipped.includes('version'))
check('applied counts only schema keys', applied === Object.keys(settings).length)

// Points. The regression this pins: every consumer indexes a point as [x, y], so leaving upstream's "256x0"
// STRING in the map makes `printable_area[1][0]` the character '2' — measured on a real MakerWorld project as a
// 2mm x NaN bed. deriveKernelParams' own bed maths is checked at the bottom, which is where it actually bit.
eq('coPoints becomes [x,y] pairs', settings.printable_area, [[0,0],[256,0],[256,256],[0,256]])
eq('a negative point coordinate survives', settings.start_end_points, [[30,-3],[54,245]])
eq('a per-extruder coPoints vector is coerced too', settings.extruder_offset, [[0,0],[0,0]])
eq('an empty coPoints stays empty', settings.bed_exclude_area, [])
eq('coPointsGroups splits into a list of point lists', settings.extruder_printable_area,
   [[[0,0],[256,0],[256,256],[0,256]], [[20.5,0],[256,0],[256,256],[20.5,256]]])
eq('a coPoint written with a comma still parses', settings.best_object_pos, [0.3, 0.5])

const bed = deriveKernelParams(settings)
eq('the imported bed is the real one, not 2 x NaN', [bed.bed_width, bed.bed_depth], [256, 256])

// Guard: every type the config schema uses must be a type coerceScalar decided about. Points were missed exactly
// because nothing forced that decision — a new upstream type must fail here rather than silently pass through.
const DECIDED = new Set(['coBool','coBools','coFloat','coFloats','coInt','coInts','coPercent','coPercents',
  'coFloatOrPercent','coFloatsOrPercents','coPoint','coPoints','coPointsGroups','coString','coStrings','coEnum','coEnums'])
const unknownTypes = [...new Set(Object.values(schema).map(o => o.type))].filter(t => !DECIDED.has(t))
check('every config-schema option type has a decided coercion', unknownTypes.length === 0, `undecided: ${unknownTypes.join(', ')}`)

// ---- optional parts ------------------------------------------------------------------------------------------
check('no layer-height profile in the base fixture', project.hasLayerHeightProfile === false)
const withExtras = (await parse3MFProject(buildFixture({
  'Metadata/layer_heights_profile.txt': strToU8('0 0.2 10 0.1\n'),
  'Metadata/custom_gcode_per_layer.xml': strToU8('<custom_gcodes_per_layer><plate/></custom_gcodes_per_layer>'),
}), 'fixture')).project
check('layer-height profile is detected', withExtras.hasLayerHeightProfile === true)
check('per-layer custom G-code is detected', withExtras.hasCustomGcodePerLayer === true)

// A 3mf with no Metadata/ at all (any CAD export) must still parse, with an empty project.
const bare = await parse3MFProject(zipSync({
  '3D/3dmodel.model': strToU8(`<?xml version="1.0"?><model><resources>${objectXml(1, {})}</resources><build><item objectid="1"/></build></model>`),
}), 'bare')
eq('a 3mf with no metadata still yields geometry', bare.objects.length, 1)
check('a 3mf with no metadata has no paint', bare.objects[0].paint === null)
check('a 3mf with no metadata has null settings', bare.project.settings === null)

// Malformed metadata must not cost the geometry.
const broken = await parse3MFProject(zipSync({
  '3D/3dmodel.model': strToU8(`<?xml version="1.0"?><model><resources>${objectXml(1, {})}</resources><build><item objectid="1"/></build></model>`),
  'Metadata/project_settings.config': strToU8('{not json'),
}), 'broken')
eq('unparsable project_settings still loads the mesh', broken.objects.length, 1)
check('unparsable project_settings yields null settings', broken.project.settings === null)

// ---- per-plate wipe tower position -----------------------------------------------------------------------
// wipe_tower_x/y are upstream's per-plate arrays (coFloats). deriveKernelParams must index them by opts.plate,
// a hole (null) must mean "auto for that plate" (NO fallback to a neighbour's entry), and a legacy scalar must
// keep applying to every plate. The array itself must survive normalizeProjectSettings un-collapsed.
{
  const { settings: towers } = normalizeProjectSettings({ wipe_tower_x: ['15', '130', '245'], wipe_tower_y: ['220', '221', '222'] })
  eq('wipe_tower_x survives import as a full per-plate array', JSON.stringify(towers.wipe_tower_x), '[15,130,245]')
  eq('plate 1 slices with its own tower x', deriveKernelParams(towers, { plate: 1 }).prime_tower_x, 130)
  eq('plate 1 slices with its own tower y', deriveKernelParams(towers, { plate: 1 }).prime_tower_y, 221)
  eq('no plate given reads plate 0 (every pre-array caller)', deriveKernelParams(towers).prime_tower_x, 15)
  check('a hole is auto for that plate, not a neighbour\'s entry',
    deriveKernelParams({ wipe_tower_x: [15, null, 245], wipe_tower_y: [220, null, 222] }, { plate: 1 }).prime_tower_x === undefined)
  eq('a legacy scalar applies to every plate', deriveKernelParams({ wipe_tower_x: 40, wipe_tower_y: 50 }, { plate: 2 }).prime_tower_x, 40)
}

console.log(failures ? `\n${failures} FAILED` : '\n3MF project import passed')
process.exit(failures ? 1 : 0)
