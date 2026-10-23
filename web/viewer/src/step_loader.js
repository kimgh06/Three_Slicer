// STEP (.step/.stp) import — tessellates BREP via occt-import-js (OCCT WASM, LGPL-2.1).
// Why it lives in the **app** rather than the package (three-slicer): it is a 7.6MB wasm dependency, and keeping it out
//  preserves the "zero runtime dependencies" of the kernel and viewer. Any consumer can attach arbitrary formats the same way by copying the 6 lines below.
// Dynamic import — the glue + wasm are fetched only when a .step file is actually opened (zero impact on the initial bundle).
import { registerLoader } from 'three-slicer-viewer/loaders'

let occtP = null
const getOcct = () => (occtP ||= (async () => {
  const [{ default: occtimportjs }, { default: wasmUrl }] = await Promise.all([
    import('occt-import-js'),
    import('occt-import-js/dist/occt-import-js.wasm?url'),
  ])
  return occtimportjs({ locateFile: () => wasmUrl })
})())

registerLoader('step,stp', async (buffer, name) => {
  const occt = await getOcct()
  const r = occt.ReadStepFile(new Uint8Array(buffer), null)   // null = default tessellation deviation
  if (!r?.success) throw new Error('Failed to parse STEP')

  // occt result: meshes[].attributes.position.array (Float32, vertices) + index.array (triangle indices).
  //  Coordinates are the file's own — STEP is z-up mm by CAD convention, so it is used as-is just like STL/3MF.
  const out = []
  for (const m of r.meshes || []) {
    const pos = m.attributes?.position?.array, idx = m.index?.array
    if (!pos || !idx || idx.length < 3) continue
    const tris = new Float32Array(idx.length * 3)
    for (let i = 0; i < idx.length; i++) {
      const o = idx[i] * 3
      tris[i * 3] = pos[o]; tris[i * 3 + 1] = pos[o + 1]; tris[i * 3 + 2] = pos[o + 2]
    }
    out.push({ name: r.meshes.length > 1 ? `${name}#${out.length + 1}` : name, modelPos: tris })
  }
  return out
})
