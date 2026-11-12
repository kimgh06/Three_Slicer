// The one place the viewer touches navigator.gpu — core/ cannot (layer guard), and should not:
//  under node the device comes from Dawn's `webgpu` package and is INJECTED into the core modules.
//  Returns null wherever WebGPU is absent; every caller must treat null as "use the CPU path".
let devicePromise = null

export function acquireGpuDevice() {
  if (devicePromise) return devicePromise
  devicePromise = (async () => {
    try {
      if (typeof navigator === 'undefined' || !navigator.gpu) return null
      // the discrete GPU where the default may be the integrated one (measured, Chrome 157 Linux: 'low-power' gave an
      //  AMD iGPU, 'high-performance' an RTX 3090)
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
      // a software adapter (Chrome on Linux without #enable-vulkan: SwiftShader) is the CPU path, slower
      if (!adapter || adapter.info?.isFallbackAdapter) return null
      return await adapter.requestDevice()
    } catch { return null }
  })()
  return devicePromise
}
