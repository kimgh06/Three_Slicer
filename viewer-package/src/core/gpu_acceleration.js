// GPU acceleration of the slice: which engine computes the per-layer contour union, decided from the host's settings map
//  and the kernel that loaded. `gpu_acceleration` is a viewer knob in the settings map, like `slice_workers` and
//  `sla_antialias`: absent means 'auto'. It is a worker option, never a kernel parameter.
//
// What the GPU does is PASS1's front: with a kernel that hands over its mesh, the cut, chain and union of every layer
//  (three-slicer's contour_front_gpu.js and contour_gpu.js, `front: 'gpu'` in the result); with an older kernel, the
//  union of the loops the kernel cut and chained (`front: 'cpu'`). Measured in node with a 3M-facet model and tree slim
//  support: the single-threaded kernel 9.8 -> 7.6 s for the union alone, the threaded kernel unchanged within run-to-run
//  spread (the same work is already spread over its threads). So 'auto' asks for the GPU only on the single-threaded
//  kernel. 'on' asks for it on either; 'off' never does.
// Whatever the mode, the worker decides whether it can: without a WebGPU device, or when the GPU refuses a slice, the
//  kernel slices by itself and the result says so (kernel_stats.js `contour`). A GPU slice's contours have the CPU
//  union's area and other vertices, so its G-code is not the CPU slice's byte for byte.

export const GPU_ACCELERATION_MODES = ['auto', 'on', 'off']
export const GPU_ACCELERATION_DEFAULT = 'auto'

/** The mode the settings map asks for; anything unknown reads as the default. */
export function gpuAccelerationMode(settings) {
  const value = settings?.gpu_acceleration
  if (GPU_ACCELERATION_MODES.includes(value)) return value
  return GPU_ACCELERATION_DEFAULT
}

/**
 * The engine a slice asks its worker for.
 * @param {{ mode: 'auto'|'on'|'off', kernelKind: 'st'|'mt'|null }} input  kernelKind: what the worker's 'warm' reply said
 * @returns {{ engine: 'gpu'|'cpu', reason: string }}
 */
export function resolveGpuAcceleration({ mode, kernelKind }) {
  if (mode === 'off') return { engine: 'cpu', reason: 'off' }
  if (mode === 'on') return { engine: 'gpu', reason: 'on' }
  if (kernelKind === 'st') return { engine: 'gpu', reason: 'auto: the single-threaded kernel' }
  return { engine: 'cpu', reason: 'auto: the threaded kernel gains nothing from it' }
}

/** One line for the stats card from a result's `contour` (kernel_stats.js), or null when the GPU was not asked for. */
export function contourEngineText(contour) {
  if (!contour) return null
  if (contour.engine === 'reused') return 'Contours reused from the previous slice'
  if (contour.engine !== 'gpu') return `Contours on the CPU (${contour.reason ?? 'GPU not used'})`
  let text = 'Contours on the GPU'
  if (contour.front === 'gpu') text = 'Contours cut and unioned on the GPU'
  if (contour.fallbackLayers > 0) return `${text}, ${contour.fallbackLayers} layers on the CPU`
  return text
}
