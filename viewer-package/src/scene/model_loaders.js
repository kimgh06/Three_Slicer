// Stage 26: unified model import pipeline — STL/OBJ/3MF/AMF/PLY.
//  Reuses three/examples/jsm loaders (no new npm dependency). Each loader result (BufferGeometry|Group) ->
//  bake world matrix -> non-indexed triangles -> a **model z-up** flat array (N*9). Reuses the slice path (addObject->buildMergedSTL->kernel).
//  Coordinate systems (measured): every 3D printing format is z-up mm. three's loaders apply no axis conversion and load raw file coordinates,
//   so STL/3MF/AMF/PLY are used as model coordinates z-up as-is. OBJ may conventionally be y-up (graphics), but printing OBJ files are
//   usually z-up -> z-up by default (rotate with the gizmo when that is wrong). This call follows the printing workflow (rationale comment).
import * as THREE from 'three'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js'
import { AMFLoader } from 'three/examples/jsm/loaders/AMFLoader.js'
import { parse3MFProject } from '../core/parse_3mf.js'
import { makeParse3mfWorker } from '../make_worker.js'
import { STL_HEADER_BYTES, STL_DATA_OFFSET, stlByteLength } from '../core/stl_format.js'

// ---- 3MF parsing off the main thread -------------------------------------------------------------------------
// A slicer project is the one import big enough to be felt: 52MB compressed / 315MB of XML / 3.8M triangles takes
//  about two seconds, and on the main thread that is two seconds of dead UI. One worker is reused for the session
//  (starting it costs a module load) and requests are tagged, so several dropped files parse without racing.
// Everything degrades to the in-thread parser: no Worker global (node, tests), a bundler that did not emit the
//  worker chunk, a CSP that blocks it. Slower, never broken — and the fallback is the same function the worker runs.
let parseWorker = null
let parseWorkerBroken = false
let nextRequestId = 0
const pendingParses = new Map()

function parse3mfWorker() {
  if (parseWorkerBroken || typeof Worker === 'undefined') return null
  if (parseWorker) return parseWorker
  try {
    parseWorker = makeParse3mfWorker()
    parseWorker.onmessage = (event) => {
      const { id, objects, project, error } = event.data || {}
      const pending = pendingParses.get(id)
      if (!pending) return
      pendingParses.delete(id)
      error ? pending.reject(new Error(error)) : pending.resolve({ objects, project })
    }
    // A worker that dies takes every request in flight with it; they are rejected so the caller can retry rather
    //  than hang, and the worker is not resurrected — whatever killed it will kill the next one too.
    parseWorker.onerror = () => {
      parseWorkerBroken = true
      for (const [, pending] of pendingParses) pending.reject(new Error('3MF parse worker failed'))
      pendingParses.clear()
      parseWorker = null
    }
  } catch {
    parseWorkerBroken = true
    parseWorker = null
  }
  return parseWorker
}

async function parse3mf(buffer, name) {
  const worker = parse3mfWorker()
  if (!worker) return parse3MFProject(buffer, name)
  try {
    const id = ++nextRequestId
    const result = new Promise((resolve, reject) => pendingParses.set(id, { resolve, reject }))
    worker.postMessage({ id, buffer, baseName: name })
    return await result
  } catch {
    return parse3MFProject(buffer, name)   // the buffer is never transferred, so it is still intact here
  }
}

// Built-in formats. registerLoader() appends extensions here (the file dialog / drag-and-drop filters read this).
export const SUPPORTED_EXT = ['stl', 'obj', '3mf', 'amf', 'ply']

// Extra loader registry. Formats needing heavy dependencies (STEP -> OCCT WASM, 7.6MB) are not bundled and are
//  registered by the consumer — three-slicer keeps zero runtime dependencies. (Demo app example: web/viewer/src/step_loader.js)
//   registerLoader('step,stp', async (buffer, name) => [{ name, modelPos: Float32Array(N*9, z-up mm) }])
const extra = new Map()
export function registerLoader(exts, fn) {
  for (const e of (Array.isArray(exts) ? exts : String(exts).split(',')).map(s => s.trim().toLowerCase())) {
    extra.set(e, fn)
    if (!SUPPORTED_EXT.includes(e)) SUPPORTED_EXT.push(e)
  }
}

export function fileExt(name) { const i = name.lastIndexOf('.'); return i < 0 ? '' : name.slice(i + 1).toLowerCase() }

// --- STL parser (binary + ASCII) -> model-space position (N*9) ---  (moved out of the old Viewport logic)
function parseSTL(buffer) {
  const dv = new DataView(buffer)
  if (buffer.byteLength >= STL_DATA_OFFSET) {
    const n = dv.getUint32(STL_HEADER_BYTES, true)
    if (buffer.byteLength === stlByteLength(n)) {
      const pos = new Float32Array(n * 9)
      let off = STL_DATA_OFFSET, p = 0
      for (let i = 0; i < n; i++) {
        off += 12
        for (let v = 0; v < 3; v++) { pos[p++] = dv.getFloat32(off, true); pos[p++] = dv.getFloat32(off + 4, true); pos[p++] = dv.getFloat32(off + 8, true); off += 12 }
        off += 2
      }
      return pos
    }
  }
  const text = new TextDecoder().decode(buffer)
  const re = /vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/g
  const nums = []; let m
  while ((m = re.exec(text))) nums.push(+m[1], +m[2], +m[3])
  if (nums.length < 9) return null
  return new Float32Array(nums)
}

// BufferGeometry (+ world matrix) -> non-indexed triangles as a model z-up flat array (N*9). Loader coordinates are used as z-up directly.
function geoToModelTris(geometry, matrix) {
  const pos = geometry?.attributes?.position
  if (!pos || pos.count < 3) return null
  const idx = geometry.index
  const v = new THREE.Vector3()
  const nTri = Math.floor((idx ? idx.count : pos.count) / 3)
  const out = new Float32Array(nTri * 9)
  let o = 0
  const emit = (i) => { v.fromBufferAttribute(pos, i); if (matrix) v.applyMatrix4(matrix); out[o++] = v.x; out[o++] = v.y; out[o++] = v.z }
  if (idx) { for (let i = 0; i < nTri * 3; i++) emit(idx.getX(i)) }
  else { for (let i = 0; i < nTri * 3; i++) emit(i) }
  return out
}

// Recursive Group/Object3D walk -> [{geometry, matrixWorld}] (for baking the world matrix).
function collectMeshes(root) {
  root.updateMatrixWorld(true)
  const meshes = []
  root.traverse(o => { if (o.isMesh && o.geometry) meshes.push({ geometry: o.geometry, matrix: o.matrixWorld }) })
  return meshes
}

// Loader result -> object list. With multi=true (3mf/amf) each mesh becomes its own object, otherwise everything is merged into one.
function meshesToObjects(baseName, meshes, multi) {
  const parts = meshes.map(m => geoToModelTris(m.geometry, m.matrix)).filter(Boolean)
  if (!parts.length) return []
  if (multi && parts.length > 1) {
    return parts.map((p, i) => ({ name: `${baseName}#${i + 1}`, modelPos: p }))
  }
  if (parts.length === 1) return [{ name: baseName, modelPos: parts[0] }]
  // Merge
  let total = 0; for (const p of parts) total += p.length
  const merged = new Float32Array(total); let o = 0
  for (const p of parts) { merged.set(p, o); o += p.length }
  return [{ name: baseName, modelPos: merged }]
}

// Public API: (filename, ArrayBuffer) -> Promise<[{name, modelPos(N*9, model z-up)}]>. Pure, kernel-independent.
export async function loadModel(name, buffer) {
  const ext = fileExt(name)
  switch (ext) {
    case 'stl': {
      const pos = parseSTL(buffer)
      if (!pos) throw new Error('Failed to parse STL')
      return [{ name, modelPos: pos }]
    }
    case 'obj': {
      const g = new OBJLoader().parse(new TextDecoder().decode(buffer))   // Group
      return meshesToObjects(name, collectMeshes(g), false)
    }
    case 'ply': {
      const geo = new PLYLoader().parse(buffer)                            // BufferGeometry
      const tris = geoToModelTris(geo, null)
      if (!tris) throw new Error('No PLY geometry')
      return [{ name, modelPos: tris }]
    }
    case '3mf': {
      // Own parser — three's ThreeMFLoader cannot read the production extension (p:path), so every slicer-saved 3mf came out empty.
      // A slicer-written 3mf is a project: `paint` and `project` carry the preset/painting/plate state next to the mesh.
      const { objects, project } = await parse3mf(buffer, name)
      const objs = objects.map(o => ({ name: o.name, modelPos: o.tris, objectid: o.objectid, paint: o.paint, bbox: o.bbox, project }))
      if (!objs.length) throw new Error('No mesh in 3MF')
      return objs
    }
    case 'amf': {
      const g = new AMFLoader().parse(buffer)                              // Group (uses DOMParser — browser only)
      const objs = meshesToObjects(name, collectMeshes(g), true)
      if (!objs.length) throw new Error('No mesh in AMF')
      return objs
    }
    default: {
      const fn = extra.get(ext)
      if (!fn) throw new Error(`Unsupported format: .${ext}`)
      const objs = await fn(buffer, name)
      if (!objs?.length) throw new Error(`No mesh in .${ext}`)
      return objs
    }
  }
}

// ---- Stage 33: split to objects (upstream Split to objects / TriangleMesh::its_split) ----
// Upstream definition: "facets are considered connected **when they share an edge** (shared edge = two shared vertex indices)"
//  (TriangleMesh.cpp:1505). Each connected component (patch) becomes its own object.
// Our localPos is a non-indexed triangle stream (9 vertex values per triangle), so we first quantize coordinates to weld vertices,
//  then build edges and gather components with union-find. No adjacency list is built, so memory/time stay near-linear.
//
// Returns: Float32Array[] when there are 2+ components (each component's localPos, in the input coordinate system),
//       null when there is only 1 (cannot split).
export function splitConnectedComponents(localPos) {
  const nTri = Math.floor(localPos.length / 9)
  if (nTri < 2) return null

  // Vertex welding: quantize to a 1e-4mm grid so floating-point error does not split identical points
  const Q = 1e4
  const vmap = new Map()
  const vidx = new Int32Array(nTri * 3)
  for (let t = 0; t < nTri; t++) {
    for (let k = 0; k < 3; k++) {
      const o = t * 9 + k * 3
      const key = `${Math.round(localPos[o] * Q)},${Math.round(localPos[o + 1] * Q)},${Math.round(localPos[o + 2] * Q)}`
      let id = vmap.get(key)
      if (id === undefined) { id = vmap.size; vmap.set(key, id) }
      vidx[t * 3 + k] = id
    }
  }

  // union-find
  const parent = new Int32Array(nTri)
  for (let i = 0; i < nTri; i++) parent[i] = i
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x] } return x }
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[b] = a }

  // Edge (vertex pair) -> the first facet seen. Meeting the same edge again unions the two facets.
  //  Non-manifold edges with 3+ facets still link up fine, all against that first facet.
  const edge = new Map()
  for (let t = 0; t < nTri; t++) {
    for (let e = 0; e < 3; e++) {
      const a = vidx[t * 3 + e], b = vidx[t * 3 + (e + 1) % 3]
      const key = a < b ? a * 4294967296 + b : b * 4294967296 + a   // pack two vertex indices into one number
      const prev = edge.get(key)
      if (prev === undefined) edge.set(key, t)
      else union(t, prev)
    }
  }

  // Collect facets per component
  const groups = new Map()
  for (let t = 0; t < nTri; t++) {
    const r = find(t)
    let g = groups.get(r)
    if (!g) { g = []; groups.set(r, g) }
    g.push(t)
  }
  if (groups.size < 2) return null

  // Largest component first (upstream also sorts by volume so the first object is the main body)
  const parts = [...groups.values()].sort((a, b) => b.length - a.length)
  return parts.map(faces => {
    const out = new Float32Array(faces.length * 9)
    let w = 0
    for (const t of faces) { const o = t * 9; for (let k = 0; k < 9; k++) out[w++] = localPos[o + k] }
    return out
  })
}
