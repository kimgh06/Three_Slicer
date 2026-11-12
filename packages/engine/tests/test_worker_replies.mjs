// The REAL slicer.worker.js, driven command by command: every paint command answers with its own reply type (never
//  the catch-all error) and echoes the request's `requestId`.
//   Run: node packages/engine/tests/test_worker_replies.mjs
// Why a real-worker test: the requestId echo routed every reply through a local `reply(...)` helper, and three
//  branches (importPaint, clear, overlay) declared a local `const reply = {...}` that shadowed it — each then called
//  `reply(reply)` and threw "reply is not a function". The brush drew no overlay, Clear failed, and a loaded plate's
//  paint counts never came back (measured in the browser: 0 kernel overlays, "Slice failed: reply is not a function").
//  The viewer's own tests drive a FAKE worker (viewer-package/tests/test_paint_sync.mjs), so they could not see it.
import assert from 'node:assert'
import { fileURLToPath } from 'node:url'

// The worker only touches `self.onmessage` and `self.postMessage`; everything it posts lands here.
const replies = []
globalThis.self = { postMessage: (message) => replies.push(message) }
await import(fileURLToPath(new URL('../src/slicer.worker.js', import.meta.url)))
const send = async (data) => {
  const before = replies.length
  await globalThis.self.onmessage({ data })
  return replies.slice(before)
}

// A 20mm cube (12 facets), the kernel's own test shape.
const cubeSTL = (() => {
  const corners = [[0,0,0],[20,0,0],[20,20,0],[0,20,0],[0,0,20],[20,0,20],[20,20,20],[0,20,20]]
  const faces = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]]
  const STL_COUNT_OFFSET = 80, STL_FACETS_OFFSET = 84, STL_FACET_BYTES = 50, STL_NORMAL_BYTES = 12, STL_FLOAT_BYTES = 4
  const bytes = new Uint8Array(STL_FACETS_OFFSET + faces.length * STL_FACET_BYTES), view = new DataView(bytes.buffer)
  view.setUint32(STL_COUNT_OFFSET, faces.length, true)
  faces.forEach((face, index) => {
    let writeAt = STL_FACETS_OFFSET + index * STL_FACET_BYTES + STL_NORMAL_BYTES
    for (const corner of face) for (const coordinate of corners[corner]) { view.setFloat32(writeAt, coordinate, true); writeAt += STL_FLOAT_BYTES }
  })
  return bytes.buffer
})()

const T2 = 2, STATES = [1, 2, 3]
let nextRequestId = 100
const expectReply = async (label, data, expectedType) => {
  const requestId = nextRequestId++
  const answers = await send({ ...data, requestId })
  const errors = answers.filter(answer => answer.type === 'error')
  assert.deepEqual(errors, [], `${label}: no error reply (got ${JSON.stringify(errors)})`)
  const answer = answers.find(candidate => candidate.type === expectedType)
  assert.ok(answer, `${label}: answers '${expectedType}' (got ${answers.map(candidate => candidate.type)})`)
  assert.equal(answer.requestId, requestId, `${label}: echoes its requestId`)
  console.log(`  ok ${label}`)
  return answer
}

await expectReply('warmup', { cmd: 'warmup', quiet: true }, 'warm')
const openShell = new Float32Array(18)
const refused = await expectReply('meshBoolean', { cmd: 'meshBoolean', first: openShell, second: openShell, operation: 0 }, 'meshBoolean')
assert.match(refused.error, /^MESH_BOOLEAN_/)
await expectReply('prepare', { cmd: 'prepare', stl: cubeSTL }, 'prepared')
const painted = await expectReply('paint', { cmd: 'paint', facet: 0, hx: 5, hy: 5, hz: 0, cx: 5, cy: 5, cz: -100, radius: 8, state: T2, states: STATES }, 'painted')
assert.ok(painted.counts[T2] > 0, 'the stroke marked facets')
const overlay = await expectReply('overlay', { cmd: 'overlay', states: [T2] }, 'overlay')
assert.ok(overlay.overlays?.[T2]?.length > 0, 'the overlay carries the painted triangles of the requested state')
const exported = await expectReply('exportPaint', { cmd: 'exportPaint' }, 'paintExport')
await expectReply('prepare again', { cmd: 'prepare', stl: cubeSTL }, 'prepared')
const imported = await expectReply('importPaint', { cmd: 'importPaint', facets: Int32Array.from(exported.facets), hex: exported.hex, states: STATES }, 'painted')
assert.equal(imported.counts[T2], painted.counts[T2], 'the import restores the stroke')
assert.equal(typeof imported.applied, 'number', 'the import reports how many facets it applied')
await expectReply('erase', { cmd: 'erase', facet: 0, hx: 5, hy: 5, hz: 0, cx: 5, cy: 5, cz: -100, radius: 8, states: STATES }, 'painted')
const cleared = await expectReply('clear', { cmd: 'clear', states: STATES }, 'painted')
assert.deepEqual(cleared.counts, Object.fromEntries(STATES.map(state => [state, 0])), 'the clear reports every requested state at zero')
await expectReply('paintMode', { cmd: 'paintMode', overhangDeg: 90 }, 'paintMode')

// A request without an id gets exactly the replies it always got — no requestId field.
const legacy = await send({ cmd: 'overlay', states: [T2] })
assert.ok(legacy.every(answer => !('requestId' in answer)) && legacy.some(answer => answer.type === 'overlay'), 'a request without an id is answered without one')
// And a failing command answers an error that names its request.
const failing = await send({ cmd: 'importPaint', facets: 'not an Int32Array', hex: 42, requestId: 999 })
assert.ok(failing.some(answer => answer.type === 'error' && answer.requestId === 999), 'an error reply echoes the requestId')
console.log('  ok legacy replies unchanged; errors name their request')

// The fill tools come from the viewer's one list (`three-slicer-viewer/paint`); a copy here drifted from it unseen.
const { readFileSync } = await import('node:fs')
const workerSource = readFileSync(fileURLToPath(new URL('../src/slicer.worker.js', import.meta.url)), 'utf8')
assert.ok(workerSource.includes("from 'three-slicer-viewer/paint'"), 'the worker reads FILL_TOOLS from three-slicer-viewer/paint')
assert.ok(!/const FILL_TOOLS\s*=/.test(workerSource), 'the worker defines no FILL_TOOLS of its own')
console.log('  ok fill tools read from three-slicer-viewer/paint')

// `gpu: true` without a WebGPU device (plain node): the slice is the kernel's own and says why
const gpuAsked = await send({ stl: cubeSTL, params: { layer_height: 0.2 }, gpu: true, requestId: 1001 })
const gpuDone = gpuAsked.find(answer => answer.type === 'done')
assert.ok(gpuDone, `gpu slice: answers 'done' (got ${gpuAsked.map(answer => answer.type)})`)
assert.equal(gpuDone.result.stats.contour_engine, 'cpu')
const { CONTOUR_DEVICE_REASON } = await import('../src/contour_gpu.js')
assert.equal(gpuDone.result.stats.contour_engine_reason, CONTOUR_DEVICE_REASON.noApi)
console.log('  ok a slice that asks for the GPU without a device is the CPU slice, with the reason')

// `exportedPreview`: the worker makes the slice what the viewer shows (three-slicer-viewer/gcode asExported) beside the
//  kernel instead of the page's main thread. Its result has to be what the viewer made from the plain stream, and its
//  layers post only their index (measured on a 28-plate project: the main thread was busy 33 s of a 25 s run).
{
  const { asExported } = await import('three-slicer-viewer/gcode')
  const sliceParams = { layer_height: 0.2, gcode_role_tags: true }
  const plainReplies = await send({ stl: cubeSTL, params: sliceParams, requestId: 1002 })
  const plainDone = plainReplies.find(answer => answer.type === 'done')
  const plainLayers = plainReplies.filter(answer => answer.type === 'layer')
  assert.ok(plainDone && plainLayers.length > 0, 'a plain slice streams its layers')
  const expected = asExported({ ...plainDone.result, layers: plainLayers.map(({ z, paths, widths }) => ({ z, paths, widths })), gcode: plainLayers.map(layer => layer.gcode).join('') }, JSON.stringify(sliceParams))
  const shownReplies = await send({ stl: cubeSTL, params: sliceParams, exportedPreview: true, requestId: 1003 })
  const shown = shownReplies.find(answer => answer.type === 'done')?.result
  assert.ok(shown, `exportedPreview slice: answers 'done' (got ${shownReplies.map(answer => answer.type)})`)
  assert.equal(shown.exportedPreview, true, 'the result says the worker made it')
  assert.equal(shown.gcode, expected.gcode, 'the finalized G-code is the one the viewer made')
  const layerValues = (layers) => layers.map(layer => [layer.z, Array.from(layer.paths), Array.from(layer.widths)])
  assert.deepStrictEqual(layerValues(shown.layers), layerValues(expected.layers), 'the read-back layers are the ones the viewer made')
  for (const key of ['layers', 'path_segments', 'filament_mm', 'time_estimate']) assert.deepStrictEqual(shown.stats[key], expected.stats[key], `stats.${key}`)
  const shownLayerReplies = shownReplies.filter(answer => answer.type === 'layer')
  assert.equal(shownLayerReplies.length, plainLayers.length, 'every layer still reports for the progress and the watchdog')
  assert.ok(shownLayerReplies.every(answer => answer.gcode === undefined && answer.paths === undefined), 'a layer posts its index only')
  console.log('  ok an exportedPreview slice is what the viewer made from the stream, and its layers carry no payload')

  // `deferPreview` (a slice-all): the result comes back with the finalized G-code and the kernel's own layers, marked
  //  `previewPending`; the `readback` command then gives the layers and figures the inline read-back gives.
  const deferredReplies = await send({ stl: cubeSTL, params: sliceParams, exportedPreview: true, deferPreview: true, requestId: 1004 })
  const deferred = deferredReplies.find(answer => answer.type === 'done')?.result
  assert.ok(deferred, `deferPreview slice: answers 'done' (got ${deferredReplies.map(answer => answer.type)})`)
  assert.equal(deferred.previewPending, true, 'the result says its read-back is still to come')
  assert.equal(deferred.gcode, expected.gcode, 'the deferred result already holds the finalized G-code')
  assert.deepStrictEqual(layerValues(deferred.layers), layerValues(plainLayers), 'its layers are the kernel stream until the read-back')
  const readbackReplies = await send({ cmd: 'readback', gcode: deferred.gcode, stats: deferred.stats, params: sliceParams, requestId: 1005 })
  const readback = readbackReplies.find(answer => answer.type === 'readback')
  assert.ok(readback, `readback: answers 'readback' (got ${readbackReplies.map(answer => answer.type)})`)
  assert.equal(readback.requestId, 1005, 'the readback reply echoes its request id')
  assert.deepStrictEqual(layerValues(readback.layers), layerValues(expected.layers), 'the deferred read-back layers are the inline ones')
  for (const key of ['layers', 'path_segments', 'filament_mm', 'time_estimate']) assert.deepStrictEqual(readback.stats[key], expected.stats[key], `readback stats.${key}`)
  console.log('  ok a deferPreview slice plus its readback is the exportedPreview slice')
}

console.log('\nworker_replies: ok')
process.exit(0)
