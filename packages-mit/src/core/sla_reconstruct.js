// Surface reconstruction for an imported SL1: mask slices -> surface nets -> indexed mesh, STREAMING.
//  This is what turns "a zip of cross-sections" back into something that LOOKS like the object — cross-sections
//  alone read as smoke. Upstream PrusaSlicer solves the same problem for its SLA import with a marching-cubes
//  port; surface nets gives the same class of result with no case tables, at the cost of slightly rounded
//  90-degree edges — invisible at the sub-0.2mm voxels this runs at.
//
//  Why streaming: the naive version materialized the whole occupancy volume plus a dense per-cell vertex index,
//  which capped resolution at ~47M voxels (the index alone was ~190MB). Feeding slices one at a time and keeping
//  a THREE-SLICE occupancy window plus a TWO-LAYER vertex-index ring makes working memory O(nx*ny) regardless of
//  layer count — which is what lets z run at the archive's own layer height and xy at 768 columns. What remains
//  proportional to output is the mesh itself.
//
// Frame contract: occupancy samples are VOXEL CENTERS, sample (x,y,z) at
//   (ox + (x+0.5)*sx, oy + (y+0.5)*sy, oz + (z+0.5)*sz)
// with +x/+y/+z the kernel's plate-local axes (z up). Everything outside the pushed slices counts as empty, so
// the surface always closes — including against the plate at z=0.

import { THEME, hexToLinear } from './theme.js'
import { ROLE } from './toolpath_encoding.js'

// Cell corners (x-fastest: index bit0=x, bit1=y, bit2=z) and the 12 cell edges, kept as FLAT arrays — this is
//  the innermost data of a loop that runs per surface vertex, and array-of-pairs iteration allocated there.
const CX = new Int8Array(8), CY = new Int8Array(8), CZ = new Int8Array(8)
for (let i = 0; i < 8; i++) { CX[i] = i & 1; CY[i] = (i >> 1) & 1; CZ[i] = (i >> 2) & 1 }
const EA = [], EB = []
for (let a = 0; a < 8; a++) for (let b = a + 1; b < 8; b++)
  if (Math.abs(CX[a] - CX[b]) + Math.abs(CY[a] - CY[b]) + Math.abs(CZ[a] - CZ[b]) === 1) { EA.push(a); EB.push(b) }

// The iso level over 0..255 occupancy. Masks arrive ANTI-ALIASED (the SL1 writer's canvas fill, then the
//  downscale) and those grays are sub-voxel information: interpolating each edge crossing against the iso
//  instead of snapping to the midpoint is what removes the voxel staircase from every surface that is not
//  axis-aligned. Binary 0/255 input degrades gracefully to midpoint crossings.
const ISO = 127.5
const filled = (v) => v > ISO

// Growable typed storage — plain number[] at tens of millions of entries is GC death.
const makeChunks = (Type) => {
  const done = []
  let cur = new Type(1 << 20), len = 0, total = 0
  return {
    push3(a, b, c) {
      if (len + 3 > cur.length) { done.push(cur.subarray(0, len)); total += len; cur = new Type(1 << 20); len = 0 }
      cur[len++] = a; cur[len++] = b; cur[len++] = c
    },
    concat() {
      done.push(cur.subarray(0, len)); total += len
      const out = new Type(total)
      let at = 0
      for (const c of done) { out.set(c, at); at += c.length }
      return out
    },
  }
}

/**
 * Streaming surface nets. Feed occupancy slices (Uint8Array(nx*ny), 0..255 coverage, y index growing along +y)
 * bottom-up with pushSlice, then finish() -> { positions, indices, normals } — an indexed mesh with outward
 * winding and area-weighted smooth vertex normals, ready for a BufferGeometry with no further processing.
 */
// Vertex colours by role, as LINEAR rgb (three.js treats colour attributes as linear): the same theme colours the
//  solid SLA preview paints its meshes with. Rounded to 3 places, the precision they were first written at by hand.
const linear3 = hex => hexToLinear(hex).map(value => Math.round(value * 1000) / 1000)
const ROLE_COLORS = { 0: linear3(THEME.slaModel), [ROLE.SUPPORT]: linear3(THEME.slaSupport), [ROLE.RAFT]: linear3(THEME.slaPad) }   // 0: model

export function makeStreamingNets(nx, ny, sx, sy, sz, ox, oy, oz) {
  const ringW = nx + 1, ringH = ny + 1
  let idxPrev = new Int32Array(ringW * ringH).fill(-1)   // vertex index of cell layer s-1
  let idxCur = new Int32Array(ringW * ringH).fill(-1)    // ... and of cell layer s
  const emptySlice = null                                 // occAt treats null as all-empty
  let below = emptySlice, cur = emptySlice               // slices s-1 and s while stepping
  let rBelow = null, rCur = null                          // role slices (0/5/6) riding alongside, optional
  let gBelow = null, gCur = null                          // per-row occupancy ranges riding alongside, optional
  let step = 0                                            // the next step's sample layer index
  const pos = makeChunks(Float32Array)
  const tris = makeChunks(Uint32Array)
  const col = makeChunks(Float32Array)
  let vertCount = 0
  let anyRoles = false

  const occAt = (slice, x, y) => (!slice || x < 0 || y < 0 || x >= nx || y >= ny) ? 0 : slice[x + nx * y]

  // Cell (cx,cy) on layer czAbs, its lower corners sampled from `low` (z=czAbs) and upper from `high` (z=czAbs+1).
  const o = new Float64Array(8)                            // corner scratch, reused per vertex — no allocation
  function vertexFor(ring, cx, cy, czAbs, low, high, rLow, rHigh) {
    const key = (cx + 1) + ringW * (cy + 1)
    const known = ring[key]
    if (known >= 0) return known
    o[0] = occAt(low, cx, cy); o[1] = occAt(low, cx + 1, cy); o[2] = occAt(low, cx, cy + 1); o[3] = occAt(low, cx + 1, cy + 1)
    o[4] = occAt(high, cx, cy); o[5] = occAt(high, cx + 1, cy); o[6] = occAt(high, cx, cy + 1); o[7] = occAt(high, cx + 1, cy + 1)
    let mx = 0, my = 0, mz = 0, hits = 0
    for (let e = 0; e < EA.length; e++) {
      const a = EA[e], b = EB[e]
      if (filled(o[a]) === filled(o[b])) continue
      const t = Math.min(1, Math.max(0, (ISO - o[a]) / (o[b] - o[a])))
      mx += CX[a] + t * (CX[b] - CX[a])
      my += CY[a] + t * (CY[b] - CY[a])
      mz += CZ[a] + t * (CZ[b] - CZ[a])
      hits++
    }
    const px = hits ? mx / hits : 0.5, py = hits ? my / hits : 0.5, pz = hits ? mz / hits : 0.5
    pos.push3(ox + (cx + px + 0.5) * sx, oy + (cy + py + 0.5) * sy, oz + (czAbs + pz + 0.5) * sz)
    if (anyRoles) {
      // The vertex's role: among the cell's FILLED corners, support wins over pad wins over model — a support
      //  head meeting the model is painted as the support that must be torn off, matching the sliced preview.
      let role = 0
      for (let c = 0; c < 8; c++) {
        if (!filled(o[c])) continue
        const r = occAt(CZ[c] ? rHigh : rLow, cx + CX[c], cy + CY[c])
        if (r === 5) { role = 5; break }
        if (r === 6) role = 6
      }
      const rgb = ROLE_COLORS[role]
      col.push3(rgb[0], rgb[1], rgb[2])
    }
    ring[key] = vertCount
    return vertCount++
  }

  // One sweep step for sample layer s: needs slices s-1 (below), s (cur) and s+1 (next). Emits the z-edges
  //  between s-1 and s, and the x/y edges within s. Quads are wound CCW around the face normal — for an edge
  //  whose FILLED sample sits on the low side the normal is the +axis, and the four surrounding dual cells are
  //  taken in the (u,v) plane order that makes (axis,u,v) right-handed.
  // Row-range accessors: an edge needs a FILLED endpoint, and filled pixels live inside the row's recorded
  //  occupancy range — so every scan below runs [lo-1, hi] of the relevant rows' union instead of the full
  //  frame. `null` ranges (a caller that never measured them) fall back to the whole row; a missing row is
  //  empty. Measured on a Benchy this is the difference between sweeping the display and sweeping the boat.
  const loRow = (g, slice, y) => (slice === emptySlice || y < 0 || y >= ny) ? nx : (g ? g[y * 2] : 0)
  const hiRow = (g, slice, y) => (slice === emptySlice || y < 0 || y >= ny) ? -1 : (g ? g[y * 2 + 1] : nx - 1)
  function runStep(next, rNext, gNext) {
    const s = step++
    const P = (cx, cy) => vertexFor(idxPrev, cx, cy, s - 1, below, cur, rBelow, rCur)
    const C = (cx, cy) => vertexFor(idxCur, cx, cy, s, cur, next, rCur, rNext)
    const quad = (c0, c1, c2, c3, flip) => {
      if (flip) { tris.push3(c3, c2, c1); tris.push3(c3, c1, c0) }
      else { tris.push3(c0, c1, c2); tris.push3(c0, c2, c3) }
    }
    for (let y = 0; y < ny; y++) {                                        // z-edges (s-1 -> s), cells on layer s-1
      const lo = Math.min(loRow(gBelow, below, y), loRow(gCur, cur, y))
      const hi = Math.max(hiRow(gBelow, below, y), hiRow(gCur, cur, y))
      for (let x = lo; x <= hi; x++) {
        const a = filled(occAt(below, x, y)), b = filled(occAt(cur, x, y))
        if (a !== b) quad(P(x - 1, y - 1), P(x, y - 1), P(x, y), P(x - 1, y), !a)
      }
    }
    for (let y = 0; y < ny; y++) {                                        // x-edges within s
      const lo = loRow(gCur, cur, y), hi = hiRow(gCur, cur, y)
      for (let x = lo - 1; x <= hi; x++) {
        const a = filled(occAt(cur, x, y)), b = filled(occAt(cur, x + 1, y))
        if (a !== b) quad(P(x, y - 1), P(x, y), C(x, y), C(x, y - 1), !a)
      }
    }
    for (let y = -1; y < ny; y++) {                                       // y-edges within s
      const lo = Math.min(loRow(gCur, cur, y), loRow(gCur, cur, y + 1))
      const hi = Math.max(hiRow(gCur, cur, y), hiRow(gCur, cur, y + 1))
      for (let x = lo; x <= hi; x++) {
        const a = filled(occAt(cur, x, y)), b = filled(occAt(cur, x, y + 1))
        if (a !== b) quad(P(x - 1, y), C(x - 1, y), C(x, y), P(x, y), !a)
      }
    }
    const recycled = idxPrev
    idxPrev = idxCur
    idxCur = recycled.fill(-1)
  }

  let started = false
  return {
    // Slices arrive bottom-up. Layer s can only be processed once s+1 is known (its cells' upper corners live
    //  there), so the first slice just primes the window and every later push runs the step one layer behind.
    //  `roles` is an optional parallel Uint8Array (0=model, 5=support, 6=pad) that turns on vertex colours;
    //  `ranges` the per-row occupancy spans fillSliceFromRGBA returns, which confine the sweep to the model.
    pushSlice(slice, roles = null, ranges = null) {
      if (roles) anyRoles = true
      if (!started) { started = true; cur = slice; rCur = roles; gCur = ranges; return }
      runStep(slice, roles, ranges)
      below = cur; cur = slice
      rBelow = rCur; rCur = roles
      gBelow = gCur; gCur = ranges
    },
    finish({ smoothRounds = 0, normalRounds = 0 } = {}) {
      if (started) {                                                        // last real layer's step
        runStep(emptySlice, null, null)
        below = cur; cur = emptySlice; rBelow = rCur; rCur = null; gBelow = gCur; gCur = null
      }
      runStep(emptySlice, null, null)                                       // top cap: z-edges into empty space
      const positions = pos.concat()
      const indices = tris.concat()
      if (smoothRounds > 0) smoothMesh(positions, indices, smoothRounds)    // before normals — they see the final shape
      // Area-weighted smooth normals: accumulate each face's (unnormalized) normal onto its vertices, then
      //  normalize — done here so the render thread receives a finished geometry and touches nothing.
      const normals = new Float32Array(positions.length)
      for (let i = 0; i < indices.length; i += 3) {
        const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3
        const abx = positions[b] - positions[a], aby = positions[b + 1] - positions[a + 1], abz = positions[b + 2] - positions[a + 2]
        const acx = positions[c] - positions[a], acy = positions[c + 1] - positions[a + 1], acz = positions[c + 2] - positions[a + 2]
        const fx = aby * acz - abz * acy, fy = abz * acx - abx * acz, fz = abx * acy - aby * acx
        normals[a] += fx; normals[a + 1] += fy; normals[a + 2] += fz
        normals[b] += fx; normals[b + 1] += fy; normals[b + 2] += fz
        normals[c] += fx; normals[c + 1] += fy; normals[c + 2] += fz
      }
      normalize(normals)
      // Then relax the NORMALS on their own. What is left of the layer ripple after Taubin is mostly a shading
      //  artefact — alternating facet orientations read as bands even where the surface itself is within a
      //  fraction of a voxel of smooth. Averaging directions over the 1-ring kills the banding without moving
      //  a single vertex, so silhouettes, the section cut and the reported dimensions are untouched, and it
      //  costs a fraction of a positional round.
      if (normalRounds > 0) smoothNormals(normals, indices, normalRounds)
      return { positions, indices, normals, colors: anyRoles ? col.concat() : null }
    },
  }
}

function normalize(n) {
  for (let v = 0; v < n.length; v += 3) {
    const len = Math.hypot(n[v], n[v + 1], n[v + 2]) || 1
    n[v] /= len; n[v + 1] /= len; n[v + 2] /= len
  }
}

/** Laplacian relaxation of vertex NORMALS, in place — geometry untouched. See the call site for why. */
export function smoothNormals(normals, indices, rounds = 2) {
  const sum = new Float32Array(normals.length)
  for (let r = 0; r < rounds; r++) {
    sum.fill(0)
    for (let i = 0; i < indices.length; i += 3) {
      const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3
      for (const [p, q] of [[a, b], [b, c], [c, a]]) {
        sum[p] += normals[q]; sum[p + 1] += normals[q + 1]; sum[p + 2] += normals[q + 2]
        sum[q] += normals[p]; sum[q + 1] += normals[p + 1]; sum[q + 2] += normals[p + 2]
      }
    }
    for (let v = 0; v < normals.length; v += 3) {
      // The vertex keeps a share of its own direction, so a genuine crease is softened rather than erased.
      normals[v] += 0.5 * sum[v]; normals[v + 1] += 0.5 * sum[v + 1]; normals[v + 2] += 0.5 * sum[v + 2]
    }
    normalize(normals)
  }
}

/**
 * Taubin smoothing, in place: `rounds` pairs of Laplacian relaxations, the second of each pair with a negative
 * factor so the mesh does not shrink the way plain Laplacian does. What it removes is exactly the reimport's
 * "grain": xy voxels are ~3x coarser than the layer height, so each layer's contour quantizes slightly
 * differently and near-vertical walls come out with a high-frequency ripple FROM LAYER TO LAYER. That makes
 * the jitter a vertical phenomenon — so neighbours are weighted by their |dz|: the out-of-phase vertices one
 * layer up/down dominate the average and cancel the ripple in a few rounds, while the same-ring lateral
 * neighbours (same phase — averaging them does nothing against jitter) barely vote. On flat tops every weight
 * degenerates to the epsilon and the pass becomes a plain no-op Laplacian over an already-flat patch.
 */
export function smoothMesh(positions, indices, rounds = 4) {
  const sum = new Float32Array(positions.length)
  const wsum = new Float32Array(positions.length / 3)
  // No per-triangle allocations in here: this runs 3 edges x ~4.5M triangles x 2 relaxations x `rounds`, and
  //  the destructured pair-array version spent more time in GC than in arithmetic.
  const edge = (p, q) => {
    const p3 = p * 3, q3 = q * 3
    const w = Math.abs(positions[q3 + 2] - positions[p3 + 2])
      + 0.05 * (Math.abs(positions[q3] - positions[p3]) + Math.abs(positions[q3 + 1] - positions[p3 + 1])) + 1e-6
    sum[p3] += w * positions[q3]; sum[p3 + 1] += w * positions[q3 + 1]; sum[p3 + 2] += w * positions[q3 + 2]
    sum[q3] += w * positions[p3]; sum[q3 + 1] += w * positions[p3 + 1]; sum[q3 + 2] += w * positions[p3 + 2]
    wsum[p] += w; wsum[q] += w
  }
  const relax = (factor) => {
    sum.fill(0); wsum.fill(0)
    for (let i = 0; i < indices.length; i += 3) {
      const a = indices[i], b = indices[i + 1], c = indices[i + 2]
      edge(a, b); edge(b, c); edge(c, a)
    }
    for (let v = 0; v < wsum.length; v++) {
      const n = wsum[v]
      if (!n) continue
      const v3 = v * 3
      positions[v3] += factor * (sum[v3] / n - positions[v3])
      positions[v3 + 1] += factor * (sum[v3 + 1] / n - positions[v3 + 1])
      positions[v3 + 2] += factor * (sum[v3 + 2] / n - positions[v3 + 2])
    }
  }
  for (let r = 0; r < rounds; r++) { relax(0.5); relax(-0.53) }
}

/**
 * Batch convenience over the streaming core (and what the node tests pin): a whole occupancy volume in, a flat
 * Float32Array triangle soup out (9 floats per face, outward winding).
 */
export function surfaceNets(occ, nx, ny, nz, sx, sy, sz, ox, oy, oz) {
  const nets = makeStreamingNets(nx, ny, sx, sy, sz, ox, oy, oz)
  for (let z = 0; z < nz; z++) nets.pushSlice(occ.subarray(z * nx * ny, (z + 1) * nx * ny))
  const { positions, indices } = nets.finish()
  const soup = new Float32Array(indices.length * 3)
  let w = 0
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i] * 3
    soup[w++] = positions[v]; soup[w++] = positions[v + 1]; soup[w++] = positions[v + 2]
  }
  return soup
}

/** RGBA pixels (canvas ImageData order, row 0 at TOP = +y) -> one occupancy slice written into `occ` at slice
 *  `z`, with rows flipped so the y index grows along +y. The green channel is kept AS COVERAGE (0..255) — its
 *  anti-aliased edge grays are what surfaceNets interpolates against; thresholding here would throw them away.
 *
 *  Returns the slice's per-row occupancy RANGES (Int32Array, [lo,hi] per output row; lo>hi = empty row) —
 *  computed here because this pass touches every byte anyway, and they are what lets the nets sweep skip the
 *  empty plate around the model instead of scanning the full frame. A zero RGBA word (cleared canvas) skips
 *  four pixels at a time; on a typical mask that is most of the frame. */
export function fillSliceFromRGBA(occ, rgba, nx, ny, z) {
  const words = new Uint32Array(rgba.buffer, rgba.byteOffset, rgba.byteLength >> 2)
  const ranges = new Int32Array(ny * 2)
  for (let r = 0; r < ny; r++) {
    const yIdx = ny - 1 - r
    const rowWord = (r * nx * 4) >> 2
    const outOff = nx * (yIdx + ny * z)
    let lo = nx, hi = -1
    for (let c = 0; c < nx; c++) {
      const w = words[rowWord + c]
      if (w === 0) { occ[outOff + c] = 0; continue }
      const g = (w >> 8) & 255                            // little-endian RGBA: byte1 = green
      occ[outOff + c] = g
      if (g) { if (c < lo) lo = c; if (c > hi) hi = c }
    }
    ranges[yIdx * 2] = lo; ranges[yIdx * 2 + 1] = hi
  }
  return ranges
}
