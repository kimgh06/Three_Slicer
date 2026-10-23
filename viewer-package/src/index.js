// three-slicer-viewer — the viewer without the slicer.
export { default } from './Viewport.jsx'
export * from './scene/toolpath_gpu.js'
export { emptyCatalog, resolveCatalog } from './core/catalog.js'
export { useNoopSlicer } from './actions/use_noop_slicer.js'
// The real slicing hook, unbound: pass `makeWorker` (a kernel worker factory) in its deps, e.g. three-slicer/client's makeSlicerWorker.
export { useSlicer } from './hooks/use_slicer.js'
// What a slicer implementation needs from this package to plug in (three-slicer's useSlicer uses all three).
export { log } from './core/log.js'
export { effectiveSettings, plateTechnology } from './core/plate_settings.js'
export { statsFromKernel } from './core/kernel_stats.js'
