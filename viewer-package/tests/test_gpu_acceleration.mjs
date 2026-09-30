// The GPU acceleration switch: the settings-map mode, the engine a slice asks for, and the stats line.
import assert from 'node:assert/strict'
import { GPU_ACCELERATION_MODES, gpuAccelerationMode, resolveGpuAcceleration, contourEngineText } from '../src/core/gpu_acceleration.js'
import { statsFromKernel } from '../src/core/kernel_stats.js'

assert.equal(gpuAccelerationMode({}), 'auto', 'absent reads as auto')
assert.equal(gpuAccelerationMode(null), 'auto', 'no settings map reads as auto')
assert.equal(gpuAccelerationMode({ gpu_acceleration: 'sideways' }), 'auto', 'an unknown value reads as auto')
for (const mode of GPU_ACCELERATION_MODES) assert.equal(gpuAccelerationMode({ gpu_acceleration: mode }), mode)

const engineOf = (mode, kernelKind) => resolveGpuAcceleration({ mode, kernelKind }).engine
assert.equal(engineOf('auto', 'st'), 'gpu', 'auto uses the GPU on the single-threaded kernel')
assert.equal(engineOf('auto', 'mt'), 'cpu', 'auto leaves the threaded kernel alone')
assert.equal(engineOf('auto', null), 'cpu', 'auto before the kernel reported its kind')
assert.equal(engineOf('on', 'mt'), 'gpu', 'on asks for it on either kernel')
assert.equal(engineOf('on', 'st'), 'gpu')
assert.equal(engineOf('off', 'st'), 'cpu', 'off never asks')

// the worker's report on the result: absent when the GPU was not asked for
assert.equal(statsFromKernel({ layers: 1 }).contour, null)
assert.equal(contourEngineText(null), null)
const onGpu = statsFromKernel({ contour_engine: 'gpu', contour_fallback_layers: 0, contour_gpu_ms: 40 }).contour
assert.deepEqual(onGpu, { engine: 'gpu', reason: null, fallbackLayers: 0, gpuMs: 40 })
assert.equal(contourEngineText(onGpu), 'Contours on the GPU')
assert.equal(contourEngineText(statsFromKernel({ contour_engine: 'gpu', contour_fallback_layers: 7 }).contour), 'Contours on the GPU, 7 layers on the CPU')
assert.equal(contourEngineText(statsFromKernel({ contour_engine: 'cpu', contour_engine_reason: 'no WebGPU device' }).contour), 'Contours on the CPU (no WebGPU device)')
assert.equal(contourEngineText(statsFromKernel({ contour_engine: 'reused' }).contour), 'Contours reused from the previous slice')

console.log('ALL GPU ACCELERATION CHECKS PASSED')
