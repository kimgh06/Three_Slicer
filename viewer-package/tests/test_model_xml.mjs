// The 3mf read path that replaced the string + regex reader: the byte scanner (model_xml.js), the zip member reader
//  (zip_entries.js), and the per-item jobs parse3MFProject hands to the parse worker's helpers. Each must give what
//  the reader before it gave, because the triangles reach the kernel and the paint reaches the selector.
//   Run: node viewer-package/tests/test_model_xml.mjs
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { zipSync, unzipSync, strToU8 } from 'three/examples/jsm/libs/fflate.module.js'
import { numberAt, scanModelXml } from '../src/core/model_xml.js'
import { zipEntries, entryData, inflateEntry } from '../src/core/zip_entries.js'
import { parse3MFProject } from '../src/core/parse_3mf.js'

let failures = 0
const check = (label, condition, detail = '') => {
  if (condition) console.log(`  ok: ${label}`)
  else {
    let suffix = ''
    if (detail) suffix = ' — ' + detail
    console.log(`  FAIL: ${label}${suffix}`); failures++
  }
}
const encode = (text) => new TextEncoder().encode(text)

console.log('[numberAt: the value +text gives]')
const tricky = ['', ' ', '0', '-0', '+0', '-0.0', '1', '+1.5', '-1.5', '1.', '.5', '-.5', '.', '-', '+', '1e3', '1E-3', '-2.5e+2',
  ' 1', '1 ', '0x10', 'abc', '1.2.3', 'Infinity', '-Infinity', 'NaN', '9007199254740991', '9007199254740993',
  '123456789012345678', '0.1234567890123456789012', '0.12345678901234567890123', '1' + '0'.repeat(30),
  '3.4028235e38', '0.1', '0.2', '0.3', '-122.71728515625', '00012.5000', '1.7976931348623157e308']
let trickyBad = []
for (const text of tricky) {
  const bytes = encode(text)
  const got = numberAt(bytes, 0, bytes.length), want = +text
  if (!Object.is(got, want)) trickyBad.push(`${JSON.stringify(text)}: ${got} vs ${want}`)
}
check(`${tricky.length} edge cases equal +text`, !trickyBad.length, trickyBad.slice(0, 3).join('; '))
let seed = 11
const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
let randomBad = 0
for (let k = 0; k < 20000; k++) {
  const digits = 1 + Math.floor(random() * 17)
  let text = String(Math.floor(random() * 10 ** Math.min(digits, 15)))
  const fraction = Math.floor(random() * 12)
  if (fraction) text += '.' + String(Math.floor(random() * 10 ** fraction)).padStart(fraction, '0')
  if (random() < 0.5) text = '-' + text
  const bytes = encode(text)
  if (!Object.is(numberAt(bytes, 0, bytes.length), +text)) randomBad++
}
check('20000 random decimals equal +text', randomBad === 0, `${randomBad} differ`)

console.log('\n[scanModelXml: the tag shapes the regex reader accepted]')
const xml = `<?xml version="1.0"?>
<model unit="millimeter" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">
 <!-- <object id="99"><mesh><vertices><vertex x="1" y="1" z="1"/></vertices></mesh></object> -->
 <resources>
  <object id="1" type="model"><mesh><vertices>
   <vertex x="0" y="0" z="0"/>
   <vertex  z="3"   x="1.5" y="-2"/>
   <vertex x="0" y="1"/>
   <vertex x='9' y="2" z="2.25"/>
  </vertices><triangles>
   <triangle v1="0" v2="1" v3="2"/>
   <triangle v1="1" v2="2" v3="3" paint_color="0C"/>
   <triangle paint_supports="4" v3="0" v1="3" v2="1" />
   <triangle v1="2" v2="3" v3="0" paint_seam="" paint_fuzzy_skin="8"/>
  </triangles></mesh></object>
  <object type="model"><mesh><vertices><vertex x="5" y="5" z="5"/></vertices></mesh></object>
  <object id="2"><components>
   <component p:path="/3D/Objects/part.model" objectid="7" transform="1 0 0 0 1 0 0 0 1 10 20 30"/>
   <component objectid="1" path="local.model"/>
   <component objectid="1" transform="1 0 0"/>
  </components></object>
  <object id="3"><mesh><vertices><vertex x="1" y="1" z="1"/><vertex x="2" y="2" z="2"/></vertices>
   <triangles><triangle v1="0" v2="1" v3="0"/></triangles></mesh></object>
 </resources>
 <build>
  <item objectid="2" transform="1 0 0 0 1 0 0 0 1 5 5 0"/>
  <item objectid="1" p:path="/3D/other.model"/>
  <item transform="1 0 0 0 1 0 0 0 1 0 0 0"/>
 </build>
 <build><item objectid="3"/></build>
</model>`
const scanned = scanModelXml(encode(xml))
const one = scanned.objects.get('1')
check('a commented-out object is not read', !scanned.objects.has('99'))
check('an object without an id is skipped', scanned.objects.size === 3)
check('vertices in any attribute order and spacing; a missing one reads 0; a single-quoted one is not read',
  JSON.stringify(Array.from(one.mesh.verts)) === JSON.stringify([0, 0, 0, 1.5, -2, 3, 0, 1, 0, 0, 2, 2.25]))
check('triangle indices in any attribute order', JSON.stringify(Array.from(one.mesh.tris)) === JSON.stringify([0, 1, 2, 1, 2, 3, 3, 1, 0, 2, 3, 0]))
check('paint on the triangle tag, before or after the indices; an empty value is not paint',
  JSON.stringify([...one.mesh.paint.color]) === '[[1,"0C"]]' && JSON.stringify([...one.mesh.paint.supports]) === '[[2,"4"]]'
  && one.mesh.paint.seam.size === 0 && JSON.stringify([...one.mesh.paint.fuzzy]) === '[[3,"8"]]')
const two = scanned.objects.get('2')
check('components: p:path before path, transform parsed, a malformed transform is identity',
  JSON.stringify(two.components) === JSON.stringify([
    { objectid: '7', path: '/3D/Objects/part.model', transform: [1, 0, 0, 0, 1, 0, 0, 0, 1, 10, 20, 30] },
    { objectid: '1', path: 'local.model', transform: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0] },
    { objectid: '1', path: null, transform: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0] }]))
check('a mesh of fewer than three vertices is no mesh', scanned.objects.get('3').mesh === null)
check('items come from the first <build> only, and need an objectid',
  JSON.stringify(scanned.items) === JSON.stringify([
    { objectid: '2', path: null, transform: [1, 0, 0, 0, 1, 0, 0, 0, 1, 5, 5, 0] },
    { objectid: '1', path: '/3D/other.model', transform: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0] }]))

console.log('\n[zipEntries + inflateEntry: the bytes fflate gives]')
const archive = zipSync({
  'a.txt': [strToU8('stored text'), { level: 0 }],
  '3D/b.model': [strToU8('<model>' + 'x'.repeat(100000) + '</model>'), { level: 6 }],
  'empty.txt': [new Uint8Array(0), { level: 6 }],
})
const listed = zipEntries(archive)
const reference = unzipSync(archive)
let inflateBad = []
for (const [name, entry] of listed) {
  const inflated = await inflateEntry(entryData(archive, entry), entry)
  if (Buffer.compare(Buffer.from(inflated), Buffer.from(reference[name]))) inflateBad.push(name)
}
check('every member of a stored + deflated archive inflates to fflate\'s bytes', listed.size === 3 && !inflateBad.length, inflateBad.join())
const cube = readFileSync(new URL('../testing_files/cube.3mf', import.meta.url))
const cubeEntries = zipEntries(cube), cubeReference = unzipSync(new Uint8Array(cube))
let cubeBad = 0
for (const [name, entry] of cubeEntries) if (Buffer.compare(Buffer.from(await inflateEntry(entryData(cube, entry), entry)), Buffer.from(cubeReference[name]))) cubeBad++
check('testing_files/cube.3mf inflates member for member', cubeEntries.size === Object.keys(cubeReference).length && cubeBad === 0)
check('a buffer that is not a zip is not listed (the fflate path reads it)', zipEntries(encode('not a zip at all, just text')) === null)

console.log('\n[parse3MFProject: an item built by a job equals the same item built in-thread]')
const part = (id, offset, paint = '') => `<model><resources><object id="${id}"><mesh><vertices>
  <vertex x="${offset}" y="0" z="0"/><vertex x="${offset + 1}" y="0.1" z="0"/><vertex x="${offset}" y="1.3" z="0.7"/><vertex x="${offset}" y="0" z="2.05"/>
 </vertices><triangles><triangle v1="0" v2="1" v3="2"${paint}/><triangle v1="0" v2="2" v3="3"/><triangle v1="0" v2="3" v3="1"/></triangles></mesh></object>
 <object id="9"><components><component p:path="/3D/Objects/deep.model" objectid="4"/></components></object></resources></model>`
const project = zipSync({
  '_rels/.rels': strToU8('<Relationships><Relationship Target="/3D/3dmodel.model" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'),
  '3D/3dmodel.model': strToU8(`<model><resources>
   <object id="1"><components><component p:path="/3D/Objects/a.model" objectid="1" transform="0.5 0 0 0 2 0 0 0 1 3.25 -7 1"/></components></object>
   <object id="2"><components><component p:path="/3D/Objects/b.model" objectid="1"/><component p:path="/3D/Objects/a.model" objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 5"/></components></object>
   <object id="3"><components><component p:path="/3D/Objects/c.model" objectid="1"/></components></object>
   <object id="5"><components><component p:path="/3D/Objects/a.model" objectid="9"/></components></object>
  </resources><build><item objectid="1"/><item objectid="2" transform="1 0 0 0 1 0 0 0 1 100 0 0"/><item objectid="3"/><item objectid="5"/></build></model>`),
  '3D/Objects/a.model': strToU8(part(1, 0, ' paint_color="8"')),
  '3D/Objects/b.model': strToU8(part(1, 10)),
  '3D/Objects/c.model': strToU8(part(1, 20, ' paint_supports="4"')),
  '3D/Objects/deep.model': strToU8(part(4, 30)),
})
let jobsRun = 0, jobItems = 0
const viaJobs = await parse3MFProject(project, 'p', { runJobs: async (jobs) => { jobsRun = jobs.length; jobItems = jobs.reduce((s, j) => s + j.items.length, 0); return Promise.all(jobs.map(async (job) => (await import('../src/core/parse_3mf.js')).runItemJob(job))) } })
const inThread = await parse3MFProject(project, 'p', { runJobs: async (jobs) => jobs.map(job => ({ items: job.items.map(item => ({ index: item.index, local: true })) })) })
const shape = (result) => JSON.stringify(result.objects.map(o => ({ ...o, tris: Array.from(o.tris), paint: o.paint && Object.fromEntries(Object.entries(o.paint).map(([k, v]) => [k, [...v]])) })))
check('items sharing a part go to one job (a.model: items 1, 2 and 4 -> 2 jobs for 4 items)', jobsRun === 2 && jobItems === 4, `${jobsRun} jobs, ${jobItems} items`)
check('the job-built objects equal the in-thread ones, triangles and paint included', shape(viaJobs) === shape(inThread))
check('a component reaching a part the job was not sent is still built (deep.model, via the in-thread fallback)',
  viaJobs.objects.length === 4 && viaJobs.objects[3].tris.length === 27)
check('paint is rebased onto the item\'s triangle numbering', JSON.stringify([...viaJobs.objects[1].paint.color]) === '[[3,"8"]]')
const baked = await parse3MFProject(project, 'p', { bake: true })
check('bake: true returns the scene geometry with each object', baked.objects.every(o => o.baked && o.baked.localPos.length === o.tris.length && o.baked.sphere))

if (failures) console.log(`\n${failures} CHECK(S) FAILED`)
else console.log('\nALL MODEL XML CHECKS PASSED')
assert.equal(failures, 0)
