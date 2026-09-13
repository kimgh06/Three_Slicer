// Pure-JS SLA (resin) slicer: binary STL -> per-layer closed contours, in the SAME layer-stream contract the
//  FFF kernel emits ({z, paths stride 8 [x0,y0,z0,enc, x1,y1,z1,enc], widths one per segment, enc = role+tool*16})
//  — so the viewer's GPU toolpath preview, layer slider and plate cache consume an SLA slice unmodified.
//
// Why JS and not the WASM kernel: an SLA slice is contours only — no walls, no infill, no G-code — and a
//  plane/triangle sweep is deterministic in doubles, so nothing here needs the C++ side. The raster/export half
//  (PNG per layer, SL1 zip) is DELIBERATELY not in this module: rasterization needs a canvas, which Node does not
//  have, and the engine package keeps zero runtime dependencies. The viewer owns that half (sl1_write.js).
//
// Determinism: iteration order is the STL's own triangle order, stitching maps insert in encounter order, and
//  vertices on a slicing plane are pushed up by a fixed epsilon — same input bytes, same output bytes.

// The toolpath stream and binary STL layouts. This worker is standalone (no imports), so it keeps its own copy of
//  numbers the viewer holds in core/toolpath_encoding.js and core/stl_format.js; TOOLPATH_SPEC.md is the contract.
const STRIDE = 8                // floats per segment: [x0,y0,z0,enc, x1,y1,z1,enc]
const ROLE_CONTOUR = 1          // ROLE.WALL — rendered as 'wall' by the preview's feature colouring
const STL_HEADER_BYTES = 80
const STL_DATA_OFFSET = 84      // header + the uint32 triangle count
const STL_TRIANGLE_BYTES = 50
const CONTOUR_WIDTH = 0.2       // display width of a contour segment (SLA has no bead width)
const PLANE_EPS = 1e-9          // a vertex exactly on a plane counts as above it — deterministic tie-break
const KEY_SCALE = 1e4           // endpoint welding: 0.1 micrometre grid

/** Binary STL -> Float32Array of 9 floats per triangle (vertices only; normals are recomputed). */
export function parseBinarySTL(bytes) {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes)
  if (bytes.byteLength < STL_DATA_OFFSET) return { error: 'not a binary STL (shorter than its own header)' }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const count = dv.getUint32(STL_HEADER_BYTES, true)
  if (STL_DATA_OFFSET + STL_TRIANGLE_BYTES * count !== bytes.byteLength) return { error: 'not a binary STL (triangle count does not match the byte length)' }
  const tris = new Float32Array(count * 9)
  for (let i = 0; i < count; i++) {
    const base = STL_DATA_OFFSET + STL_TRIANGLE_BYTES * i + 12   // skip the stored normal — recomputed from the winding below
    for (let f = 0; f < 9; f++) tris[i * 9 + f] = dv.getFloat32(base + 4 * f, true)
  }
  return { tris, count }
}

const ptKey = (x, y) => Math.round(x * KEY_SCALE) + ',' + Math.round(y * KEY_SCALE)

// One plane through the triangle soup -> oriented segments. Direction is Z×N (N = winding normal), which walks
//  outer boundaries counter-clockwise and holes clockwise — that orientation is what makes the summed shoelace
//  area the NET cross-section (outer minus holes) without any containment test.
function sliceAtPlane(tris, z) {
  const segs = []                          // [x0,y0,x1,y1] oriented
  const n = tris.length / 9
  for (let t = 0; t < n; t++) {
    const o = t * 9
    const vx = [tris[o], tris[o + 3], tris[o + 6]]
    const vy = [tris[o + 1], tris[o + 4], tris[o + 7]]
    const vz = [tris[o + 2], tris[o + 5], tris[o + 8]]
    for (let i = 0; i < 3; i++) if (Math.abs(vz[i] - z) < PLANE_EPS) vz[i] = z + PLANE_EPS
    const below = [vz[0] < z, vz[1] < z, vz[2] < z]
    const nb = (below[0] ? 1 : 0) + (below[1] ? 1 : 0) + (below[2] ? 1 : 0)
    if (nb === 0 || nb === 3) continue
    // The lone vertex (on the minority side) and its two crossing edges
    const lone = nb === 1 ? below.indexOf(true) : below.indexOf(false)
    const a = (lone + 1) % 3, b = (lone + 2) % 3
    const ta = (z - vz[lone]) / (vz[a] - vz[lone])
    const tb = (z - vz[lone]) / (vz[b] - vz[lone])
    let px = vx[lone] + ta * (vx[a] - vx[lone]), py = vy[lone] + ta * (vy[a] - vy[lone])
    let qx = vx[lone] + tb * (vx[b] - vx[lone]), qy = vy[lone] + tb * (vy[b] - vy[lone])
    // Winding normal N = (B-A)×(C-A); in-plane direction Z×N = (-Ny, Nx)
    const ux = vx[1] - vx[0], uy = vy[1] - vy[0], uz = vz[1] - vz[0]
    const wx = vx[2] - vx[0], wy = vy[2] - vy[0], wz = vz[2] - vz[0]
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz
    const dirx = -ny, diry = nx
    if ((qx - px) * dirx + (qy - py) * diry < 0) { const sx = px, sy = py; px = qx; py = qy; qx = sx; qy = sy }
    if (Math.abs(px - qx) > 1e-12 || Math.abs(py - qy) > 1e-12) segs.push(px, py, qx, qy)
  }
  return segs
}

// Oriented segments -> closed loops (walk start-key -> next segment). Open chains (non-manifold geometry) are
//  dropped whole and counted, mirroring how the paint importer drops a malformed facet rather than guessing.
function stitchLoops(segs) {
  const byStart = new Map()
  const segCount = segs.length / 4
  for (let s = 0; s < segCount; s++) {
    const k = ptKey(segs[s * 4], segs[s * 4 + 1])
    let list = byStart.get(k)
    if (!list) { list = []; byStart.set(k, list) }
    list.push(s)
  }
  const used = new Uint8Array(segCount)
  const loops = []
  let dropped = 0
  for (let s0 = 0; s0 < segCount; s0++) {
    if (used[s0]) continue
    const startKey = ptKey(segs[s0 * 4], segs[s0 * 4 + 1])
    const pts = []
    let cur = s0, closed = false
    while (true) {
      used[cur] = 1
      pts.push(segs[cur * 4], segs[cur * 4 + 1])
      const endKey = ptKey(segs[cur * 4 + 2], segs[cur * 4 + 3])
      if (endKey === startKey) { closed = true; break }
      const nexts = byStart.get(endKey)
      let next = -1
      if (nexts) for (const cand of nexts) if (!used[cand]) { next = cand; break }
      if (next < 0) break
      cur = next
    }
    if (closed && pts.length >= 6) loops.push(pts)
    else dropped++
  }
  return { loops, dropped }
}

const loopArea = (pts) => {   // signed shoelace, CCW positive
  let area = 0
  for (let i = 0, n = pts.length / 2; i < n; i++) {
    const j = (i + 1) % n
    area += pts[i * 2] * pts[j * 2 + 1] - pts[j * 2] * pts[i * 2 + 1]
  }
  return area / 2
}

/**
 * Slice a binary STL for a resin print.
 * params: layer_height, initial_layer_height, exposure_time, initial_exposure_time, faded_layers,
 *         sla_layer_overhead (per-layer tilt/lift seconds) — all optional.
 * hooks: {onProgress(done,total), onLayer({z,idx,paths,widths,area})} — layer buffers belong to the callee.
 * Returns {stats, layers} (layers omitted when onLayer took them, mirroring the kernel's streamed mode).
 */
export function sliceSla(stlBytes, params = {}, hooks = {}) {
  const parsed = parseBinarySTL(stlBytes)
  if (parsed.error) return { error: parsed.error }
  const { tris, count } = parsed
  if (!count) return { error: 'empty STL (no triangles)' }

  const lh = Number(params.layer_height) > 0 ? Number(params.layer_height) : 0.05
  const ilh = Number(params.initial_layer_height) > 0 ? Number(params.initial_layer_height) : lh
  const exposure = Number(params.exposure_time) > 0 ? Number(params.exposure_time) : 7
  const initialExposure = Number(params.initial_exposure_time) > 0 ? Number(params.initial_exposure_time) : 35
  const faded = Number.isFinite(Number(params.faded_layers)) ? Math.max(0, Number(params.faded_layers)) : 10
  const overhead = Number(params.sla_layer_overhead) >= 0 ? Number(params.sla_layer_overhead) : 6

  let minZ = Infinity, maxZ = -Infinity
  for (let i = 2; i < tris.length; i += 3) { const v = tris[i]; if (v < minZ) minZ = v; if (v > maxZ) maxZ = v }
  const height = maxZ - minZ
  if (!(height > 0)) return { error: 'model has no height to slice' }

  const layerCount = height <= ilh ? 1 : 1 + Math.ceil((height - ilh) / lh)
  const layers = hooks.onLayer ? null : []
  let segTotal = 0, volume = 0, droppedTotal = 0

  for (let i = 0; i < layerCount; i++) {
    const thickness = i === 0 ? ilh : lh
    const top = minZ + (i === 0 ? ilh : ilh + i * lh)
    const mid = top - thickness / 2
    const { loops, dropped } = stitchLoops(sliceAtPlane(tris, mid))
    droppedTotal += dropped
    let area = 0, segCount = 0
    for (const pts of loops) { area += loopArea(pts); segCount += pts.length / 2 }
    area = Math.max(0, area)
    volume += area * thickness
    const paths = new Float32Array(segCount * STRIDE)
    const widths = new Float32Array(segCount)
    let w = 0
    for (const pts of loops) {
      const n = pts.length / 2
      for (let p = 0; p < n; p++) {
        const q = (p + 1) % n
        paths[w * STRIDE] = pts[p * 2]; paths[w * STRIDE + 1] = pts[p * 2 + 1]; paths[w * STRIDE + 2] = top; paths[w * STRIDE + 3] = ROLE_CONTOUR
        paths[w * STRIDE + 4] = pts[q * 2]; paths[w * STRIDE + 5] = pts[q * 2 + 1]; paths[w * STRIDE + 6] = top; paths[w * STRIDE + 7] = ROLE_CONTOUR
        widths[w] = CONTOUR_WIDTH
        w++
      }
    }
    segTotal += segCount
    const layer = { z: top, idx: i, paths, widths, area }
    if (hooks.onLayer) hooks.onLayer(layer)
    else layers.push(layer)
    if (hooks.onProgress && (i % 16 === 0 || i === layerCount - 1)) hooks.onProgress(i + 1, layerCount)
  }

  // Exposure fades linearly from the initial to the regular value over the faded band, upstream's model.
  let time = layerCount * overhead
  for (let i = 0; i < layerCount; i++) {
    const blend = faded > 0 ? Math.min(1, i / faded) : 1
    time += initialExposure + (exposure - initialExposure) * blend
  }

  const stats = {
    sla: true, streamed: !!hooks.onLayer,
    layers: layerCount, path_segments: segTotal, filament_mm: 0,
    resin_ml: volume / 1000, volume_mm3: volume,
    time_estimate: Math.round(time),
    open_chains_dropped: droppedTotal,
    layer_height: lh, initial_layer_height: ilh,
  }
  return layers ? { stats, layers } : { stats }
}
