import * as THREE from 'three'
import { buildRayGrid, raycastGrid } from '../core/ray_grid.js'

// Mesh.raycast through core/ray_grid.js, in three's own hit format, for the viewer's unindexed double-sided meshes. Any
//  other mesh takes three's raycast. The grid is built on the first raycast and kept while the positions are unchanged.
const grids = new WeakMap()
const inverse = new THREE.Matrix4()
const localRay = new THREE.Ray()
const triangle = new THREE.Triangle()

export function gridRaycast(raycaster, intersects) {
  const geometry = this.geometry
  const position = geometry?.attributes?.position
  if (!position || geometry.index || this.material?.side !== THREE.DoubleSide) {
    THREE.Mesh.prototype.raycast.call(this, raycaster, intersects)
    return
  }
  let kept = grids.get(geometry)
  if (!kept || kept.version !== position.version) {
    kept = { version: position.version, grid: buildRayGrid(position.array) }
    grids.set(geometry, kept)
  }
  inverse.copy(this.matrixWorld).invert()
  localRay.copy(raycaster.ray).applyMatrix4(inverse)
  const origin = localRay.origin.toArray(), direction = localRay.direction.toArray()
  const positions = position.array
  for (const hit of raycastGrid(kept.grid, positions, origin, direction)) {
    const point = localRay.at(hit.distance, new THREE.Vector3()).applyMatrix4(this.matrixWorld)
    const distance = raycaster.ray.origin.distanceTo(point)
    if (distance < raycaster.near || distance > raycaster.far) continue
    const at = hit.triangle * 9
    triangle.a.fromArray(positions, at); triangle.b.fromArray(positions, at + 3); triangle.c.fromArray(positions, at + 6)
    const a = hit.triangle * 3
    intersects.push({ distance, point, object: this, faceIndex: hit.triangle, face: { a, b: a + 1, c: a + 2, normal: triangle.getNormal(new THREE.Vector3()), materialIndex: 0 } })
  }
}
