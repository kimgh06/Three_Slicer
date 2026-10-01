// 3MF parser — replaces three's ThreeMFLoader.
// Why: ThreeMFLoader does not understand the **production extension** (`p:path` referencing external .model parts).
//  Nearly every 3mf written by OrcaSlicer/BambuStudio/PrusaSlicer uses it (3D/3dmodel.model holds only component
//  shells, the real meshes live in 3D/Objects/*.model), so the loader returned an empty Group and "no 3MF mesh" errors.
// We only need triangles (materials/textures/colors are irrelevant), so we go straight from zip -> .model XML -> triangle stream.
// The .model parts are read from their bytes (model_xml.js); the metadata is small and read with the regexes below.
// With no DOMParser dependency it is testable under node as-is.
import { unzipSync, unzip } from 'three/examples/jsm/libs/fflate.module.js'
import { SLA_POINT_RADIUS } from './viewer_defaults.js'
import { scanModelXml, parseTransform, PAINT_ATTRS, emptyPaint, paintIsEmpty } from './model_xml.js'
import { zipEntries, entryData, inflateEntry } from './zip_entries.js'
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

function parseModelSettings(xml) {
  const objects = new Map()   // 3mf object id -> {name, extruder, …} (the <metadata> of that object)
  const volumes = new Map()
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
  return { objects, plates, volumes }
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
  const models = new Map()
  await Promise.all(job.members.map(async (member) => {
    models.set(member.path, scanModelXml(await inflateEntry(member.data, member.entry)))
  }))
  const names = new Set(job.names)
  const getModel = (path) => {
    const normalized = normPath(path)
    if (models.has(normalized)) return models.get(normalized)
    if (names.has(normalized)) throw NOT_IN_JOB
    return null
  }
  return {
    items: job.items.map((item) => {
      try {
        return { index: item.index, built: finishItem(emitItem(item.refs, getModel), item.volumeRecords, job.bake) }
      } catch (error) {
        if (error === NOT_IN_JOB) return { index: item.index, local: true }
        throw error
      }
    }),
  }
}

const runJobsInThread = (jobs) => Promise.all(jobs.map(runItemJob))

// The archive's members, inflated on demand. zipEntries() lists them without inflating anything; an archive it cannot
//  read goes through fflate whole, and its items are then all built in-thread.
async function openArchive(bytes) {
  const entries = zipEntries(bytes)
  if (!entries) {
    const files = new Map()
    const zip = await unzipAll(bytes)
    for (const k of Object.keys(zip)) files.set(normPath(k), zip[k])
    return { names: [...files.keys()], entry: () => null, read: async (path) => files.get(path) ?? null }
  }
  const byPath = new Map()
  for (const [name, entry] of entries) byPath.set(normPath(name), entry)
  const inflated = new Map()
  return {
    names: [...byPath.keys()],
    entry: (path) => byPath.get(path) ?? null,
    read: (path) => {
      const entry = byPath.get(path)
      if (!entry) return Promise.resolve(null)
      if (!inflated.has(path)) inflated.set(path, inflateEntry(entryData(bytes, entry), entry))
      return inflated.get(path)
    },
  }
}

const isModelPart = (path) => path.toLowerCase().endsWith('.model')

/**
 * 3MF (ArrayBuffer|Uint8Array) -> {objects, project}
 *   objects: [{name, tris: Float32Array(N*9), objectid, paint, sla, bbox, baked?}]  (z-up mm, build transform baked in)
 *            One build item = one object. When there are no items, every top-level object with a mesh is used.
 *   project: the Metadata/*.config side — preset, per-object state, plate layout (all nullable).
 *   options.runJobs: runs a list of runItemJob jobs (a worker pool); in-thread when absent.
 *   options.bake:    also return each object's scene geometry (bakeModel) as `baked`.
 */
export async function parse3MFProject(buffer, baseName = 'model', { runJobs = runJobsInThread, bake = false } = {}) {
  // TypedArray/Buffer may sit on a pooled ArrayBuffer, so offset/length must be preserved.
  let bytes = new Uint8Array(buffer)
  if (ArrayBuffer.isView(buffer)) bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const archive = await openArchive(bytes)
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
  const rootBytes = await archive.read(rootPath)
  const root = rootBytes && scanModelXml(rootBytes)
  // A .gcode.3mf holds no meshes (upstream writes it with SkipModel), so a missing root is its normal shape.
  if (!root && project.gcodePlates) return { objects: [], project }
  if (!root) throw new Error(`3MF root model not found: ${rootPath}`)

  let items = root.items
  if (!items.length) items = [...root.objects.keys()].filter(id => root.objects.get(id).mesh).map(id => ({ objectid: id, path: rootPath, transform: IDENT }))

  // Which items can be built from their own parts: the item's object (or its first level of components) must sit in
  //  a part other than the root. Items that share a part go to the same job, so no part is inflated twice.
  const jobs = [], jobOfPart = new Map(), local = []
  // The item as emit() starts it from the build: its own object, at depth 0. Any item can be built from this.
  const wholeItem = (index) => {
    const it = items[index]
    return { index, refs: [{ objectid: it.objectid, path: it.path || rootPath, xf: it.transform, depth: 0 }], volumeRecords: project.volumeMeta.get(it.objectid) || [] }
  }
  items.forEach((it, index) => {
    const itemPath = it.path || rootPath
    const volumeRecords = project.volumeMeta.get(it.objectid) || []
    let refs = [{ objectid: it.objectid, path: itemPath, xf: it.transform, depth: 0 }]
    if (normPath(itemPath) === rootPath) {
      const obj = root.objects.get(it.objectid)
      if (obj?.components) refs = obj.components.map(c => ({ objectid: c.objectid, path: c.path || itemPath, xf: mul(c.transform, it.transform), depth: 1 }))
    }
    const parts = [...new Set(refs.map(r => normPath(r.path)))]
    if (parts.some(part => part === rootPath || !archive.entry(part))) { local.push(wholeItem(index)); return }
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
  // Largest first: the slowest job bounds the parse, so it should start first.
  const payloads = jobs.map(job => ({
    members: [...job.parts].map(path => { const entry = archive.entry(path); return { path, data: entryData(bytes, entry).slice(), entry: { method: entry.method, size: entry.size } } }),
    names: archive.names, items: job.items, bake,
  })).sort((a, b) => b.members.reduce((s, m) => s + m.data.length, 0) - a.members.reduce((s, m) => s + m.data.length, 0))
  for (const result of await runJobs(payloads)) {
    for (const item of result.items) {
      if (item.local) local.push(wholeItem(item.index))
      else built[item.index] = item.built
    }
  }

  if (local.length) {
    const models = new Map([[rootPath, root]])
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
