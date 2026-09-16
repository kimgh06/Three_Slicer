// The solid resin preview as a three.js group — one builder for the focused plate (clipped by the layer slider's
// planes) and the static previews of the other resin plates (no planes). Split out of use_three_scene.js by
// size only; the scene owns the planes and the groups.
import * as THREE from 'three'
import { indexedGeometry } from './sla_raster.js'
import { stlToSoup } from '../core/model_geometry.js'
import { THEME } from '../core/theme.js'

export const disposeSceneGroup = (g) => { g.parent?.remove(g); g.traverse(o => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose() } }) }

// One builder for both the focused (clipped by the layer slider) and the static (whole) resin previews.
export function buildSlaGroup(payload, clipPlanes) {
  const { modelSTL, modelIndexed, supportMesh, padMesh, lift = 0, offX = 0, offZ = 0 } = payload
  const group = new THREE.Group()
  group.rotation.x = -Math.PI / 2
  group.position.set(offX, 0, offZ)
  const material = (color) => new THREE.MeshPhongMaterial({
    color, side: THREE.DoubleSide, ...(clipPlanes ? { clippingPlanes: clipPlanes } : {}),
  })
  const soup = (arr) => {
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(arr, 3))
    geo.computeVertexNormals(); return geo }
  // A reconstruction arrives pre-indexed with smooth normals averaged in the worker (indexedGeometry,
  //  scene/sla_raster.js); a sliced result stays a flat-shaded STL soup.
  const modelGeo = modelIndexed ? indexedGeometry(modelIndexed) : (modelSTL ? soup(stlToSoup(modelSTL)) : null)
  if (modelGeo) {
    const mesh = new THREE.Mesh(modelGeo, Object.assign(material(modelIndexed?.colors ? 0xffffff : THEME.slaModel), { vertexColors: !!modelIndexed?.colors }))
    mesh.position.z = lift            // group is z-up: +z is world up
    group.add(mesh)
  }
  if (supportMesh && supportMesh.length) group.add(new THREE.Mesh(soup(supportMesh), material(THEME.slaSupport)))
  if (padMesh && padMesh.length) group.add(new THREE.Mesh(soup(padMesh), material(THEME.slaPad)))
  return group
}
