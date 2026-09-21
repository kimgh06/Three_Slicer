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
import { ROLE, encodeRole } from './toolpath_encoding.js'

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

// The file's own colours with the session palette filling the holes, one entry per tool either side has.
//  G-code colours belong to the ARTIFACT (upstream's G-code viewer reads them from the file, GCodeProcessor.cpp
//  :3291), so a loaded file is drawn in them; a result without them (every kernel slice) keeps the session palette.
export function resultToolColors(stats, sessionColors = []) {
  const own = Array.isArray(stats?.colors) ? stats.colors : []
  const length = Math.max(own.length, sessionColors.length)
  return Array.from({ length }, (_unused, index) => own[index] || sessionColors[index])
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
export function parseGcode(text, opts = {}) {
  const filArea = Math.PI / 4 * (opts.filamentDiameter > 0 ? opts.filamentDiameter : DEFAULT_FILAMENT_DIAMETER) ** 2
  const defH = opts.defaultLayerHeight > 0 ? opts.defaultLayerHeight : DEFAULT_LAYER_HEIGHT

  let x = 0, y = 0, z = 0, e = 0, absXYZ = true, absE = true   // RepRap defaults: G90 + M82
  let tool = 0, role = ROLE.WALL, width = 0                            // width 0 -> derive from E per segment
  let cur = null                                               // open layer {z, p:[], w:[]}
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
    cur = { z: lz, p: [], w: [] }; layers.push(cur)
    pendingLayer = false; pendingZ = NaN
    if (fromMarker || !tagged) unstate()
  }
  const prevLayerZ = () => (layers.length > 1 ? layers[layers.length - 2].z : 0)

  const pushSeg = (x0, y0, z0, x1, y1, z1, dE) => {
    const dist = Math.hypot(x1 - x0, y1 - y0, z1 - z0)
    if (dist < EPS) return
    if (dE > EPS) {                                            // extrusion
      filament += dE
      filamentByTool[tool] = (filamentByTool[tool] ?? 0) + dE
      if (pendingLayer) openLayer(Number.isNaN(pendingZ) ? z1 : pendingZ)
      else if (!markerMode && z1 > cur.z + 1e-3) openLayer(z1) // comment-less fallback: new layer on z rise
      const enc = encodeRole(role, tool)
      cur.p.push(x0, y0, z0, enc, x1, y1, z1, enc)
      const h = Math.max(0.02, cur.z - prevLayerZ() || defH)
      // Inverse of the upstream rounded-rectangle bead: cross-section = h·(w − h·(1−π/4))  ->  w = A/h + h·(1−π/4)
      const w = width > 0 ? width : dE * filArea / (dist * h) + h * (1 - Math.PI / 4)
      cur.w.push(Math.min(3, Math.max(0.05, w)))
      nSeg++
    } else if (cur) {                                          // travel (drop pre-first-layer homing moves)
      cur.p.push(x0, y0, z0, encodeRole(ROLE.TRAVEL, tool), x1, y1, z1, encodeRole(ROLE.TRAVEL, tool))
      cur.w.push(0)
      nTravel++
    }
  }

  for (const rawLine of text.split('\n')) {
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
      if (cl.startsWith('type:')) { role = ROLE_BY_NAME[cl.slice(5).trim()] ?? ROLE.WALL; tagged = true; continue }
      if (cl.startsWith('_extrusion_role:')) { role = PE_ROLE[parseInt(cl.slice(16), 10)] ?? ROLE.WALL; tagged = true; continue }
      if (cl.startsWith('width:')) { const v = parseFloat(cl.slice(6)); width = v > 0 ? v : 0; continue }
      if (cl.startsWith('layer_change') || cl.startsWith('layer:')) { markerMode = true; pendingLayer = true; unstate(); continue }
      if (cl.startsWith('z:')) { const v = parseFloat(cl.slice(2)); if (pendingLayer && v > 0) { markerMode = true; openLayer(v) } continue }
      const km = /^layer \d+ z([-\d.]+)/.exec(cl)              // this kernel: "; LAYER 12 Z2.600"
      if (km) { markerMode = true; openLayer(parseFloat(km[1]), true); continue }
      const feat = KERNEL_MARK.find(([k]) => markMatches(cl, k))
      if (feat) role = feat[1]
      continue
    }
    if (!code) continue

    const words = code.split(/\s+/)
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
      const x1 = Number.isNaN(nx) ? x : (absXYZ ? nx : x + nx)
      const y1 = Number.isNaN(ny) ? y : (absXYZ ? ny : y + ny)
      const z1 = Number.isNaN(nz) ? z : (absXYZ ? nz : z + nz)
      const dE = Number.isNaN(ne) ? 0 : (absE ? ne - e : ne)
      if (cmd === 'G2' || cmd === 'G3') {                      // I/J arc -> chords (≈0.3mm, capped)
        const cx = x + ai, cy = y + aj
        const r = Math.hypot(x - cx, y - cy)
        const a0 = Math.atan2(y - cy, x - cx)
        let a1 = Math.atan2(y1 - cy, x1 - cx)
        const ccw = cmd === 'G3'
        if (ccw && a1 <= a0 + EPS) a1 += 2 * Math.PI
        if (!ccw && a1 >= a0 - EPS) a1 -= 2 * Math.PI
        const n = Math.max(1, Math.min(360, Math.ceil(Math.abs(a1 - a0) * r / 0.3)))
        let px = x, py = y, pz = z
        for (let s = 1; s <= n; s++) {
          const a = a0 + (a1 - a0) * s / n
          const qx = s === n ? x1 : cx + r * Math.cos(a), qy = s === n ? y1 : cy + r * Math.sin(a)
          const qz = z + (z1 - z) * s / n
          pushSeg(px, py, pz, qx, qy, qz, dE / n)
          px = qx; py = qy; pz = qz
        }
      } else {
        pushSeg(x, y, z, x1, y1, z1, dE)
      }
      x = x1; y = y1; z = z1; if (!Number.isNaN(ne)) e = absE ? ne : e + ne
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
    layers: layers.map(L => ({ z: L.z, paths: Float32Array.from(L.p), widths: Float32Array.from(L.w) })),
    stats: {
      layers: layers.length, path_segments: nSeg, travel_segments: nTravel,
      filament_mm: filament, tools: [...tools].sort((a, b) => a - b),
      // The kernel's own stat name, so the Filament-view switch and the stats card's per-tool split work unchanged.
      filament_mm_by_tool: byTool,
      ...(colors.some(Boolean) && { colors }),
    },
  }
}
