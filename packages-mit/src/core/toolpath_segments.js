// Kernel layer stream -> the GPU attribute buffers the toolpath shader reads, plus the queries the UI makes
// about them.
//
// Written from viewer/TOOLPATH_SPEC.md §2-3 and §6.
//
// Two passes on purpose. A slice of a large model is millions of segments, so the buffers are typed arrays
// sized exactly once: pass 1 counts extrusions, travels and moves per layer, pass 2 fills. Growing JS arrays
// and converting at the end would hold both representations at peak.
//
// The role field is packed: enc = role + tool * 16 (see the spec). Everything downstream reads the DECODED
// role and tool out of meta, never the raw enc — that decode happens here, once.
import { TYPE_COLOR, TYPE_LABEL, packColor } from './toolpath_palette.js'
import { DEFAULT_LAYER_HEIGHT, DEFAULT_LINE_WIDTH } from './viewer_defaults.js'
import { STRIDE, ROLE, roleOf, toolOf } from './toolpath_encoding.js'


const packedTypeColor = {}
for (const role of Object.keys(TYPE_COLOR)) packedTypeColor[role] = packColor(TYPE_COLOR[role])

/** Layer heights from the z ladder: each layer's height is its rise over the one below. The first layer has
 *  nothing below it, so it takes its own z — a raft or a lifted first layer would otherwise report a bead
 *  taller than it prints. A non-positive result falls back rather than producing a zero-height bead. */
function layerHeights(layers) {
  const out = new Float32Array(layers.length)
  for (let i = 0; i < layers.length; i++) {
    const z = Number(layers[i]?.z) || 0
    const below = i > 0 ? (Number(layers[i - 1]?.z) || 0) : 0
    const h = i > 0 ? z - below : z
    out[i] = h > 1e-6 ? h : DEFAULT_LAYER_HEIGHT
  }
  return out
}

const pathsOf = (layer) => (layer?.paths?.length ? layer.paths : null)
const segCountOf = (layer) => { const p = pathsOf(layer); return p ? Math.floor(p.length / STRIDE) : 0 }

/**
 * layers[{z, paths(stride 8), widths[]}] -> SegmentData.
 *
 * `defaultLineWidth` stands in wherever the stream carries no usable width — G-code without a `;WIDTH:`
 * comment, or a kernel result whose widths array is short. A zero-width bead is invisible, so "unknown"
 * must resolve to something drawable rather than to nothing.
 */
export function buildSegmentData(layers, defaultLineWidth) {
  const src = Array.isArray(layers) ? layers : []
  const layerCount = src.length
  const fallbackWidth = Number(defaultLineWidth) > 0 ? Number(defaultLineWidth) : DEFAULT_LINE_WIDTH
  const heights = layerHeights(src)

  // ---- pass 1: counts, so every buffer is allocated once at its final size
  const layerSegPrefix = new Uint32Array(layerCount + 1)
  const travelPrefix = new Uint32Array(layerCount + 1)
  const movePrefix = new Uint32Array(layerCount + 1)
  let nSeg = 0, nTrav = 0, nMove = 0
  for (let li = 0; li < layerCount; li++) {
    const paths = pathsOf(src[li])
    const count = segCountOf(src[li])
    for (let s = 0; s < count; s++) {
      if (roleOf(paths[s * STRIDE + 3]) === ROLE.TRAVEL) nTrav++
      else nSeg++
    }
    nMove += count
    layerSegPrefix[li + 1] = nSeg
    travelPrefix[li + 1] = nTrav
    movePrefix[li + 1] = nMove
  }

  const nV = nSeg * 2                      // one vertex per segment endpoint; the shader expands the bead
  const position = new Float32Array(nV * 4)   // [x, y, z - h/2, 0] — vec4 keeps the attribute 16-byte aligned
  const hwa = new Float32Array(nV * 4)        // [height, width, xy angle, packed feature colour]
  const segIndex = new Uint32Array(nV * 2)    // [segment index, layer index]
  const vType = new Uint8Array(nV)
  const vTool = new Uint8Array(nV)
  const vWidth = new Float32Array(nV)
  const vHeight = new Float32Array(nV)
  const vLayer = new Int32Array(nV)
  const travelPos = new Float32Array(nTrav * 6)
  const movePos = new Float32Array(nMove * 3)   // the move endpoint at its TRUE path z, for the scrub cursor
  const moveKind = new Uint8Array(nMove)        // 0 = travel, 1 = extrusion
  const typeLengths = new Float64Array(16)

  let hasNaN = false, maxAbs = 0
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity

  // ---- pass 2: fill
  let vi = 0, si = 0, ti = 0, mi = 0
  for (let li = 0; li < layerCount; li++) {
    const layer = src[li]
    const paths = pathsOf(layer)
    const count = segCountOf(layer)
    const widths = layer?.widths
    const height = heights[li]
    const halfHeight = height / 2

    for (let s = 0; s < count; s++) {
      const o = s * STRIDE
      const x0 = paths[o], y0 = paths[o + 1], z0 = paths[o + 2]
      const x1 = paths[o + 4], y1 = paths[o + 5], z1 = paths[o + 6]
      const enc = paths[o + 3] | 0
      const role = roleOf(enc)
      const tool = toolOf(enc)

      if (!Number.isFinite(x0 + y0 + z0 + x1 + y1 + z1)) hasNaN = true

      // The move list is the PERFORMED order — extrusions and travels interleaved as the machine does them.
      //  It is the only record of that order once the two go to separate buffers, and moveCursor needs it.
      moveKind[mi] = role === ROLE.TRAVEL ? 0 : 1
      movePos[mi * 3] = x1; movePos[mi * 3 + 1] = y1; movePos[mi * 3 + 2] = z1
      mi++

      if (role === ROLE.TRAVEL) {
        const t = ti * 6
        travelPos[t] = x0; travelPos[t + 1] = y0; travelPos[t + 2] = z0
        travelPos[t + 3] = x1; travelPos[t + 4] = y1; travelPos[t + 5] = z1
        ti++
        continue
      }

      const rawWidth = widths ? Number(widths[s]) : NaN
      const width = Number.isFinite(rawWidth) && rawWidth > 0 ? rawWidth : fallbackWidth
      const dx = x1 - x0, dy = y1 - y0
      const angle = Math.atan2(dy, dx)
      const length = Math.hypot(dx, dy, z1 - z0)
      if (Number.isFinite(length)) typeLengths[role] += length

      const colour = packedTypeColor[role] ?? packedTypeColor[1]
      // The path z is the NOZZLE, and plastic is laid below it — so the bead centre sits half a layer
      //  height down, and the shader expands +/- halfHeight around it.
      for (const [px, py, pz] of [[x0, y0, z0], [x1, y1, z1]]) {
        const p = vi * 4
        position[p] = px; position[p + 1] = py; position[p + 2] = pz - halfHeight; position[p + 3] = 0
        hwa[p] = height; hwa[p + 1] = width; hwa[p + 2] = angle; hwa[p + 3] = colour
        segIndex[vi * 2] = si; segIndex[vi * 2 + 1] = li
        vType[vi] = role; vTool[vi] = tool
        vWidth[vi] = width; vHeight[vi] = height; vLayer[vi] = li
        vi++

        const cz = pz - halfHeight
        if (px < minX) minX = px; if (px > maxX) maxX = px
        if (py < minY) minY = py; if (py > maxY) maxY = py
        if (cz < minZ) minZ = cz; if (cz > maxZ) maxZ = cz
        const a = Math.max(Math.abs(px), Math.abs(py), Math.abs(cz))
        if (a > maxAbs) maxAbs = a
      }
      si++
    }
  }

  const bbox = nV > 0 && Number.isFinite(minX)
    ? { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] }
    : null

  return {
    position, hwa, segIndex, nV, nSeg,
    layerSegPrefix, travelPos, travelPrefix, nTrav,
    movePos, moveKind, movePrefix,
    layerCount, maxAbs, hasNaN, typeLengths, bbox,
    meta: { vType, vTool, vWidth, vHeight, vLayer },
  }
}

/** Extruded length share per role, descending, summing to 100. The kernel reports no per-role TIME, so
 *  length stands in for it — which is why this is a share and never a duration. */
export function roleRatios(typeLengths) {
  const lengths = typeLengths ?? []
  let total = 0
  for (let i = 0; i < 16; i++) total += Number(lengths[i]) || 0
  if (total <= 0) return []
  const out = []
  for (let i = 0; i < 16; i++) {
    const v = Number(lengths[i]) || 0
    if (v <= 0) continue
    out.push({ type: i, label: TYPE_LABEL[i] ?? String(i), pct: v / total * 100, color: TYPE_COLOR[i] ?? TYPE_COLOR[1] })
  }
  return out.sort((a, b) => b.pct - a.pct)
}

const movesIn = (data, layer) =>
  (layer >= 0 && layer < data.layerCount) ? data.movePrefix[layer + 1] - data.movePrefix[layer] : 0

/** Moves in one layer — extrusions and travels together, because that is what the scrub bar walks. */
export function layerMoveCount(data, layer) {
  return movesIn(data, layer)
}

/** The topmost layer in [lo, hi] that actually has moves, or lo when none does. The scrub bar follows the
 *  layer slider's upper thumb, and a layer with no moves would leave it with nothing to walk. */
export function topMoveLayer(data, lo, hi) {
  const top = Math.min(hi, data.layerCount - 1)
  for (let l = top; l >= lo; l--) if (movesIn(data, l) > 0) return l
  return lo
}

/**
 * Where the nozzle is after `at` moves into `layer`, and how much of each draw list that accounts for.
 *
 * `segCount + travCount === at` always (clamped to the layer's move count): the two lists partition the
 * performed order, which is the property the scrub bar depends on to draw a partial layer.
 */
export function moveCursor(data, layer, at) {
  const total = movesIn(data, layer)
  const k = Math.max(0, Math.min(Number(at) || 0, total))
  const base = (layer >= 0 && layer < data.layerCount) ? data.movePrefix[layer] : 0

  let segCount = 0, travCount = 0
  for (let i = 0; i < k; i++) {
    if (data.moveKind[base + i] === 0) travCount++
    else segCount++
  }
  if (k === 0) return { point: null, segCount: 0, travCount: 0, onTravel: false }

  const m = base + k - 1
  return {
    point: [data.movePos[m * 3], data.movePos[m * 3 + 1], data.movePos[m * 3 + 2]],
    segCount, travCount,
    onTravel: data.moveKind[m] === 0,
  }
}
