// 3MF parser — replaces three's ThreeMFLoader.
// Why: ThreeMFLoader does not understand the **production extension** (`p:path` referencing external .model parts).
//  Nearly every 3mf written by OrcaSlicer/BambuStudio/PrusaSlicer uses it (3D/3dmodel.model holds only component
//  shells, the real meshes live in 3D/Objects/*.model), so the loader returned an empty Group and "no 3MF mesh" errors.
// We only need triangles (materials/textures/colors are irrelevant), so we go straight from zip -> .model XML -> triangle stream.
// The .model parts are read from their bytes (model_xml.js); the metadata is small and read with the regexes below.
// With no DOMParser dependency it is testable under node as-is.
import { unzipSync, unzip } from 'three/examples/jsm/libs/fflate.module.js'
import { SLA_POINT_RADIUS } from './viewer_defaults.js'
import { scanModelXml, indexModelXml, createModelIndexer, parseTransform, PAINT_ATTRS, emptyPaint, paintIsEmpty } from './model_xml.js'
import { zipEntries, zipEntriesFromBlob, entryData, inflateEntry, inflateEntryProgressively } from './zip_entries.js'
import { bakeModel } from './bake_local.js'

export { emptyPaint, paintIsEmpty }

// The fallback for an archive zipEntries() cannot list (zip64, encryption): fflate's async entry point spreads the
//  members over a Web Worker pool; unzipSync does them one after another. `unzip` needs the `Worker` global and throws
//  SYNCHRONOUSLY without it, which is every non-browser caller and any environment that refuses nested workers —
//  both failure shapes land on the same synchronous path.
function unzipAll(bytes) {
  return new Promise((resolve) => {
    let settled = false
    const done = (files) => { if (!settled) { settled = true; resolve(files) } }
    try {
      unzip(bytes, (err, files) => { if (err) done(unzipSync(bytes)); else done(files) })
    } catch {
      done(unzipSync(bytes))
    }
  })
}

const IDENT = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]

// A 3mf transform is 4x3 row-major (row-vector convention, translation in the last row). combine(a,b) = a first, then b.
function mul(a, b) {
  const o = new Array(12)
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 3; c++) {
      let translation = 0
      if (r === 3) translation = b[9 + c]
      o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c] + translation
    }
  }
  return o
}

const A_RE = {}
function attr(tag, name) {
  const re = A_RE[name] || (A_RE[name] = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`))
  return re.exec(tag)?.[1] ?? null
}

function normPath(p) {
  const s = String(p).replace(/^\/+/, '')
  return s.includes('%') ? decodeURIComponent(s) : s
}

// ---- Metadata/*.config -------------------------------------------------------------------------------------
// A slicer-written 3mf is a whole project, not just geometry: alongside the meshes it carries the preset the
//  creator sliced with, the per-object state, and the plate layout. Everything here is optional — a 3mf exported
//  by a CAD tool has none of it, and the geometry path must not care.

// <config><object id="1"><metadata key="extruder" value="2"/>…</object><plate>…</plate></config>
// Attribute-only tags again (same reasoning as the .model parsing above), so regexes are enough.
function metadataPairs(fragment) {
  const out = {}
  for (const tag of fragment.match(/<metadata\b[^>]*>/g) || []) {
    const key = attr(tag, 'key')
    if (key) out[key] = attr(tag, 'value') ?? ''
  }
  return out
}

// A <part>'s subtype -> the modifier kind it is, for the two the viewer keeps (support painting's states); the
//  printable kind is normal_part. OrcaSlicer/BambuStudio write a support enforcer or blocker added to an object this
//  way: a part of the object, its mesh a component of it in 3D/Objects/*.model, with no triangle range (the older
//  <volume firstid lastid> form has one).
const PART_MODIFIER_KINDS = { support_enforcer: 'enforcer', support_blocker: 'blocker' }

function parseModelSettings(xml) {
  const objects = new Map()   // 3mf object id -> {name, extruder, …} (the <metadata> of that object)
  const volumes = new Map()
  const partVolumes = new Map()   // object id -> { partIds, records }: modifier parts, ranged by the parts' face counts
  const OBJ_RE = /<object\b([^>]*)>([\s\S]*?)<\/object>/g
  let m
  while ((m = OBJ_RE.exec(xml))) {
    const id = attr(m[1], 'id')
    // Only the object's OWN metadata: <part> children carry their own and would otherwise overwrite it.
    if (id) {
      const body = m[2]
      objects.set(id, metadataPairs(body.replace(/<(?:part|volume)\b[\s\S]*?<\/(?:part|volume)>/g, '')))
      const records = []
      for (const volume of body.match(/<volume\b[\s\S]*?<\/volume>/g) || []) {
        const type = metadataPairs(volume).volume_type
        const kind = type === 'SupportBlocker' ? 'blocker' : type === 'SupportEnforcer' ? 'enforcer' : null
        const firstTriangle = Number(attr(volume, 'firstid'))
        const lastTriangle = Number(attr(volume, 'lastid'))
        if (kind && Number.isInteger(firstTriangle) && Number.isInteger(lastTriangle) && firstTriangle >= 0 && lastTriangle >= firstTriangle)
          records.push({ firstTriangle, lastTriangle, kind })
      }
      if (records.length) volumes.set(id, records)
      // <part> form: each part's triangles follow the ones before it, in the order the parts are listed, which is the
      //  order of the object's components. The ranges come from the parts' face counts; parse3MFProject uses them
      //  only when the components are exactly these parts in this order.
      const parts = (body.match(/<part\b[\s\S]*?<\/part>/g) || []).map((part) => ({
        id: attr(part, 'id'), subtype: attr(part, 'subtype'), faces: Number(attr(part.replace(/^<part\b[^>]*>/, ''), 'face_count')),
      }))
      if (parts.some((part) => PART_MODIFIER_KINDS[part.subtype]) && parts.every((part) => part.id && Number.isInteger(part.faces) && part.faces >= 0)) {
        const partRecords = []
        let first = 0
        for (const part of parts) {
          const kind = PART_MODIFIER_KINDS[part.subtype]
          if (kind && part.faces) partRecords.push({ firstTriangle: first, lastTriangle: first + part.faces - 1, kind })
          first += part.faces
        }
        partVolumes.set(id, { partIds: parts.map((part) => part.id), records: partRecords })
      }
    }
  }
  const plates = []
  const PLATE_RE = /<plate\b[^>]*>([\s\S]*?)<\/plate>/g
  while ((m = PLATE_RE.exec(xml))) {
    const body = m[1]
    const meta = metadataPairs(body.replace(/<model_instance\b[\s\S]*?<\/model_instance>/g, ''))
    const objectIds = []
    for (const inst of body.match(/<model_instance\b[\s\S]*?<\/model_instance>/g) || []) {
      const objectId = metadataPairs(inst).object_id
      if (objectId) objectIds.push(objectId)
    }
    // plater_id is 1-based upstream; the viewer's plates are 0-based.
    plates.push({ index: Math.max(0, (Number(meta.plater_id) || plates.length + 1) - 1), objectIds, gcodeFile: meta.gcode_file || null })
  }
  return { objects, plates, volumes, partVolumes }
}

const SLA_CAPABILITIES = Object.freeze({
  manualSupportPoints: 'prepared-roundtrip',
  drainHoles: 'preserved-unsupported',
  modifierVolumes: 'prepared-mask-filtering',
  uiEditing: 'unavailable',
})

function parseSlaRecords(text, label, stride, issues, readRecord) {
  const records = new Map()
  if (!text?.trim()) return records
  const lines = text.trim().split(/\r?\n/)
  const header = new RegExp(`^${label}_format_version=(\\d+)$`).exec(lines[0])
  const version = header ? Number(header[1]) : 0
  for (const line of lines.slice(header ? 1 : 0)) {
    const match = /^object_id=(\d+)\|(.*)$/.exec(line)
    if (!match || records.has(Number(match?.[1]))) continue
    const object = Number(match[1])
    const values = match[2].trim() ? match[2].trim().split(/\s+/).map(Number) : []
    const width = stride(version)
    if (!width || values.length % width !== 0 || values.some(value => !Number.isFinite(value))) {
      issues.push({ code: label === 'support_points' ? 'SLA_SUPPORT_POINT_COUNT' : 'SLA_DRAIN_HOLE_COUNT', object })
      records.set(object, [])
      continue
    }
    const parsed = []
    for (let at = 0; at < values.length; at += width) parsed.push(readRecord(values.slice(at, at + width), version))
    records.set(object, parsed)
  }
  return records
}

function transformPoint(xf, point) {
  const [x, y, z] = point
  return [x * xf[0] + y * xf[3] + z * xf[6] + xf[9], x * xf[1] + y * xf[4] + z * xf[7] + xf[10], x * xf[2] + y * xf[5] + z * xf[8] + xf[11]]
}

function transformDirection(xf, direction) {
  const [x, y, z] = direction
  const out = [x * xf[0] + y * xf[3] + z * xf[6], x * xf[1] + y * xf[4] + z * xf[7], x * xf[2] + y * xf[5] + z * xf[8]]
  const length = Math.hypot(...out)
  return length ? out.map(value => value / length) : out
}

function readProject(files, dec) {
  const text = (path) => { const raw = files.get(path); return raw ? dec.decode(raw) : null }
  const project = {
    settings: null,        // Metadata/project_settings.config — the flattened preset (raw upstream strings)
    objectMeta: new Map(), // 3mf object id -> per-object metadata (name, extruder, per-object overrides)
    plates: [],            // [{index, objectIds}]
    hasLayerHeightProfile: false,
    hasCustomGcodePerLayer: false,
    volumeMeta: new Map(),
    partVolumeMeta: new Map(),
    sla: { capabilities: { ...SLA_CAPABILITIES }, issues: [], supportPoints: new Map(), drainHoles: new Map() },
    viewerSettings: null,  // Metadata/three_slicer_settings.json — this package's own member (write_3mf.js)
    plateSettings: null,   //  ...its two halves: global viewer knobs, and per-plate overrides keyed by plate index
    plateCount: null,      //  ...and the plate count it was saved with (empty plates hold no <plate> record)
    gcodePlates: null,     // a .gcode.3mf's sliced plates: [{index, gcode}] (write_3mf.js writeGcode3MF), else null
  }
  const settingsText = text('Metadata/project_settings.config')
  if (settingsText) {
    // Malformed metadata must not cost the geometry — a 3mf whose config we cannot read still has a mesh worth loading.
    try { project.settings = JSON.parse(settingsText) } catch { project.settings = null }
  }
  // Our own member, read defensively: it is a file from anywhere, so a malformed one costs only itself, and only
  //  plain-object maps under non-negative integer plate keys survive.
  const sidecarText = text('Metadata/three_slicer_settings.json')
  if (sidecarText) {
    let sidecar = null
    try { sidecar = JSON.parse(sidecarText) } catch { sidecar = null }
    const isMap = (value) => value && typeof value === 'object' && !Array.isArray(value)
    if (isMap(sidecar)) {
      if (isMap(sidecar.viewer) && Object.keys(sidecar.viewer).length) project.viewerSettings = sidecar.viewer
      let plateEntries = []
      if (isMap(sidecar.plates)) plateEntries = Object.entries(sidecar.plates)
      const plates = plateEntries
        .filter(([plate, map]) => /^\d+$/.test(plate) && isMap(map) && Object.keys(map).length)
      if (plates.length) project.plateSettings = Object.fromEntries(plates.map(([plate, map]) => [Number(plate), map]))
      if (Number.isInteger(sidecar.plateCount) && sidecar.plateCount >= 1) project.plateCount = sidecar.plateCount
    }
  }
  const modelSettings = text('Metadata/model_settings.config')
  if (modelSettings) {
    const parsed = parseModelSettings(modelSettings)
    project.objectMeta = parsed.objects
    project.plates = parsed.plates
    project.volumeMeta = parsed.volumes
    project.partVolumeMeta = parsed.partVolumes
  }
  // A .gcode.3mf is told apart by its CONTENT, not its name: a <plate> record naming a G-code member that exists.
  //  Upstream decides the same way (a plate with a valid slice result, Plater.cpp) — the file name is only a
  //  convention, and a renamed file is still a print job.
  const gcodePlates = project.plates
    .map(plate => ({ index: plate.index, gcode: plate.gcodeFile && text(normPath(plate.gcodeFile)) }))
    .filter(plate => plate.gcode)
  if (gcodePlates.length) project.gcodePlates = gcodePlates
  project.sla.supportPoints = parseSlaRecords(text('Metadata/Slic3r_PE_sla_support_points.txt'), 'support_points',
    version => version === 0 ? 3 : version === 1 ? 5 : 0, project.sla.issues, (values, version) => ({
      position: values.slice(0, 3), radius: version === 0 ? SLA_POINT_RADIUS : values[3],
      type: version === 0 || values[4] === 2 ? 'manual' : values[4] === 1 ? 'island' : 'slope',
    }))
  project.sla.drainHoles = parseSlaRecords(text('Metadata/Slic3r_PE_sla_drain_holes.txt'), 'drain_holes',
    version => version === 1 ? 8 : 0, project.sla.issues, values => {
      const normalLength = Math.hypot(values[3], values[4], values[5])
      const normal = normalLength ? values.slice(3, 6).map(value => value / normalLength) : values.slice(3, 6)
      return { position: values.slice(0, 3).map((value, axis) => value + normal[axis]), normal, radius: values[6], height: values[7] - 1 }
    })
  project.hasLayerHeightProfile = !!text('Metadata/layer_heights_profile.txt')?.trim()
  project.hasCustomGcodePerLayer = !!text('Metadata/custom_gcode_per_layer.xml')?.trim()
  return project
}

// ---- Build items ------------------------------------------------------------------------------------------
// One build item becomes one object: its meshes (reached through components, possibly in other .model parts) with
//  the build transform applied, its painted facets rebased onto the output numbering, its modifier volumes split
//  off, its XY box, and — when asked — the scene geometry (bakeModel). An item is described by its REFS: the
//  (objectid, path, transform, depth) entries emit() starts from, so an item whose root object lives in the root
//  part can hand its first level of components to a worker that never sees the root part.

// Thrown by a job's getModel for a part that exists in the archive but was not sent to the job; the item is then
//  built where the whole archive is.
const NOT_IN_JOB = Symbol('part not in job')

// A job's copy of the root part may hold only the objects its items were found to need (parse3MFProject). An object
//  missing from it is then not "absent from the file" but "not sent": the item is built where the whole part is.
function onlySentObjects(objects) {
  return {
    get(objectid) {
      const object = objects.get(objectid)
      if (!object) throw NOT_IN_JOB
      return object
    },
  }
}

function walk(objectid, path, xf, depth, getModel, visit) {
  if (depth > 16) return   // guards against circular references
  const obj = getModel(path)?.objects.get(objectid)
  if (!obj) return
  if (obj.components) {
    for (const c of obj.components) walk(c.objectid, c.path || path, mul(c.transform, xf), depth + 1, getModel, visit)
    return
  }
  if (obj.mesh) visit(obj.mesh, xf)
}

// The item's triangles, as Float32 values of the double-precision transform — what `new Float32Array(sinkArray)`
//  held when they were pushed onto a JS array first. Counted first, so the stream is written once into its final array.
function emitItem(refs, getModel) {
  let values = 0
  for (const r of refs) walk(r.objectid, r.path, r.xf, r.depth, getModel, (mesh) => { values += mesh.tris.length * 3 })
  const sink = new Float32Array(values)
  const paintSink = emptyPaint()
  let written = 0
  for (const r of refs) walk(r.objectid, r.path, r.xf, r.depth, getModel, ({ verts, tris, paint }, xf) => {
    const triBase = written / 9   // output index of this mesh's first triangle
    for (let i = 0; i < tris.length; i++) {
      const o = tris[i] * 3
      const x = verts[o], y = verts[o + 1], z = verts[o + 2]
      sink[written] = x * xf[0] + y * xf[3] + z * xf[6] + xf[9]
      sink[written + 1] = x * xf[1] + y * xf[4] + z * xf[7] + xf[10]
      sink[written + 2] = x * xf[2] + y * xf[5] + z * xf[8] + xf[11]
      written += 3
    }
    for (const [, slot] of PAINT_ATTRS)
      for (const [localTri, hex] of paint[slot]) paintSink[slot].set(triBase + localTri, hex)
  })
  return { sink, paintSink }
}

// Modifier volumes out of the printable mesh, the XY box, and the scene geometry. -> null for an item with no triangle.
function finishItem({ sink, paintSink }, volumeRecords, bake) {
  if (sink.length < 9) return null
  let tris = sink
  const modifiers = []
  if (volumeRecords.length) {
    const modifierFaces = new Set()
    for (let volume = 0; volume < volumeRecords.length; volume++) {
      const record = volumeRecords[volume]
      const start = record.firstTriangle * 9
      const end = Math.min(sink.length, (record.lastTriangle + 1) * 9)
      if (start >= end) continue
      for (let face = record.firstTriangle; face <= record.lastTriangle; face++) modifierFaces.add(face)
      modifiers.push({ volume, kind: record.kind, tris: sink.slice(start, end) })
    }
    if (modifierFaces.size) {
      const printable = new Float32Array(sink.length - [...modifierFaces].filter(face => face < sink.length / 9).length * 9)
      let at = 0
      for (let face = 0; face < sink.length / 9; face++) {
        if (modifierFaces.has(face)) continue
        printable.set(sink.subarray(face * 9, face * 9 + 9), at); at += 9
      }
      tris = printable
    }
  }
  // The XY box in the file's own coordinates. A slicer-written 3mf lays its PLATES OUT IN WORLD SPACE — plate 2's
  //  objects simply sit a few hundred mm along x from plate 1's — so this box is the only record of the
  //  arrangement the author made. The scene's bakeLocal centres every object and drops it, which is why the
  //  importer has to capture it here and re-apply it per plate.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (let v = 0; v < tris.length; v += 3) {
    const x = tris[v], y = tris[v + 1]
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  let paint = paintSink
  if (paintIsEmpty(paintSink)) paint = null
  const built = { tris, paint, modifiers, bbox: { minX, minY, maxX, maxY } }
  if (bake) built.baked = bakeModel(tris)
  return built
}

/**
 * Builds the items of one job from the compressed parts it was sent. Pure — it is what a parse worker's helper
 *  workers run, and what runs in-thread when there are none.
 *   job: { members: [{ path, data, entry }], names: [every part path in the archive], items: [{ index, refs, volumeRecords }], bake }
 *   ->   { items: [{ index, built } | { index, local: true }] }
 */
export async function runItemJob(job) {
  const models = await modelsOf(job.members)
  return { items: buildJobItems(job, models) }
}

async function modelsOf(members) {
  const models = new Map()
  await Promise.all(members.map(async (member) => {
    const model = scanModelXml(await inflateEntry(member.data, member.entry))
    if (member.partial) model.objects = onlySentObjects(model.objects)
    models.set(member.path, model)
  }))
  return models
}

function buildJobItems(job, models) {
  const names = new Set(job.names)
  const getModel = (path) => {
    const normalized = normPath(path)
    if (models.has(normalized)) return models.get(normalized)
    if (names.has(normalized)) throw NOT_IN_JOB
    return null
  }
  return job.items.map((item) => {
    try {
      return { index: item.index, built: finishItem(emitItem(item.refs, getModel), item.volumeRecords, job.bake) }
    } catch (error) {
      if (error === NOT_IN_JOB) return { index: item.index, local: true }
      throw error
    }
  })
}

// ---- A pool of helpers that keep what they read ---------------------------------------------------------------------
// The root part arrives as one inflating stream, and its <build> comes last (haaland100_f3.3mf: 100.00% into 303MB),
//  so no item can be built before the whole part is in. Its mesh objects can be read before that: a pool helper is
//  sent each object's span as soon as it is complete (scanKeptObjects) and keeps the result, and once the build is
//  known it is sent the items of those objects (runKeptItemJob) — transforming and baking them is all that is left.

/**
 * What a pool helper keeps across one parse: the objects it read, the ones it already built as they stand, and the
 *  objects it is still reading piece by piece (scanModelXml's openObject, by object id).
 */
export function createKept() {
  return { objects: new Map(), ready: new Map(), open: new Map() }
}

const isIdentity = (xf) => xf.length === 12 && xf.every((value, k) => value === IDENT[k])

/**
 * A pool helper's scan: reads the object spans in `data` into `kept.objects`. Each mesh object is also built as it
 *  stands — transformed by the identity and baked — into `kept.ready`, while the archive is still inflating: a build
 *  item that places the object as it stands (every item of a MakerWorld project does, measured: 17 of 17) then has
 *  nothing left to do once the build is known. Under the identity the arithmetic is the normal path's exactly
 *  (x*1 + y*0 + z*0 + 0 is x), so the result is byte-identical; any other transform builds the normal way.
 */
export function scanKeptObjects(data, kept, { bake = false, objectId = null, complete = true } = {}) {
  const asKept = () => ({ objects: kept.objects })
  // A piece of one object: continue it where the last piece left off, and keep it open until the last piece. The open
  //  state comes out of the map before the scan, so a scan that throws leaves nothing a later piece could resume from.
  let openObject = null
  if (objectId !== null) {
    openObject = kept.open.get(objectId) ?? null
    kept.open.delete(objectId)
  }
  const scanned = scanModelXml(data, openObject)
  if (objectId !== null && !complete && scanned.openObject) kept.open.set(objectId, scanned.openObject)
  for (const [id, object] of scanned.objects) {
    kept.objects.set(id, object)
    if (!object.mesh) continue
    kept.ready.set(id, finishItem(emitItem([{ objectid: id, path: '', xf: IDENT, depth: 0 }], asKept), [], bake))
  }
}

// How much of an object has to be in before its first piece goes out, and how much new before the next: fewer,
//  larger messages. The last piece is whatever is left when the object ends. parse3MFProject takes it as an option so
//  a test can make a small part go out in pieces.
export const PIECE_BYTES = 1 << 20

/**
 * A pool helper's item job: the root part (job.keptPath) is the objects this helper kept, plus any sent along with
 *  the job as a partial member; an object in neither sends its item to the in-thread fallback.
 */
export async function runKeptItemJob(job, kept) {
  const models = await modelsOf(job.members)
  const sent = models.get(job.keptPath)?.objects
  models.set(job.keptPath, {
    items: [],
    objects: {
      get(objectid) {
        const object = kept?.objects.get(objectid)
        if (object) return object
        if (sent) return sent.get(objectid)
        throw NOT_IN_JOB
      },
    },
  })
  // An item that places one kept object as it stands, with no modifier volumes, is the build this helper already made.
  //  Taken once: a second instance of the same object builds its own copy.
  const ready = []
  const rest = []
  for (const item of job.items) {
    const [ref] = item.refs
    if (item.refs.length === 1 && normPath(ref.path) === job.keptPath && isIdentity(ref.xf) && !item.volumeRecords.length && kept?.ready.has(ref.objectid)) {
      ready.push({ index: item.index, built: kept.ready.get(ref.objectid), prebuilt: true })   // prebuilt: for the tests
      kept.ready.delete(ref.objectid)
    } else rest.push(item)
  }
  const items = [...ready, ...buildJobItems({ ...job, items: rest }, models)]
  // The ready builds the items did not place (a translated instance, an object no item places) were made on an idle
  //  helper during the inflate and are not wanted now; a build job is this helper's last word on the parse.
  kept.ready.clear()
  return { items }
}

// The root inflated and indexed together, each mesh object going to a pool slot as its bytes arrive: the first piece
//  once PIECE_BYTES of it are in, more as they come, the last one when the object ends, so a helper reads an object
//  while the inflater is still on it (the two biggest objects of a MakerWorld project sit at the end of the part, and
//  their reading after the inflate was the parse's tail). An object small enough to complete between two pieces goes
//  whole. -> { rootBytes, root (the index), keptOn: Map(objectid -> slot), scans: Promise of every scan }
async function streamRoot(compressed, entry, pool, bake, pieceBytes) {
  const keptOn = new Map()
  const load = new Array(pool.size).fill(0)
  const scans = []
  const inProgress = new Map()   // objectid -> { slot, sent }: an object some of whose pieces went out
  const failed = new Set()       // objects a piece of which the helper could not read: nothing more goes, nothing is kept
  let indexed = null, indexer = null
  const leastLoaded = () => {
    let slot = 0
    for (let k = 1; k < pool.size; k++) if (load[k] < load[slot]) slot = k
    return slot
  }
  // A piece's scan that fails ends the object's streaming: it is marked failed, no later piece goes, and it is not
  //  kept — its items are sent its span, or built in-thread. The mark, not keptOn, is what the completion checks: the
  //  failure can land before the object completes, when keptOn does not hold it yet.
  const send = (object, slot, start, end, complete) => {
    load[slot] += end - start
    scans.push(pool.scan(slot, indexed.slice(start, end), { bake, objectId: object.id, complete }).catch(() => { failed.add(object.id); keptOn.delete(object.id) }))
  }
  // Not into shared memory, although a cross-origin isolated page would allow it: writing the inflated chunks into a
  //  SharedArrayBuffer measured 300ms against 240ms into a plain one (303MB, Chromium), more than the 30ms of copying
  //  each object's span out of the plain buffer to transfer it.
  // A pool that can inflate does it on one of its workers (pool.inflate, the same contract as
  //  inflateEntryProgressively): DecompressionStream inflates on the reading thread, so inflated here the 219ms of
  //  zlib and the ~130ms of indexing, copying and dispatching below ran one after the other.
  const inflate = pool.inflate ?? inflateEntryProgressively
  const rootBytes = await inflate(compressed, entry, (buffer, received) => {
    // A member that inflates past its recorded size is moved to a larger buffer; the index then starts over on it.
    if (buffer !== indexed) { indexed = buffer; indexer = createModelIndexer(buffer) }
    for (const object of indexer.advance(received)) {
      if (keptOn.has(object.id) || failed.has(object.id)) continue
      const started = inProgress.get(object.id)
      if (started) {
        inProgress.delete(object.id)
        keptOn.set(object.id, started.slot)
        send(object, started.slot, started.sent, object.end, true)
        continue
      }
      if (!object.hasMesh) continue
      const slot = leastLoaded()
      keptOn.set(object.id, slot)
      send(object, slot, object.start, object.end, true)
    }
    // The object the received bytes end inside: its complete tags so far go out once enough are pending.
    const open = indexer.open()
    if (!open?.id || !open.hasMesh || failed.has(open.id)) return
    let started = inProgress.get(open.id)
    if (!started) {
      if (received - open.start < pieceBytes) return
      started = { slot: leastLoaded(), sent: open.start }
      inProgress.set(open.id, started)
    }
    const cut = buffer.subarray(0, received).lastIndexOf(62) + 1   // just past the last complete tag
    if (cut - started.sent < pieceBytes) return
    send(open, started.slot, started.sent, cut, false)
    started.sent = cut
  })
  if (indexed !== rootBytes) { indexer = createModelIndexer(rootBytes); indexer.advance(rootBytes.length) }
  return { rootBytes, root: indexer.finish(), keptOn, scans: Promise.all(scans) }
}

const runJobsInThread = (jobs) => Promise.all(jobs.map(runItemJob))

const isBlob = (source) => typeof Blob !== 'undefined' && source instanceof Blob

// The archive's members, inflated on demand, over its bytes or over a Blob (then read as slices, so the archive is
//  never loaded whole: a 51MB project's one big part streams from disk into its inflater). zipEntries() lists the
//  members without inflating anything; an archive it cannot read goes through fflate whole, and its items are then
//  all built in-thread.
//   names, entry(path); read(path) -> inflated bytes; compressed(path) -> the member's compressed bytes as a
//   Uint8Array (bytes) or a Blob slice (Blob), what inflateEntry and the pool's inflater take.
async function openArchive(source) {
  let entries = null
  if (isBlob(source)) entries = await zipEntriesFromBlob(source)
  else entries = zipEntries(source)
  if (!entries) {
    const files = new Map()
    let bytes = source
    if (isBlob(source)) bytes = new Uint8Array(await source.arrayBuffer())
    const zip = await unzipAll(bytes)
    for (const k of Object.keys(zip)) files.set(normPath(k), zip[k])
    return { names: [...files.keys()], entry: () => null, read: async (path) => files.get(path) ?? null, compressed: async () => null }
  }
  const byPath = new Map()
  for (const [name, entry] of entries) byPath.set(normPath(name), entry)
  const compressed = (entry) => {
    if (isBlob(source)) return source.slice(entry.dataStart, entry.dataStart + entry.compressedSize)
    return entryData(source, entry)
  }
  const inflated = new Map()
  return {
    names: [...byPath.keys()],
    entry: (path) => byPath.get(path) ?? null,
    compressed: (path) => {
      const entry = byPath.get(path)
      if (!entry) return null
      return compressed(entry)
    },
    read: (path) => {
      const entry = byPath.get(path)
      if (!entry) return Promise.resolve(null)
      if (!inflated.has(path)) inflated.set(path, inflateEntry(compressed(entry), entry))
      return inflated.get(path)
    },
  }
}

const isModelPart = (path) => path.toLowerCase().endsWith('.model')

/**
 * 3MF (ArrayBuffer|Uint8Array|Blob) -> {objects, project}
 *   objects: [{name, tris: Float32Array(N*9), objectid, paint, sla, bbox, baked?}]  (z-up mm, build transform baked in)
 *            One build item = one object. When there are no items, every top-level object with a mesh is used.
 *   project: the Metadata/*.config side — preset, per-object state, plate layout (all nullable).
 *   options.runJobs: runs a list of runItemJob jobs (a worker pool); in-thread when absent.
 *   options.bake:    also return each object's scene geometry (bakeModel) as `baked`.
 */
export async function parse3MFProject(buffer, baseName = 'model', { runJobs = runJobsInThread, bake = false, pool = null, pieceBytes = PIECE_BYTES } = {}) {
  try {
    return await parseProject(buffer, baseName, { runJobs, bake, pool, pieceBytes })
  } finally {
    // The helpers drop what they kept for this parse whether it finished or threw: a parse that fails after the
    //  root streamed would otherwise leave every helper holding its objects and ready builds until the worker dies.
    pool?.release()
  }
}

async function parseProject(buffer, baseName, { runJobs, bake, pool, pieceBytes }) {
  // A Blob is read as slices (openArchive); bytes are used in place. TypedArray/Buffer may sit on a pooled
  //  ArrayBuffer, so offset/length must be preserved.
  let source = buffer
  if (ArrayBuffer.isView(buffer)) source = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  else if (!isBlob(buffer)) source = new Uint8Array(buffer)
  const archive = await openArchive(source)
  const dec = new TextDecoder()

  // Every member but the .model parts is metadata: small, and read synchronously by readProject.
  const files = new Map()
  await Promise.all(archive.names.filter(path => !isModelPart(path)).map(async (path) => files.set(path, await archive.read(path))))

  // Root part: the 3dmodel relationship in _rels/.rels -> the conventional path when absent
  let rootPath = '3D/3dmodel.model'
  const rels = files.get('_rels/.rels')
  if (rels) {
    for (const r of dec.decode(rels).match(/<Relationship\b[^>]*>/g) || []) {
      if ((attr(r, 'Type') || '').endsWith('/3dmodel')) { rootPath = normPath(attr(r, 'Target')); break }
    }
  }
  const project = readProject(files, dec)
  // The root part is indexed, not read: where its own objects hold the meshes (a MakerWorld project keeps all 17, 316MB
  //  of XML, there), their spans go to other workers, so several of them read them instead of this one reading all.
  //  With a pool the spans go out while the part is still inflating (streamRoot); without one they go with the jobs.
  //  The whole part is read only for the in-thread fallback, and for a root with no build items.
  let rootBytes = null, root = null, keptOn = new Map(), scans = Promise.resolve(), wholeRoot = null
  const rootEntry = archive.entry(rootPath)
  const inThread = runJobs === runJobsInThread && !pool
  if (pool?.size > 1 && rootEntry) ({ rootBytes, root, keptOn, scans } = await streamRoot(archive.compressed(rootPath), rootEntry, pool, bake, pieceBytes))
  else {
    rootBytes = await archive.read(rootPath)
    // In-thread nothing is sent anywhere, so the root's items are built from the whole part (below): reading it is the
    //  work, and an index first only added to it (measured on the 303MB part: +65ms).
    if (rootBytes && inThread) root = wholeRoot = scanModelXml(rootBytes)
    else root = rootBytes && indexModelXml(rootBytes)
  }
  // A .gcode.3mf holds no meshes (upstream writes it with SkipModel), so a missing root is its normal shape.
  if (!root && project.gcodePlates) return { objects: [], project }
  if (!root) throw new Error(`3MF root model not found: ${rootPath}`)
  const readWholeRoot = () => (wholeRoot ??= scanModelXml(rootBytes))

  let items = root.items
  if (!items.length) {
    // "Every object with a mesh" means a mesh of at least one triangle, which only reading the part can say.
    const whole = readWholeRoot()
    items = [...whole.objects.keys()].filter(id => whole.objects.get(id).mesh).map(id => ({ objectid: id, path: rootPath, transform: IDENT }))
  }

  // The root objects an item reads: its own and, through components that stay in the root, theirs. Components into
  //  other parts are those parts' business; a part that points back into the root is caught by onlySentObjects.
  const rootObjectsOf = (refs) => {
    const needed = new Set()
    const visit = (objectid, depth) => {
      if (depth > 16 || needed.has(objectid)) return
      const object = root.objects.get(objectid)
      if (!object) return
      needed.add(objectid)
      for (const c of object.components) if (!c.path || normPath(c.path) === rootPath) visit(c.objectid, depth + 1)
    }
    for (const r of refs) if (normPath(r.path) === rootPath) visit(r.objectid, r.depth)
    return needed
  }
  // A root object takes part in job grouping as if it were a part of its own, under a key no archive path can have
  //  (normPath strips no NUL, and zip names hold none): items that read the same object share a job and it is read once.
  const ROOT_OBJECT = '\u0000root-object:'

  // Which items can be built in a job: from their own parts and the root objects they read. Items that share a part
  //  or a root object go to the same job, so nothing is inflated or read twice.
  const jobs = [], jobOfPart = new Map(), local = []
  const pooledJobs = []   // per pool slot: { items, spans }
  // The item as emit() starts it from the build: its own object, at depth 0. Any item can be built from this.
  // An object's modifier volumes as triangle ranges of the item: the <volume firstid lastid> form as written, or the
  //  <part> form when the object's components are exactly its parts in order (a support enforcer box added to a
  //  MakerWorld model is one; read as a printable component, it printed as a solid cube and lifted the model off the
  //  bed by its own depth).
  const volumeRecordsOf = (objectid) => {
    const ranged = project.volumeMeta.get(objectid)
    if (ranged) return ranged
    const parts = project.partVolumeMeta.get(objectid)
    const components = root.objects.get(objectid)?.components ?? []
    if (!parts || components.length !== parts.partIds.length) return []
    if (!components.every((component, k) => component.objectid === parts.partIds[k])) return []
    return parts.records
  }
  const wholeItem = (index) => {
    const it = items[index]
    return { index, refs: [{ objectid: it.objectid, path: it.path || rootPath, xf: it.transform, depth: 0 }], volumeRecords: volumeRecordsOf(it.objectid) }
  }
  items.forEach((it, index) => {
    const itemPath = it.path || rootPath
    const volumeRecords = volumeRecordsOf(it.objectid)
    let refs = [{ objectid: it.objectid, path: itemPath, xf: it.transform, depth: 0 }]
    if (normPath(itemPath) === rootPath) {
      const obj = root.objects.get(it.objectid)
      if (obj?.components?.length) refs = obj.components.map(c => ({ objectid: c.objectid, path: c.path || itemPath, xf: mul(c.transform, it.transform), depth: 1 }))
    }
    const otherParts = [...new Set(refs.map(r => normPath(r.path)))].filter(part => part !== rootPath)
    if (otherParts.some(part => !archive.entry(part))) { local.push(wholeItem(index)); return }
    // An item read entirely from root objects a pool helper kept goes to that helper, with the spans of any of its
    //  objects the helper does not keep (component objects, objects kept elsewhere) sent along.
    if (keptOn.size && !otherParts.length) {
      const objectIds = [...rootObjectsOf(refs)]
      const keptSlots = objectIds.filter(id => keptOn.has(id)).map(id => keptOn.get(id))
      if (keptSlots.length) {
        const slot = keptSlots[0]
        const pooledJob = (pooledJobs[slot] ??= { items: [], spans: new Set() })
        pooledJob.items.push({ index, refs, volumeRecords })
        for (const id of objectIds) if (keptOn.get(id) !== slot) pooledJob.spans.add(id)
        return
      }
    }
    // In-thread the jobs run one after another, so splitting the root only adds the index and the copies (measured on
    //  haaland100_f3.3mf, node: 960 -> 1212ms): there the root's items are built from the whole part, as before.
    let rootKeys = []
    if (!inThread) rootKeys = [...rootObjectsOf(refs)].map(id => ROOT_OBJECT + id)
    if (refs.some(r => normPath(r.path) === rootPath) && !rootKeys.length) { local.push(wholeItem(index)); return }
    const parts = [...otherParts, ...rootKeys]
    let job = parts.map(part => jobOfPart.get(part)).find(Boolean)
    if (!job) { job = { parts: new Set(), items: [] }; jobs.push(job) }
    for (const part of parts) {
      const other = jobOfPart.get(part)
      if (other && other !== job) {            // two jobs now share a part: fold the other one in
        for (const p of other.parts) { job.parts.add(p); jobOfPart.set(p, job) }
        job.items.push(...other.items); jobs.splice(jobs.indexOf(other), 1)
      }
      job.parts.add(part); jobOfPart.set(part, job)
    }
    job.items.push({ index, refs, volumeRecords })
  })

  const built = new Array(items.length).fill(null)
  // Root objects as one stored (uncompressed) partial member for a job: their own bytes, in file order. What
  //  scanModelXml reads of them is what it reads of the whole part.
  const spansOf = (ids) => {
    const spans = [...ids].map(id => root.objects.get(id)).filter(Boolean).sort((a, b) => a.start - b.start)
    const data = new Uint8Array(spans.reduce((sum, span) => sum + span.end - span.start, 0))
    let at = 0
    for (const span of spans) { data.set(rootBytes.subarray(span.start, span.end), at); at += span.end - span.start }
    return { path: rootPath, data, entry: { method: 0, size: data.length }, partial: true }
  }
  // Largest first: the slowest job bounds the parse, so it should start first.
  const payloads = await Promise.all(jobs.map(async job => {
    const members = []
    const rootObjects = []
    for (const key of job.parts) {
      if (key.startsWith(ROOT_OBJECT)) { rootObjects.push(key.slice(ROOT_OBJECT.length)); continue }
      const entry = archive.entry(key)
      // A copy of its own, so the job can be transferred (bytes) or read without the archive (Blob).
      const data = new Uint8Array(await new Blob([archive.compressed(key)]).arrayBuffer())
      members.push({ path: key, data, entry: { method: entry.method, size: entry.size } })
    }
    if (rootObjects.length) members.push(spansOf(rootObjects))
    return { members, names: archive.names, items: job.items, bake }
  }))
  payloads.sort((a, b) => b.members.reduce((s, m) => s + m.data.length, 0) - a.members.reduce((s, m) => s + m.data.length, 0))
  // The pool's jobs wait for its scans (a helper answers its messages in order, but a failed scan must be known before
  //  its object is counted as kept); they and the other jobs then run together.
  await scans
  const pooledRuns = pooledJobs.map((job, slot) => {
    if (!job) return null
    // A kept object whose scan failed is no longer kept: it travels as a span like the others.
    for (const item of job.items) for (const id of rootObjectsOf(item.refs)) if (keptOn.get(id) !== slot) job.spans.add(id)
    const members = []
    if (job.spans.size) members.push(spansOf(job.spans))
    return pool.build(slot, { members, names: archive.names, items: job.items, bake, keptPath: rootPath })
      .catch(() => ({ items: job.items.map(item => ({ index: item.index, local: true })) }))
  }).filter(Boolean)
  const [jobResults, pooledResults] = await Promise.all([runJobs(payloads), Promise.all(pooledRuns)])
  for (const result of [...jobResults, ...pooledResults]) {
    for (const item of result.items) {
      if (item.local) local.push(wholeItem(item.index))
      else built[item.index] = item.built
    }
  }

  if (local.length) {
    const models = new Map([[rootPath, readWholeRoot()]])
    for (const path of archive.names) if (isModelPart(path) && path !== rootPath) models.set(path, scanModelXml(await archive.read(path)))
    const getModel = (path) => models.get(normPath(path)) ?? null
    for (const item of local) built[item.index] = finishItem(emitItem(item.refs, getModel), item.volumeRecords, bake)
  }

  const out = []
  items.forEach((it, i) => {
    const item = built[i]
    if (!item) return
    const supportPoints = (project.sla.supportPoints.get(i + 1) || []).map(point => ({ ...point, position: transformPoint(it.transform, point.position) }))
    const drainHoles = (project.sla.drainHoles.get(i + 1) || []).map(hole => ({
      ...hole, position: transformPoint(it.transform, hole.position), normal: transformDirection(it.transform, hole.normal),
    }))
    const modifierVolumes = item.modifiers.map(({ volume, kind, tris }) => ({ id: `${it.objectid}:modifier:${volume}`, kind, tris }))
    let name = baseName
    if (items.length > 1) name = `${baseName}#${i + 1}`
    const object = { name, tris: item.tris, objectid: it.objectid, paint: item.paint, sla: { supportPoints, drainHoles, modifierVolumes }, bbox: item.bbox }
    if (item.baked) object.baked = item.baked
    out.push(object)
  })
  return { objects: out, project }
}

/** Geometry only — the shape every caller before the project import used. */
export async function parse3MF(buffer, baseName = 'model') { return (await parse3MFProject(buffer, baseName)).objects }
