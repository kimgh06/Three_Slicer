// The paint store's selector swaps, driven through the REAL makeSupportPaint against a fake worker that keeps a
//  selector's marks the way the kernel does (prepare empties it, importPaint replaces, exportPaint reads, clear
//  empties). Every case here was a bug in the browser first:
//   · a copy whose plate-local merge matched the original's inherited its paint (bytes alone called it the same mesh)
//   · opening the support brush filed the held material paint as support paint
//   · a material stroke over loaded support paint turned every support mark into material paint
//   · a worker replaced by the watchdog wiped the stored paint of the plate it held
//   Run: node viewer-package/tests/test_paint_swap.mjs
import assert from 'node:assert'
import { Object3D } from 'three'
import { makeSupportPaint } from '../src/actions/support_paint.js'

const HEX_STATE_1 = '4', HEX_STATE_2 = '8', HEX_STATE_3 = '0C'

// A worker holding one selector: merged facet -> hex. Replies echo requestId like the real one.
class FakeSelectorWorker extends EventTarget {
  constructor() { super(); this.marks = new Map(); this.sent = []; this.failImport = false }
  terminate() {}
  answer(data, request) {
    const event = new Event('message')
    event.data = data
    if (request.requestId !== undefined) event.data = { ...data, requestId: request.requestId }
    queueMicrotask(() => this.dispatchEvent(event))
  }
  postMessage(message) {
    this.sent.push(message.cmd)
    if (message.cmd === 'prepare') { if (!message.keepPaint) this.marks = new Map(); this.answer({ type: 'prepared' }, message); return }
    if (message.cmd === 'importPaint' && this.failImport) { this.answer({ type: 'error', error: 'memory access out of bounds' }, message); return }
    if (message.cmd === 'importPaint') {
      this.marks = new Map()
      const hexes = String(message.hex).split('\n')
      Array.from(message.facets).forEach((facet, index) => this.marks.set(facet, hexes[index]))
      this.answer({ type: 'painted', counts: {} }, message); return
    }
    if (message.cmd === 'exportPaint') {
      const facets = [...this.marks.keys()].sort((a, b) => a - b)
      this.answer({ type: 'paintExport', supported: true, facets, hex: facets.map(facet => this.marks.get(facet)).join('\n') }, message); return
    }
    if (message.cmd === 'clear') { this.marks = new Map(); this.answer({ type: 'painted', counts: {} }, message) }
  }
  // A brush stroke, as the kernel would record it.
  brush(facet, hex) { this.marks.set(facet, hex) }
}

// Two plates: object 1 (4 facets) alone on plate 0, object 2 (4 facets) alone on plate 1. `sameBytes` makes the two
//  plate-local merges byte-identical — a copy placed where the original sits on its own plate.
const makeScene = ({ sameBytes = false } = {}) => {
  const objects = [{ id: 1, plate: 0, localPos: new Float32Array(36), mesh: new Object3D() },
                   { id: 2, plate: 1, localPos: new Float32Array(36), mesh: new Object3D() }]
  const SHARED_MARKER = 7
  const bufferOf = (plate) => {
    const bytes = new Uint8Array(84 + 4 * 50)
    bytes[0] = plate
    if (sameBytes) bytes[0] = SHARED_MARKER
    return bytes.buffer
  }
  const buildMergedSTL = (plate) => {
    const members = objects.filter(object => object.plate === plate).map(object => ({ id: object.id, faceCount: 4 }))
    if (!members.length) return null
    return { buf: bufferOf(plate), topology: members.map(member => `${member.id}:1:4`).join('|'), members, plate, offX: plate * 240, offZ: 0, paint: {} }
  }
  return { objects, buildMergedSTL }
}

const setup = (scene, { slicing = { current: false } } = {}) => {
  let worker = new FakeSelectorWorker()
  const refs = { selectedPlateRef: { current: 0 }, selectorGeomRef: { current: null }, paintXformRef: { current: null },
                 paintOverlayRef: { current: null }, paintModeRef: { current: 'off' }, materialExtruderRef: { current: 1 },
                 extruderColorsRef: { current: ['#111111', '#222222', '#333333'] }, paintStateCountsRef: { current: {} },
                 objectsRef: { current: scene.objects } }
  const paint = makeSupportPaint({
    ...refs,
    three: { current: { objectsGroup: { add() {}, remove() {} }, invalidate() {} } },
    apiRef: { current: { buildMergedSTL: scene.buildMergedSTL, detachTransform() {}, refreshCursor() {}, paintClipPlanes: () => null } },
    getWorker: () => worker,
    setError() {}, setPaintModeState() {}, setPaintCounts() {}, setPaintStateCounts() {}, setSliceNotice() {},
    isSelectorSlicing: () => slicing.current,
  })
  return { paint, refs, worker: () => worker, replaceWorker: () => { worker = new FakeSelectorWorker(); return worker } }
}
const paintOf = (scene, id) => scene.objects.find(object => object.id === id).paint ?? {}
const entries = (marks) => [...(marks ?? new Map())]
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

// ---- a copy whose merge has the same bytes is still another object: its plate does not inherit the paint ----
{
  const scene = makeScene({ sameBytes: true })
  const { paint, refs, worker } = setup(scene)
  paint.setPaintMode('material'); await paint.registerSelector(); await settle()
  worker().brush(0, HEX_STATE_2)                                       // plate 0: object 1 painted
  refs.selectedPlateRef.current = 1
  await paint.registerSelector(); await settle()                        // plate 1: object 2, same bytes
  assert.deepEqual(entries(paintOf(scene, 1).color), [[0, HEX_STATE_2]], 'the original keeps its paint in the store')
  assert.equal(worker().marks.size, 0, 'the copy\'s plate starts with its own (empty) paint, not the original\'s')
}

// ---- opening a brush of the other kind swaps the annotation; neither is converted into the other ----
{
  const scene = makeScene()
  const { paint, refs, worker } = setup(scene)
  paint.setPaintMode('enforcer'); await paint.registerSelector(); await settle()
  refs.paintModeRef.current = 'enforcer'
  worker().brush(1, HEX_STATE_1)                                       // a support enforcer
  paint.setPaintMode('material'); await settle(); await paint.flushPaint(); await settle()
  assert.deepEqual(entries(paintOf(scene, 1).supports), [[1, HEX_STATE_1]], 'the support mark went back as support paint')
  assert.equal(worker().marks.size, 0, 'the material brush starts on the material annotation, not on the support marks')
  refs.paintModeRef.current = 'material'
  worker().brush(3, HEX_STATE_3)                                       // a material stroke
  await paint.flushPaint(); await settle()
  assert.deepEqual(entries(paintOf(scene, 1).color), [[3, HEX_STATE_3]], 'the material stroke is material paint')
  assert.deepEqual(entries(paintOf(scene, 1).supports), [[1, HEX_STATE_1]], 'and the support paint is untouched')
  // A slice asks for 'auto': material first.
  await paint.registerSelector(null, { kind: 'auto' }); await settle()
  assert.deepEqual(entries(worker().marks), [[3, HEX_STATE_3]], 'the slice reads the material annotation')
  // Opening and closing the support brush without painting relabels nothing.
  paint.setPaintMode('enforcer'); await settle(); paint.setPaintMode('off'); await settle()
  await paint.flushPaint(); await settle()
  assert.deepEqual(entries(paintOf(scene, 1).color), [[3, HEX_STATE_3]], 'material paint stays material after a brush was only opened')
}

// ---- a worker replaced by the watchdog: nothing is written back from its empty successor; the store reloads ----
{
  const scene = makeScene()
  const { paint, worker, replaceWorker } = setup(scene)
  paint.setPaintMode('material'); await paint.registerSelector(); await settle()
  worker().brush(2, HEX_STATE_2)
  await paint.flushPaint(); await settle()
  const fresh = replaceWorker()
  await paint.flushPaint(); await settle()
  assert.deepEqual(entries(paintOf(scene, 1).color), [[2, HEX_STATE_2]], 'the empty new selector does not wipe the store')
  await paint.registerSelector(); await settle()
  assert.deepEqual(entries(fresh.marks), [[2, HEX_STATE_2]], 'the next registration loads the store into the new worker')
}

// ---- a flush during a slice answers at once: the worker is busy, and the store is already current ----
{
  const scene = makeScene()
  const slicing = { current: false }
  const { paint, worker } = setup(scene, { slicing })
  paint.setPaintMode('material'); await paint.registerSelector(); await settle()
  worker().brush(1, HEX_STATE_2)
  await paint.flushPaint(); await settle()                              // the flush a slice start does
  slicing.current = true
  const sentBefore = worker().sent.length
  assert.equal(await paint.flushPaint(), 'busy', 'a save or copy during the slice does not queue behind it')
  assert.equal(worker().sent.length, sentBefore, 'and asks the busy worker nothing')
  assert.deepEqual(entries(paintOf(scene, 1).color), [[1, HEX_STATE_2]], 'the store holds what the pre-slice flush wrote')
}

// ---- a load the worker fails: no bare slice, nothing written back over the store, no strokes on the empty selector ----
{
  const scene = makeScene()
  const { paint, refs, worker } = setup(scene)
  scene.objects[1].paint = { color: new Map([[2, HEX_STATE_2]]) }      // plate 1 carries stored paint
  paint.setPaintMode('material'); await paint.registerSelector(); await settle()   // plate 0 held
  worker().failImport = true
  refs.selectedPlateRef.current = 1
  const result = await paint.registerSelector(null, { kind: 'auto' }); await settle()
  assert.equal(result, 'load-failed', 'the swap reports the failed load to the slice that asked for it')
  assert.equal(refs.paintXformRef.current, null, 'no stroke may land on the empty selector')
  await paint.flushPaint(); await settle()
  assert.deepEqual(entries(paintOf(scene, 2).color), [[2, HEX_STATE_2]], 'nothing is written back over the store from the empty selector')
  // A drag commit re-registers with no kind. It must not turn strokes back on over the empty selector — it retries.
  await paint.registerSelector(); await settle()
  assert.equal(refs.paintXformRef.current, null, 'a re-registration while the load still fails keeps strokes off')
  worker().failImport = false
  await paint.registerSelector(); await settle()
  assert.deepEqual(entries(worker().marks), [[2, HEX_STATE_2]], 'the next re-registration loads the store')
  assert.notEqual(refs.paintXformRef.current, null, 'and only then turns strokes back on')
}

console.log('paint_swap: ok')
