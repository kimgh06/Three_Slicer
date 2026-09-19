// 3MF parser — replaces three's ThreeMFLoader.
// Why: ThreeMFLoader does not understand the **production extension** (`p:path` referencing external .model parts).
//  Nearly every 3mf written by OrcaSlicer/BambuStudio/PrusaSlicer uses it (3D/3dmodel.model holds only component
//  shells, the real meshes live in 3D/Objects/*.model), so the loader returned an empty Group and "no 3MF mesh" errors.
// We only need triangles (materials/textures/colors are irrelevant), so we go straight from zip -> .model XML -> triangle stream.
// The XML is read with regexes: vertex/triangle/component/item in 3mf are all attribute-only self-closing tags and
//  objects do not nest, so no scanner is needed. With no DOMParser dependency it is testable under node as-is.
import { unzipSync, unzip } from 'three/examples/jsm/libs/fflate.module.js'
import { SLA_POINT_RADIUS } from './viewer_defaults.js'

// Decompression is the single largest fixed cost of reading a project (measured on a 52MB / 315MB-inflated
//  MakerWorld file: ~600ms of a 2.0s parse), and it is embarrassingly parallel — 18 independent .model parts.
//  fflate's async entry point spreads them over a Web Worker pool; unzipSync does them one after another.
// The fallback is not defensive padding: `unzip` needs the `Worker` global and throws SYNCHRONOUSLY without it,
//  which is every non-browser caller (this package's own node tests) and any environment that refuses nested
//  workers — this parser itself runs inside a worker. Both failure shapes land on the same synchronous path.
function unzipAll(bytes) {
  return new Promise((resolve) => {
    let settled = false
    const done = (files) => { if (!settled) { settled = true; resolve(files) } }
    try {
      unzip(bytes, (err, files) => done(err ? unzipSync(bytes) : files))
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
      o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c] + (r === 3 ? b[9 + c] : 0)
    }
  }
  return o
}

function parseTransform(s) {
  if (!s) return IDENT
  const t = s.trim().split(/\s+/).map(Number)
  return t.length === 12 && t.every(Number.isFinite) ? t : IDENT
}

const A_RE = {}
function attr(tag, name) {
  const re = A_RE[name] || (A_RE[name] = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`))
  const m = re.exec(tag)
  return m ? m[1] : null
}

const VERT_FAST = /<vertex\s+x="([^"]*)"\s+y="([^"]*)"\s+z="([^"]*)"/g
// The trailing group captures whatever follows v3 on the same tag — that is where the painted-facet attributes live.
const TRI_FAST = /<triangle\s+v1="([^"]*)"\s+v2="([^"]*)"\s+v3="([^"]*)"([^>]*)/g

// Painting is stored ON the <triangle> tag, not in Metadata/model_settings.config as the rest of the per-object
//  state is (slicer/src/libslic3r/Format/bbs_3mf.cpp:329-332). Each value is upstream's split-tree bitstream
//  rendered as hex by FacetsAnnotation::get_triangle_as_string — opaque here, decoded by the kernel's selector.
// paint_seam / paint_fuzzy_skin are read too so a project that carries them can be REPORTED as dropped rather
//  than silently losing them; the kernel has no seam or fuzzy-skin painting to apply them to.
const PAINT_ATTRS = [
  ['paint_color', 'color'],        // multi-material: state 1..16 == Extruder1..16
  ['paint_supports', 'supports'],  // support enforcer/blocker: states 1 and 2
  ['paint_seam', 'seam'],          // unsupported by the kernel — collected for the warning only
  ['paint_fuzzy_skin', 'fuzzy'],   // ditto
]
export function emptyPaint() { return { color: new Map(), supports: new Map(), seam: new Map(), fuzzy: new Map() } }
export function paintIsEmpty(paint) { return !paint || PAINT_ATTRS.every(([, slot]) => paint[slot].size === 0) }

function readPaint(tag, triIndex, paint) {
  for (const [attrName, slot] of PAINT_ATTRS) {
    // includes() first: the overwhelmingly common tag has no paint at all, and a substring scan is far cheaper
    //  than building/running four attribute regexes per triangle on a mesh with hundreds of thousands of them.
    if (!tag.includes(attrName)) continue
    const value = attr(tag, attrName)
    if (value) paint[slot].set(triIndex, value)
  }
}

function parseMesh(body) {
  const verts = []
  VERT_FAST.lastIndex = 0
  let m
  while ((m = VERT_FAST.exec(body))) verts.push(+m[1], +m[2], +m[3])
  if (!verts.length) {
    // Tolerates writers with a different attribute order (x/y/z order irrelevant)
    for (const t of body.match(/<vertex\b[^>]*>/g) || []) verts.push(+attr(t, 'x'), +attr(t, 'y'), +attr(t, 'z'))
  }
  if (verts.length < 9) return null

  const tris = []
  const paint = emptyPaint()
  TRI_FAST.lastIndex = 0
  while ((m = TRI_FAST.exec(body))) {
    const triIndex = tris.length / 3
    tris.push(+m[1], +m[2], +m[3])
    // A self-closing tag with nothing painted leaves "/" here, so anything shorter than an attribute cannot carry one.
    if (m[4].length > 2) readPaint(m[4], triIndex, paint)
  }
  if (!tris.length) {
    for (const t of body.match(/<triangle\b[^>]*>/g) || []) {
      const triIndex = tris.length / 3
      tris.push(+attr(t, 'v1'), +attr(t, 'v2'), +attr(t, 'v3'))
      readPaint(t, triIndex, paint)
    }
  }
  if (!tris.length) return null
  return { verts, tris, paint }
}

// One .model XML -> { objects: Map(id -> {mesh|components}), items: [{objectid, path, transform}] }
function parseModelXml(xml) {
  const objects = new Map()
  const OBJ_RE = /<object\b([^>]*)>([\s\S]*?)<\/object>/g
  let m
  while ((m = OBJ_RE.exec(xml))) {
    const id = attr(m[1], 'id')
    if (!id) continue
    const body = m[2]
    const comps = []
    for (const c of body.match(/<component\b[^>]*>/g) || []) {
      const oid = attr(c, 'objectid')
      if (oid) comps.push({ objectid: oid, path: attr(c, 'p:path') || attr(c, 'path'), transform: parseTransform(attr(c, 'transform')) })
    }
    objects.set(id, comps.length ? { components: comps } : { mesh: parseMesh(body) })
  }

  const items = []
  const build = /<build\b[^>]*>([\s\S]*?)<\/build>/.exec(xml)
  if (build) {
    for (const it of build[1].match(/<item\b[^>]*>/g) || []) {
      const oid = attr(it, 'objectid')
      if (oid) items.push({ objectid: oid, path: attr(it, 'p:path') || attr(it, 'path'), transform: parseTransform(attr(it, 'transform')) })
    }
  }
  return { objects, items }
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

/**
 * 3MF (ArrayBuffer|Uint8Array) -> {objects, project}
 *   objects: [{name, tris: Float32Array(N*9), objectid, paint}]  (z-up mm, build transform baked in)
 *            One build item = one object. When there are no items, every top-level object with a mesh is used.
 *   project: the Metadata/*.config side — preset, per-object state, plate layout (all nullable).
 */
export async function parse3MFProject(buffer, baseName = 'model') {
  // TypedArray/Buffer may sit on a pooled ArrayBuffer, so offset/length must be preserved.
  const bytes = ArrayBuffer.isView(buffer)
    ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    : new Uint8Array(buffer)
  const zip = await unzipAll(bytes)
  const files = new Map()
  for (const k of Object.keys(zip)) files.set(normPath(k), zip[k])

  const dec = new TextDecoder()
  const models = new Map()   // path → parsed
  const getModel = (path) => {
    const p = normPath(path)
    if (models.has(p)) return models.get(p)
    const raw = files.get(p)
    const parsed = raw ? parseModelXml(dec.decode(raw)) : null
    models.set(p, parsed)
    return parsed
  }

  // Root part: the 3dmodel relationship in _rels/.rels -> the conventional path when absent
  let rootPath = '3D/3dmodel.model'
  const rels = files.get('_rels/.rels')
  if (rels) {
    for (const r of dec.decode(rels).match(/<Relationship\b[^>]*>/g) || []) {
      if ((attr(r, 'Type') || '').endsWith('/3dmodel')) { rootPath = normPath(attr(r, 'Target')); break }
    }
  }
  const project = readProject(files, dec)
  const root = getModel(rootPath)
  // A .gcode.3mf holds no meshes (upstream writes it with SkipModel), so a missing root is its normal shape.
  if (!root && project.gcodePlates) return { objects: [], project }
  if (!root) throw new Error(`3MF root model not found: ${rootPath}`)

  const out = []
  // Expand objects recursively -> push triangles into the tris array. depth guards against circular references.
  // `paintSink` collects the painted facets of every mesh reached, rebased onto the OUTPUT triangle numbering:
  //  one build item may pull in several component meshes, each with its own local facet indices, and the kernel's
  //  selector only ever sees the flattened result.
  const emit = (objectid, path, xf, sink, paintSink, depth) => {
    if (depth > 16) return
    const model = getModel(path)
    const obj = model?.objects.get(objectid)
    if (!obj) return
    if (obj.components) {
      for (const c of obj.components) emit(c.objectid, c.path || path, mul(c.transform, xf), sink, paintSink, depth + 1)
      return
    }
    if (!obj.mesh) return
    const { verts, tris, paint } = obj.mesh
    const triBase = sink.length / 9   // output index of this mesh's first triangle (9 values pushed per triangle)
    for (let i = 0; i < tris.length; i++) {
      const o = tris[i] * 3
      const x = verts[o], y = verts[o + 1], z = verts[o + 2]
      sink.push(
        x * xf[0] + y * xf[3] + z * xf[6] + xf[9],
        x * xf[1] + y * xf[4] + z * xf[7] + xf[10],
        x * xf[2] + y * xf[5] + z * xf[8] + xf[11],
      )
    }
    if (paint) for (const [, slot] of PAINT_ATTRS)
      for (const [localTri, hex] of paint[slot]) paintSink[slot].set(triBase + localTri, hex)
  }

  const items = root.items.length
    ? root.items
    : [...root.objects.keys()].filter(id => root.objects.get(id).mesh).map(id => ({ objectid: id, path: rootPath, transform: IDENT }))

  items.forEach((it, i) => {
    const sink = []
    const paintSink = emptyPaint()
    emit(it.objectid, it.path || rootPath, it.transform, sink, paintSink, 0)
    if (sink.length < 9) return
    let tris = new Float32Array(sink)
    const modifiers = []
    const volumeRecords = project.volumeMeta.get(it.objectid) || []
    if (volumeRecords.length) {
      const modifierFaces = new Set()
      for (let volume = 0; volume < volumeRecords.length; volume++) {
        const record = volumeRecords[volume]
        const start = record.firstTriangle * 9
        const end = Math.min(sink.length, (record.lastTriangle + 1) * 9)
        if (start >= end) continue
        for (let face = record.firstTriangle; face <= record.lastTriangle; face++) modifierFaces.add(face)
        modifiers.push({ id: `${it.objectid}:modifier:${volume}`, kind: record.kind, tris: new Float32Array(sink.slice(start, end)) })
      }
      if (modifierFaces.size) {
        const printable = []
        for (let face = 0; face < sink.length / 9; face++) if (!modifierFaces.has(face)) printable.push(...sink.slice(face * 9, face * 9 + 9))
        tris = new Float32Array(printable)
      }
    }
    const supportPoints = (project.sla.supportPoints.get(i + 1) || []).map(point => ({ ...point, position: transformPoint(it.transform, point.position) }))
    const drainHoles = (project.sla.drainHoles.get(i + 1) || []).map(hole => ({
      ...hole, position: transformPoint(it.transform, hole.position), normal: transformDirection(it.transform, hole.normal),
    }))
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
    out.push({
      name: items.length > 1 ? `${baseName}#${i + 1}` : baseName,
      tris,
      objectid: it.objectid,
      paint: paintIsEmpty(paintSink) ? null : paintSink,
      sla: { supportPoints, drainHoles, modifierVolumes: modifiers },
      bbox: { minX, minY, maxX, maxY },
    })
  })
  return { objects: out, project }
}

/** Geometry only — the shape every caller before the project import used. */
export async function parse3MF(buffer, baseName = 'model') { return (await parse3MFProject(buffer, baseName)).objects }
