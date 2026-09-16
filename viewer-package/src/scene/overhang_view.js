import * as THREE from 'three'

// Overhang shading: highlights the facets that will need support, before slicing.
// The rule mirrors the kernel (support.cpp): θ is the slope angle measured so that 90° is a vertical wall and
// 0° a horizontal ceiling, and support is generated where θ < support_threshold_angle. For a facet whose world
// normal is n that angle is acos(-n.y), so the test is cos θ > cos(threshold) — upward-facing facets give a
// negative cosine and never qualify, which is why no separate "is it downward" check is needed.
// It is a per-facet approximation of the kernel's per-layer contour test: good enough to aim the support brush,
// not a prediction of the exact support polygons.
export function buildOverhangGeometry(mesh, thresholdDeg) {
  const geometry = mesh.geometry
  const position = geometry?.getAttribute('position')
  if (!position) return null
  const index = geometry.getIndex()
  const faceCount = (index ? index.count : position.count) / 3
  const minCos = Math.cos(Math.max(0, Math.min(90, thresholdDeg)) * Math.PI / 180)

  const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld)
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3()
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), normal = new THREE.Vector3()
  const out = []

  for (let f = 0; f < faceCount; f++) {
    const i0 = index ? index.getX(f * 3) : f * 3
    const i1 = index ? index.getX(f * 3 + 1) : f * 3 + 1
    const i2 = index ? index.getX(f * 3 + 2) : f * 3 + 2
    a.fromBufferAttribute(position, i0)
    b.fromBufferAttribute(position, i1)
    c.fromBufferAttribute(position, i2)
    normal.copy(ab.subVectors(b, a)).cross(ac.subVectors(c, a))
    if (normal.lengthSq() === 0) continue                 // degenerate facet
    normal.applyMatrix3(normalMatrix).normalize()
    if (-normal.y <= minCos) continue                     // steeper than the threshold (or facing up) -> no support
    out.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z)  // local coords: the overlay is a child of the mesh
  }
  if (!out.length) return null
  const overhang = new THREE.BufferGeometry()
  overhang.setAttribute('position', new THREE.Float32BufferAttribute(out, 3))
  overhang.computeVertexNormals()
  return overhang
}
