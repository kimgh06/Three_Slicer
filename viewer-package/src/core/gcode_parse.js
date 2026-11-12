// G-code -> kernel-shaped layer stream. Lets the GPU toolpath renderer draw an external .gcode file
//  (or the kernel's own output) without slicing: parseGcode(text) returns layers[{z, paths, widths}] in the
//  exact contract buildSegmentData consumes (paths stride 8: [x0,y0,z0,enc, x1,y1,z1,enc], enc = role + tool*16,
//  widths one entry per segment — see toolpath_segments.js).
// Recognized input: G0/G1 linear moves, G2/G3 I/J arcs, G90/G91, M82/M83, G92, T<n> tool changes (n <= 254),
//  and the role/layer comment conventions of OrcaSlicer/PrusaSlicer (;TYPE: ;WIDTH: ;LAYER_CHANGE ;Z:),
//  Cura (;TYPE: ;LAYER:) and this kernel ("; LAYER n Zx.xxx", "; walls"-style feature markers).
// Roles the stream cannot state are recovered lossily: unknown ;TYPE: names fall back to wall(1), and when no
//  ;WIDTH: comment is present the bead width is derived from E (filament cross-section · ΔE = width · height · length).
// ponytail: no R-form arcs (I/J only — neither Orca, Prusa, Cura nor this kernel emits R), no G10/G11
//  firmware retract, no vase-mode layer splitting for comment-less files; extend when such a file actually shows up.

import { DEFAULT_FILAMENT_DIAMETER, DEFAULT_LAYER_HEIGHT } from './viewer_defaults.js'
import { ROLE, STRIDE, encodeRole } from './toolpath_encoding.js'
import { TOOL_COLOR } from './toolpath_palette.js'
// The placeholders the kernel leaves for the finished estimate (M73 progress, file_start_gcode's totals).
export { finalizeGcode } from './finalize_gcode.js'
// A finished slice made what the viewer shows (finalized, read back), for the slicer worker to run beside the kernel.
export { asExported, finalizedExport, hasReadBack, readBack } from './exported_preview.js'

const EPS = 1e-6
// Upstream's highest real tool id (GCodeProcessor::process_T). Bambu start/end G-code carries T255, T1000, T1001,
//  T1100, T65279 and T65535 as firmware opcodes, not tool changes; reading them as tools stamped the purge line
//  as "tool 1000" and put a bogus entry in the tool list.
const MAX_TOOL = 254
// `; filament_colour = #RRGGBB;#RRGGBB` (Orca/Bambu/Prusa config block) and `; extruder_colour = …` (Prusa, where
//  an empty entry means "use the filament colour"). The exact key only: Orca also writes filament_colour_type and
//  filament_multi_colour, which are not the palette.
const COLOUR_LINE = /^(filament|extruder)_colour\s*=\s*(.*)$/i
const colourList = (value) => value.split(/[;,]/).map(entry => {
  const match = /^"?#?([0-9a-f]{6})(?:[0-9a-f]{2})?"?$/i.exec(entry.trim())   // #RRGGBBAA keeps its RGB
  if (!match) return null
  return '#' + match[1].toUpperCase()
})

// The categorical colour computeColors falls back to for a tool no palette names, as a hex string.
const toolHex = (index) => '#' + TOOL_COLOR[index % TOOL_COLOR.length]
  .map(channel => Math.round(channel * 255).toString(16).padStart(2, '0')).join('')

// The one colour list of a result: what its toolpath is drawn in, what both legends show and what its export
//  states. The file's own colours come first — G-code colours belong to the file (upstream's G-code viewer reads
//  them from it, GCodeProcessor.cpp:3291) — then the session palette, then the categorical stand-in. Every tool the
//  result extruded with gets an entry: a file can use more tools than the session has filaments, and T3 used to be
//  green on the toolpath, grey in the stats card and missing from the view legend.
export function resultToolColors(stats, sessionColors) {
  let own = []
  if (Array.isArray(stats?.colors)) own = stats.colors
  const session = sessionColors ?? []
  const length = Math.max(own.length, session.length, stats?.filament_mm_by_tool?.length ?? 0)
  return Array.from({ length }, (_unused, index) => own[index] || session[index] || toolHex(index))
}

// A result's G-code as it is saved: with the colour list above stated in it.
export function exportedGcode(result, sessionColors) {
  return withFilamentColours(result.gcode, resultToolColors(result.stats, sessionColors))
}

// Appends the palette to G-code that does not state one, so an exported file opens in its own colours here and in
//  upstream's viewer. The kernel does not write it (its G-code is golden-pinned); a file that already carries a
//  palette — an opened .gcode saved again — keeps its own.
export function withFilamentColours(gcode, colors) {
  const text = String(gcode ?? '')
  const valid = [colors].flat().filter(Boolean)
  if (!valid.length || /^;\s*filament_colour\s*=/mi.test(text)) return text
  const line = '; filament_colour = ' + valid.join(';') + '\n'
  // Upstream reads settings only between ; CONFIG_BLOCK_START and ; CONFIG_BLOCK_END (Config.cpp
  //  load_from_gcode_file), so where the file has that block the line goes inside it.
  const blockEnd = text.lastIndexOf('\n; CONFIG_BLOCK_END')
  if (blockEnd >= 0) return text.slice(0, blockEnd + 1) + line + text.slice(blockEnd + 1)
  let separator = '\n'
  if (!text || text.endsWith('\n')) separator = ''
  return text + separator + line
}
const ROLE_BY_NAME = {
  // OrcaSlicer / PrusaSlicer ;TYPE: names
  'outer wall': ROLE.WALL, 'external perimeter': ROLE.WALL, 'inner wall': ROLE.WALL, 'perimeter': ROLE.WALL,
  'internal perimeter': ROLE.WALL,
  'overhang wall': ROLE.WALL, 'overhang perimeter': ROLE.WALL, 'sparse infill': ROLE.SPARSE,
  'internal infill': ROLE.SPARSE,
  'solid infill': ROLE.SOLID, 'internal solid infill': ROLE.SOLID, 'top solid infill': ROLE.SOLID,
  'top surface': ROLE.SOLID, 'bottom surface': ROLE.SOLID,
  'skirt': ROLE.SKIRT, 'brim': ROLE.SKIRT, 'skirt/brim': ROLE.SKIRT,
  'support': ROLE.SUPPORT, 'support material': ROLE.SUPPORT, 'support material interface': ROLE.SUPPORT,
  'support interface': ROLE.SUPPORT, 'support transition': ROLE.SUPPORT,
  'raft': ROLE.RAFT, 'gap fill': ROLE.GAP, 'gap infill': ROLE.GAP, 'thin wall': ROLE.THIN,
  'bridge': ROLE.BRIDGE, 'bridge infill': ROLE.BRIDGE, 'internal bridge': ROLE.BRIDGE,
  'internal bridge infill': ROLE.BRIDGE,
  'ironing': ROLE.IRONING, 'prime tower': ROLE.PRIME, 'wipe tower': ROLE.PRIME, 'custom': ROLE.WALL,
  // Cura ;TYPE: names
  'wall-outer': ROLE.WALL, 'wall-inner': ROLE.WALL, 'fill': ROLE.SPARSE, 'skin': ROLE.SOLID,
  'support-interface': ROLE.SUPPORT, 'prime-tower': ROLE.PRIME,
}
// This kernel's own free-form feature comments ("; walls (Arachne — ...)"), longest key first.
const KERNEL_MARK = [
  ['skirt/brim', ROLE.SKIRT], ['skirt', ROLE.SKIRT], ['walls', ROLE.WALL], ['thin-wall', ROLE.THIN], ['gap-fill', ROLE.GAP],
  ['bridge', ROLE.BRIDGE], ['ironing', ROLE.IRONING], ['support', ROLE.SUPPORT], ['prime tower', ROLE.PRIME], ['wipe_tower_real', ROLE.PRIME],
]
// The key must be the whole comment or end at a word boundary. A plain prefix test is wrong: this kernel's header
//  carries "; skirt=1@2.0mm brim=0.0mm …", which starts with "skirt" while describing settings, not a feature —
//  measured, it stamped every segment in the file as skirt because the header runs before the first layer.
const markMatches = (comment, key) =>
  comment === key || key.length < comment.length && ' (:/'.includes(comment[key.length]) && comment.startsWith(key)
// PrusaSlicer's `;_EXTRUSION_ROLE:<n>` tag (GCodeExtrusionRole), which this kernel emits too when tag mode is on
//  (gcode_writer.h pe_begin_run). Exact and per-run, unlike the free-form comments above — so it wins when present.
const PE_ROLE = {
  1: ROLE.WALL, 2: ROLE.WALL, 3: ROLE.WALL, 4: ROLE.SPARSE, 5: ROLE.SOLID, 6: ROLE.SOLID, 7: ROLE.SOLID, 8: ROLE.IRONING, 9: ROLE.BRIDGE, 10: ROLE.BRIDGE, 11: ROLE.GAP,
  12: ROLE.SKIRT, 13: ROLE.SKIRT, 14: ROLE.SUPPORT, 15: ROLE.SUPPORT, 16: ROLE.SUPPORT, 17: ROLE.PRIME,
}

// parseGcode(text, {filamentDiameter=1.75, defaultLayerHeight=0.2}) ->
//   { layers: [{z, paths: Float32Array, widths: Float32Array}],
//     stats: {layers, path_segments, travel_segments, filament_mm, tools, filament_mm_by_tool, colors?} }
// The layers a slice is previewed with, read back from the very G-code it exports, so the preview is the file: the
//  printer's start and end G-code extrusions included (an A1 mini draws its calibration lines in front of the bed),
//  arcs as the parser divides them. The kernel's own toolpath stream left those out, and a sliced plate and the
//  same file opened again looked different (measured on a benchy: 240 vs 241 layers, 5255.5 vs 5279.3 mm).
//  The G-code is in printer coordinates; a slice's layers are plate-local, so the bed centre comes back off.
//  Returns parseGcode's shape: the layers and the figures counted from the same text (layers, segments, filament).
export function previewFromGcode(gcode, { center = { x: 0, y: 0 }, filamentDiameter, layerHeight } = {}) {
  const parsed = parseGcode(gcode, { filamentDiameter, defaultLayerHeight: layerHeight })
  for (const layer of parsed.layers) {
    const paths = layer.paths
    for (let k = 0; k + STRIDE <= paths.length; k += STRIDE) {
      paths[k] -= center.x; paths[k + 1] -= center.y; paths[k + 4] -= center.x; paths[k + 5] -= center.y
    }
  }
  return parsed
}

// A layer's segments are written into Float32Arrays that double as they fill, and the text is walked line by line.
//  The parser used to keep every number in plain arrays and every line in one array, all of it on the JS heap, and
//  every JS heap of a tab (the page's and each worker's) shares one 4 GB region in Chrome. With the read-back running
//  in the slicer workers, several large plates parsed at once and the tab died with "V8 javascript OOM" (measured on a
//  28-plate project, 224 MB of G-code: 4 crashes in 23 slice-all runs; one 21.5 MB plate held 2.9M segments, 188 MB
//  as doubles). A typed array's numbers live outside that region.
const INITIAL_SEGMENTS = 256
// code.split(/\s+/) for a trimmed command, without the regex: G-code separates words with ASCII blanks. A line with
//  any other character class goes to the regex itself.
const ASCII_LIMIT = 127, SPACE = 32, TAB = 9, CARRIAGE_RETURN = 13
const isBlank = (character) => character === SPACE || (character >= TAB && character <= CARRIAGE_RETURN)
// Character codes fastMove reads, and its limits: "G1 " is three characters; 15 decimal digits fit a double exactly.
const UPPER_G = 71, SEMICOLON = 59, MINUS = 45, PLUS = 43, POINT = 46, DIGIT_0 = 48, DIGIT_9 = 57
const LOWER_CASE_BIT = 32, LOWER_A = 97, LOWER_Z = 122, LOWER_X = 120, LOWER_Y = 121, LOWER_E = 101, LOWER_I = 105, LOWER_J = 106
const FAST_PREFIX = 3, EXACT_DIGITS = 15
const POWER_OF_TEN = Array.from({ length: EXACT_DIGITS + 1 }, (_unused, exponent) => 10 ** exponent)
const ARC_OF = { G2: 2, G3: 3 }
function wordsOf(code) {
  const words = []
  let wordStart = -1
  for (let index = 0; index < code.length; index++) {
    const character = code.charCodeAt(index)
    if (character > ASCII_LIMIT) return code.split(/\s+/)
    const blank = isBlank(character)
    if (blank && wordStart >= 0) { words.push(code.slice(wordStart, index)); wordStart = -1 }
    if (!blank && wordStart < 0) wordStart = index
  }
  if (wordStart >= 0) words.push(code.slice(wordStart))
  return words
}

export function parseGcode(text, opts = {}) {
  const filArea = Math.PI / 4 * (opts.filamentDiameter > 0 ? opts.filamentDiameter : DEFAULT_FILAMENT_DIAMETER) ** 2
  const defH = opts.defaultLayerHeight > 0 ? opts.defaultLayerHeight : DEFAULT_LAYER_HEIGHT

  let x = 0, y = 0, z = 0, e = 0, absXYZ = true, absE = true   // RepRap defaults: G90 + M82
  let tool = 0, role = ROLE.WALL, width = 0                            // width 0 -> derive from E per segment
  let cur = null                                               // open layer {z, p, w, segments}: see appendSegment
  const layers = []
  let markerMode = false                                       // a layer-change comment was seen -> trust markers only
  let pendingLayer = true                                      // next extrusion (or ;Z:) opens a layer
  let pendingZ = NaN
  let nSeg = 0, nTravel = 0, filament = 0
  const tools = new Set([0])
  const filamentByTool = []                                    // mm of filament per tool index, the kernel's filament_mm_by_tool
  let filamentColours = [], extruderColours = []

  // A layer change resets the role and the width back to "unstated". They are per-run markers: this kernel writes
  //  "; skirt" once, for the skirt of layer 0, and nothing afterwards — carrying that across the whole file painted
  //  every layer as skirt. Unstated means wall(1) for the role and E-derived for the width.
  // The reset happens at the layer MARKER, not where the layer is opened: a layer opens lazily at its first
  //  extrusion, after any ;TYPE: written between the marker and that move, and resetting there threw the tag away
  //  (Cura's ";LAYER:n" then ";TYPE:", and this kernel's raft layers, which carry no "; LAYER" line at all). A layer
  //  opened by a z rise alone still resets — unless the file states roles with tags, where the last tag holds.
  let tagged = false
  const unstate = () => { role = ROLE.WALL; width = 0 }
  const openLayer = (lz, fromMarker = false) => {
    cur = { z: lz, p: new Float32Array(INITIAL_SEGMENTS * STRIDE), w: new Float32Array(INITIAL_SEGMENTS), segments: 0 }; layers.push(cur)
    pendingLayer = false; pendingZ = NaN
    if (fromMarker || !tagged) unstate()
  }
  const prevLayerZ = () => (layers.length > 1 ? layers[layers.length - 2].z : 0)

  // One segment appended to the open layer: stride-8 path floats and its width.
  const appendSegment = (x0, y0, z0, x1, y1, z1, enc, segmentWidth) => {
    if (cur.segments === cur.w.length) {
      const paths = new Float32Array(cur.p.length * 2), widths = new Float32Array(cur.w.length * 2)
      paths.set(cur.p); widths.set(cur.w)
      cur.p = paths; cur.w = widths
    }
    const at = cur.segments * STRIDE, paths = cur.p
    paths[at] = x0; paths[at + 1] = y0; paths[at + 2] = z0; paths[at + 3] = enc
    paths[at + 4] = x1; paths[at + 5] = y1; paths[at + 6] = z1; paths[at + 7] = enc
    cur.w[cur.segments] = segmentWidth
    cur.segments++
  }
  const pushSeg = (x0, y0, z0, x1, y1, z1, dE) => {
    const dist = Math.hypot(x1 - x0, y1 - y0, z1 - z0)
    if (dist < EPS) return
    if (dE > EPS) {                                            // extrusion
      filament += dE
      filamentByTool[tool] = (filamentByTool[tool] ?? 0) + dE
      if (pendingLayer && Number.isNaN(pendingZ)) openLayer(z1)
      else if (pendingLayer) openLayer(pendingZ)
      else if (!markerMode && z1 > cur.z + 1e-3) openLayer(z1) // comment-less fallback: new layer on z rise
      const h = Math.max(0.02, cur.z - prevLayerZ() || defH)
      // Inverse of the upstream rounded-rectangle bead: cross-section = h·(w − h·(1−π/4))  ->  w = A/h + h·(1−π/4)
      let w = width
      if (!(width > 0)) w = dE * filArea / (dist * h) + h * (1 - Math.PI / 4)
      appendSegment(x0, y0, z0, x1, y1, z1, encodeRole(role, tool), Math.min(3, Math.max(0.05, w)))
      nSeg++
    } else if (cur) {                                          // travel (drop pre-first-layer homing moves)
      appendSegment(x0, y0, z0, x1, y1, z1, encodeRole(ROLE.TRAVEL, tool), 0)
      nTravel++
    }
  }

  // A G0-G3 move with the words its line gave (NaN: not given). `arc` is 0 for a straight move, 2 or 3 for G2 / G3.
  const move = (arc, nx, ny, nz, ne, ai, aj) => {
    let x1 = x, y1 = y, z1 = z, dE = 0
    if (!Number.isNaN(nx)) { x1 = nx; if (!absXYZ) x1 = x + nx }
    if (!Number.isNaN(ny)) { y1 = ny; if (!absXYZ) y1 = y + ny }
    if (!Number.isNaN(nz)) { z1 = nz; if (!absXYZ) z1 = z + nz }
    if (!Number.isNaN(ne)) { dE = ne; if (absE) dE = ne - e }
    if (arc) {                                                 // I/J arc -> chords (≈0.3mm, capped)
      const cx = x + ai, cy = y + aj
      const r = Math.hypot(x - cx, y - cy)
      const a0 = Math.atan2(y - cy, x - cx)
      let a1 = Math.atan2(y1 - cy, x1 - cx)
      const ccw = arc === 3
      if (ccw && a1 <= a0 + EPS) a1 += 2 * Math.PI
      if (!ccw && a1 >= a0 - EPS) a1 -= 2 * Math.PI
      const n = Math.max(1, Math.min(360, Math.ceil(Math.abs(a1 - a0) * r / 0.3)))
      let px = x, py = y, pz = z
      for (let s = 1; s <= n; s++) {
        const a = a0 + (a1 - a0) * s / n
        let qx = cx + r * Math.cos(a), qy = cy + r * Math.sin(a)
        if (s === n) { qx = x1; qy = y1 }
        const qz = z + (z1 - z) * s / n
        pushSeg(px, py, pz, qx, qy, qz, dE / n)
        px = qx; py = qy; pz = qz
      }
    } else {
      pushSeg(x, y, z, x1, y1, z1, dE)
    }
    x = x1; y = y1; z = z1
    if (!Number.isNaN(ne) && absE) e = ne
    else if (!Number.isNaN(ne)) e = e + ne
  }

  // The common line, read in place: "G0".."G3", a space, then words of one letter and a plain decimal (sign, digits,
  //  point), up to a comment. Most of a file is such lines, and reading one through a line string, a trimmed copy, a
  //  word array and a slice per number was most of the parse (measured: a 21.5 MB plate 410 -> 280 ms). A plain
  //  decimal of up to 15 digits is its digits as an exact integer over an exact power of ten, and that one division
  //  rounds as parseFloat does. Anything else on the line (an exponent, a checksum, a second sign, lower case)
  //  returns false before any state changes, and the line goes the general way below.
  const fastMove = (from, to) => {
    let nx = NaN, ny = NaN, nz = NaN, ne = NaN, ai = 0, aj = 0
    let at = from + FAST_PREFIX
    while (at < to) {
      let character = text.charCodeAt(at)
      if (isBlank(character)) { at++; continue }
      if (character === SEMICOLON) break
      const letter = character | LOWER_CASE_BIT
      if (letter < LOWER_A || letter > LOWER_Z) return false
      at++
      let negative = false
      if (at < to) {
        character = text.charCodeAt(at)
        if (character === MINUS) { negative = true; at++ }
        else if (character === PLUS) at++
      }
      let mantissa = 0, digits = 0, decimals = 0, pointSeen = false
      for (; at < to; at++) {
        character = text.charCodeAt(at)
        if (character >= DIGIT_0 && character <= DIGIT_9) {
          mantissa = mantissa * 10 + (character - DIGIT_0)
          digits++
          if (pointSeen) decimals++
        }
        else if (character === POINT && !pointSeen) pointSeen = true
        else break
      }
      if (at < to && !isBlank(character) && character !== SEMICOLON) return false
      if (digits > EXACT_DIGITS) return false
      if (digits === 0) continue                               // parseFloat of no digits is NaN: the word is skipped
      let value = mantissa / POWER_OF_TEN[decimals]
      if (negative) value = -value
      if (letter === LOWER_X) nx = value
      else if (letter === LOWER_Y) ny = value
      else if (letter === LOWER_Z) nz = value
      else if (letter === LOWER_E) ne = value
      else if (letter === LOWER_I) ai = value
      else if (letter === LOWER_J) aj = value
    }
    const kind = text.charCodeAt(from + 1) - DIGIT_0
    let arc = 0
    if (kind >= 2) arc = kind
    move(arc, nx, ny, nz, ne, ai, aj)
    return true
  }

  // Line by line, never as one array of lines: that array held every line of the file at once (see INITIAL_SEGMENTS).
  const textLength = text.length
  let lineStart = 0
  while (lineStart <= textLength) {
    let lineEnd = text.indexOf('\n', lineStart)
    if (lineEnd < 0) lineEnd = textLength
    const from = lineStart
    lineStart = lineEnd + 1
    if (lineEnd - from > FAST_PREFIX && text.charCodeAt(from) === UPPER_G && text.charCodeAt(from + 2) === SPACE) {
      const kind = text.charCodeAt(from + 1) - DIGIT_0
      if (kind >= 0 && kind <= 3 && fastMove(from, lineEnd)) continue
    }
    const rawLine = text.slice(from, lineEnd)
    const ci = rawLine.indexOf(';')
    const code = (ci < 0 ? rawLine : rawLine.slice(0, ci)).trim()
    const comment = ci < 0 ? '' : rawLine.slice(ci + 1).trim()

    if (comment && !code) {
      const cl = comment.toLowerCase()
      const colourLine = COLOUR_LINE.exec(comment)
      if (colourLine) {
        if (colourLine[1].toLowerCase() === 'filament') filamentColours = colourList(colourLine[2])
        else extruderColours = colourList(colourLine[2])
        continue
      }
      // Bambu Lab's printers take upstream's BBL reserved tags (GCodeProcessor.cpp Reserved_Tags): "; FEATURE: <role>",
      //  "; LINE_WIDTH: ", "; CHANGE_LAYER" and "; Z_HEIGHT: " in place of ";TYPE:", ";WIDTH:", ";LAYER_CHANGE" and ";Z:".
      //  A Bambu Studio file read with only the compatible spellings drew every role as wall.
      if (cl.startsWith('type:')) { role = ROLE_BY_NAME[cl.slice(5).trim()] ?? ROLE.WALL; tagged = true; continue }
      if (cl.startsWith('feature:')) { role = ROLE_BY_NAME[cl.slice(8).trim()] ?? ROLE.WALL; tagged = true; continue }
      if (cl.startsWith('_extrusion_role:')) { role = PE_ROLE[parseInt(cl.slice(16), 10)] ?? ROLE.WALL; tagged = true; continue }
      if (cl.startsWith('width:') || cl.startsWith('line_width:')) {
        const v = parseFloat(cl.slice(cl.indexOf(':') + 1))
        width = 0
        if (v > 0) width = v
        continue
      }
      if (cl.startsWith('layer_change') || cl.startsWith('change_layer') || cl.startsWith('layer:')) { markerMode = true; pendingLayer = true; unstate(); continue }
      if (cl.startsWith('z:') || cl.startsWith('z_height:')) {
        const v = parseFloat(cl.slice(cl.indexOf(':') + 1))
        if (pendingLayer && v > 0) { markerMode = true; openLayer(v) }
        continue
      }
      const km = /^layer \d+ z([-\d.]+)/.exec(cl)              // this kernel: "; LAYER 12 Z2.600"
      if (km) { markerMode = true; openLayer(parseFloat(km[1]), true); continue }
      const feat = KERNEL_MARK.find(([k]) => markMatches(cl, k))
      if (feat) role = feat[1]
      continue
    }
    if (!code) continue

    const words = wordsOf(code)
    const cmd = words[0].toUpperCase()
    if (cmd === 'G90') { absXYZ = true; continue }
    if (cmd === 'G91') { absXYZ = false; continue }
    if (cmd === 'M82') { absE = true; continue }
    if (cmd === 'M83') { absE = false; continue }
    if (/^T\d+$/.test(cmd)) {
      const id = parseInt(cmd.slice(1), 10)
      if (id <= MAX_TOOL) { tool = id; tools.add(tool) }
      continue
    }

    if (cmd === 'G92' || cmd === 'G0' || cmd === 'G1' || cmd === 'G2' || cmd === 'G3') {
      let nx = NaN, ny = NaN, nz = NaN, ne = NaN, ai = 0, aj = 0
      for (let wi = 1; wi < words.length; wi++) {
        const L = words[wi][0], v = parseFloat(words[wi].slice(1))
        if (Number.isNaN(v)) continue
        if (L === 'X' || L === 'x') nx = v; else if (L === 'Y' || L === 'y') ny = v
        else if (L === 'Z' || L === 'z') nz = v; else if (L === 'E' || L === 'e') ne = v
        else if (L === 'I' || L === 'i') ai = v; else if (L === 'J' || L === 'j') aj = v
      }
      if (cmd === 'G92') {                                     // set position, no motion
        if (!Number.isNaN(nx)) x = nx; if (!Number.isNaN(ny)) y = ny
        if (!Number.isNaN(nz)) z = nz; if (!Number.isNaN(ne)) e = ne
        continue
      }
      move(ARC_OF[cmd] ?? 0, nx, ny, nz, ne, ai, aj)
    }
  }

  // `filament_mm` / `path_segments` / `layers` carry the kernel's own stat names, so a parsed result drops straight
  //  into the places a slice result goes (StatsCard reads stats.filament_mm). Time is NOT derived: an estimate needs
  //  the machine's acceleration limits, which G-code does not carry.
  // `filament_mm_by_tool` too: the Filament-view switch, the stats card's per-tool rows and a .gcode.3mf's
  //  slice_info all read it, and without it an opened multi-tool file landed on the Feature view while the same
  //  slice opened on Filament. Purge (tower) extrusion is counted under its tool: G-code does not separate it.
  // Per tool, extruder_colour wins where it names one (PrusaSlicer's GCodeViewer rule); Orca writes both the same.
  const colourCount = Math.max(filamentColours.length, extruderColours.length)
  const colors = Array.from({ length: colourCount }, (_unused, index) => extruderColours[index] || filamentColours[index] || null)
  const byTool = Array.from({ length: Math.max(...tools) + 1 }, (_unused, index) => filamentByTool[index] || 0)
  return {
    layers: layers.map(L => ({ z: L.z, paths: L.p.slice(0, L.segments * STRIDE), widths: L.w.slice(0, L.segments) })),
    stats: {
      layers: layers.length, path_segments: nSeg, travel_segments: nTravel,
      filament_mm: filament, tools: [...tools].sort((a, b) => a - b),
      // The kernel's own stat name, so the Filament-view switch and the stats card's per-tool split work unchanged.
      filament_mm_by_tool: byTool,
      ...(colors.some(Boolean) && { colors }),
    },
  }
}
