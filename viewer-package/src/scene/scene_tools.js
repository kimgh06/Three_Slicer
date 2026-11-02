import * as THREE from 'three'
import { isClick } from '../core/click.js'
import { THEME } from '../core/theme.js'
import { worldToModel } from '../core/measure.js'

// What the object tools need from the scene: a click on a surface, marks drawn over the model, and turning an object.
//  While a pick handler is set a click belongs to the tool, so it selects nothing (`picking`, read in onDown).
const PLANE_MARGIN_MM = 8      // the cut plane shows past the object, or the object would hide all of it

export function applyNegativeLook(mesh, negative) {
  // Drawn through the model: a negative part sits inside what it cuts, where an opaque body would hide it.
  mesh.material.transparent = negative
  mesh.material.depthTest = !negative
  mesh.renderOrder = 0
  mesh.material.opacity = 1
  if (negative) { mesh.material.opacity = 0.45; mesh.material.color.set(THEME.negativePart); mesh.renderOrder = 5 }
  mesh.material.needsUpdate = true
}

export function createSceneTools({ scene, camera, renderer, raycaster, pointer, toPointer, activeMeshes, objectsRef, invalidate }) {
  let onPick = null, press = null
  const marks = new THREE.Group()
  marks.renderOrder = 10
  scene.add(marks)
  const markMaterial = new THREE.PointsMaterial({ color: 0xffffff, size: 9, sizeAttenuation: false, depthTest: false, transparent: true })
  const lineMaterial = new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true })
  const planeMaterial = new THREE.MeshBasicMaterial({ color: THEME.accent, side: THREE.DoubleSide, transparent: true, opacity: 0.35, depthWrite: false })

  const clearMarks = () => {
    for (const child of [...marks.children]) { child.geometry.dispose(); marks.remove(child) }
    invalidate()
  }
  // The cut plane's preview, in the world frame: a quad across `bounds` (model frame) at `at` along model `axis`.
  const showPlane = (axis, at, { min, max }) => {
    clearMarks()
    const span = [0, 1, 2].filter(other => other !== axis)
    const corner = (u, v) => {
      const point = [0, 0, 0]
      point[axis] = at
      point[span[0]] = [min[span[0]] - PLANE_MARGIN_MM, max[span[0]] + PLANE_MARGIN_MM][u]
      point[span[1]] = [min[span[1]] - PLANE_MARGIN_MM, max[span[1]] + PLANE_MARGIN_MM][v]
      return new THREE.Vector3(point[0], point[2], -point[1])
    }
    const geometry = new THREE.BufferGeometry().setFromPoints([corner(0, 0), corner(1, 0), corner(1, 1), corner(0, 0), corner(1, 1), corner(0, 1)])
    marks.add(new THREE.Mesh(geometry, planeMaterial))
    invalidate()
  }
  const showMarks = (worldPoints) => {
    clearMarks()
    const geometry = () => new THREE.BufferGeometry().setFromPoints(worldPoints.map(point => new THREE.Vector3(...point)))
    marks.add(new THREE.Points(geometry(), markMaterial))
    if (worldPoints.length > 1) marks.add(new THREE.Line(geometry(), lineMaterial))
    invalidate()
  }
  const surfaceAt = (event) => {
    toPointer(event)
    raycaster.setFromCamera(pointer, camera)
    const hit = raycaster.intersectObjects(activeMeshes(), false)[0]
    if (!hit) return null
    const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld)
    const worldPoint = hit.point.toArray()
    return {
      worldPoint, point: worldToModel(worldPoint), normal: worldToModel(normal.toArray()),
      objectId: objectsRef.current.find(object => object.mesh === hit.object)?.id ?? null,
    }
  }
  const onDown = (event) => { if (onPick && event.button === 0) press = { x: event.clientX, y: event.clientY } }
  const onUp = (event) => {
    if (!onPick || event.button !== 0 || !isClick(press, { x: event.clientX, y: event.clientY })) return
    press = null
    const surface = surfaceAt(event)
    if (surface) onPick(surface)
  }
  renderer.domElement.addEventListener('pointerdown', onDown)
  renderer.domElement.addEventListener('pointerup', onUp)

  // Turns an object so `direction` (model frame) faces the bed, keeping it where it stands and setting it on the bed.
  //  Precise box: the geometry's own box through a rotation is loose, which would leave the object floating.
  const faceBed = (id, direction) => {
    const mesh = objectsRef.current.find(object => object.id === id)?.mesh
    if (!mesh) return
    mesh.updateMatrixWorld(true)
    const before = new THREE.Box3().setFromObject(mesh, true).getCenter(new THREE.Vector3())
    const worldDirection = new THREE.Vector3(direction[0], direction[2], -direction[1]).normalize()
    mesh.quaternion.premultiply(new THREE.Quaternion().setFromUnitVectors(worldDirection, new THREE.Vector3(0, -1, 0)))
    mesh.updateMatrixWorld(true)
    const after = new THREE.Box3().setFromObject(mesh, true)
    const center = after.getCenter(new THREE.Vector3())
    mesh.position.x += before.x - center.x
    mesh.position.z += before.z - center.z
    mesh.position.y -= after.min.y
    mesh.updateMatrixWorld(true)
    invalidate()
  }

  // A negative part is a tool, not a print: drawn see-through, and it holds its height because it cuts at that height.
  const setNegative = (id, negative) => {
    const object = objectsRef.current.find(candidate => candidate.id === id)
    if (!object) return
    object.negative = negative; object.keepHeight = negative
    object.mesh.userData.keepHeight = negative
    object.mesh.userData.negative = negative
    applyNegativeLook(object.mesh, negative)
    invalidate()
  }
  const setHeight = (id, height) => {
    const mesh = objectsRef.current.find(object => object.id === id)?.mesh
    if (mesh) { mesh.position.y = height; mesh.updateMatrixWorld(true); invalidate() }
  }

  return {
    showPlane, setNegative, setHeight,
    setPick: (handler) => { onPick = handler; press = null },
    picking: () => !!onPick,
    showMarks, clearMarks, faceBed,
    dispose: () => {
      renderer.domElement.removeEventListener('pointerdown', onDown)
      renderer.domElement.removeEventListener('pointerup', onUp)
      clearMarks(); scene.remove(marks); markMaterial.dispose(); lineMaterial.dispose(); planeMaterial.dispose()
    },
  }
}
