import * as THREE from 'three'
import { platePosition, plateIndexAtXZ, plateLayoutHetero } from './plate_layout.js'
import { STL_HEADER_BYTES, STL_DATA_OFFSET, STL_TRIANGLE_BYTES, stlByteLength } from './stl_format.js'

// The object list -> model-space geometry. Both consumers of that conversion live here because they share three
//  things that must not drift apart: the extruder sort (which decides the merged facet numbering), the
//  three(x,y,z) -> model(x,-z,y) frame, and the plate grid the coordinates are expressed against.
//
// Only three.js MATH is used (Vector3/Matrix4), never the renderer — so this module runs under node and is
//  covered by test_merge_stl.mjs. That is the whole point of it not living in the scene's mount-once closure:
//  `buildMergedSTL` is the single owner of the kernel's facet numbering (see AGENTS.md), and a contract that
//  cannot be executed in a test is a contract nobody is checking.
//
// Callers pass PLAIN objects, not meshes: {id, name, extruder, localPos, matrixWorld, paint}. Deciding which
//  objects are in the list (visibility, selection) stays with the scene, because that is scene state.

/** Upstream's merge order: ascending extruder. Stable, so objects on the same tool keep their scene order. */
export const sortByExtruder = (objects) => [...objects].sort((a, b) => (a.extruder || 1) - (b.extruder || 1))

/** Which plate an object sits on = the plate nearest its world origin. `plateDims` (heterogeneous beds)
 *  switches the closed-form uniform grid for the cumulative one — same rule, per-plate cell sizes. */
export function plateOfObject(object, { plateCount, bedWidth, bedDepth, plateDims }) {
  const worldPosition = new THREE.Vector3().setFromMatrixPosition(object.matrixWorld)
  if (plateDims) return plateLayoutHetero(plateDims).indexAt(worldPosition.x, worldPosition.z)
  return plateIndexAtXZ(worldPosition.x, worldPosition.z, plateCount, bedWidth, bedDepth)
}

// When plateIndex != null, only objects on that plate are used and coordinates are converted to plate-local
//  (three-x -= PX) (keeps the stage-28 contract).
export function buildMergedSTL(objects, { plateIndex = null, selectedPlate = 0, plateCount, bedWidth, bedDepth, plateDims = null }) {
  const grid = { plateCount, bedWidth, bedDepth, plateDims }
  let arr = objects
  if (plateIndex != null) arr = arr.filter(o => plateOfObject(o, grid) === plateIndex)
  if (!arr.length) return null
  const sorted = sortByExtruder(arr)
  const usedExtruders = new Set(sorted.map(o => o.extruder || 1))
  const tmp = new THREE.Vector3(); const out = []
  // One boundary per extruder change, not just the first: with objects on T1/T2/T3 a single boundary would
  //  fold T3's triangles into T2's group and print them with T2's material. `tools` carries the real
  //  extruder number of each group, because assignments can skip one (T1 and T3 with nothing on T2).
  let triCount = 0, split = 0
  const splits = [], tools = []
  // What the selector's facet numbering depends on: which objects are in the merge, in what order, each with
  //  how many faces. Moving one does not appear here — which is the point, because a move must not renumber
  //  anything and so must not cost the paint.
  const topology = []
  // Painting imported from a 3mf, rebased from each object's own facet numbering onto the merged one. It has to
  //  happen HERE and not at load: which objects are merged, and in what order, is decided by this function
  //  (visibility, plate, the extruder sort below) and the kernel's selector only ever sees the result.
  const paintImport = { color: { facets: [], hex: [] }, supports: { facets: [], hex: [] } }
  for (const o of sorted) {
    const ext = o.extruder || 1
    topology.push(`${o.id}:${ext}:${o.localPos.length / 9}`)
    // triCount is this object's base facet index — it is only advanced at the bottom of the loop.
    if (o.paint) for (const slot of ['color', 'supports'])
      for (const [localTri, hex] of o.paint[slot] ?? []) {   // the store writes only the kinds it holds
        paintImport[slot].facets.push(triCount + localTri)
        paintImport[slot].hex.push(hex)
      }
    if (tools.length === 0) tools.push(ext - 1)
    else if (ext - 1 !== tools[tools.length - 1]) { splits.push(triCount); tools.push(ext - 1) }
    if (ext >= 2 && split === 0) split = triCount   // start boundary of ext2 (the pre-N-way scalar form)
    const M = o.matrixWorld, lp = o.localPos
    for (let i = 0; i < lp.length; i += 3) { tmp.set(lp[i], lp[i + 1], lp[i + 2]).applyMatrix4(M); out.push(tmp.x, -tmp.z, tmp.y) }  // Rinv -> model (world)
    triCount += lp.length / 9
  }
  // The slice frame is the PLATE, not the model. This used to subtract the content's own bbox centre, which
  //  made the frame move whenever the model moved — and everything anchored to something else then needed a
  //  correction nobody owned: the prime tower drifted by exactly the model's off-centre amount, and the paint
  //  transform went stale on the first drag. Subtracting the plate origin instead gives a frame that does not
  //  move, so a bed coordinate means the same thing to the slicer, the scene and the G-code.
  //  (The centring was a workaround for a kernel that lost infill away from the origin — clip_util.h
  //  infill_lines, fixed: six placements of the same cube now slice to the same 1043.9 mm.)
  //  Upstream does the same thing with m_plate_origin.
  const plate = plateIndex != null ? plateIndex : selectedPlate
  const origin = plateDims ? plateLayoutHetero(plateDims).position(plate) : platePosition(plate, plateCount, bedWidth, bedDepth)
  const originModelX = origin.x, originModelY = -origin.z      // three(x,z) -> model(x,y)
  for (let i = 0; i < out.length; i += 3) { out[i] -= originModelX; out[i + 1] -= originModelY }
  // Toolpath display offset: put the plate back where it lives. Plate 0 is the origin, so a single-plate
  //  project slices in world coordinates and needs no offset at all.
  const offX3 = origin.x, offZ3 = origin.z
  const buf = new ArrayBuffer(stlByteLength(triCount)), dvw = new DataView(buf)
  dvw.setUint32(STL_HEADER_BYTES, triCount, true)
  let off = STL_DATA_OFFSET, vi = 0
  for (let t = 0; t < triCount; t++) {
    off += 12
    for (let k = 0; k < 3; k++) { dvw.setFloat32(off, out[vi++], true); dvw.setFloat32(off + 4, out[vi++], true); dvw.setFloat32(off + 8, out[vi++], true); off += 12 }
    dvw.setUint16(off, 0, true); off += 2
  }
  // The content's own box in slice coordinates, so the slicer side can place the prime tower NEXT to the model
  //  rather than at the bed-corner default (measured: model at the bed centre, tower 90mm away at (10,10)).
  //  The box, not half-extents: the model is no longer centred in this frame, so where it sits matters as
  //  much as how big it is.
  let minX = 1e18, minY = 1e18, maxX = -1e18, maxY = -1e18
  for (let i = 0; i < out.length; i += 3) {
    if (out[i] < minX) minX = out[i]; if (out[i] > maxX) maxX = out[i]
    if (out[i + 1] < minY) minY = out[i + 1]; if (out[i + 1] > maxY) maxY = out[i + 1]
  }
  // Ready for the kernel's selector_import_paint: a facet-index array and the matching hex strings, joined
  //  with the newline that binding splits on. A slot with nothing painted is null, not an empty pair.
  const paint = {}
  for (const slot of ['color', 'supports'])
    paint[slot] = paintImport[slot].facets.length
      ? { facets: Int32Array.from(paintImport[slot].facets), hex: paintImport[slot].hex.join('\n') }
      : null
  // `plate` rides along so per-plate settings (the wipe_tower_x/y arrays) can be indexed by the plate this
  //  merge actually cut, not by whatever is selected when the slice runs.
  // `members` is the merge's object order with each object's face count — the numbering the selector uses, which
  //  the per-object paint store (paint_store.js) splits exports by and rebuilds imports from.
  const members = sorted.map(o => ({ id: o.id, faceCount: o.localPos.length / 9 }))
  return { buf, split, splits, tools, extruders: usedExtruders.size, offX: offX3, offZ: offZ3,
           plate, topology: topology.join('|'), members, minX, minY, maxX, maxY, paint }
}

/** Every object as the 3mf writer needs it: world MODEL-space triangles (three (x,y,z) -> model (x,-z,y),
 *  the same convention buildMergedSTL uses), plus the plate it sits on and its facet count. Per object and
 *  NOT merged, because a 3mf keeps one <object> per model and its facet indices are per object.
 *  The merge order is the writer's problem, not this one's — it needs the same sort buildMergedSTL applies
 *  to line the selector's facet numbering back up, so that sort is applied here as well. */
export function exportObjects(objects, { plateCount, bedWidth, bedDepth }) {
  const grid = { plateCount, bedWidth, bedDepth }
  const tmp = new THREE.Vector3()
  return sortByExtruder(objects).map(o => {
    const M = o.matrixWorld, lp = o.localPos
    const tris = new Float32Array(lp.length)
    for (let i = 0; i < lp.length; i += 3) {
      tmp.set(lp[i], lp[i + 1], lp[i + 2]).applyMatrix4(M)
      tris[i] = tmp.x; tris[i + 1] = -tmp.z; tris[i + 2] = tmp.y
    }
    const plate = plateOfObject(o, grid)
    // The plate's own origin in MODEL coordinates, so the writer can express the object's position relative
    //  to its plate without re-deriving this viewer's grid (it has upstream's to encode into already).
    const origin = platePosition(plate, plateCount, bedWidth, bedDepth)
    return { id: o.id, name: o.name, extruder: o.extruder || 1, plate,
             plateOriginX: origin.x, plateOriginY: -origin.z,
             tris, faceCount: lp.length / 9, paint: o.paint || null }
  })
}

// Binary STL bytes -> a non-indexed position soup (9 floats per triangle), stored normals skipped. This is the
//  inverse direction of buildMergedSTL: the SLA preview re-renders the exact buffer the kernel sliced as a solid
//  mesh, so the two cannot disagree. Returns null on anything that is not a well-formed binary STL.
export function stlToSoup(buf) {
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf
  if (!bytes || bytes.byteLength < STL_DATA_OFFSET) return null
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const count = dv.getUint32(STL_HEADER_BYTES, true)
  if (stlByteLength(count) !== bytes.byteLength) return null
  const pos = new Float32Array(count * 9)
  for (let i = 0; i < count; i++) {
    const base = STL_DATA_OFFSET + STL_TRIANGLE_BYTES * i + 12   // past the stored normal
    for (let f = 0; f < 9; f++) pos[i * 9 + f] = dv.getFloat32(base + 4 * f, true)
  }
  return pos
}
