// The GPU acceleration switch: the settings-map mode and the engine it resolves to.
import assert from 'node:assert/strict'
import { GPU_ACCELERATION_MODES, gpuAccelerationMode, resolveGpuAcceleration } from '../src/core/gpu_acceleration.js'

assert.equal(gpuAccelerationMode({}), 'auto', 'absent reads as auto')
assert.equal(gpuAccelerationMode(null), 'auto', 'no settings map reads as auto')
assert.equal(gpuAccelerationMode({ gpu_acceleration: 'sideways' }), 'auto', 'an unknown value reads as auto')
for (const mode of GPU_ACCELERATION_MODES) assert.equal(gpuAccelerationMode({ gpu_acceleration: mode }), mode)

assert.deepEqual(resolveGpuAcceleration({ mode: 'auto', webgpu: true }), { engine: 'gpu', reason: 'auto' })
assert.deepEqual(resolveGpuAcceleration({ mode: 'auto', webgpu: false }), { engine: 'cpu', reason: 'no WebGPU device' })
assert.deepEqual(resolveGpuAcceleration({ mode: 'on', webgpu: true }), { engine: 'gpu', reason: 'on' })
assert.deepEqual(resolveGpuAcceleration({ mode: 'on', webgpu: false }), { engine: 'cpu', reason: 'no WebGPU device' })
assert.deepEqual(resolveGpuAcceleration({ mode: 'off', webgpu: true }), { engine: 'cpu', reason: 'off' })

console.log('ALL GPU ACCELERATION CHECKS PASSED')
