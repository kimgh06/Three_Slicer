// GPU acceleration of the kernel's polygon booleans: which engine a slice uses, decided from the host's settings map and
//  what the platform offers. `gpu_acceleration` is a viewer knob in the settings map, like `slice_workers` and
//  `sla_antialias`: absent means 'auto'. The decision is pure so the viewer and the slicer worker read the same rule.
//
// 'auto' uses the GPU wherever WebGPU gives a device; 'on' asks for it and reports why when it cannot; 'off' keeps every
//  boolean on the CPU. Whatever the mode, a GPU call that fails falls back to the CPU for that call, so 'auto' and 'on'
//  never lose a slice — they can only lose the speed.

export const GPU_ACCELERATION_MODES = ['auto', 'on', 'off']
export const GPU_ACCELERATION_DEFAULT = 'auto'

/** The mode the settings map asks for; anything unknown reads as the default. */
export function gpuAccelerationMode(settings) {
  const value = settings?.gpu_acceleration
  if (GPU_ACCELERATION_MODES.includes(value)) return value
  return GPU_ACCELERATION_DEFAULT
}

/**
 * The engine a slice will use.
 * @param {{ mode: 'auto'|'on'|'off', webgpu: boolean }} input  webgpu: a device could be acquired
 * @returns {{ engine: 'gpu'|'cpu', reason: string }}
 */
export function resolveGpuAcceleration({ mode, webgpu }) {
  if (mode === 'off') return { engine: 'cpu', reason: 'off' }
  if (!webgpu) return { engine: 'cpu', reason: 'no WebGPU device' }
  return { engine: 'gpu', reason: mode }
}
