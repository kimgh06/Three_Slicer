// Surface-nets reconstruction invariants (core/sla_reconstruct.js): outward winding (positive signed volume),
//  dimensional fidelity within a voxel, holes preserved, and the RGBA slice reader's row flip.
import { strict as assert } from 'node:assert'
import { surfaceNets, makeStreamingNets, smoothMesh, fillSliceFromRGBA } from './src/core/sla_reconstruct.js'

let passed = 0
const ok = (name) => { passed++; console.log('  ok', name) }

const signedVolume = (soup) => {
  let six = 0
  for (let i = 0; i < soup.length; i += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = soup.subarray(i, i + 9)
    six += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)
  }
  return six / 6
}
const bboxOf = (soup) => {
  const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9]
  for (let i = 0; i < soup.length; i += 3) for (let a = 0; a < 3; a++) {
    if (soup[i + a] < lo[a]) lo[a] = soup[i + a]
    if (soup[i + a] > hi[a]) hi[a] = soup[i + a]
  }
  return { lo, hi }
}
const boxOcc = (nx, ny, nz, fill) => {
  const occ = new Uint8Array(nx * ny * nz)
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++)
    occ[x + nx * (y + ny * z)] = fill(x, y, z) ? 255 : 0
  return occ
}

// [box] a filled block comes back as a closed outward-wound box of its own size
{
  const [nx, ny, nz] = [24, 16, 10]
  const occ = boxOcc(nx, ny, nz, (x, y, z) => x >= 2 && x < 22 && y >= 2 && y < 14 && z >= 1 && z < 9)
  const soup = surfaceNets(occ, nx, ny, nz, 0.5, 0.5, 0.4, -6, -4, 0)
  assert.ok(soup.length > 0)
  const vol = signedVolume(soup)
  const expected = 20 * 0.5 * 12 * 0.5 * 8 * 0.4   // 76.8 mm^3
  assert.ok(vol > 0, `outward winding — signed volume ${vol.toFixed(2)} must be positive`)
  assert.ok(Math.abs(vol - expected) / expected < 0.1, `volume ${vol.toFixed(2)} vs ${expected}`)
  const { lo, hi } = bboxOf(soup)
  // sample centres of the filled span sit at [-4.75, 4.75] in x; the surface lands half a voxel outside them
  assert.ok(Math.abs((hi[0] - lo[0]) - 10) < 0.51, `x extent ${(hi[0] - lo[0]).toFixed(2)}`)
  assert.ok(Math.abs((hi[1] - lo[1]) - 6) < 0.51, `y extent ${(hi[1] - lo[1]).toFixed(2)}`)
  assert.ok(Math.abs((hi[2] - lo[2]) - 3.2) < 0.41, `z extent ${(hi[2] - lo[2]).toFixed(2)}`)
  ok('box: closed, outward, dimensions within a voxel')
}

// [hole] a through-tunnel survives: volume = outer minus tunnel
{
  const [nx, ny, nz] = [20, 20, 8]
  const occ = boxOcc(nx, ny, nz, (x, y, z) =>
    x >= 2 && x < 18 && y >= 2 && y < 18 && z >= 1 && z < 7
    && !(x >= 8 && x < 12 && y >= 8 && y < 12))       // 4x4 tunnel through all z
  const soup = surfaceNets(occ, nx, ny, nz, 1, 1, 1, 0, 0, 0)
  const vol = signedVolume(soup)
  const expected = 16 * 16 * 6 - 4 * 4 * 6
  assert.ok(Math.abs(vol - expected) / expected < 0.1, `volume ${vol.toFixed(1)} vs ${expected}`)
  ok('hole: through-tunnel volume subtracts')
}

// [slice reader] canvas rows (top = +y) land flipped into the volume, green channel kept as coverage
{
  const nx = 4, ny = 3
  const rgba = new Uint8ClampedArray(nx * ny * 4)
  const set = (c, r, g) => { rgba[(r * nx + c) * 4 + 1] = g }
  set(1, 0, 255)   // top row -> highest y index
  set(3, 2, 200)   // bottom row -> y index 0
  set(0, 1, 10)    // faint gray survives as data
  const occ = new Uint8Array(nx * ny * 2)
  fillSliceFromRGBA(occ, rgba, nx, ny, 1)
  assert.equal(occ[nx * (2 + ny * 1) + 1], 255)   // (x=1, y=2, z=1)
  assert.equal(occ[nx * (0 + ny * 1) + 3], 200)   // (x=3, y=0, z=1)
  assert.equal(occ[nx * (1 + ny * 1) + 0], 10)
  ok('slice reader: row flip, coverage preserved')
}

// [interpolation] anti-aliased edge grays move the surface INSIDE the voxel — a box wrapped in a gray ring
//  must come out larger than the sharp box, by the iso crossing's fraction of a voxel
{
  const [nx, ny, nz] = [24, 16, 10]
  const inner = (x, y, z) => x >= 3 && x < 21 && y >= 3 && y < 13 && z >= 2 && z < 8
  const ring = (x, y, z) => x >= 2 && x < 22 && y >= 2 && y < 14 && z >= 1 && z < 9
  const sharp = boxOcc(nx, ny, nz, inner)
  const soft = boxOcc(nx, ny, nz, inner)
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++)
    if (ring(x, y, z) && !inner(x, y, z)) soft[x + nx * (y + ny * z)] = 64   // a 25% gray shell
  const volSharp = signedVolume(surfaceNets(sharp, nx, ny, nz, 1, 1, 1, 0, 0, 0))
  const volSoft = signedVolume(surfaceNets(soft, nx, ny, nz, 1, 1, 1, 0, 0, 0))
  // crossing between 255 and 64 sits at t = (127.5-255)/(64-255) = 0.667 of the edge instead of 0.5
  assert.ok(volSoft > volSharp * 1.05, `soft ${volSoft.toFixed(1)} must exceed sharp ${volSharp.toFixed(1)}`)
  assert.ok(volSoft > 0)
  ok('interpolation: gray edges shift the surface off the voxel grid')
}

// [indexed output] the streaming API's mesh is well-formed: indices in range, unit smooth normals that agree
//  with the winding (a vertex normal must not point against the faces that built it)
{
  const [nx, ny, nz] = [16, 12, 8]
  const nets = makeStreamingNets(nx, ny, 1, 1, 1, 0, 0, 0)
  for (let z = 0; z < nz; z++) {
    const slice = new Uint8Array(nx * ny)
    if (z >= 1 && z < 7)
      for (let y = 2; y < 10; y++) for (let x = 2; x < 14; x++) slice[x + nx * y] = 255
    nets.pushSlice(slice)
  }
  const { positions, indices, normals } = nets.finish()
  assert.equal(positions.length, normals.length)
  assert.equal(indices.length % 3, 0)
  const vertCount = positions.length / 3
  for (const i of indices) assert.ok(i >= 0 && i < vertCount, `index ${i} out of ${vertCount}`)
  for (let v = 0; v < normals.length; v += 3) {
    const len = Math.hypot(normals[v], normals[v + 1], normals[v + 2])
    assert.ok(Math.abs(len - 1) < 1e-5, `normal length ${len}`)
  }
  // every face normal must have a positive dot with its vertices' smooth normals
  let bad = 0
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3
    const abx = positions[b] - positions[a], aby = positions[b + 1] - positions[a + 1], abz = positions[b + 2] - positions[a + 2]
    const acx = positions[c] - positions[a], acy = positions[c + 1] - positions[a + 1], acz = positions[c + 2] - positions[a + 2]
    const fx = aby * acz - abz * acy, fy = abz * acx - abx * acz, fz = abx * acy - aby * acx
    for (const v of [a, b, c]) if (fx * normals[v] + fy * normals[v + 1] + fz * normals[v + 2] < 0) bad++
  }
  assert.equal(bad, 0, `${bad} vertex normals point against their faces`)
  // and the indexed mesh agrees with the batch wrapper over the identical volume
  const occ = new Uint8Array(nx * ny * nz)
  for (let z = 1; z < 7; z++) for (let y = 2; y < 10; y++) for (let x = 2; x < 14; x++) occ[x + nx * (y + ny * z)] = 255
  const soup = surfaceNets(occ, nx, ny, nz, 1, 1, 1, 0, 0, 0)
  assert.equal(soup.length, indices.length * 3)
  assert.ok(Math.abs(signedVolume(soup) - 12 * 8 * 6) / (12 * 8 * 6) < 0.1)
  ok('indexed output: bounds, unit normals, winding agreement, matches the batch path')
}

// [role colours] with role slices supplied, vertices inside the support/pad regions take those colours and
//  the rest stay model-coloured; without them `colors` is null
{
  const [nx, ny, nz] = [20, 10, 6]
  const mkSlice = (fill) => {
    const s = new Uint8Array(nx * ny)
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) s[x + nx * y] = fill(x, y) ? 255 : 0
    return s
  }
  // two blocks: model at x 2..8, support at x 12..18 (marked role 5)
  const nets = makeStreamingNets(nx, ny, 1, 1, 1, 0, 0, 0)
  for (let z = 0; z < nz; z++) {
    const slice = mkSlice((x, y) => y >= 2 && y < 8 && ((x >= 2 && x < 8) || (x >= 12 && x < 18)))
    const roles = new Uint8Array(nx * ny)
    for (let y = 2; y < 8; y++) for (let x = 12; x < 18; x++) roles[x + nx * y] = 5
    nets.pushSlice(slice, roles)
  }
  const { positions, colors } = nets.finish()
  assert.ok(colors && colors.length === positions.length)
  let modelSide = null, supportSide = null
  for (let v = 0; v < positions.length; v += 3) {
    if (positions[v] < 9 && modelSide === null) modelSide = colors.slice(v, v + 3)
    if (positions[v] > 11 && supportSide === null) supportSide = colors.slice(v, v + 3)
  }
  assert.ok(modelSide && supportSide)
  assert.notDeepEqual(Array.from(modelSide), Array.from(supportSide))
  assert.ok(supportSide[2] > supportSide[0], 'support colour is the blue-leaning purple')
  assert.ok(modelSide[0] > modelSide[2], 'model colour is the red-leaning orange')
  // and without roles, no colour attribute at all
  const plain = makeStreamingNets(4, 4, 1, 1, 1, 0, 0, 0)
  plain.pushSlice(mkSlice((x, y) => false).slice(0, 16))
  assert.equal(plain.finish().colors, null)
  ok('role colours: support/pad vertices coloured, absent roles -> null')
}

// [smoothing] Taubin passes remove per-layer jitter without shrinking the body: a wall whose occupancy
//  alternates one voxel in x every other layer must flatten, while the enclosed volume stays put
{
  const [nx, ny, nz] = [20, 12, 16]
  const nets = makeStreamingNets(nx, ny, 1, 1, 1, 0, 0, 0)
  for (let z = 0; z < nz; z++) {
    const slice = new Uint8Array(nx * ny)
    const xEnd = 10 + (z % 2)                              // the jittered wall at x ~ 10
    for (let y = 2; y < 10; y++) for (let x = 2; x < xEnd; x++) slice[x + nx * y] = 255
    nets.pushSlice(slice)
  }
  const rough = nets.finish()                              // no smoothing
  // Only the jittered wall (x ~ 10, away from the box's own edges) — a whole-mesh metric would be dominated
  //  by the corners, which smoothing correctly leaves alone.
  const wallStd = (positions) => {
    let sum = 0, sq = 0, n = 0
    for (let v = 0; v < positions.length; v += 3) {
      const x = positions[v], y = positions[v + 1], z = positions[v + 2]
      if (x > 8.5 && y > 4 && y < 8 && z > 4 && z < 12) { sum += x; sq += x * x; n++ }
    }
    return Math.sqrt(sq / n - (sum / n) ** 2)
  }
  const before = wallStd(rough.positions)
  const smoothed = Float32Array.from(rough.positions)
  smoothMesh(smoothed, rough.indices, 4)
  const after = wallStd(smoothed)
  assert.ok(after < before * 0.5, `wall jitter ${before.toFixed(4)} -> ${after.toFixed(4)} must drop by half`)
  // volume preserved: rebuild soups from both and compare signed volumes
  const soupOf = (positions, indices) => {
    const s = new Float32Array(indices.length * 3)
    let w = 0
    for (const i of indices) { s[w++] = positions[i * 3]; s[w++] = positions[i * 3 + 1]; s[w++] = positions[i * 3 + 2] }
    return s
  }
  const v0 = signedVolume(soupOf(rough.positions, rough.indices))
  const v1 = signedVolume(soupOf(smoothed, rough.indices))
  assert.ok(Math.abs(v1 - v0) / v0 < 0.05, `volume ${v0.toFixed(1)} -> ${v1.toFixed(1)} must hold within 5%`)
  ok('smoothing: layer jitter halved, volume held')
}

console.log(`test_sla_reconstruct: ${passed} checks passed`)
