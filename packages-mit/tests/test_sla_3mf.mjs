import { strict as assert } from 'node:assert'
import { strToU8, unzipSync, zipSync } from 'three/examples/jsm/libs/fflate.module.js'
import { parse3MFProject } from './src/core/parse_3mf.js'
import { write3MFProject } from './src/core/write_3mf.js'

const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
 <resources><object id="42" type="model"><mesh><vertices>
  <vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/>
  <vertex x="2" y="0" z="0"/><vertex x="3" y="0" z="0"/><vertex x="2" y="1" z="0"/>
 </vertices><triangles><triangle v1="0" v2="1" v3="2"/><triangle v1="3" v2="4" v3="5"/></triangles></mesh></object></resources>
 <build><item objectid="42" transform="1 0 0 0 1 0 0 0 1 10 20 30"/></build>
</model>`

const config = `<?xml version="1.0" encoding="UTF-8"?><config>
 <object id="42"><metadata key="name" value="sla-part"/>
  <volume firstid="0" lastid="0"><metadata key="volume_type" value="ModelPart"/></volume>
  <volume firstid="1" lastid="1"><metadata key="volume_type" value="SupportBlocker"/></volume>
 </object>
</config>`

const archive = (points, holes) => zipSync({
  '3D/3dmodel.model': strToU8(model),
  'Metadata/model_settings.config': strToU8(config),
  'Metadata/Slic3r_PE_sla_support_points.txt': strToU8(points),
  'Metadata/Slic3r_PE_sla_drain_holes.txt': strToU8(holes),
})

// Given: Prusa SLA metadata attached to object 42 and a translated build item.
// When: the project is parsed. Then: records attach to that object in baked coordinates, while its blocker is
// separated from printable geometry and never appears as FDM facet paint.
const parsed = await parse3MFProject(archive(
  'support_points_format_version=1\nobject_id=1|1 2 3 0.25 2 4 5 6 0.3 1\n',
  'drain_holes_format_version=1\nobject_id=1|1 2 2 0 0 -1 0.8 5\n',
), 'sla')
assert.equal(parsed.objects.length, 1)
assert.equal(parsed.objects[0].objectid, '42')
assert.equal(parsed.objects[0].tris.length, 9)
assert.equal(parsed.objects[0].paint, null)
assert.deepEqual(parsed.objects[0].sla.supportPoints, [
  { position: [11, 22, 33], radius: 0.25, type: 'manual' },
  { position: [14, 25, 36], radius: 0.3, type: 'island' },
])
assert.deepEqual(parsed.objects[0].sla.drainHoles, [
  { position: [11, 22, 31], normal: [0, 0, -1], radius: 0.8, height: 4 },
])
assert.equal(parsed.objects[0].sla.modifierVolumes[0].kind, 'blocker')
assert.deepEqual([...parsed.objects[0].sla.modifierVolumes[0].tris.slice(0, 3)], [12, 20, 30])
assert.deepEqual(parsed.project.sla.capabilities, {
  manualSupportPoints: 'prepared-roundtrip',
  drainHoles: 'preserved-unsupported',
  modifierVolumes: 'prepared-mask-filtering',
  uiEditing: 'unavailable',
})

// Given: malformed record counts. When: parsed. Then: each malformed object record is replaced by an empty set,
// with a machine-readable issue; no truncated record leaks into the following object.
const malformed = await parse3MFProject(archive(
  'support_points_format_version=1\nobject_id=1|1 2 3 0.25\n',
  'drain_holes_format_version=1\nobject_id=1|1 2 3 0 0 1 0.8\n',
), 'malformed')
assert.deepEqual(malformed.objects[0].sla.supportPoints, [])
assert.deepEqual(malformed.objects[0].sla.drainHoles, [])
assert.deepEqual(malformed.project.sla.issues.map(issue => issue.code), ['SLA_SUPPORT_POINT_COUNT', 'SLA_DRAIN_HOLE_COUNT'])

// Given: prepared SLA data, including an enforcer volume replacing the imported blocker.
// When: it is saved and read again. Then: dedicated metadata members and volume type round-trip deterministically.
const prepared = [{
  name: 'prepared', tris: parsed.objects[0].tris, faceCount: 1, plate: 0,
  sla: {
    supportPoints: parsed.objects[0].sla.supportPoints,
    drainHoles: parsed.objects[0].sla.drainHoles,
    modifierVolumes: [{ ...parsed.objects[0].sla.modifierVolumes[0], kind: 'enforcer' }],
  },
}]
const bytes = await write3MFProject(prepared, {}, { plateCount: 1 })
const files = unzipSync(bytes)
assert.ok(files['Metadata/Slic3r_PE_sla_support_points.txt'])
assert.ok(files['Metadata/Slic3r_PE_sla_drain_holes.txt'])
assert.match(new TextDecoder().decode(files['Metadata/model_settings.config']), /volume_type" value="SupportEnforcer"/)
const roundTrip = await parse3MFProject(bytes, 'roundtrip')
assert.deepEqual(roundTrip.objects[0].sla.supportPoints, prepared[0].sla.supportPoints)
assert.deepEqual(roundTrip.objects[0].sla.drainHoles, prepared[0].sla.drainHoles)
assert.equal(roundTrip.objects[0].sla.modifierVolumes[0].kind, 'enforcer')

console.log('test_sla_3mf: metadata members, transforms/object ids, malformed counts, capability state, and modifier replacement passed')
