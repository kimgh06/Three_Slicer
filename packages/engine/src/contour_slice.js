// One slice with PASS1's per-layer union on the GPU: the kernel's two calls (wasm-core/contour_phase.h) around
//  contour_gpu.js's one. Used by the slicer worker, and by the node test with Dawn's device.
//
// The slice never depends on the GPU: a kernel without the contour phase, a slice that does not reach PASS1 (a
//  multi-material or cached one), a device that refuses the input, a pipeline that stops itself — each ends in the
//  kernel's own slice, and the reason is reported. A layer whose loops the GPU left open gets the kernel's own union
//  inside the GPU slice (contour_phase::assemble) and is counted.
const PHASE_OFF = 0, PHASE_CAPTURE = 1

/** Whether this kernel build can take contours from outside. */
export const kernelHasContourPhase = (kernel) => typeof kernel?.contour_phase_mode === 'function'

/**
 * @param {object} job
 * @param {object} job.kernel       the loaded kernel module
 * @param {object} job.contourGpu   makeContourGpu()'s result
 * @param {Uint8Array} job.stl
 * @param {string} job.paramsText
 * @param {(done: number, total: number) => void} job.onProgress
 * @param {() => boolean} [job.canceled]  read between the two kernel calls (the second call clears the cancel flag)
 * @returns {Promise<object>} the kernel's result; `stats.contour_engine` is 'gpu' or 'cpu', with
 *   `contour_engine_reason` when the GPU was asked for and not used, or 'reused' when the layers came from the stage cache
 */
export async function sliceWithContourGpu({ kernel, contourGpu, stl, paramsText, onProgress, canceled = () => false }) {
  const onCpu = (reason) => {
    kernel.contour_phase_mode(PHASE_OFF)
    const result = kernel.slice(stl, paramsText, onProgress)
    if (result?.stats) { result.stats.contour_engine = 'cpu'; result.stats.contour_engine_reason = reason }
    return result
  }
  const captureStarted = performance.now()
  kernel.contour_phase_mode(PHASE_CAPTURE)
  let captured
  try { captured = kernel.slice(stl, paramsText, onProgress) }
  catch (error) { kernel.contour_phase_mode(PHASE_OFF); throw error }
  if (!captured?.captured) {
    // the slice took a route without PASS1's union, or failed or was canceled: what it returned is the answer
    kernel.contour_phase_mode(PHASE_OFF)
    if (captured?.stats) {
      // reuse_stages 2 is the kernel's stage cache: the layers, contours included, are the previous slice's
      captured.stats.contour_engine = 'cpu'
      captured.stats.contour_engine_reason = 'this slice has its own contour path'
      if (Number(JSON.parse(paramsText).reuse_stages) >= 2) { captured.stats.contour_engine = 'reused'; delete captured.stats.contour_engine_reason }
    }
    return captured
  }
  const captureMs = performance.now() - captureStarted

  const gpuStarted = performance.now()
  let outcome
  try { outcome = await contourGpu.union(kernel.contour_gpu_input(), (pieceCount) => kernel.contour_result_buffer(pieceCount)) }
  catch (error) { outcome = { ok: false, reason: String(error?.message ?? error) } }
  if (canceled()) { kernel.contour_phase_mode(PHASE_OFF); return { error: 'canceled' } }
  if (!outcome.ok) return onCpu(outcome.reason)
  const assembled = kernel.contour_assemble()   // from here the kernel reads the contours on its next slice
  const gpuMs = performance.now() - gpuStarted

  let result
  try { result = kernel.slice(stl, paramsText, onProgress) }
  finally { kernel.contour_phase_mode(PHASE_OFF) }
  if (result?.stats) {
    result.stats.contour_engine = 'gpu'
    result.stats.contour_capture_ms = captureMs
    result.stats.contour_gpu_ms = gpuMs
    result.stats.contour_fallback_layers = assembled.fallbackLayers
    result.stats.contour_pieces = outcome.pieceCount
    result.stats.contour_crossings = outcome.eventCount
  }
  return result
}
