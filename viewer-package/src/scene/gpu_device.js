// The one place the viewer touches navigator.gpu — core/ cannot (layer guard), and should not:
//  under node the device comes from Dawn's `webgpu` package and is INJECTED into the core modules.
//  Returns null wherever WebGPU is absent; every caller must treat null as "use the CPU path".
let devicePromise = null

export function acquireGpuDevice() {
  if (devicePromise) return devicePromise
  devicePromise = (async () => {
    try {
      if (typeof navigator === 'undefined' || !navigator.gpu) return null
      const adapter = await navigator.gpu.requestAdapter()
      if (!adapter) return null
      return await adapter.requestDevice()
    } catch { return null }
  })()
  return devicePromise
}
