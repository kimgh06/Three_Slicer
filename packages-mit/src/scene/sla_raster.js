import * as THREE from 'three'
import { THEME } from '../core/theme.js'

// Sampled planes in the stand-in stack; `?sl1Ghost=N` overrides for measuring (0 disables it entirely).
const GHOST_PLANES = (() => {
  const q = typeof location !== 'undefined' && Number(new URLSearchParams(location.search).get('sl1Ghost'))
  return Number.isFinite(q) && q >= 0 ? q : 64
})()

// Imported SL1 raster preview: one full-resolution plane for the CURRENT layer (decoded on demand — a whole
//  archive decoded up front is gigabytes of RGBA) plus a translucent THUMBNAIL STACK of sampled layers.
//  The stack is what makes the import read as the object: a single mask at a time is geometrically faithful
//  and still looks nothing like the model — an archive's top layer is one speck floating at full height,
//  which reads as "the import came out wrong" rather than as a layer. Masks drive alphaMap, so white (cured)
//  pixels show as resin and black stays transparent. Lives outside use_three_scene to keep that shell under
//  its line budget; the factory owns all of the state.
/** The reconstruction worker's indexed mesh -> a BufferGeometry, verbatim: positions, averaged normals, the
 *  index and (when the archive carried a role sidecar) per-vertex colours all arrive finished, so the render
 *  thread never pays the million-vertex weld itself. */
export function indexedGeometry({ positions, indices, normals, colors = null }) {
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
  if (colors) geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  geo.setIndex(new THREE.BufferAttribute(indices, 1))
  return geo
}

export function makeSlaRaster(toolpathGroup, invalidate) {
  let state = null   // { group, plane, texture, canvas, payload, token, stack: [{mesh, texture}] }

  function clearStack() {
    if (!state) return
    for (const s of state.stack) { s.mesh.parent?.remove(s.mesh); s.mesh.geometry.dispose(); s.mesh.material.dispose(); s.texture.dispose() }
    state.stack = []
  }

  function clear() {
    if (!state) return
    state.token = -1                                    // orphan any in-flight decode
    clearStack()
    state.group.parent?.remove(state.group)
    state.plane.geometry.dispose()
    state.plane.material.dispose()
    state.texture.dispose()
    state = null
    invalidate()
  }

  /** `payload` is { width, height (mm), affine: {width, height, matrix}, zOf(i),
   *  getImage(i) -> Promise<ImageBitmap>, offX, offZ }; null tears it down. The plane sits in the same
   *  z-up kernel frame the solid SLA preview uses. Call setLayer to show a layer. */
  function set(payload) {
    clear()
    if (!payload) return
    const group = new THREE.Group()
    group.rotation.x = -Math.PI / 2
    group.position.set(payload.offX ?? 0, 0.02, payload.offZ ?? 0)   // hair above the plate, against z-fighting
    const canvas = document.createElement('canvas')
    canvas.width = payload.affine.width; canvas.height = payload.affine.height
    const texture = new THREE.CanvasTexture(canvas)
    const material = new THREE.MeshBasicMaterial({
      color: THEME.slaModel, alphaMap: texture, transparent: true, side: THREE.DoubleSide, depthWrite: false,
    })
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(payload.width, payload.height), material)
    plane.renderOrder = 2                     // above the ghost stack
    group.add(plane)
    toolpathGroup.add(group)
    state = { group, plane, texture, canvas, payload, token: 0, stack: [] }
    invalidate()
    buildStack(state)
  }

  // The silhouette: sampled layers as faint downscaled planes, decoded one at a time in the background so the
  //  import stays responsive. Density matters (48 planes over 1095 layers read as venetian blinds), but so
  //  does what this stack now IS: a stand-in for the ~5-10s until the reconstruction worker delivers the solid
  //  mesh. 64 planes is dense enough to read as the object for that long, and every main-thread decode here
  //  competes with the worker's own decode pool — halving the stack measurably shortens the wait for the mesh.
  async function buildStack(st) {
    const n = st.payload.layerCount
    const count = Math.min(GHOST_PLANES, n)
    const step = n / count
    const opacity = Math.max(0.08, Math.min(0.3, 14 / count))
    const thumbW = 320
    const scale = thumbW / st.payload.affine.width
    const thumbH = Math.max(1, Math.round(st.payload.affine.height * scale))
    for (let k = 0; k < count; k++) {
      const i = Math.min(n - 1, Math.round(k * step))
      if (state !== st || st.token < 0) return            // torn down while decoding
      let bmp
      try { bmp = await st.payload.getImage(i) } catch { continue }
      if (state !== st) { bmp?.close?.(); return }
      const c = document.createElement('canvas')
      c.width = thumbW; c.height = thumbH
      const ctx = c.getContext('2d')
      const m = st.payload.affine.matrix
      ctx.setTransform(m[0] * scale, m[1] * scale, m[2] * scale, m[3] * scale, m[4] * scale, m[5] * scale)
      ctx.drawImage(bmp, 0, 0)
      bmp?.close?.()
      const texture = new THREE.CanvasTexture(c)
      const material = new THREE.MeshBasicMaterial({
        color: THEME.slaModel, alphaMap: texture, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false,
      })
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(st.payload.width, st.payload.height), material)
      mesh.position.z = st.payload.zOf(i)
      mesh.renderOrder = 1
      st.group.add(mesh)
      st.stack.push({ mesh, texture })
      if ((k & 7) === 7) invalidate()                     // repaint as bands of the ghost appear
    }
    invalidate()
  }

  /** Decode layer `i`'s mask and show it at that layer's height. Async; a newer call orphans an older one. */
  async function setLayer(i) {
    const st = state; if (!st) return
    const token = ++st.token
    let bmp
    try { bmp = await st.payload.getImage(i) } catch { return }
    if (state !== st || st.token !== token) { bmp?.close?.(); return }
    const ctx = st.canvas.getContext('2d')
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, st.canvas.width, st.canvas.height)
    ctx.setTransform(...st.payload.affine.matrix)          // archive frame -> display frame
    ctx.drawImage(bmp, 0, 0)
    bmp?.close?.()
    st.texture.needsUpdate = true
    st.plane.position.z = st.payload.zOf(i)
    invalidate()
  }

  return { set, setLayer, clear }
}
