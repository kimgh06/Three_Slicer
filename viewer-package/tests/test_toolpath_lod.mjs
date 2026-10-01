// The toolpath's level of detail: which layers a coarse level keeps, when it is chosen, and that the mesh switches
//  to it only for a whole, uncut print.
//   Run: node viewer-package/tests/test_toolpath_lod.mjs
import assert from 'node:assert'
import * as THREE from 'three'
import { LOD_LEVELS, LOD_MAX_LAYER_PX, baseLayerTop, decimateLayers, typicalLayerHeight, projectedPixels, chooseLevel }
  from '../src/core/toolpath_lod.js'
import { ROLE } from '../src/core/toolpath_encoding.js'
import { buildSegmentData } from '../src/core/toolpath_segments.js'
import { makeToolpath } from '../src/scene/toolpath_mesh.js'

let failures = 0
const check = (label, condition, detail = '') => {
  if (condition) console.log(`  ok: ${label}`)
  else {
    let suffix = ''
    if (detail) suffix = ' — ' + detail
    console.log(`  FAIL: ${label}${suffix}`); failures++
  }
}

console.log('[lod: every layer is drawn exactly once, by itself or by the group above it]')
let uncovered = 0
for (const layerCount of [1, 2, 7, 10, 33]) {
  for (const baseTop of [0, 1, 3]) {
    for (const k of LOD_LEVELS) {
      const layerOf = (s) => s   // one segment per layer
      const { source, layers } = decimateLayers(layerOf, layerCount, k, baseTop)
      const covered = new Array(layerCount).fill(0)
      for (let j = 0; j < source.length; j++)
        for (let below = 0; below < layers[j]; below++) covered[layerOf(source[j]) - below]++
      const exact = covered.every(count => count === 1)
      if (!exact) { uncovered++; console.log(`  layers=${layerCount} base=${baseTop} k=${k}: ${JSON.stringify(covered)}`) }
    }
  }
}
check('coverage exact for every layer count, base and level', uncovered === 0, `${uncovered} cases`)

console.log('\n[lod: the top layer and the base layers are always kept, at their own thickness]')
{
  const { source, layers } = decimateLayers(s => s, 10, 4, 1)
  check('top layer kept', source.includes(9))
  check('base layers 0..1 kept, one layer thick each', source[0] === 0 && source[1] === 1 && layers[0] === 1 && layers[1] === 1)
  check('the lowest group stops at the base', layers[[...source].indexOf(5)] === 4 && !source.includes(2), `${[...source]} / ${[...layers]}`)
}

console.log('\n[lod: base layers are those holding raft or skirt]')
{
  const vType = Uint8Array.from([ROLE.RAFT, ROLE.RAFT, ROLE.RAFT, ROLE.RAFT, ROLE.WALL, ROLE.WALL, ROLE.SKIRT, ROLE.SKIRT])
  const vLayer = Int32Array.from([0, 0, 2, 2, 3, 3, 1, 1])
  check('raft up to layer 2 -> base top 2', baseLayerTop(vType, vLayer) === 2)
  check('no raft or skirt -> base top 0', baseLayerTop(Uint8Array.from([ROLE.WALL, ROLE.WALL]), Int32Array.from([5, 5])) === 0)
}

console.log('\n[lod: level choice keeps k layers within LOD_MAX_LAYER_PX]')
for (const px of [0.1, 0.19, 0.3, 0.5, 0.65, 2, Infinity]) {
  const k = chooseLevel(px)
  const fits = k === 1 || k * px <= LOD_MAX_LAYER_PX
  const coarsest = LOD_LEVELS.every(level => level <= k || level * px > LOD_MAX_LAYER_PX)
  check(`${px} px/layer -> k=${k}`, fits && coarsest)
}
check('a camera inside the box is detailed', projectedPixels(0.2, 0, 50, 1000) === Infinity)
check('typical height is the median', typicalLayerHeight(s => [0.2, 0.1, 0.1, 0.3, 0.1][s], 5) === 0.1)

console.log('\n[lod: the mesh switches only for a whole print, and recolours every level]')
{
  const stride = (x0, y0, z, x1, y1, role) => [x0, y0, z, role, x1, y1, z, role]
  const layerCount = 40
  const layers = Array.from({ length: layerCount }, (_unused, layer) => {
    const z = 0.1 * (layer + 1)
    const role = { 0: ROLE.SKIRT }[layer] ?? ROLE.WALL
    return { z, paths: Float32Array.from([...stride(0, 0, z, 10, 0, role), ...stride(10, 0, z, 10, 10, role)]), widths: Float32Array.from([0.4, 0.4]) }
  })
  const data = buildSegmentData(layers, 0.4)
  const handle = makeToolpath(THREE, data)
  handle.mesh.updateMatrixWorld()
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1e6)
  const lookFrom = (distance) => { camera.position.set(distance, distance, distance); camera.updateMatrixWorld() }

  check('one child mesh per level, hidden', handle.mesh.children.length === LOD_LEVELS.length && handle.mesh.children.every(c => !c.visible))
  lookFrom(1e5); handle.updateLod(camera, 1000)
  const far = handle.lodLevel()
  check('far away -> the coarsest level', far === Math.max(...LOD_LEVELS), `k=${far}`)
  check('the full mesh draws no instances meanwhile', handle.mesh.geometry.instanceCount === 0)
  check('exactly one level visible', handle.mesh.children.filter(c => c.visible).length === 1)
  lookFrom(20); handle.updateLod(camera, 1000)
  check('close -> full detail', handle.lodLevel() === 1 && handle.mesh.geometry.instanceCount === data.nSeg && handle.mesh.children.every(c => !c.visible))
  lookFrom(1e5); handle.setLayerRange(0, 20); handle.updateLod(camera, 1000)
  check('a cut layer range draws full detail even far away', handle.lodLevel() === 1)
  handle.setLayerRange(0, layerCount - 1); handle.updateLod(camera, 1000)
  check('the whole range again -> coarse', handle.lodLevel() === far)

  const color = new Float32Array(data.nV * 4)
  for (let s = 0; s < data.nSeg; s++) color[s * 8] = 1000 + s
  handle.setColors(color)
  const recoloured = handle.mesh.children.every(child => {
    const colors = child.geometry.attributes.iColor.array, layerOfLevel = child.geometry.attributes.iLayer.array
    for (let j = 0; j < colors.length; j++) if (colors[j] < 1000 || data.meta.vLayer[(colors[j] - 1000) * 2] !== layerOfLevel[j]) return false
    return true
  })
  check('setColors reaches every level, each instance from its own source segment', recoloured)
  const level4 = handle.mesh.children[LOD_LEVELS.indexOf(4)].geometry.attributes
  const thickest = Math.max(...level4.iHW.array.filter((_v, i) => i % 2 === 0))
  check('a kept bead is k layers thick', Math.abs(thickest - 0.4) < 1e-6, `${thickest}`)
  handle.dispose()
}

if (failures) console.log(`\n${failures} CHECK(S) FAILED`)
else console.log('\nALL TOOLPATH LOD CHECKS PASSED')
assert.equal(failures, 0)
