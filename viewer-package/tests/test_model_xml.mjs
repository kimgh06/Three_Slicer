// The 3mf read path that replaced the string + regex reader: the byte scanner (model_xml.js), the zip member reader
//  (zip_entries.js), and the per-item jobs parse3MFProject hands to the parse worker's helpers. Each must give what
//  the reader before it gave, because the triangles reach the kernel and the paint reaches the selector.
//   Run: node viewer-package/tests/test_model_xml.mjs
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { zipSync, unzipSync, strToU8 } from 'three/examples/jsm/libs/fflate.module.js'
import { numberAt, scanModelXml, indexModelXml, createModelIndexer } from '../src/core/model_xml.js'
import { zipEntries, zipEntriesFromBlob, entryData, inflateEntry, inflateEntryProgressively, inflateEntryInBatches, inflateSink } from '../src/core/zip_entries.js'
import { parse3MFProject, runItemJob, scanKeptObjects, runKeptItemJob, createKept } from '../src/core/parse_3mf.js'

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

console.log('\n[meshes held by the root part: its objects go to the jobs as spans]')
const projectWithParts = project
{
  // MakerWorld keeps every mesh in 3D/3dmodel.model. The parse indexes that part and sends each job the spans of the
  //  objects its items read; read in-thread, the same file is built from the whole part. Both must give the same objects.
  const mesh = (id, at, extra = '') => `<object id="${id}" type="model"><mesh><vertices><vertex x="${at}" y="0" z="0"/><vertex x="${at + 1}" y="0" z="0"/><vertex x="${at}" y="1" z="0"/><vertex x="${at}" y="0" z="1"/></vertices><triangles><triangle v1="0" v2="1" v3="2"${extra}/><triangle v1="0" v2="2" v3="3"/><triangle v1="0" v2="3" v3="1"/></triangles></mesh></object>`
  const rootXml = (build) => `<model><resources>
   ${mesh(10, 0)}
   ${mesh(11, 5)}
   <object id="12"><components><component objectid="10" transform="1 0 0 0 1 0 0 0 1 0 0 2"/><component objectid="11"/></components></object>
   ${mesh(14, 9, ' paint_color="8"')}
   ${mesh(17, 13)}
   ${mesh(18, 17)}
   <object id="16"><components><component objectid="17"/><component p:path="/3D/Objects/a.model" objectid="2"/></components></object>
   <object id="19" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/></vertices><triangles></triangles></mesh></object>
  </resources>${build}</model>`
  const build = '<build><item objectid="10"/><item objectid="10" transform="1 0 0 0 1 0 0 0 1 40 0 0"/><item objectid="12"/><item objectid="14"/><item objectid="11"/><item objectid="16"/></build>'
  const aModel = `<model><resources>${mesh(1, 30)}<object id="2"><components><component p:path="/3D/3dmodel.model" objectid="18"/></components></object></resources></model>`
  const archive = (rootText) => zipSync({
    '_rels/.rels': strToU8('<Relationships><Relationship Target="/3D/3dmodel.model" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'),
    '3D/3dmodel.model': strToU8(rootText),
    '3D/Objects/a.model': strToU8(aModel),
  })
  const rootBytes = encode(rootXml(build))
  const index = indexModelXml(rootBytes), whole = scanModelXml(rootBytes)
  check('the index finds every object and item the full read does', JSON.stringify([...index.objects.keys()]) === JSON.stringify([...whole.objects.keys()]) && JSON.stringify(index.items) === JSON.stringify(whole.items))
  check('the index reads components as the full read does', JSON.stringify(index.objects.get('12').components) === JSON.stringify(whole.objects.get('12').components))
  const spanAlone = (id) => scanModelXml(rootBytes.subarray(index.objects.get(id).start, index.objects.get(id).end)).objects.get(id)
  check('an object\'s span read alone is the object', ['10', '14', '17'].every((id) => JSON.stringify(Array.from(spanAlone(id).mesh.tris)) === JSON.stringify(Array.from(whole.objects.get(id).mesh.tris)) && JSON.stringify(Array.from(spanAlone(id).mesh.verts)) === JSON.stringify(Array.from(whole.objects.get(id).mesh.verts))))

  const project = archive(rootXml(build))
  const sent = []
  const pool = async (jobs) => {
    sent.push(...jobs)
    return Promise.all(jobs.map(runItemJob))
  }
  const viaPool = await parse3MFProject(project, 'p', { runJobs: pool })
  const inThread = await parse3MFProject(project, 'p')
  check('the root\'s items are built in jobs, not in-thread', sent.length > 0 && sent.some((job) => job.members.some((member) => member.partial)))
  check('instances and a component object share the job of the objects they read (10, 10, 12, 11)',
    sent.some((job) => JSON.stringify(job.items.map((item) => item.index).sort()) === '[0,1,2,4]'))
  check('a job is sent the spans of its objects, not the whole root part', sent.every((job) => job.members.every((member) => !member.partial || member.data.length < rootBytes.length)))
  check('pool-built objects equal the in-thread ones, triangles and paint included', shape(viaPool) === shape(inThread), `${viaPool.objects.length} vs ${inThread.objects.length}`)
  check('a part pointing back to a root object the job was not sent is built in-thread (item 16 reaches 18 through a.model)',
    viaPool.objects.length === 6 && viaPool.objects[5].tris.length === 2 * 27)
  // A pool as the parse worker's helpers are one, in-process: each slot keeps what it scanned. `fail` breaks a slot's
  //  scans or builds, which must leave the result as it is (the items go to the in-thread fallback).
  const makePool = (size, fail = {}) => {
    const kept = Array.from({ length: size }, () => createKept())
    const used = { scans: 0, builds: 0, released: 0, readyTaken: 0, batches: 0 }
    // The parse worker's pool inflates on one helper and receives batches (inflateSink); the same two halves, in process.
    const inflate = async (data, entry, onBytes) => {
      const sink = inflateSink(entry, onBytes)
      await inflateEntryInBatches(data, entry, (batch) => { used.batches++; sink.push(batch.slice()) }, 256)
      return sink.finish()
    }
    return {
      used, size, inflate,
      scan: async (slot, data, options) => {
        if (fail.scan === slot) throw new Error('scan failed')
        used.scans++
        scanKeptObjects(data, kept[slot], options)
      },
      build: async (slot, job) => {
        if (fail.build === slot) throw new Error('build failed')
        used.builds++
        const result = await runKeptItemJob(job, kept[slot])
        used.readyTaken += result.items.filter((item) => item.prebuilt).length
        return result
      },
      release: () => { used.released++; for (const slot of kept) { slot.objects.clear(); slot.ready.clear() } },
    }
  }
  const pooled = makePool(3)
  const viaKept = await parse3MFProject(project, 'p', { pool: pooled, runJobs: pool })
  // With pieces small enough for this project, objects stream in pieces; a scan that fails on an object's FIRST piece
  //  (the rest of its pieces still succeed) must leave it unkept and built elsewhere, not kept from a stale state.
  const piecePool = (fail = {}) => {
    const base = makePool(3)
    const seen = new Map()
    const scan = base.scan
    base.scan = async (slot, data, options) => {
      const nth = (seen.get(options.objectId) ?? 0) + 1
      seen.set(options.objectId, nth)
      if (fail.objectId === options.objectId && nth === fail.piece) throw new Error('piece scan failed')
      return scan(slot, data, options)
    }
    base.seen = seen
    return base
  }
  const piecewise = piecePool()
  const viaPieces = await parse3MFProject(project, 'p', { pool: piecewise, runJobs: pool, pieceBytes: 64 })
  check('with small pieces the objects stream in several pieces', [...piecewise.seen.values()].some((count) => count > 1), JSON.stringify([...piecewise.seen]))
  check('and the result is the in-thread one', shape(viaPieces) === shape(inThread))
  const firstPieceFails = piecePool({ objectId: '14', piece: 1 })
  check('a failure on an object\'s first piece leaves the result as it is', shape(await parse3MFProject(project, 'p', { pool: firstPieceFails, runJobs: pool, pieceBytes: 64 })) === shape(inThread))
  const lastPieceFails = piecePool({ objectId: '14', piece: 2 })
  check('so does one on a later piece', shape(await parse3MFProject(project, 'p', { pool: lastPieceFails, runJobs: pool, pieceBytes: 64 })) === shape(inThread))
  check('with a pool the root\'s meshes are scanned as they inflate and their items built where they were kept',
    pooled.used.scans >= 5 && pooled.used.builds >= 1 && pooled.used.released === 1, JSON.stringify(pooled.used))
  check('pool-kept objects equal the in-thread ones', shape(viaKept) === shape(inThread))
  check('the root was inflated through the pool, in batches', pooled.used.batches > 1, String(pooled.used.batches))
  check('items placing an object as it stands take the build made at scan time (10, 14, 11), the translated instance and the component objects do not', pooled.used.readyTaken === 3, String(pooled.used.readyTaken))
  check('a failed scan changes nothing (its object travels as a span)', shape(await parse3MFProject(project, 'p', { pool: makePool(3, { scan: 0 }), runJobs: pool })) === shape(inThread))
  check('a failed build changes nothing (its items are built in-thread)', shape(await parse3MFProject(project, 'p', { pool: makePool(3, { build: 0 }), runJobs: pool })) === shape(inThread))
  const withParts = await parse3MFProject(projectWithParts, 'p', { pool: makePool(3), runJobs: pool })
  check('meshes kept in other parts still go through the part jobs with a pool', shape(withParts) === shape(await parse3MFProject(projectWithParts, 'p')))
  const bakedKept = await parse3MFProject(project, 'p', { pool: makePool(2), runJobs: pool, bake: true })
  const bakedThread = await parse3MFProject(project, 'p', { bake: true })
  check('bake: pool-built scene geometry equals the in-thread one', JSON.stringify(bakedKept.objects.map((o) => Array.from(o.baked.localPos))) === JSON.stringify(bakedThread.objects.map((o) => Array.from(o.baked.localPos))))

  // A part read in pieces cut between tags, each continuing the object the last one ended inside, gives what the whole
  //  part gives — what a helper does with the pieces streamRoot sends it while the inflater is still on the object.
  {
    const cuts = []
    for (let at = 0; at < rootBytes.length; at = cuts[cuts.length - 1]) {
      const next = rootBytes.indexOf(62, at + 700) + 1   // the next '>' at least 700 bytes on: cuts inside vertices and triangles
      if (next <= 0 || next >= rootBytes.length) { cuts.push(rootBytes.length); break }
      cuts.push(next)
    }
    const pieced = new Map()
    let from = 0, openObject = null
    for (const cut of cuts) {
      const scanned = scanModelXml(rootBytes.subarray(from, cut), openObject)
      for (const [id, object] of scanned.objects) pieced.set(id, object)
      openObject = scanned.openObject
      from = cut
    }
    const same = [...whole.objects.keys()].every((id) => {
      const a = whole.objects.get(id), b = pieced.get(id)
      if (!b) return false
      if (!a.mesh) return JSON.stringify(a) === JSON.stringify(b)
      return b.mesh && JSON.stringify(Array.from(a.mesh.verts)) === JSON.stringify(Array.from(b.mesh.verts)) && JSON.stringify(Array.from(a.mesh.tris)) === JSON.stringify(Array.from(b.mesh.tris)) && JSON.stringify([...a.mesh.paint.color]) === JSON.stringify([...b.mesh.paint.color])
    })
    check(`a part read in ${cuts.length} pieces, resumed object by object, is the part`, cuts.length > 3 && same && pieced.size === whole.objects.size, `${cuts.length} pieces, ${pieced.size} objects`)
    const kept = createKept()
    const span = index.objects.get('10')
    const middle = rootBytes.indexOf(62, span.start + 120) + 1   // a tag boundary inside the mesh
    scanKeptObjects(rootBytes.slice(span.start, middle), kept, { objectId: '10', complete: false })
    check('a kept object stays open between pieces', kept.open.has('10') && kept.objects.size === 0)
    scanKeptObjects(rootBytes.slice(middle, span.end), kept, { objectId: '10', complete: true })
    check('and is kept, and pre-built, after the last one', !kept.open.has('10') && kept.objects.has('10') && kept.ready.has('10')
      && JSON.stringify(Array.from(kept.objects.get('10').mesh.tris)) === JSON.stringify(Array.from(whole.objects.get('10').mesh.tris)))
  }

  // The index over a part still arriving gives what the index over the whole part gives, however it is chunked.
  for (const chunk of [1, 7, 64, 1000]) {
    const indexer = createModelIndexer(rootBytes)
    for (let received = chunk; ; received += chunk) { indexer.advance(Math.min(received, rootBytes.length)); if (received >= rootBytes.length) break }
    const result = indexer.finish()
    check(`a part indexed in ${chunk}-byte steps is indexed as a whole`, JSON.stringify([...result.objects]) + JSON.stringify(result.items) === JSON.stringify([...index.objects]) + JSON.stringify(index.items))
  }
  const deflated = zipEntries(project).get('3D/3dmodel.model')
  let calls = 0
  const progressive = await inflateEntryProgressively(entryData(project, deflated), deflated, () => calls++)
  check('a member inflated progressively is the member inflated whole', calls >= 1 && Buffer.from(progressive).equals(Buffer.from(await inflateEntry(entryData(project, deflated), deflated))))

  // The same archive as a Blob: read as slices, the big part streamed from the Blob into the pool's inflater.
  const asBlob = new Blob([project])
  const fromBlobEntries = await zipEntriesFromBlob(asBlob)
  check('zipEntriesFromBlob lists what zipEntries lists', JSON.stringify([...fromBlobEntries]) === JSON.stringify([...zipEntries(project)]))
  check('a Blob parses as its bytes do, in-thread', shape(await parse3MFProject(asBlob, 'p')) === shape(inThread))
  const blobPool = makePool(3)
  check('a Blob parses as its bytes do, through the pool', shape(await parse3MFProject(asBlob, 'p', { pool: blobPool, runJobs: pool })) === shape(inThread) && blobPool.used.batches > 1)
  check('a Blob with parts parses as its bytes do', shape(await parse3MFProject(new Blob([projectWithParts]), 'p', { pool: makePool(3), runJobs: pool })) === shape(await parse3MFProject(projectWithParts, 'p')))
  check('inflateEntry reads a Blob slice', Buffer.from(await inflateEntry(asBlob.slice(deflated.dataStart, deflated.dataStart + deflated.compressedSize), deflated)).equals(Buffer.from(progressive)))

  const noBuild = archive(rootXml(''))
  const noBuildPool = await parse3MFProject(noBuild, 'p', { runJobs: pool })
  const noBuildThread = await parse3MFProject(noBuild, 'p')
  check('with no build items every mesh object with a triangle is one (10 11 14 17 18; not the components 12 16 or the degenerate 19)',
    noBuildThread.objects.length === 5 && shape(noBuildPool) === shape(noBuildThread), String(noBuildThread.objects.length))
}

if (failures) console.log(`\n${failures} CHECK(S) FAILED`)
else console.log('\nALL MODEL XML CHECKS PASSED')
assert.equal(failures, 0)
