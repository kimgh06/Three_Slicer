// One slice with PASS1's front on the GPU: the kernel's calls (wasm-core/contour_phase.h) around contour_gpu.js'.
//  Used by the slicer worker, and by the node test with Dawn's device. Two routes:
//   mesh     the kernel parses, seats and plans the layers and hands the mesh over (MESH); the GPU cuts, chains and
//            unions every layer (contour_front_gpu.js -> contour_gpu.js) without the contours leaving it; the kernel
//            walks the union's pieces and finishes the slice (INJECT). Taken when the kernel and the GPU module both
//            have it.
//   capture  the kernel cuts and chains every layer itself (CAPTURE), the GPU unions them, the kernel finishes (INJECT).
//
// The slice never depends on the GPU: a kernel without the contour phase, a slice that does not reach PASS1 (a
//  multi-material or cached one), a device that refuses the input, a pipeline that stops itself — each ends in the
//  kernel's own slice, and the reason is reported. A layer the GPU left open (a chain that does not close, a union
//  whose pieces do not close) gets the kernel's own union inside the GPU slice (contour_phase::assemble) and is counted;
//  on the mesh route the kernel first cuts and chains that layer from the mesh it kept.
const PHASE_OFF = 0, PHASE_CAPTURE = 1, PHASE_MESH = 3

/** Whether this kernel build can take contours from outside. */
export const kernelHasContourPhase = (kernel) => typeof kernel?.contour_phase_mode === 'function'
/** Whether this kernel build can hand its mesh to the GPU's cut and chain (the mesh route). */
export const kernelHasMeshPhase = (kernel) => typeof kernel?.contour_mesh === 'function'

/**
 * @param {object} job
 * @param {object} job.kernel       the loaded kernel module
 * @param {object} job.contourGpu   makeContourGpu()'s result (`front` present: the mesh route)
 * @param {Uint8Array} job.stl
 * @param {string} job.paramsText
 * @param {(done: number, total: number) => void} job.onProgress
 * @param {() => boolean} [job.canceled]  read between the kernel calls (the last call clears the cancel flag)
 * @param {boolean} [job.meshRoute]  false keeps the capture route even where the mesh route is available
 * @returns {Promise<object>} the kernel's result; `stats.contour_engine` is 'gpu' or 'cpu', with
 *   `contour_engine_reason` when the GPU was asked for and not used, or 'reused' when the layers came from the stage
 *   cache; `stats.contour_front` says which route cut and chained the layers ('gpu' on the mesh route, 'cpu' on capture)
 */
export async function sliceWithContourGpu(job) {
  if (job.meshRoute !== false && job.contourGpu.front && kernelHasMeshPhase(job.kernel)) return sliceThroughMesh(job)
  return sliceThroughCapture(job)
}

// the kernel's own slice, with the reason the GPU was not used
const kernelSlice = ({ kernel, stl, paramsText, onProgress }, reason) => {
  kernel.contour_phase_mode(PHASE_OFF)
  const result = kernel.slice(stl, paramsText, onProgress)
  if (result?.stats) { result.stats.contour_engine = 'cpu'; result.stats.contour_engine_reason = reason }
  return result
}

// a first call that did not stop at PASS1: the slice took a route without its union, or failed or was canceled, and
//  what it returned is the answer
const notStopped = ({ kernel, paramsText }, result) => {
  kernel.contour_phase_mode(PHASE_OFF)
  if (result?.stats) {
    // reuse_stages 2 is the kernel's stage cache: the layers, contours included, are the previous slice's
    result.stats.contour_engine = 'cpu'
    result.stats.contour_engine_reason = 'this slice has its own contour path'
    if (Number(JSON.parse(paramsText).reuse_stages) >= 2) { result.stats.contour_engine = 'reused'; delete result.stats.contour_engine_reason }
  }
  return result
}

// the first kernel call, in `phase`; it stops at PASS1 when the slice reaches it
const firstCall = ({ kernel, stl, paramsText, onProgress }, phase) => {
  kernel.contour_phase_mode(phase)
  try { return kernel.slice(stl, paramsText, onProgress) }
  catch (error) { kernel.contour_phase_mode(PHASE_OFF); throw error }
}

// the last kernel call, on the contours assemble() left; the stats say how they were made
const finish = ({ kernel, stl, paramsText, onProgress }, stats) => {
  let result
  try { result = kernel.slice(stl, paramsText, onProgress) }
  finally { kernel.contour_phase_mode(PHASE_OFF) }
  if (result?.stats) Object.assign(result.stats, { contour_engine: 'gpu' }, stats)
  return result
}

async function sliceThroughMesh(job) {
  const { kernel, contourGpu, canceled = () => false } = job
  const meshStarted = performance.now()
  const meshed = firstCall(job, PHASE_MESH)
  if (!meshed?.captured) return notStopped(job, meshed)
  const meshMs = performance.now() - meshStarted

  const gpuStarted = performance.now()
  let front
  try {
    const mesh = kernel.contour_mesh()   // views into the kernel's heap: read before the kernel allocates again
    front = await contourGpu.front.cut(mesh.tris, mesh.planes)
  } catch (error) { front = { failure: String(error?.message ?? error) } }
  if (canceled()) { kernel.contour_phase_mode(PHASE_OFF); return { error: 'canceled' } }
  if (front.failure) return kernelSlice(job, front.failure)
  kernel.contour_origin_buffer(front.input.layerCount).set(front.origins)
  kernel.contour_open_layers().set(front.openLayers)
  let outcome
  try { outcome = await contourGpu.union(front.input, (pieceCount) => kernel.contour_result_buffer(pieceCount)) }
  catch (error) { outcome = { ok: false, reason: String(error?.message ?? error) } }
  if (canceled()) { kernel.contour_phase_mode(PHASE_OFF); return { error: 'canceled' } }
  if (!outcome.ok) return kernelSlice(job, outcome.reason)
  const assembled = kernel.contour_assemble()   // from here the kernel reads the contours on its next slice
  if (assembled.unavailable) return kernelSlice(job, 'a layer the GPU left open has no mesh to be rebuilt from')
  const gpuMs = performance.now() - gpuStarted

  let openLayers = 0
  for (const flag of front.openLayers) openLayers += flag
  return finish(job, {
    contour_front: 'gpu', contour_capture_ms: meshMs, contour_front_ms: front.ms, contour_gpu_ms: gpuMs,
    contour_fallback_layers: assembled.fallbackLayers, contour_open_layers: openLayers,
    contour_pieces: outcome.pieceCount, contour_crossings: outcome.eventCount,
  })
}

async function sliceThroughCapture(job) {
  const { kernel, contourGpu, canceled = () => false } = job
  const captureStarted = performance.now()
  const captured = firstCall(job, PHASE_CAPTURE)
  if (!captured?.captured) return notStopped(job, captured)
  const captureMs = performance.now() - captureStarted

  const gpuStarted = performance.now()
  let outcome
  try { outcome = await contourGpu.union(kernel.contour_gpu_input(), (pieceCount) => kernel.contour_result_buffer(pieceCount)) }
  catch (error) { outcome = { ok: false, reason: String(error?.message ?? error) } }
  if (canceled()) { kernel.contour_phase_mode(PHASE_OFF); return { error: 'canceled' } }
  if (!outcome.ok) return kernelSlice(job, outcome.reason)
  const assembled = kernel.contour_assemble()   // from here the kernel reads the contours on its next slice
  const gpuMs = performance.now() - gpuStarted

  return finish(job, {
    contour_front: 'cpu', contour_capture_ms: captureMs, contour_gpu_ms: gpuMs,
    contour_fallback_layers: assembled.fallbackLayers, contour_pieces: outcome.pieceCount, contour_crossings: outcome.eventCount,
  })
}
