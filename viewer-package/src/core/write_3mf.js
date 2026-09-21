// 3MF project WRITER — the inverse of parse_3mf.js. What upstream calls "save project as": a zip whose
//  3D/3dmodel.model holds the meshes and whose Metadata/*.config hold the preset, the per-object state and the
//  plate layout. Reading only the geometry back would lose the half of the file the user actually tuned, so all of
//  it is written — and it is written the way UPSTREAM spells it, because the point of a project file is that
//  OrcaSlicer/BambuStudio can open it.
// Three spellings that are not negotiable (each is the mirror of a trap parse_3mf.js documents):
//   · every project_settings.config value is a STRING — serializeProjectSettings does that coercion
//   · plates live in WORLD space under upstream's own grid (corner origin, gap = bed/5, rows along -y)
//   · painting rides on the <triangle> tag as paint_color / paint_supports hex, not in model_settings.config
import { zipSync, zip, strToU8 } from 'three/examples/jsm/libs/fflate.module.js'
import { serializeProjectSettings, settingRaw } from 'three-slicer-viewer/settings'
import { plateCols, UPSTREAM_PLATE_GAP_RATIO } from './plate_layout.js'
import { DEFAULT_BED, SLA_POINT_RADIUS } from './viewer_defaults.js'
import { STL_HEADER_BYTES, STL_DATA_OFFSET, stlByteLength } from './stl_format.js'
import { md5Hex } from './md5.js'

// Deflate is the single largest cost of writing a project, and on the main thread every millisecond of it is a
//  frozen tab. fflate's async entry point moves it to a Web Worker pool — the mirror of what parse_3mf.js does for
//  reading. It is a deliberate trade, measured in the app on a 980k-facet model: going off-thread costs ~270ms of
//  total time (1.27s -> 1.53s, the price of handing the buffers across) and buys back more than twice that in
//  responsiveness — the longest frame gap drops from 1203ms to 515ms. The bigger the model the better that trade
//  gets, since the freeze grows with the deflate while the handover does not.
// The fallback is not defensive padding, for the same reason it is not there: `zip` needs the `Worker` global and
//  throws SYNCHRONOUSLY without it, which is every node caller (this package's own tests) and any environment
//  that refuses nested workers.
function zipAll(files, opts) {
  return new Promise((resolve, reject) => {
    let settled = false
    const done = (bytes) => { if (!settled) { settled = true; resolve(bytes) } }
    try {
      zip(files, opts, (err, bytes) => {
        if (!err) return done(bytes)
        try { done(zipSync(files, opts)) } catch (syncErr) { reject(syncErr) }
      })
    } catch {
      try { done(zipSync(files, opts)) } catch (syncErr) { reject(syncErr) }
    }
  })
}

const xmlEscape = (text) => String(text)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// Coordinates are written at 6 decimals — micron-level for a printer whose own resolution is ~10µm, and short
//  enough that a 100k-triangle model does not triple the file size on trailing zeros.
const num = (value) => {
  const rounded = Math.round(value * 1e6) / 1e6
  return Object.is(rounded, -0) ? '0' : String(rounded)
}

// A soup of triangles (flat x,y,z per vertex, 3 per face) -> indexed vertices. 3mf has no other form: <triangle>
//  references <vertex> by index. Welding keeps the FACET ORDER — which the painting is keyed by — identical to
//  the order the selector numbered, and on a real mesh it removes ~83% of the vertices (measured on a 980k-facet
//  sphere: 2.94M vertex slots -> 489k), so the XML it saves pays for itself many times over in the deflate.
// The key is the vertices' BIT PATTERN, not a string of their decimals. The coordinates are already float32, so
//  bit equality is coordinate equality — and the string form cost 708ms of a 980k-facet export against 89ms here,
//  because it built three `String(float)`s per vertex slot. Two levels because a Map key must be one value and
//  three 32-bit words do not fit in one double: x picks the bucket, (y,z) combine exactly inside it.
//  (+0 and -0 have different bits and so stay separate vertices — harmless, a 3mf may list a coordinate twice.)
function weld(tris) {
  const source = tris instanceof Float32Array ? tris : Float32Array.from(tris)
  const words = new Uint32Array(source.buffer, source.byteOffset, source.length)
  const buckets = new Map()
  const vertices = []
  const faces = new Int32Array(source.length / 3)
  for (let i = 0, f = 0; i < source.length; i += 3, f++) {
    let bucket = buckets.get(words[i])
    if (bucket === undefined) { bucket = new Map(); buckets.set(words[i], bucket) }
    const inner = words[i + 1] * 4294967296 + words[i + 2]
    let at = bucket.get(inner)
    if (at === undefined) {
      at = vertices.length / 3
      bucket.set(inner, at)
      vertices.push(source[i], source[i + 1], source[i + 2])
    }
    faces[f] = at
  }
  return { vertices, faces }
}

// Where an object goes in the FILE's coordinates. The viewer's plate origin is the plate's centre with a constant
//  40mm gap; upstream's is the corner with a gap of bed/5. Decoding is model_load.js platePlacements — this is the
//  same rule run backwards, so a project written here and reopened here lands where it started, and one opened in
//  OrcaSlicer lands on the plate it was saved on.
function upstreamPlateOrigin(plateIndex, plateTotal, bedWidth, bedDepth) {
  const cols = plateCols(Math.max(1, plateTotal))
  return {
    x: (plateIndex % cols) * bedWidth * (1 + UPSTREAM_PLATE_GAP_RATIO),
    y: -Math.floor(plateIndex / cols) * bedDepth * (1 + UPSTREAM_PLATE_GAP_RATIO),
  }
}

// The object's own XY centre, so the plate offset can be applied about it. Z is left alone: the viewer already
//  seats every object at z=0 (bakeLocal + placeOnBed), which is where a 3mf expects it.
function centreXY(tris) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (let i = 0; i < tris.length; i += 3) {
    if (tris[i] < minX) minX = tris[i]
    if (tris[i] > maxX) maxX = tris[i]
    if (tris[i + 1] < minY) minY = tris[i + 1]
    if (tris[i + 1] > maxY) maxY = tris[i + 1]
  }
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 }
}

// A growable byte sink. The mesh XML is built straight into bytes rather than as JS strings that are joined and
//  then encoded: the string path allocated ~1.5M chunks, joined them into one 79MB string and re-encoded THAT into
//  79MB of UTF-8 — measured at 410ms against 117ms here on a 980k-facet model, and it held two full copies of the
//  document at the peak. It grows instead of pre-sizing exactly because a painted facet's hex is its whole split
//  tree, which has no fixed length (one measured brush stroke was 1673 nibbles on a single facet).
function byteSink(initialSize) {
  let buffer = new Uint8Array(Math.max(1024, initialSize))
  let length = 0
  const room = (needed) => {
    if (length + needed <= buffer.length) return
    let size = buffer.length * 2
    while (size < length + needed) size *= 2
    const grown = new Uint8Array(size)
    grown.set(buffer.subarray(0, length))
    buffer = grown
  }
  return {
    // Every caller passes markup or an already-formatted number, so one byte per char holds.
    ascii(text) {
      room(text.length)
      for (let i = 0; i < text.length; i++) buffer[length++] = text.charCodeAt(i)
    },
    // Vertex indices are non-negative integers — writing the digits directly skips a String() per index, which at
    //  three per triangle was the single most repeated allocation in the document.
    int(value) {
      room(11)
      if (value === 0) { buffer[length++] = 48; return }
      const start = length
      let rest = value
      while (rest > 0) { buffer[length++] = 48 + (rest % 10); rest = (rest / 10) | 0 }
      for (let i = start, j = length - 1; i < j; i++, j--) { const swap = buffer[i]; buffer[i] = buffer[j]; buffer[j] = swap }
    },
    bytes: () => buffer.subarray(0, length),
  }
}

// The indentation is kept on purpose: dropping it makes the XML 11% smaller but the deflate SLOWER (646ms -> 705ms
//  measured), because regular whitespace is the most compressible thing in the document.
function meshBytes(object, shift, paintOf) {
  const { vertices, faces } = weld(object.tris)
  const sink = byteSink((vertices.length / 3) * 96 + (faces.length / 3) * 72 + 1024)
  sink.ascii('   <mesh>\n    <vertices>\n')
  for (let v = 0; v < vertices.length; v += 3) {
    sink.ascii('     <vertex x="'); sink.ascii(num(vertices[v] + shift.x))
    sink.ascii('" y="'); sink.ascii(num(vertices[v + 1] + shift.y))
    sink.ascii('" z="'); sink.ascii(num(vertices[v + 2])); sink.ascii('"/>\n')
  }
  sink.ascii('    </vertices>\n    <triangles>\n')
  for (let f = 0; f < faces.length; f += 3) {
    sink.ascii('     <triangle v1="'); sink.int(faces[f])
    sink.ascii('" v2="'); sink.int(faces[f + 1])
    sink.ascii('" v3="'); sink.int(faces[f + 2])
    sink.ascii('"'); sink.ascii(paintOf(f / 3)); sink.ascii('/>\n')
  }
  sink.ascii('    </triangles>\n   </mesh>\n')
  return sink.bytes()
}

// The document is a mix by design: the small markup around the meshes stays as strings (it is written once and
//  reads far better that way), while the meshes themselves arrive already in bytes.
function joinChunks(chunks) {
  const encoded = chunks.map(chunk => (typeof chunk === 'string' ? strToU8(chunk) : chunk))
  let total = 0
  for (const chunk of encoded) total += chunk.length
  const out = new Uint8Array(total)
  let at = 0
  for (const chunk of encoded) { out.set(chunk, at); at += chunk.length }
  return out
}

const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>
`

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
 <Default Extension="config" ContentType="text/xml"/>
 <Default Extension="png" ContentType="image/png"/>
</Types>
`

/**
 * Write a whole project as a 3mf.
 *   objects  — apiRef.exportObjects(): [{id, name, extruder, plate, tris, faceCount, paint}], in MERGE order
 *   settings — the viewer's settings map (real JS types); serialized to strings here
 *   opts.paintExport — {facets:Int32Array|number[], hex:string} straight off the kernel's selector_export_paint,
 *     in MERGED facet numbering. Rebased onto per-object numbering with the same running offset buildMergedSTL
 *     used, which is why `objects` must arrive in that same order.
 *   opts.paintKind — 'color' (material) | 'supports'; which annotation the kernel's marks are. One facet holds one
 *     state, so they can only be one or the other — the same constraint the import side reports.
 *   opts.bedWidth/bedDepth/plateCount — the plate grid to encode positions under.
 * Returns a Promise of a Uint8Array (the zip) — the compression runs off the main thread where it can.
 */
// What upstream's project format has no place for, in a member of our own. project_settings.config is ONE
//  flattened preset, typed by the schema, and upstream's <plate> metadata is a fixed set of keys (bed type, print
//  sequence, spiral mode, filament map — bbs_3mf.cpp), so two things used to be lost on every save: the per-plate
//  overrides (a plate's own tower, width, layer height...) and the viewer knobs in the global map that no schema
//  types (wipe_tower_real, sla_antialias). Plain JSON, because only this package reads it — the values keep their JS
//  types and need none of the string coercion project_settings.config does. Upstream ignores an unknown zip member,
//  so an OrcaSlicer open of the same file sees the global preset on every plate, exactly as before this existed.
//  Only plates that exist are written, and the plate count with them: an override left on a plate index the
//  import does not recreate would come back attached to whatever plate takes that index next.
export const VIEWER_SETTINGS_MEMBER = 'Metadata/three_slicer_settings.json'

// The per-facet paint attributes upstream's 3mf uses, one per annotation of the per-object store.
const PAINT_ATTRIBUTES = [['color', 'paint_color'], ['supports', 'paint_supports']]

// A hole in an array value — wipe_tower_x/y hold `null` for a plate whose tower is placed automatically — is not
//  something upstream can read, and not harmlessly: its loader rejects an array whose entries are not all strings
//  and then BREAKS OUT OF THE WHOLE KEY LOOP (Config.cpp load_from_json, `parse_str_arr` -> `break;`). Keys are
//  visited in sorted order, so one `null` in wipe_tower_x silently dropped the 17 keys after it — z_hop, z_offset,
//  xy_hole_compensation among them (measured with upstream's own parse loop on a file this writer produced).
//  Upstream has no "automatic" position, so the hole is written as the schema default (what a fresh upstream plate
//  holds), and the original array — holes included — goes to our own member, whose values the import lays over
//  project_settings.config, so this viewer still reads "automatic". Mutates `projectSettings`; returns the
//  originals it replaced.
function fillArrayHoles(projectSettings, settings) {
  const holed = {}
  for (const [key, value] of Object.entries(projectSettings)) {
    const original = settings?.[key]
    if (!Array.isArray(value) || !Array.isArray(original)) continue
    // A hole is judged on the ORIGINAL entry (null, or a sparse array's missing slot — Array.from reads it as
    //  undefined), not on the serialized one: serializeScalar writes null as '', and '' is also a legitimate blank
    //  in a string vector (a filament slot with no preset id), which must stay as written.
    const holes = Array.from(original, entry => entry == null)
    if (!holes.some(Boolean)) continue
    // The default in upstream's spelling for its type (a bool as "0"/"1", a point as "XxY") — a String() of it wrote
    //  "false", which upstream rejects, ending its key loop exactly as a null did.
    const fallback = [settingRaw({}, key)].flat()[0]
    const fallbackText = serializeProjectSettings({ [key]: [fallback] })[key]?.[0] ?? ''
    projectSettings[key] = holes.map((hole, at) => {
      if (hole) return fallbackText
      return value[at]
    })
    holed[key] = original
  }
  return holed
}
function viewerSettingsSidecar(settings, projectSettings, plateSettings, plateCount, holed = {}) {
  const viewer = { ...Object.fromEntries(Object.entries(settings ?? {}).filter(([key]) => !(key in projectSettings))), ...holed }
  const plates = Object.fromEntries(Object.entries(plateSettings ?? {})
    .filter(([plate, map]) => Number(plate) < plateCount && map && Object.keys(map).length))
  if (!Object.keys(viewer).length && !Object.keys(plates).length) return null
  // The plate count too: the <plate> records hold only plates with objects, so an EMPTY plate that carries an
  //  override would not exist after import, and its override would attach to whatever plate took that index next.
  return { version: 1, viewer, plates, plateCount }
}

export async function write3MFProject(objects, settings, opts = {}) {
  const {
    paintExport = null, paintKind = 'color', bedWidth = DEFAULT_BED.width, bedDepth = DEFAULT_BED.depth, plateCount = 1,
    application = 'ThreeSlicer', plateSettings = null,
  } = opts
  if (!objects?.length) throw new Error('nothing to export')

  // The kernel's facets are numbered across the merged mesh; a 3mf's are per object. Rebasing needs the same
  //  running offset the merge used — so the caller's object order must be the merge order (exportObjects sorts by
  //  extruder exactly as buildMergedSTL does). Anything landing outside an object's range is dropped rather than
  //  guessed at, because a mis-rebased facet paints a different part of the model.
  const paintByObject = new Map()
  if (paintExport?.facets?.length) {
    const hexLines = String(paintExport.hex ?? '').split('\n')
    const bases = []
    let running = 0
    for (const object of objects) { bases.push(running); running += object.faceCount }
    for (let i = 0; i < paintExport.facets.length; i++) {
      const facet = paintExport.facets[i], hex = hexLines[i]
      if (!hex) continue
      let at = -1
      for (let o = 0; o < objects.length; o++) if (facet >= bases[o] && facet < bases[o] + objects[o].faceCount) { at = o; break }
      if (at < 0) continue
      if (!paintByObject.has(at)) paintByObject.set(at, new Map())
      paintByObject.get(at).set(facet - bases[at], hex)
    }
  }
  // Every annotation goes under its OWN attribute, from each object's own marks (the per-object store) — upstream
  //  keeps material and support paint as two annotations a facet can carry both of. One attribute for the whole
  //  file, picked from the brush last used, filed one plate's material paint as another's support paint, and an
  //  EMPTY support map shadowed the object's real material paint so nothing was written (measured: color 1,
  //  supports 0 in -> color 0, supports 0 back). A merge-numbered kernel export (`paintExport`) stands in for the
  //  `paintKind` annotation it describes. An empty map is no paint.
  const marksOf = (object, at, kind) => {
    if (kind === paintKind && paintByObject.has(at)) return paintByObject.get(at)
    const marks = object.paint?.[kind]
    if (marks?.size) return marks
    return null
  }

  const modelParts = [
    '<?xml version="1.0" encoding="UTF-8"?>\n',
    '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"',
    ' xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">\n',
    ` <metadata name="Application">${xmlEscape(application)}</metadata>\n`,
    ' <resources>\n',
  ]
  const items = []
  const volumeRanges = []
  objects.forEach((object, at) => {
    const objectId = at + 1                     // 3mf ids are 1-based and must be unique within the model part
    const origin = upstreamPlateOrigin(object.plate ?? 0, plateCount, bedWidth, bedDepth)
    // The object's placement ON its plate is what carries over; only the plate frames differ. The viewer's origin
    //  is the plate CENTRE, upstream's is the corner — so subtracting the viewer origin and adding the upstream one
    //  plus half a bed re-expresses the same position. Exactly what model_load.js platePlacements decodes.
    const shift = {
      x: origin.x + bedWidth / 2 - (object.plateOriginX ?? 0),
      y: origin.y + bedDepth / 2 - (object.plateOriginY ?? 0),
    }

    const annotations = PAINT_ATTRIBUTES
      .map(([kind, attribute]) => [attribute, marksOf(object, at, kind)])
      .filter(([, marks]) => marks)
    const paintOf = (face) => {
      let attributes = ''
      for (const [attribute, marks] of annotations) {
        const hex = marks.get(face)
        if (hex) attributes += ` ${attribute}="${hex}"`
      }
      return attributes
    }
    const modifiers = object.sla?.modifierVolumes || []
    const parts = [object.tris, ...modifiers.map(modifier => modifier.tris)]
    const length = parts.reduce((sum, part) => sum + part.length, 0)
    const combined = new Float32Array(length)
    let writeAt = 0
    for (const part of parts) { combined.set(part, writeAt); writeAt += part.length }
    const ranges = [{ first: 0, last: object.tris.length / 9 - 1, type: 'ModelPart' }]
    let face = object.tris.length / 9
    for (const modifier of modifiers) {
      const count = modifier.tris.length / 9
      ranges.push({ first: face, last: face + count - 1, type: modifier.kind === 'enforcer' ? 'SupportEnforcer' : 'SupportBlocker' })
      face += count
    }
    volumeRanges.push(ranges)
    modelParts.push(`  <object id="${objectId}" type="model">\n`)
    modelParts.push(meshBytes({ tris: combined }, shift, paintOf))
    modelParts.push('  </object>\n')
    items.push(`  <item objectid="${objectId}" transform="1 0 0 0 1 0 0 0 1 0 0 0" printable="1"/>\n`)
  })
  modelParts.push(' </resources>\n <build>\n', ...items, ' </build>\n</model>\n')

  // Per-object state: name and extruder are what this viewer owns (the import applies exactly these two).
  const objectConfig = ['<?xml version="1.0" encoding="UTF-8"?>\n<config>\n']
  objects.forEach((object, at) => {
    objectConfig.push(`  <object id="${at + 1}">\n`)
    objectConfig.push(`    <metadata key="name" value="${xmlEscape(object.name ?? `object_${at + 1}`)}"/>\n`)
    objectConfig.push(`    <metadata key="extruder" value="${object.extruder ?? 1}"/>\n`)
    for (const range of volumeRanges[at]) {
      objectConfig.push(`    <volume firstid="${range.first}" lastid="${range.last}">\n`)
      objectConfig.push(`      <metadata key="volume_type" value="${range.type}"/>\n`)
      objectConfig.push('    </volume>\n')
    }
    objectConfig.push('  </object>\n')
  })
  // plater_id is 1-based upstream; the viewer's plates are 0-based (parse_3mf.js reads it back the same way).
  // A record for EVERY plate, the empty ones included, as upstream writes them: the importer lays its grid out from
  //  the number of records, and one short (an empty plate between two occupied ones) moved every column —
  //  objects failed to decode onto their plates and fell back to group-centred placement.
  const plates = new Map()
  for (let plate = 0; plate < plateCount; plate++) plates.set(plate, [])
  objects.forEach((object, at) => {
    const plate = object.plate ?? 0
    if (!plates.has(plate)) plates.set(plate, [])
    plates.get(plate).push(at + 1)
  })
  for (const [plate, ids] of [...plates.entries()].sort((a, b) => a[0] - b[0])) {
    objectConfig.push('  <plate>\n')
    objectConfig.push(`    <metadata key="plater_id" value="${plate + 1}"/>\n`)
    for (const id of ids)
      objectConfig.push(`    <model_instance>\n      <metadata key="object_id" value="${id}"/>\n      <metadata key="instance_id" value="0"/>\n    </model_instance>\n`)
    objectConfig.push('  </plate>\n')
  }
  objectConfig.push('</config>\n')

  const files = {
    '_rels/.rels': strToU8(RELS),
    '[Content_Types].xml': strToU8(CONTENT_TYPES),
    '3D/3dmodel.model': joinChunks(modelParts),
    'Metadata/model_settings.config': strToU8(objectConfig.join('')),
  }
  const projectSettings = serializeProjectSettings(settings)
  const holed = fillArrayHoles(projectSettings, settings)
  if (Object.keys(projectSettings).length)
    files['Metadata/project_settings.config'] = strToU8(JSON.stringify(projectSettings, null, 4) + '\n')
  const sidecar = viewerSettingsSidecar(settings, projectSettings, plateSettings, plateCount, holed)
  if (sidecar) files[VIEWER_SETTINGS_MEMBER] = strToU8(JSON.stringify(sidecar, null, 2) + '\n')

  const supportLines = []
  const drainLines = []
  objects.forEach((object, at) => {
    const points = object.sla?.supportPoints || []
    if (points.length) supportLines.push(`object_id=${at + 1}|${points.map(point => {
      const type = point.type === 'manual' ? 2 : point.type === 'island' ? 1 : 3
      return [...point.position, point.radius ?? SLA_POINT_RADIUS, type].map(num).join(' ')
    }).join(' ')}`)
    const holes = object.sla?.drainHoles || []
    if (holes.length) drainLines.push(`object_id=${at + 1}|${holes.map(hole => {
      const length = Math.hypot(...hole.normal)
      const normal = length ? hole.normal.map(value => value / length) : hole.normal
      const storedPosition = hole.position.map((value, axis) => value - normal[axis])
      return [...storedPosition, ...normal, hole.radius, hole.height + 1].map(num).join(' ')
    }).join(' ')}`)
  })
  if (supportLines.length)
    files['Metadata/Slic3r_PE_sla_support_points.txt'] = strToU8(`support_points_format_version=1\n${supportLines.join('\n')}\n`)
  if (drainLines.length)
    files['Metadata/Slic3r_PE_sla_drain_holes.txt'] = strToU8(`drain_holes_format_version=1\n${drainLines.join('\n')}\n`)

  // level 3, not the 6 that looks like the safe default: a 3mf is XML, which deflate shreds at any level, so 6
  //  buys nothing here and costs the user seconds of a frozen tab. Measured on a 980k-facet sphere (79MB of XML):
  //  level 6 = 1445ms -> 7.94MB, level 3 = 781ms -> 7.92MB. Level 3 is both faster AND smaller on this input;
  //  level 1 (681ms -> 8.77MB) starts giving real size back, so 3 is where the curve turns.
  return zipAll(files, { level: 3 })
}

// ---- .gcode.3mf — upstream's "Export all plate sliced file" -------------------------------------------------
// The same container, a different payload: upstream writes it with SaveStrategy SkipModel | WithGcode
//  (Plater.cpp export_gcode_3mf), so the meshes are left out and each sliced plate's G-code rides as
//  Metadata/plate_N.gcode, named by a `gcode_file` entry on its <plate> record, with its MD5 beside it (the
//  printer checks it) and the plate's estimate in Metadata/slice_info.config. It is a print job, not a project:
//  opening one shows the result and nothing in it can be re-sliced — which is also how upstream opens it.
export const gcodeMemberOf = (plate) => `Metadata/plate_${plate + 1}.gcode`

const GCODE_CONTENT_TYPES = CONTENT_TYPES.replace('</Types>',
  ' <Default Extension="gcode" ContentType="text/x.gcode"/>\n</Types>')

const EMPTY_MODEL = '<?xml version="1.0" encoding="UTF-8"?>\n'
  + '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n'
  + ' <resources>\n </resources>\n <build>\n </build>\n</model>\n'

// Grams from millimetres of filament, per tool: the filament's cross-section times its density (g/cm3), as upstream
//  derives used_g. A tool without a density or diameter weighs 0 rather than NaN.
function filamentGrams(millimetres, tool, settings) {
  const pick = (key) => Number([settingRaw(settings, key)].flat()[tool] ?? [settingRaw(settings, key)].flat()[0]) || 0
  const radius = pick('filament_diameter') / 2
  return millimetres * Math.PI * radius * radius * pick('filament_density') / 1000
}

function sliceInfoPlate(plate, stats, settings) {
  const byTool = Array.isArray(stats?.filament_mm_by_tool) ? stats.filament_mm_by_tool : [stats?.filament_mm ?? 0]
  const filaments = byTool.map((millimetres, tool) => ({ tool, millimetres: Number(millimetres) || 0 }))
    .filter(entry => entry.millimetres > 0)
  const colors = [settingRaw(settings, 'filament_colour')].flat()
  const types = [settingRaw(settings, 'filament_type')].flat()
  const grams = filaments.reduce((sum, entry) => sum + filamentGrams(entry.millimetres, entry.tool, settings), 0)
  const lines = [
    '  <plate>\n',
    `    <metadata key="index" value="${plate + 1}"/>\n`,
    `    <metadata key="prediction" value="${Math.round(Number(stats?.time_estimate) || 0)}"/>\n`,
    `    <metadata key="weight" value="${grams.toFixed(2)}"/>\n`,
    `    <metadata key="outside" value="${stats?.over_bed ? 'true' : 'false'}"/>\n`,
  ]
  for (const entry of filaments) {
    lines.push(`    <filament id="${entry.tool + 1}" type="${xmlEscape(types[entry.tool] ?? '')}"`
      + ` color="${xmlEscape(colors[entry.tool] ?? '')}" used_m="${(entry.millimetres / 1000).toFixed(2)}"`
      + ` used_g="${filamentGrams(entry.millimetres, entry.tool, settings).toFixed(2)}"/>\n`)
  }
  lines.push('  </plate>\n')
  return lines.join('')
}

/**
 * Sliced plates -> a .gcode.3mf (Uint8Array, via a Promise — the deflate runs off-thread like the project writer's).
 *   plates: [{ index, gcode, stats }] — plateResultsRef's own shape; `index` is the 0-based plate.
 *   settings: the global map, written as project_settings.config exactly as a project save writes it.
 *   opts.plateCount — every plate gets a <plate> record, sliced or not, as the project writer does.
 */
export async function writeGcode3MF(plates, settings, opts = {}) {
  const { plateCount = 1, application = 'ThreeSlicer' } = opts
  const sliced = (plates ?? []).filter(plate => typeof plate?.gcode === 'string' && plate.gcode.length)
    .sort((left, right) => left.index - right.index)
  if (!sliced.length) throw new Error('no sliced plate to export')
  const encoder = new TextEncoder()
  const files = {
    '_rels/.rels': strToU8(RELS),
    '[Content_Types].xml': strToU8(GCODE_CONTENT_TYPES),
    '3D/3dmodel.model': strToU8(EMPTY_MODEL),
  }
  const byPlate = new Map(sliced.map(plate => [plate.index, plate]))
  const plateTotal = Math.max(plateCount, sliced.at(-1).index + 1)
  const modelConfig = ['<?xml version="1.0" encoding="UTF-8"?>\n<config>\n']
  const sliceInfo = ['<?xml version="1.0" encoding="UTF-8"?>\n<config>\n',
    `  <header>\n    <header_item key="X-BBL-Client-Type" value="slicer"/>\n    <header_item key="X-BBL-Client-Version" value="${xmlEscape(application)}"/>\n  </header>\n`]
  for (let plate = 0; plate < plateTotal; plate++) {
    modelConfig.push('  <plate>\n', `    <metadata key="plater_id" value="${plate + 1}"/>\n`)
    const result = byPlate.get(plate)
    if (result) {
      const member = gcodeMemberOf(plate)
      const bytes = encoder.encode(result.gcode)
      files[member] = bytes
      files[`${member}.md5`] = strToU8(md5Hex(bytes))
      modelConfig.push(`    <metadata key="gcode_file" value="${member}"/>\n`)
      sliceInfo.push(sliceInfoPlate(plate, result.stats, settings))
    }
    modelConfig.push('  </plate>\n')
  }
  modelConfig.push('</config>\n')
  sliceInfo.push('</config>\n')
  files['Metadata/model_settings.config'] = strToU8(modelConfig.join(''))
  files['Metadata/slice_info.config'] = strToU8(sliceInfo.join(''))
  const projectSettings = serializeProjectSettings(settings)
  fillArrayHoles(projectSettings, settings)
  if (Object.keys(projectSettings).length)
    files['Metadata/project_settings.config'] = strToU8(JSON.stringify(projectSettings, null, 4) + '\n')
  return zipAll(files, { level: 3 })
}

/** Binary STL of a triangle soup (flat x,y,z per vertex, 3 vertices per face) — the plain mesh export.
 *  Facet normals are computed the way upstream computes them (`its_write_stl_binary`, TriangleMesh.cpp:1650):
 *  `(v1-v0) × (v2-v1)`, normalized. Leaving them zero is tolerated by anything that recomputes from winding —
 *  this viewer's own parser ignores the field entirely — but they are a required part of the format, and at a
 *  measured 16ms per million facets there is no reason to ship a file that leans on the reader's forgiveness.
 *  A degenerate triangle has no direction to point in, so its normal stays zero rather than becoming NaN. */
export function writeSTL(tris, header = 'ThreeSlicer export') {
  const faceCount = tris.length / 9
  const buffer = new ArrayBuffer(stlByteLength(faceCount))
  const view = new DataView(buffer)
  new Uint8Array(buffer, 0, STL_HEADER_BYTES).set(strToU8(header.slice(0, STL_HEADER_BYTES - 1)))
  view.setUint32(STL_HEADER_BYTES, faceCount, true)
  let at = STL_DATA_OFFSET, read = 0
  for (let f = 0; f < faceCount; f++) {
    const ax = tris[read + 3] - tris[read], ay = tris[read + 4] - tris[read + 1], az = tris[read + 5] - tris[read + 2]
    const bx = tris[read + 6] - tris[read + 3], by = tris[read + 7] - tris[read + 4], bz = tris[read + 8] - tris[read + 5]
    let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx
    const len = Math.hypot(nx, ny, nz)
    if (len > 0) { nx /= len; ny /= len; nz /= len } else { nx = ny = nz = 0 }
    view.setFloat32(at, nx, true); view.setFloat32(at + 4, ny, true); view.setFloat32(at + 8, nz, true)
    at += 12
    for (let v = 0; v < 3; v++) {
      view.setFloat32(at, tris[read++], true)
      view.setFloat32(at + 4, tris[read++], true)
      view.setFloat32(at + 8, tris[read++], true)
      at += 12
    }
    view.setUint16(at, 0, true); at += 2
  }
  return new Uint8Array(buffer)
}
