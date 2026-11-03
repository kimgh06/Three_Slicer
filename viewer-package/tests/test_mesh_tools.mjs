// The object tools' pure halves: measuring, arranging, orienting. Fixtures are built here, with known answers.
import assert from 'node:assert/strict'
import { measureBetween, worldToModel } from '../src/core/measure.js'
import { edgeGrid, snapPoint } from '../src/core/edge_snap.js'
import { arrangeOnBed } from '../src/core/arrange.js'
import { bestOrientation } from '../src/core/orient.js'
import { scriptOf, fallbackFor, textRuns } from '../src/core/text_runs.js'
import { glyphShapes } from '../src/core/glyph_shapes.js'
import { seatShift } from '../src/core/model_soup.js'
import { gizmoLayout, handleOffset } from '../src/core/gizmo_layout.js'
import { createBodyDrag } from '../src/scene/body_drag.js'
import { createFineTransform } from '../src/scene/fine_transform.js'
import { resizedScales, arrowEdit, wrapAngle, twistDegrees, arrowHint, arrowHelp } from '../src/core/fine_adjust.js'
import { createRingDrag } from '../src/scene/ring_drag.js'
import { Mesh, BoxGeometry, Ray, Vector3, Quaternion, PerspectiveCamera, MathUtils } from 'three'
import { ShapeUtils } from 'three'

const close = (a, b, tolerance = 1e-6) => assert.ok(Math.abs(a - b) <= tolerance, `${a} vs ${b}`)

// ---- measure ----
{
  const result = measureBetween({ point: [0, 0, 0], normal: [0, 0, 1] }, { point: [3, 4, 0], normal: [1, 0, 0] })
  close(result.distance, 5); close(result.angle, 90); assert.deepEqual(result.delta, [3, 4, 0])
  close(measureBetween({ point: [0, 0, 0], normal: [0, 0, 1] }, { point: [0, 0, 0], normal: [0, 0, 1] }).angle, 0)
  assert.deepEqual(worldToModel([1, 2, 3]), [1, -3, 2])
}

// ---- text runs ----
{
  assert.deepEqual(['A', '한', 'ㄹ', 'あ', 'カ', '漢'].map(scriptOf), ['latin', 'hangul', 'hangul', 'kana', 'kana', 'han'])
  const entries = [{ id: 'latin', covers: ['latin'] }, { id: 'ko', covers: ['hangul'] }, { id: 'ja', covers: ['kana'] }, { id: 'zh' }]
  assert.equal(fallbackFor('한', entries).id, 'ko')
  assert.equal(fallbackFor('あ', entries).id, 'ja')
  assert.equal(fallbackFor('漢', entries), null)   // a Han form is never guessed
  const fontOf = (character) => ({ A: 'latin', B: 'latin', 한: 'ko' })[character]
  assert.deepEqual(textRuns('A B한 ', fontOf, 'latin'), [{ font: 'latin', text: 'A B' }, { font: 'ko', text: '한 ' }])
  assert.deepEqual(textRuns(' 한', fontOf, 'latin'), [{ font: 'latin', text: ' ' }, { font: 'ko', text: '한' }])
}

// ---- glyph outlines: neither contour order nor winding direction decides what is a hole ----
{
  const square = (from, to, clockwise) => {
    const corners = [[from, from], [to, from], [to, to], [from, to]]
    if (clockwise) corners.reverse()
    return `m ${corners[0]} l ${corners[1]} l ${corners[2]} l ${corners[3]} `.replaceAll(',', ' ')
  }
  const filledArea = (glyph) => glyphShapes(glyph, 1, 0).reduce((total, shape) => total + Math.abs(ShapeUtils.area(shape.getPoints()))
    - shape.holes.reduce((holes, hole) => holes + Math.abs(ShapeUtils.area(hole.getPoints())), 0), 0)
  for (const clockwise of [true, false]) {
    close(filledArea({ o: square(0, 10, clockwise) + square(2, 8, !clockwise) }), 64)   // solid first
    close(filledArea({ o: square(2, 8, !clockwise) + square(0, 10, clockwise) }), 64)   // hole first, as a CFF font may
    close(filledArea({ o: square(0, 10, clockwise) + square(2, 8, !clockwise) + square(4, 6, clockwise) }), 68)   // an island in the hole
  }
  close(filledArea({ o: square(0, 2, true) + square(5, 7, true) }), 8)   // two solids side by side
  assert.deepEqual(glyphShapes({ o: '' }, 1, 0), [])   // a space has no outline
}

// ---- what stands on the bed ----
{
  assert.equal(seatShift(5), 5); assert.equal(seatShift(-5), -5)
  assert.equal(seatShift(5, { keepHeight: true }), 0)      // text on a model stays up
  assert.equal(seatShift(-7, { keepHeight: true }), -7)    // but never under the bed
  assert.equal(seatShift(-7, { keepHeight: true, negative: true }), 0)
}

// ---- the gizmo stands outside the selection, sized by it ----
{
  const box = { low: [60, 0, 10], high: [60, 4, 10] }
  const near = gizmoLayout({ ...box, pixelsPerMm: 10, mode: 'translate' })
  const doubled = gizmoLayout({ low: box.low.map(v => v * 2), high: box.high.map(v => v * 2), pixelsPerMm: 10, mode: 'translate' })
  close(doubled.scale / near.scale, 2)   // proportional to the selection
  const far = gizmoLayout({ low: [1, 1, 1], high: [1, 1, 1], pixelsPerMm: 1, mode: 'translate' })
  const farther = gizmoLayout({ low: [1, 1, 1], high: [1, 1, 1], pixelsPerMm: 0.5, mode: 'translate' })
  close(farther.margin / far.margin, 2)  // twice the camera distance, twice the gap: it holds on screen
  assert.ok(gizmoLayout({ ...box, pixelsPerMm: 0.01, mode: 'translate' }).scale > near.scale)   // but still big enough to hit from far away
  const place = ([centre, axis]) => centre[axis] * near.scale + handleOffset(centre, near)[axis]
  close(place([[0.55, 0, 0], 0]), 60 + near.margin)     // +X arm past the +X face
  close(place([[-0.55, 0, 0], 0]), -(60 + near.margin))
  close(place([[0, 0, 0.55], 2]), 10 + near.margin)     // the Z arms sit by the Z faces, not at the X reach
  assert.deepEqual(handleOffset([0.15, 0, 0.15], near)[1], 0)
  const off = { low: [10, 0, 10], high: [30, 20, 10] }  // a rotated model: the origin is not the box's middle
  const skewed = gizmoLayout({ ...off, pixelsPerMm: 10, mode: 'translate' })
  close(0.55 * skewed.scale + handleOffset([0.55, 0, 0], skewed)[0], 30 + skewed.margin)
  close(-0.55 * skewed.scale + handleOffset([-0.55, 0, 0], skewed)[0], -(10 + skewed.margin))
  const rings = gizmoLayout({ ...box, pixelsPerMm: 10, mode: 'rotate' })
  assert.ok(rings.scale * 0.5 > Math.hypot(60, 4, 10))   // the rings clear every corner
}

// ---- dragging the selection moves it; a click does not start a drag ----
{
  const fixture = () => {
    const calls = []
    const object = new Mesh(new BoxGeometry(10, 10, 10))
    const transform = { object, mode: 'translate', enabled: true, axis: null, updateMatrixWorld() {}, pointerDown(pointer) { calls.push({ ...pointer, axis: this.axis }) } }
    const orbit = { enabled: true }
    return { calls, transform, orbit, drag: createBodyDrag({ transform, orbit }) }
  }
  const through = new Ray(new Vector3(0, 0, 50), new Vector3(0, 0, -1))
  const beside = new Ray(new Vector3(50, 0, 50), new Vector3(0, 0, -1))
  const press = { button: 0, clientX: 100, clientY: 100 }
  const pointer = { x: 0.1, y: 0.2 }

  const click = fixture()
  click.drag.press(press, pointer, through)
  assert.equal(click.orbit.enabled, false)
  click.drag.move({ clientX: 102, clientY: 101 })
  click.drag.release()
  assert.equal(click.calls.length, 0)        // within the click distance
  assert.equal(click.orbit.enabled, true)    // the camera comes back

  const drag = fixture()
  drag.drag.press(press, pointer, through)
  drag.drag.move({ clientX: 130, clientY: 100 }); drag.drag.move({ clientX: 140, clientY: 100 })
  assert.deepEqual(drag.calls, [{ x: 0.1, y: 0.2, button: 0, axis: 'XZ' }])   // once, from where the press was

  for (const [event, ray, mode] of [[press, beside, 'translate'], [press, through, 'rotate'], [{ ...press, button: 2 }, through, 'translate'], [{ ...press, ctrlKey: true }, through, 'translate']]) {
    const refused = fixture()
    refused.transform.mode = mode
    refused.drag.press(event, pointer, ray)
    refused.drag.move({ clientX: 140, clientY: 100 })
    assert.equal(refused.calls.length, 0); assert.equal(refused.orbit.enabled, true)
  }
}

// ---- fine adjust: typed values, committed as a drag ----
{
  assert.deepEqual(resizedScales([1, 2, 1], [10, 20, 30], 1, 40, false), [1, 4, 1])
  assert.deepEqual(resizedScales([1, 2, 1], [10, 20, 30], 1, 40, true), [2, 4, 2])
  assert.deepEqual(arrowEdit('translate', 1, 0, false, true), { kind: 'move', deltas: [0.1, -0] })
  assert.deepEqual(arrowEdit('translate', 0, -1, true, true), { kind: 'move', deltas: [0, 1] })   // up is +Y, Shift goes ten times as far
  assert.deepEqual(arrowEdit('rotate', 1, 0, false, true), { kind: 'rotate', axis: 2, degrees: -1 })
  assert.deepEqual(arrowEdit('rotate', 0, 1, true, true), { kind: 'rotate', axis: 0, degrees: 10 })
  close(arrowEdit('scale', 0, -1, false, true).ratio, 1.01)
  assert.equal(arrowEdit('scale', 1, 0, false, true), null)
  assert.deepEqual(arrowEdit('translate', 1, 0, false, false), { kind: 'move', deltas: [10, -0] })   // everyday steps
  assert.deepEqual(arrowEdit('translate', 1, 0, true, false), { kind: 'move', deltas: [1, -0] })
  assert.deepEqual(arrowEdit('rotate', 1, 0, false, false), { kind: 'rotate', axis: 2, degrees: -15 })
  close(arrowEdit('scale', 0, -1, false, false).ratio, 1.05)
  assert.equal(arrowHint('translate'), 'Arrow keys move 0.1 mm, Shift 1 mm')   // read from the steps themselves
  assert.match(arrowHelp(), /move 10mm, rotate 15°, scale 5%/)
  const events = []
  const mesh = new Mesh(new BoxGeometry(10, 20, 30))   // scene x 10, height 20, scene z 30
  mesh.position.set(100, 0, 40)
  const transform = { object: mesh, dispatchEvent: event => events.push(event.value), snaps: {}, pointerDown() {}, pointerMove() {},
    setTranslationSnap(value) { this.snaps.move = value }, setRotationSnap(value) { this.snaps.rotate = value }, setScaleSnap(value) { this.snaps.scale = value } }
  const fine = createFineTransform({ transform })
  const origin = { x: 90, z: 50 }
  mesh.updateMatrixWorld(true)
  const first = fine.read(origin)
  assert.deepEqual(first.position, [10, 10])      // model Y runs along scene -Z
  assert.deepEqual(first.sizes, [10, 30, 20])     // model order
  fine.move(0, 25, origin)
  close(mesh.position.x, 115)
  fine.move(1, 0, origin)
  close(mesh.position.z, 50)
  assert.deepEqual(events, [true, false, true, false])   // each edit is one drag, so one undo step
  fine.resize(0, 20, true)
  close(mesh.scale.x, 2); close(mesh.scale.y, 2); close(mesh.scale.z, 2)
  fine.reset('scale')
  fine.resize(2, 40, false)
  close(mesh.scale.y, 2); close(mesh.scale.x, 1)    // model Z is scene height
  fine.rotate(2, 90)
  close(mesh.rotation.y, Math.PI / 2)
  fine.rotate(0, 90)
  fine.rotate(2, 10)
  mesh.updateMatrixWorld(true)
  close(fine.read(origin).degrees[0], 90); close(fine.read(origin).degrees[2], 100)   // read back as turned
  mesh.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), MathUtils.degToRad(100))     // from elsewhere: undo, Orient
  assert.deepEqual(fine.read(origin).degrees.map(Math.round), [0, 0, 100])
  fine.reset('rotate')
  close(mesh.rotation.y, 0)
  const heldScale = mesh.scale.toArray(), heldPosition = mesh.position.toArray()
  const before = events.length
  fine.resize(0, 0, true); fine.resize(0, -5, true); fine.resize(0, NaN, true); fine.move(0, NaN, origin); fine.rotate(0, NaN); fine.setHeight(NaN)
  assert.equal(events.length, before)                 // refused before the commit, so no undo step either
  assert.deepEqual(mesh.scale.toArray(), heldScale); assert.deepEqual(mesh.position.toArray(), heldPosition)
  fine.setSnap(true); close(transform.snaps.move, 0.1)
  fine.setSnap(false); assert.equal(transform.snaps.move, null)
  transform.object = { userData: { isPrimeTower: true } }
  assert.equal(fine.read(origin), null)            // the tower's place is a setting, with its own card
}

// ---- a ring turns by the angle the pointer sweeps around it, wherever the sweep begins ----
{
  close(wrapAngle(3 * Math.PI / 2), -Math.PI / 2); close(wrapAngle(-3 * Math.PI / 2), Math.PI / 2)
  close(twistDegrees(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), MathUtils.degToRad(100)), [0, 1, 0]), 100)
  const camera = new PerspectiveCamera(50, 1, 1, 2000)
  camera.position.set(0, 200, 0); camera.lookAt(0, 0, 0); camera.updateMatrixWorld(true)
  const ringPoint = (degrees) => {
    const radians = MathUtils.degToRad(degrees)
    const projected = new Vector3(60 * Math.cos(radians), 0, 60 * Math.sin(radians)).project(camera)
    return { x: projected.x, y: projected.y, button: -1 }
  }
  const sweep = (from, by, rotationSnap = null) => {
    const object = new Mesh()
    const turns = []
    const transform = { camera, object, mode: 'rotate', axis: 'Y', dragging: true, rotationSnap, worldPosition: new Vector3(),
      dispatchEvent() {}, pointerDown() {}, pointerMove() {} }
    createRingDrag(transform, { turned: (target, axis, degrees, rotate) => { rotate(); turns.push({ axis, degrees }) } })
    transform.pointerDown({ ...ringPoint(from), button: 0 })
    for (let step = 1; step <= 6; step++) transform.pointerMove(ringPoint(from + by * step / 6))
    return { swept: Math.abs(twistDegrees(object.quaternion, [0, 1, 0])), turns }
  }
  for (const from of [0, 45, 90, 135, 180, 225, 270, 315, 350]) close(sweep(from, 30).swept, 30, 1e-3)   // the wrap at +-180 included
  assert.equal(sweep(0, 30).turns[0].axis, 2)     // scene Y is model Z
  close(sweep(0, 120, MathUtils.degToRad(1)).swept, 30)   // Alt: a quarter of the sweep, on whole degrees
}

// ---- measure snaps to corners first, then edges, and only within reach ----
{
  const square = [0, 0, 0, 10, 0, 0, 10, 0, 0, 10, 10, 0, 10, 10, 0, 0, 10, 0, 0, 10, 0, 0, 0, 0]
  const grid = edgeGrid(Float32Array.from(square), 4)
  assert.deepEqual(snapPoint(grid, [9.2, 0.6, 0], 1), { point: [10, 0, 0], kind: 'corner' })
  assert.deepEqual(snapPoint(grid, [5, 0.6, 0], 1), { point: [5, 0, 0], kind: 'edge' })
  assert.deepEqual(snapPoint(grid, [5, 5, 0], 1), { point: [5, 5, 0], kind: null })
  assert.deepEqual(snapPoint(grid, [5, 10.5, 2], 1), { point: [5, 10.5, 2], kind: null })   // out of reach in 3D
}

// ---- arrange ----
const square = (size, x = 0, y = 0) => [[x, y], [x + size, y], [x + size, y + size], [x, y + size]]
const boxOf = (item, place) => {
  const xs = item.hull.map(point => point[0] + place.x), ys = item.hull.map(point => point[1] + place.y)
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) }
}
{
  const items = [1, 2, 3, 4, 5, 6].map(id => ({ id, hull: square(40, -20, -20) }))
  const { placed, unplaced } = arrangeOnBed(items, { width: 200, depth: 200, spacing: 3 })
  assert.equal(placed.length, 6); assert.equal(unplaced.length, 0)
  const boxes = placed.map(place => boxOf(items.find(item => item.id === place.id), place))
  for (const box of boxes) assert.ok(box.minX >= -100 && box.maxX <= 100 && box.minY >= -100 && box.maxY <= 100, 'stays on the bed')
  boxes.forEach((a, index) => boxes.slice(index + 1).forEach(b => {
    const gap = Math.max(b.minX - a.maxX, a.minX - b.maxX, b.minY - a.maxY, a.minY - b.maxY)
    assert.ok(gap >= 3, `spacing kept, gap ${gap}`)
  }))
  // A single object lands in the middle of the bed whatever its own reference point is.
  const [only] = arrangeOnBed([{ id: 1, hull: square(40, 10, 10) }], { width: 200, depth: 200 }).placed
  close(only.x + 30, 0, 2); close(only.y + 30, 0, 2)
  // What cannot fit is reported, not forced on.
  const tooBig = arrangeOnBed([{ id: 1, hull: square(300) }, { id: 2, hull: square(20) }], { width: 200, depth: 200 })
  assert.deepEqual(tooBig.unplaced, [1]); assert.equal(tooBig.placed.length, 1)
  // A full bed leaves the rest out rather than stacking them.
  const crowded = arrangeOnBed(Array.from({ length: 40 }, (_, id) => ({ id, hull: square(60, -30, -30) })), { width: 200, depth: 200 })
  assert.ok(crowded.placed.length >= 4 && crowded.unplaced.length > 0)
}

// ---- orient ----
function quad(soup, a, b, c, d) { soup.push(...a, ...b, ...c, ...a, ...c, ...d) }
// An axis-aligned box whose outward faces are wound correctly.
function box(soup, [x0, y0, z0], [x1, y1, z1]) {
  quad(soup, [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0])   // bottom, facing -z
  quad(soup, [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1])   // top
  quad(soup, [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1])   // -y
  quad(soup, [x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1])   // +y
  quad(soup, [x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1])   // -x
  quad(soup, [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1])   // +x
}
{
  // Already flat: nothing to do.
  const flat = []; box(flat, [0, 0, 0], [20, 20, 5])
  assert.equal(bestOrientation(new Float32Array(flat)), null)
  // A table standing on its top, legs in the air, wants to turn over... the other way up it stands on four legs with
  //  the top overhanging, so the top face stays down.
  const table = []
  box(table, [0, 0, 20], [40, 40, 24])
  for (const [x, y] of [[0, 0], [36, 0], [0, 36], [36, 36]]) box(table, [x, y, 0], [x + 4, y + 4, 20])
  const direction = bestOrientation(new Float32Array(table))
  assert.deepEqual(direction.map(value => Math.round(value)), [0, 0, 1], 'the slab goes on the bed')
  // A tall thin plate lies down.
  const plate = []; box(plate, [0, 0, 0], [40, 2, 40])
  const lying = bestOrientation(new Float32Array(plate))
  assert.equal(Math.abs(Math.round(lying[1])), 1, 'its broad face goes on the bed')
}

console.log('test_mesh_tools: ok')
