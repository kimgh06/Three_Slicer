// A brush stroke across objects and plates, driven through the REAL createPaintInput with a stubbed raycast.
//   · a hit reaches the kernel in the selector's MERGED numbering (the raycast reports the hit object's own), so an
//     object after the first in the merge is painted where it was hit — it used to seed at the first object's facet
//     of that number, outside the brush, and mark nothing
//   · a stroke that reaches an object on another plate switches the selector there and carries on: the samples that
//     arrive during the switch are not sent to the old selector, the latest one is painted once the switch lands,
//     and the capsule does not span the two plates
//   · the tower and hidden objects paint nothing
//   Run: node viewer-package/tests/test_paint_plate_switch.mjs
import assert from 'node:assert'
import * as THREE from 'three'
import { createPaintInput } from '../src/scene/paint_input.js'
import { mergedFacetOf } from '../src/core/paint_store.js'

const FACES_A = 12, FACES_B = 8, FACES_C = 6
const A = { id: 1, plate: 0, mesh: new THREE.Object3D() }
const B = { id: 2, plate: 0, mesh: new THREE.Object3D() }
const C = { id: 3, plate: 1, mesh: new THREE.Object3D() }
const HIDDEN = { id: 4, plate: 0, mesh: new THREE.Object3D(), visible: false }
const LATE = { id: 5, plate: 0, mesh: new THREE.Object3D() }   // on plate 0, added after the merge was taken
const FACES_LATE = 4
const TOWER = new THREE.Object3D()
const PLATE_0 = { plate: 0, members: [{ id: A.id, faceCount: FACES_A }, { id: B.id, faceCount: FACES_B }] }
const PLATE_1 = { plate: 1, members: [{ id: C.id, faceCount: FACES_C }] }
const HIT_FACET = 3

// ---- the numbering itself ----
{
  assert.equal(mergedFacetOf(PLATE_0.members, A.id, HIT_FACET), HIT_FACET, 'the first object keeps its numbering')
  assert.equal(mergedFacetOf(PLATE_0.members, B.id, HIT_FACET), FACES_A + HIT_FACET, 'a later one starts after the ones before it')
  assert.equal(mergedFacetOf(PLATE_0.members, C.id, HIT_FACET), null, 'an object the selector does not hold has no number')
  assert.equal(mergedFacetOf(PLATE_0.members, B.id, FACES_B), null, 'a facet past the object is not another object\'s')
  assert.equal(mergedFacetOf(null, A.id, 0), null)
}

const setup = () => {
  const sent = []
  let nextHit = null
  const selectorGeomRef = { current: PLATE_0 }
  const switches = []
  let finishSwitch = null
  const camera = new THREE.PerspectiveCamera()
  camera.position.set(0, 100, 100)
  const input = createPaintInput({
    camera, raycaster: { setFromCamera() {}, intersectObjects: () => [nextHit].filter(Boolean) },
    pointer: new THREE.Vector2(), toPointer() {}, activeMeshes: () => [], cursorParent: new THREE.Object3D(),
    invalidate() {}, sectionPlane: { isClipped: () => false, refresh() { switches.push('refresh') } },
    deps: {
      workerRef: { current: { postMessage: (message) => sent.push(message) } },
      paintModeRef: { current: 'material' }, paintXformRef: { current: { cx: 0, cy: 0, minz: 0 } },
      paintToolRef: { current: { tool: 'brush', cursor: 'circle', angle: 30 } }, brushRadiusRef: { current: 2 },
      materialExtruderRef: { current: 1 }, extruderColorsRef: { current: ['#111111', '#222222'] },
      setBrushRadius() {}, setFillAngle() {},
      // The scene derives an object's plate from its position; the records here carry it for the stub to read.
      objectsRef: { current: [A, B, C, HIDDEN, LATE] }, selectorGeomRef, apiRef: { current: { plateOfObject: (object) => object.plate } },
      onPaintPlateNeeded: (plate) => { switches.push(plate); return new Promise(resolve => { finishSwitch = resolve }) },
    },
  })
  const hitOn = (object, x) => { nextHit = { object, faceIndex: HIT_FACET, point: new THREE.Vector3(x, 0, 0) } }
  const land = async (held) => { selectorGeomRef.current = held; finishSwitch(); await new Promise(resolve => setTimeout(resolve, 0)) }
  return { input, sent, switches, hitOn, land }
}
const STROKE = { clientX: 0, clientY: 0 }
const strokes = (sent) => sent.filter(message => message.cmd === 'paint')

// ---- same plate: A then B in one drag ----
{
  const { input, sent, hitOn } = setup()
  input.beginStroke(STROKE)
  hitOn(A.mesh, 1); input.paintAt(STROKE)
  hitOn(B.mesh, 2); input.paintAt(STROKE)
  assert.deepEqual(strokes(sent).map(message => message.facet), [HIT_FACET, FACES_A + HIT_FACET], 'B is painted at its own facet in the merge')
}

// ---- the tower and a hidden object paint nothing and switch nothing ----
{
  const { input, sent, switches, hitOn } = setup()
  input.beginStroke(STROKE)
  hitOn(TOWER, 0); input.paintAt(STROKE)
  hitOn(HIDDEN.mesh, 0); input.paintAt(STROKE)
  assert.equal(sent.length, 0); assert.equal(switches.length, 0)
}

// ---- across plates: A (plate 0) -> C (plate 1) -> back to A, one drag ----
{
  const { input, sent, switches, hitOn, land } = setup()
  input.beginStroke(STROKE)
  hitOn(A.mesh, 1); input.paintAt(STROKE)
  hitOn(C.mesh, 300); input.paintAt(STROKE)
  assert.deepEqual(switches, [C.plate], 'reaching plate 1 asks for the selector to switch there')
  const LATEST_X = 301
  hitOn(C.mesh, 302); input.paintAt(STROKE)
  hitOn(C.mesh, LATEST_X); input.paintAt(STROKE)
  assert.equal(strokes(sent).length, 1, 'nothing is sent to the old selector while it switches')
  assert.deepEqual(switches, [C.plate], 'one switch, however many samples arrive during it')
  await land(PLATE_1)
  const afterSwitch = strokes(sent).at(-1)
  assert.equal(strokes(sent).length, 2, 'the latest held sample is painted once the switch lands')
  assert.equal(afterSwitch.facet, HIT_FACET, 'on plate 1 C is the first object')
  assert.equal(afterSwitch.hx, LATEST_X, 'it is the latest sample, not the first one')
  assert.equal(afterSwitch.px, undefined, 'the capsule does not span the two plates')
  assert.ok(switches.includes('refresh'), 'the section plane is re-sent in the new plate\'s frame')
  hitOn(A.mesh, 2); input.paintAt(STROKE)
  assert.deepEqual(switches.filter(entry => entry !== 'refresh'), [C.plate, A.plate], 'back on plate 0 switches back')
  await land(PLATE_0)
  assert.equal(strokes(sent).at(-1).facet, HIT_FACET, 'and A is painted again')
}

// ---- a fill click on another plate: the click itself is the held sample ----
{
  const { input, sent, switches, hitOn, land } = setup()
  hitOn(C.mesh, 300); input.paintAt(STROKE)
  input.endStroke()
  assert.deepEqual(switches, [C.plate])
  await land(PLATE_1)
  assert.equal(strokes(sent).length, 1, 'the click lands after the switch even though the button is already up')
}

// ---- an object on the held plate that the merge predates: re-registered, then painted ----
{
  const { input, sent, switches, hitOn, land } = setup()
  input.beginStroke(STROKE)
  hitOn(LATE.mesh, 5); input.paintAt(STROKE)
  assert.deepEqual(switches, [LATE.plate], 'the held plate is registered again to take the object in')
  const WITH_LATE = { plate: 0, topology: 'with-late', members: [...PLATE_0.members, { id: LATE.id, faceCount: FACES_LATE }] }
  await land(WITH_LATE)
  assert.equal(strokes(sent).at(-1).facet, FACES_A + FACES_B + HIT_FACET, 'and the stroke lands on it')
}

// ---- one the registration still leaves out is not asked for again until the merge changes ----
{
  const { input, sent, switches, hitOn, land } = setup()
  input.beginStroke(STROKE)
  hitOn(LATE.mesh, 5); input.paintAt(STROKE)
  await land({ ...PLATE_0, topology: 'without-late' })
  hitOn(LATE.mesh, 6); input.paintAt(STROKE)
  assert.deepEqual(switches.filter(entry => entry !== 'refresh'), [LATE.plate], 'no swap on every sample')
  assert.equal(strokes(sent).length, 0)
}

console.log('paint_plate_switch: ok')
