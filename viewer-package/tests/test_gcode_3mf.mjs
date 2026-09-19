// .gcode.3mf: write the sliced plates, read them back through the importer the viewer uses for every 3mf, and check
// the G-code comes back byte for byte on the plate it left. Also pins the members upstream's loader and a Bambu
// printer look for (gcode_file on the <plate> record, the uppercase MD5 beside each G-code), the MD5 itself against
// known vectors, and that an ordinary project is not mistaken for a print job.
import { createHash } from 'node:crypto'
import { unzipSync, strFromU8 } from 'three/examples/jsm/libs/fflate.module.js'
import { writeGcode3MF, write3MFProject, gcodeMemberOf } from '../src/core/write_3mf.js'
import { parse3MFProject } from '../src/core/parse_3mf.js'
import { md5Hex } from '../src/core/md5.js'
import { parseGcode } from '../src/core/gcode_parse.js'

let failures = 0
const check = (name, cond, detail = '') => {
  if (cond) console.log('ok  ' + name)
  else { console.log('FAIL ' + name + (detail ? '  — ' + detail : '')); failures++ }
}
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)

// ---- MD5: RFC 1321 vectors, the 55/56/64-byte padding edges, and multi-byte text ----
const encoder = new TextEncoder()
eq('md5 of ""', md5Hex(new Uint8Array(0)), 'D41D8CD98F00B204E9800998ECF8427E')
eq('md5 of "abc"', md5Hex(encoder.encode('abc')), '900150983CD24FB0D6963F7D28E17F72')
for (const text of ['a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'G1 X1 Y2 ; 한글\n'.repeat(500)]) {
  const bytes = encoder.encode(text)
  eq(`md5 matches node crypto (${bytes.length} bytes)`, md5Hex(bytes), createHash('md5').update(bytes).digest('hex').toUpperCase())
}

// ---- Round trip ----
// Two layers of extrusion, enough for parseGcode to report layers (the viewer's own "is this G-code" test).
const gcodeOf = (x) => [
  'G90', 'M83', 'G1 Z0.2 F600', `G1 X${x} Y10 F3000`, `G1 X${x + 20} Y10 E1.0`, `G1 X${x + 20} Y30 E1.0`,
  'G1 Z0.4', `G1 X${x} Y30 E1.0`, `G1 X${x} Y10 E1.0`, '',
].join('\n')
const plates = [
  { index: 0, gcode: gcodeOf(10), stats: { time_estimate: 125.4, filament_mm: 1200, filament_mm_by_tool: [1200] } },
  { index: 2, gcode: gcodeOf(50), stats: { time_estimate: 60, filament_mm: 300, filament_mm_by_tool: [100, 200] } },
]
check('fixture G-code parses to layers', parseGcode(plates[0].gcode).stats.layers >= 2)
const settings = { filament_diameter: [1.75, 1.75], filament_density: [1.24, 1.04], filament_type: ['PLA', 'PETG'],
  filament_colour: ['#FF0000', '#00FF00'] }
const bytes = await writeGcode3MF(plates, settings, { plateCount: 3 })
const members = unzipSync(bytes)

for (const plate of plates) {
  const member = gcodeMemberOf(plate.index)
  eq(`plate ${plate.index + 1} G-code member is upstream's name`, member, `Metadata/plate_${plate.index + 1}.gcode`)
  eq(`plate ${plate.index + 1} md5 member matches its G-code`, strFromU8(members[`${member}.md5`] ?? new Uint8Array()),
    createHash('md5').update(members[member] ?? new Uint8Array()).digest('hex').toUpperCase())
}
check('unsliced plate 2 has no G-code member', !members['Metadata/plate_2.gcode'])
const modelSettings = strFromU8(members['Metadata/model_settings.config'])
eq('one <plate> record per plate', (modelSettings.match(/<plate>/g) ?? []).length, 3)
check('gcode_file names the member', modelSettings.includes('<metadata key="gcode_file" value="Metadata/plate_3.gcode"/>'))
check('no mesh is written', !/<object\b/.test(strFromU8(members['3D/3dmodel.model'])))
const sliceInfo = strFromU8(members['Metadata/slice_info.config'])
check('slice_info carries the prediction (seconds)', sliceInfo.includes('<metadata key="prediction" value="125"/>'))
// 1200mm of 1.75mm PLA at 1.24 g/cm3 = 3.58 g
check('slice_info carries the weight', sliceInfo.includes('<metadata key="weight" value="3.58"/>'), sliceInfo)
check('slice_info lists each tool used', sliceInfo.includes('<filament id="2" type="PETG" color="#00FF00" used_m="0.20"'))
check('the content types declare .gcode', strFromU8(members['[Content_Types].xml']).includes('Extension="gcode"'))

const { objects, project } = await parse3MFProject(bytes, 'plates.gcode.3mf')
eq('read back: no objects', objects.length, 0)
eq('read back: the sliced plates, in order', project.gcodePlates?.map(plate => plate.index), [0, 2])
check('read back: G-code byte-identical', project.gcodePlates?.every((plate, at) => plate.gcode === plates[at].gcode))
eq('read back: the settings come along', project.settings?.filament_type, ['PLA', 'PETG'])

// ---- An ordinary project is not a print job ----
const tetra = Float32Array.from([0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 0, 10, 0, 0, 0, 0, 10, 0, 0, 0, 0, 10, 0, 0, 0, 10, 10, 0, 0, 0, 10, 0, 0, 0, 10])
const projectBytes = await write3MFProject([{ name: 'tetra', tris: tetra, faceCount: 4, plate: 0, extruder: 1 }], {}, { plateCount: 1 })
const ordinary = await parse3MFProject(projectBytes, 'model.3mf')
eq('a project reads back with gcodePlates null', ordinary.project.gcodePlates, null)
eq('a project still reads its object', ordinary.objects.length, 1)

// A gcode_file pointing at a member that is not there is not a print job either.
const broken = { ...members }
delete broken['Metadata/plate_1.gcode']; delete broken['Metadata/plate_3.gcode']
const { zipSync } = await import('three/examples/jsm/libs/fflate.module.js')
const brokenRead = await parse3MFProject(zipSync(broken), 'broken.gcode.3mf').catch(error => ({ error }))
check('gcode_file without its member is not a print job', brokenRead.error || brokenRead.project?.gcodePlates === null)

try { await writeGcode3MF([], settings); check('nothing to export throws', false) }
catch { check('nothing to export throws', true) }

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
console.log('\nall .gcode.3mf checks passed')
