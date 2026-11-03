import * as THREE from 'three'
import { isClick } from '../core/click.js'
import { THEME } from '../core/theme.js'
import { worldToModel } from '../core/measure.js'
import { edgeGrid, snapPoint, SNAP_RADIUS_PX } from '../core/edge_snap.js'

// What the object tools need from the scene: a click on a surface, marks drawn over the model, and turning an object.
//  While a pick handler is set a click belongs to the tool, so it selects nothing (`picking`, read in onDown).
const PLANE_MARGIN_MM = 8      // the cut plane shows past the object, or the object would hide all of it
const FEATURE_EDGE_DEGREES = 30   // faces meeting at more than this make an edge worth snapping to; flat faces' diagonals do not
const EDGE_GRID_CELL_MM = 4

export function applyNegativeLook(mesh, negative) {
  // Drawn through the model: a negative part sits inside what it cuts, where an opaque body would hide it.
  mesh.material.transparent = negative
  mesh.material.depthTest = !negative
  mesh.renderOrder = 0
  mesh.material.opacity = 1
  if (negative) { mesh.material.opacity = 0.45; mesh.material.color.set(THEME.negativePart); mesh.renderOrder = 5 }
  mesh.material.needsUpdate = true
}

export function createSceneTools({ scene, camera, renderer, raycaster, pointer, toPointer, activeMeshes, objectsRef, extruderColorsRef, invalidate }) {
  let onPick = null, press = null, onHover = null, snapping = false
  const edgeGrids = new WeakMap()   // per geometry, built on the first hover over it: three's EdgesGeometry walks every face
  const marks = new THREE.Group()
  marks.renderOrder = 10
  scene.add(marks)
  const markMaterial = new THREE.PointsMaterial({ color: 0xffffff, size: 9, sizeAttenuation: false, depthTest: false, transparent: true })
  const hoverMaterial = new THREE.PointsMaterial({ color: 0xffffff, size: 7, sizeAttenuation: false, depthTest: false, transparent: true, opacity: 0.7 })
  const snapMaterial = new THREE.PointsMaterial({ color: THEME.accent, size: 11, sizeAttenuation: false, depthTest: false, transparent: true })
  const previewMaterial = new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 2, gapSize: 1.5, depthTest: false, transparent: true })
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
  // The picked points, and the point under the pointer: dashed from the last pick while a second one is wanted, green when
  //  it sits on a corner or an edge.
  const showMarks = (worldPoints, hover = null) => {
    clearMarks()
    const geometry = (points) => new THREE.BufferGeometry().setFromPoints(points.map(point => new THREE.Vector3(...point)))
    if (worldPoints.length) marks.add(new THREE.Points(geometry(worldPoints), markMaterial))
    if (worldPoints.length > 1) marks.add(new THREE.Line(geometry(worldPoints), lineMaterial))
    if (hover) {
      let material = hoverMaterial
      if (hover.snapped) material = snapMaterial
      marks.add(new THREE.Points(geometry([hover.worldPoint]), material))
      if (worldPoints.length === 1) {
        const preview = new THREE.Line(geometry([worldPoints[0], hover.worldPoint]), previewMaterial)
        preview.computeLineDistances()
        marks.add(preview)
      }
    }
    invalidate()
  }
  const gridOf = (mesh) => {
    if (!edgeGrids.has(mesh.geometry)) {
      const edges = new THREE.EdgesGeometry(mesh.geometry, FEATURE_EDGE_DEGREES)
      edgeGrids.set(mesh.geometry, edgeGrid(edges.getAttribute('position').array, EDGE_GRID_CELL_MM))
      edges.dispose()
    }
    return edgeGrids.get(mesh.geometry)
  }
  // Snapping works in the mesh's own frame, where the edges were found; the reach in pixels becomes millimetres at the hit.
  const snapped = (hit) => {
    const mesh = hit.object
    const reachPerPixel = 2 * hit.distance * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / renderer.domElement.clientHeight
    const scale = mesh.getWorldScale(new THREE.Vector3())
    const local = mesh.worldToLocal(hit.point.clone()).toArray()
    const result = snapPoint(gridOf(mesh), local, SNAP_RADIUS_PX * reachPerPixel / Math.max(scale.x, scale.y, scale.z))
    return { worldPoint: mesh.localToWorld(new THREE.Vector3(...result.point)).toArray(), kind: result.kind }
  }
  const surfaceAt = (event) => {
    toPointer(event)
    raycaster.setFromCamera(pointer, camera)
    const hit = raycaster.intersectObjects(activeMeshes(), false)[0]
    if (!hit) return null
    const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld)
    let worldPoint = hit.point.toArray(), snappedTo = null
    if (snapping && (snapKeyHeld || event.ctrlKey || event.metaKey)) ({ worldPoint, kind: snappedTo } = snapped(hit))
    return {
      worldPoint, point: worldToModel(worldPoint), normal: worldToModel(normal.toArray()), snapped: snappedTo,
      objectId: objectsRef.current.find(object => object.mesh === hit.object)?.id ?? null,
    }
  }
  // Snapping lasts while Ctrl (Cmd on a Mac) is held, so a press or release with the pointer still re-reads the hover. The
  //  key state is kept here too: a Cmd click measured without metaKey on its pointer events.
  let lastMove = null, snapKeyHeld = false
  const onMove = (event) => {
    lastMove = { clientX: event.clientX, clientY: event.clientY }
    if (onHover && event.buttons === 0) onHover(surfaceAt(event))
  }
  const onModifier = (event) => {
    if (event.key !== 'Control' && event.key !== 'Meta') return
    snapKeyHeld = event.type === 'keydown'
    if (onHover && lastMove) onHover(surfaceAt({ ...lastMove, ctrlKey: false, metaKey: false }))
  }
  const onBlur = () => { snapKeyHeld = false }
  const onDown = (event) => { if (onPick && event.button === 0) press = { x: event.clientX, y: event.clientY } }
  const onUp = (event) => {
    if (!onPick || event.button !== 0 || !isClick(press, { x: event.clientX, y: event.clientY })) return
    press = null
    const surface = surfaceAt(event)
    if (surface) onPick(surface)
  }
  renderer.domElement.addEventListener('pointerdown', onDown)
  renderer.domElement.addEventListener('pointerup', onUp)
  renderer.domElement.addEventListener('pointermove', onMove)
  window.addEventListener('keydown', onModifier)
  window.addEventListener('keyup', onModifier)
  window.addEventListener('blur', onBlur)

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
    if (!negative) {
      const color = extruderColorsRef.current[(object.extruder || 1) - 1]
      if (color) object.mesh.material.color.set(color)
      object.mesh.position.y -= new THREE.Box3().setFromObject(object.mesh).min.y   // a print stands on the bed
      object.mesh.updateMatrixWorld(true)
    }
    invalidate()
  }
  const setHeight = (id, height) => {
    const mesh = objectsRef.current.find(object => object.id === id)?.mesh
    if (mesh) { mesh.position.y = height; mesh.updateMatrixWorld(true); invalidate() }
  }

  return {
    showPlane, setNegative, setHeight,
    // `hover` follows the pointer while no button is down; `snap` moves picks and hovers onto corners and edges while Ctrl
    //  or Cmd is held.
    setPick: (handler, { hover = null, snap = false } = {}) => { onPick = handler; onHover = hover; snapping = snap; press = null },
    picking: () => !!onPick,
    showMarks, clearMarks, faceBed,
    dispose: () => {
      renderer.domElement.removeEventListener('pointerdown', onDown)
      renderer.domElement.removeEventListener('pointerup', onUp)
      renderer.domElement.removeEventListener('pointermove', onMove)
      window.removeEventListener('keydown', onModifier)
      window.removeEventListener('keyup', onModifier)
      window.removeEventListener('blur', onBlur)
      clearMarks(); scene.remove(marks)
      for (const material of [markMaterial, hoverMaterial, snapMaterial, previewMaterial, lineMaterial, planeMaterial]) material.dispose()
    },
  }
}
