// One slice with the organic tree support's branches made on the GPU: the kernel's calls (wasm-core/support_phase.h)
//  around support_gpu.js'. Used by the slicer worker, and by the node test with Dawn's device.
//   CAPTURE  the kernel slices up to its support tips and stops ({supportCaptured: true})
//   GPU      support_gpu.js makes every layer's support body from the tips and the outlines
//   INJECT   the kernel finishes the slice on that body: interfaces, toolpaths and G-code are its own
// The slice never depends on the GPU. A slice that does not stop at tips (no support, another style, a raft,
//  multi-material) is returned as it came. When the GPU fails after the capture, RESUME finishes the slice with
//  upstream's own support, which is the plain slice's G-code byte for byte.
const PHASE_OFF = 0, PHASE_CAPTURE = 1, PHASE_RESUME = 3
const NO_PIPELINE_REASON = 'no WebGPU device'

/** Whether this kernel build can take its tree support's branches from outside. */
export const kernelHasSupportPhase = (kernel) => typeof kernel?.support_phase_mode === 'function'
/**
 * Whether a slice with these kernel params stops at support tips: organic tree support, which is the style the kernel
 *  takes when `tree_style` is absent (params.h), without a raft. A wrong yes costs nothing: the slice comes back whole.
 */
export function slicesOrganicSupport(paramsText) {
  const params = JSON.parse(paramsText)
  return !!params.enable_support && params.support_style === 'tree' && (params.tree_style ?? 'organic') === 'organic' && !(Number(params.raft_layers) > 0)
}

// the request's views point into the kernel's heap: copied before anything else runs
const copyRequest = (request) => ({
  ...request,
  outlines: { layerRingStart: Uint32Array.from(request.outlines.layerRingStart), ringStart: Uint32Array.from(request.outlines.ringStart), points: Float32Array.from(request.outlines.points) },
  layerZ: Float64Array.from(request.layerZ), tips: Float32Array.from(request.tips),
})

/**
 * @param {object} job
 * @param {object} job.kernel       the loaded kernel module
 * @param {object|Promise<object|null>} job.supportGpu   makeSupportGpu()'s result, or a promise of it: it is awaited
 *   after the capture, so a caller can have the device and the pipelines made while the kernel runs
 * @param {() => string|null} [job.unavailableReason]  why that promise gave nothing
 * @param {Uint8Array} job.stl
 * @param {string} job.paramsText
 * @param {(done: number, total: number) => void} job.onProgress
 * @param {() => boolean} [job.canceled]
 * @returns {Promise<object>} the kernel's result; `stats.support_engine` is 'gpu' with the pipeline's figures under
 *   `stats.support_gpu`, or 'cpu' with `support_engine_reason` when the slice stopped at its tips and the GPU did not
 *   make the branches. A slice that never stopped carries neither.
 */
export async function sliceWithSupportGpu({ kernel, supportGpu, unavailableReason = () => null, stl, paramsText, onProgress, canceled = () => false }) {
  const captureStarted = performance.now()
  kernel.support_phase_mode(PHASE_CAPTURE)
  let captured
  try { captured = kernel.slice(stl, paramsText, onProgress) }
  catch (error) { kernel.support_phase_mode(PHASE_OFF); throw error }
  if (!captured?.supportCaptured) { kernel.support_phase_mode(PHASE_OFF); return captured }
  const captureMs = performance.now() - captureStarted

  const finish = (stats) => {
    let result
    try { result = kernel.slice(stl, paramsText, onProgress) }
    finally { kernel.support_phase_mode(PHASE_OFF) }
    if (result?.stats) Object.assign(result.stats, stats)
    return result
  }
  let made
  try {
    const pipeline = await supportGpu
    if (pipeline) made = await pipeline.run(copyRequest(kernel.support_phase_request()), { canceled })
    else made = { ok: false, reason: unavailableReason() ?? NO_PIPELINE_REASON }
  } catch (error) { made = { ok: false, reason: String(error?.message ?? error) } }
  if (canceled()) { kernel.support_phase_mode(PHASE_OFF); return { error: 'canceled' } }
  if (!made.ok) {
    kernel.support_phase_mode(PHASE_RESUME)
    return finish({ support_engine: 'cpu', support_engine_reason: made.reason })
  }
  kernel.support_phase_inject(made.layerRingStart, made.ringStart, made.points)
  return finish({ support_engine: 'gpu', support_capture_ms: captureMs, support_gpu: made.stats })
}
