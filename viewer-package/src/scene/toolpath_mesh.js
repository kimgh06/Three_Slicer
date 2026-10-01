// The toolpath scene objects: one instanced mesh for the extrusions, one LineSegments for the travels.
//
// Written from viewer/TOOLPATH_SPEC.md §4. THREE is PASSED IN, never imported — that is what guarantees the
// consumer's own three.js instance is used, and it is why this module has no dependency of its own and can
// be consumed from a page that already has three loaded.
import { SEG_VS, SEG_FS } from '../core/toolpath_shaders.js'
import { THEME } from '../core/theme.js'
import { LOD_LEVELS, baseLayerTop, decimateLayers, typicalLayerHeight, projectedPixels, chooseLevel } from '../core/toolpath_lod.js'

// The bead template: a four-corner ring at each end of the segment, so 8 vertices.
//  tpl = [which end (0 = start, 1 = end), which ring corner (0 = +side, 1 = +up, 2 = -side, 3 = -up)]
export const TEMPLATE_TPL = new Float32Array([
  0, 0,  0, 1,  0, 2,  0, 3,     // start ring
  1, 0,  1, 1,  1, 2,  1, 3,     // end ring
])

/** The 24 indices that skin the four sides of the prism. Caps are omitted on purpose: consecutive beads
 *  butt against each other, so a cap is either hidden or coincident, and 8 more triangles per segment on a
 *  million-segment plate is not free. Generated rather than written out, so the winding cannot drift. */
export const VERTEX_DATA = (() => {
  const idx = []
  for (let ring = 0; ring < 4; ring++) {
    const a = ring, b = (ring + 1) % 4          // start ring
    const c = 4 + ((ring + 1) % 4), d = 4 + ring // end ring, same two corners
    idx.push(a, b, c, a, c, d)
  }
  return idx
})()

/**
 * data -> { mesh, travLines, setLayerRange, setVisibleLayers, setTravelVisible, setColors, dispose,
 *           nSeg, layerCount }
 *
 * Per-instance attributes are read out of the per-vertex buffers in pairs: vertices 2s and 2s+1 are the two
 * endpoints of segment s. Height, width, orientation and colour are constant along a segment, so they come
 * from the first of the pair.
 */
export function makeToolpath(THREE, data) {
  const { nSeg, nV, position, hwa, travelPos, travelPrefix, layerCount, meta } = data

  const iStart = new Float32Array(nSeg * 3)
  const iEnd = new Float32Array(nSeg * 3)
  const iHW = new Float32Array(nSeg * 2)
  const iColor = new Float32Array(nSeg)
  const iLayer = new Float32Array(nSeg)

  for (let s = 0; s < nSeg; s++) {
    const a = (s * 2) * 4, b = (s * 2 + 1) * 4
    iStart[s * 3] = position[a]; iStart[s * 3 + 1] = position[a + 1]; iStart[s * 3 + 2] = position[a + 2]
    iEnd[s * 3] = position[b]; iEnd[s * 3 + 1] = position[b + 1]; iEnd[s * 3 + 2] = position[b + 2]
    iHW[s * 2] = hwa[a]; iHW[s * 2 + 1] = hwa[a + 1]
    iColor[s] = hwa[a + 3]                       // the feature-view colour, until setColors replaces it
    iLayer[s] = meta.vLayer[s * 2]
  }

  const geometry = new THREE.InstancedBufferGeometry()
  geometry.setAttribute('tpl', new THREE.BufferAttribute(TEMPLATE_TPL, 2))
  geometry.setIndex(VERTEX_DATA)
  geometry.setAttribute('iStart', new THREE.InstancedBufferAttribute(iStart, 3))
  geometry.setAttribute('iEnd', new THREE.InstancedBufferAttribute(iEnd, 3))
  geometry.setAttribute('iHW', new THREE.InstancedBufferAttribute(iHW, 2))
  const colorAttr = new THREE.InstancedBufferAttribute(iColor, 1)
  geometry.setAttribute('iColor', colorAttr)
  geometry.setAttribute('iLayer', new THREE.InstancedBufferAttribute(iLayer, 1))
  geometry.instanceCount = nSeg
  // The instances move themselves in the vertex shader, so the template's own tiny bounds are meaningless
  //  to the frustum culler — it would cull the whole plate the moment the template's origin left the view.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), (data.maxAbs || 1) * 2)

  const material = new THREE.RawShaderMaterial({
    vertexShader: SEG_VS,
    fragmentShader: SEG_FS,
    glslVersion: THREE.GLSL3,
    // Every face of the template winds outward (test_toolpath_contract.mjs), so a back face is only ever the
    //  inside of a bead seen through its open end. Drawing those doubled the GPU time of a frame: measured on a
    //  14.6M-segment scene (6 plates, M5 Pro, DPR 2), 53.6 -> 29.4 ms with back faces culled.
    side: THREE.FrontSide,
    uniforms: { uLayerLo: { value: 0 }, uLayerHi: { value: Math.max(0, layerCount - 1) } },
  })

  const mesh = new THREE.Mesh(geometry, material)
  mesh.frustumCulled = false

  // The coarse levels (core/toolpath_lod.js): one instanced mesh per k, children of `mesh` so a consumer that adds
  //  `mesh` to its scene has them too. They stay hidden until updateLod picks one; the full mesh then draws no
  //  instances (three.js skips a draw of 0 instances) rather than being hidden, which would hide its children.
  const baseTop = baseLayerTop(meta.vType, meta.vLayer)
  const levels = LOD_LEVELS.map((k) => {
    const { source, layers } = decimateLayers(s => iLayer[s], nSeg, k, baseTop)
    const n = source.length
    const lStart = new Float32Array(n * 3), lEnd = new Float32Array(n * 3), lHW = new Float32Array(n * 2)
    const lColor = new Float32Array(n), lLayer = new Float32Array(n)
    for (let j = 0; j < n; j++) {
      const s = source[j], height = iHW[s * 2]
      const drop = (layers[j] - 1) * height / 2    // the bead covers its group, so its centre moves down
      lStart[j * 3] = iStart[s * 3]; lStart[j * 3 + 1] = iStart[s * 3 + 1]; lStart[j * 3 + 2] = iStart[s * 3 + 2] - drop
      lEnd[j * 3] = iEnd[s * 3]; lEnd[j * 3 + 1] = iEnd[s * 3 + 1]; lEnd[j * 3 + 2] = iEnd[s * 3 + 2] - drop
      lHW[j * 2] = height * layers[j]; lHW[j * 2 + 1] = iHW[s * 2 + 1]
      lColor[j] = iColor[s]; lLayer[j] = iLayer[s]
    }
    const levelGeometry = new THREE.InstancedBufferGeometry()
    levelGeometry.setAttribute('tpl', geometry.attributes.tpl)
    levelGeometry.setIndex(geometry.index)
    levelGeometry.setAttribute('iStart', new THREE.InstancedBufferAttribute(lStart, 3))
    levelGeometry.setAttribute('iEnd', new THREE.InstancedBufferAttribute(lEnd, 3))
    levelGeometry.setAttribute('iHW', new THREE.InstancedBufferAttribute(lHW, 2))
    const levelColorAttr = new THREE.InstancedBufferAttribute(lColor, 1)
    levelGeometry.setAttribute('iColor', levelColorAttr)
    levelGeometry.setAttribute('iLayer', new THREE.InstancedBufferAttribute(lLayer, 1))
    levelGeometry.instanceCount = n
    const levelMesh = new THREE.Mesh(levelGeometry, material)
    levelMesh.frustumCulled = false
    levelMesh.visible = false
    mesh.add(levelMesh)
    return { k, mesh: levelMesh, source, colors: lColor, colorAttr: levelColorAttr }
  })
  let level = 1, fullRange = true
  const showLevel = (k) => {
    if (k === level) return
    level = k
    for (const entry of levels) entry.mesh.visible = entry.k === k
    geometry.instanceCount = 0
    if (k === 1) geometry.instanceCount = nSeg
  }
  const layerHeight = typicalLayerHeight(s => iHW[s * 2], nSeg)
  const localBox = data.bbox && new THREE.Box3(new THREE.Vector3(...data.bbox.min), new THREE.Vector3(...data.bbox.max))
  const worldBox = new THREE.Box3()
  /** Picks the level for this frame from how tall one layer is on screen at the plate's NEAREST point, so a plate
   *  the camera is close to anywhere stays detailed there. A cut layer range always draws full detail. */
  const updateLod = (camera, viewportPixels) => {
    if (!fullRange || !localBox || !camera?.isPerspectiveCamera) { showLevel(1); return }
    worldBox.copy(localBox).applyMatrix4(mesh.matrixWorld)
    showLevel(chooseLevel(projectedPixels(layerHeight, worldBox.distanceToPoint(camera.position), camera.fov, viewportPixels)))
  }
  mesh.userData.updateLod = updateLod

  const travGeometry = new THREE.BufferGeometry()
  travGeometry.setAttribute('position', new THREE.BufferAttribute(travelPos, 3))
  const travMaterial = new THREE.LineBasicMaterial({ color: THEME.travel, transparent: true, opacity: 0.6 })
  const travLines = new THREE.LineSegments(travGeometry, travMaterial)
  travLines.visible = false
  travLines.frustumCulled = false

  const setLayerRange = (lo, hi) => {
    const top = Math.max(0, layerCount - 1)
    const l = Math.max(0, Math.min(lo | 0, top))
    const h = Math.max(l, Math.min(hi | 0, top))
    material.uniforms.uLayerLo.value = l
    material.uniforms.uLayerHi.value = h
    fullRange = l === 0 && h === top
    if (!fullRange) showLevel(1)
    // Travels ARE stored in layer order, so a draw range is exact here and costs nothing — no need to pay
    //  for a second shader just to hide them.
    const from = travelPrefix[l] * 2
    const to = travelPrefix[h + 1] * 2
    travGeometry.setDrawRange(from, Math.max(0, to - from))
  }
  setLayerRange(0, layerCount - 1)

  return {
    mesh,
    travLines,
    setLayerRange,
    setVisibleLayers: (n) => setLayerRange(0, (n | 0) - 1),
    setTravelVisible: (visible) => { travLines.visible = !!visible },
    /** color is Float32Array(nV*4) with the packed value in .r — computeColors' output shape. One instance
     *  takes the colour of its first vertex; the two agree, since a segment is one colour. */
    setColors: (color) => {
      if (!color || color.length < nV * 4) return
      for (let s = 0; s < nSeg; s++) iColor[s] = color[(s * 2) * 4]
      colorAttr.needsUpdate = true
      for (const entry of levels) {
        for (let j = 0; j < entry.source.length; j++) entry.colors[j] = iColor[entry.source[j]]
        entry.colorAttr.needsUpdate = true
      }
    },
    /** Call once per frame before rendering; viewportPixels is the drawing buffer's height. */
    updateLod,
    lodLevel: () => level,
    dispose: () => {
      for (const entry of levels) entry.mesh.geometry.dispose()
      geometry.dispose(); material.dispose()
      travGeometry.dispose(); travMaterial.dispose()
    },
    nSeg,
    layerCount,
  }
}
