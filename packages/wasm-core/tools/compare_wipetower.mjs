// S3 investigation: comparison of the two prime tower paths — default (square ring approximation) vs wipe_tower_real (the ported real WipeTower.generate()).
//  Collects evidence for switching the default. Prints success and G-code plausibility indicators side by side (a human makes the call).
import createSlicer from '../../engine/src/slicer_core.js'

// MM input: two boxes side by side — the kernel splits groups so the leading tris are ext1 and everything after split is ext2
function boxTris(originX, originY, originZ, sizeX, sizeY, sizeZ) {
  const corners = [[0,0,0],[sizeX,0,0],[sizeX,sizeY,0],[0,sizeY,0],[0,0,sizeZ],[sizeX,0,sizeZ],[sizeX,sizeY,sizeZ],[0,sizeY,sizeZ]].map(vertex => [vertex[0]+originX, vertex[1]+originY, vertex[2]+originZ])
  const quad = (first,second,third,fourth) => [[corners[first],corners[second],corners[third]],[corners[first],corners[third],corners[fourth]]]
  return [...quad(0,1,2,3), ...quad(4,5,6,7), ...quad(0,1,5,4), ...quad(1,2,6,5), ...quad(2,3,7,6), ...quad(3,0,4,7)]
}
function trisToSTL(tris) {
  const buffer = Buffer.alloc(84 + tris.length * 50)
  buffer.writeUInt32LE(tris.length, 80)
  let offset = 84
  for (const triangle of tris) {
    offset += 12
    for (const point of triangle) {
      buffer.writeFloatLE(point[0], offset)
      buffer.writeFloatLE(point[1], offset+4)
      buffer.writeFloatLE(point[2], offset+8)
      offset += 12
    }
    buffer.writeUInt16LE(0, offset)
    offset += 2
  }
  return buffer
}
const boxA = boxTris(-25, -10, 0, 20, 20, 10)
const boxB = boxTris(5, -10, 0, 20, 20, 10)
const stl = new Uint8Array(trisToSTL([...boxA, ...boxB]))
const SPLIT = boxA.length   // triangle index where ext2 starts

const base = {
  layer_height: 0.2, first_layer_height: 0.2, line_width: 0.42, wall_loops: 2,
  infill_density: 0.15, nozzle_diameter: 0.4, filament_diameter: 1.75,
  extruder_count: 2, mm_group_split: SPLIT, prime_tower_width: 30,
}
const slicer = await createSlicer()

const probe = (label, extra) => {
  let result, error = null
  const startTime = performance.now()
  try { result = slicer.slice(stl, JSON.stringify({ ...base, ...extra }), () => {}) } catch (caught) { error = String(caught && caught.message || caught) }
  const elapsedMs = performance.now() - startTime
  if (error || !result || result.error) {
    console.log(`${label.padEnd(22)} failed: ${error || result?.error}`)
    return null
  }
  const gcode = result.gcode
  const lines = gcode.split('\n')
  const toolChanges = lines.filter(line => /^T[01]\b/.test(line)).length
  const towerReal = lines.filter(line => line.includes('wipe_tower_real')).length
  const towerRing = lines.filter(line => line.includes('prime tower')).length
  const cpToolchange = lines.filter(line => line.includes('CP TOOLCHANGE') || line.includes('WIPE_TOWER')).length
  // type 11 = prime tower toolpath segments
  let towerSeg = 0
  for (const layer of result.layers || []) {
    const paths = layer.paths
    if (!paths) continue
    for (let i = 0; i < paths.length; i += 8) if (paths[i+3] === 11) towerSeg++
  }
  console.log(`${label.padEnd(22)} layers ${String(result.stats.layers).padStart(3)}  tool changes ${String(toolChanges).padStart(3)}  ` +
    `tower segs ${String(towerSeg).padStart(5)}  filament ${result.stats.filament_mm.toFixed(1).padStart(8)}mm  ` +
    `gcode ${String(gcode.length).padStart(7)}B  ${elapsedMs.toFixed(0)}ms`)
  console.log(`${''.padEnd(22)}   markers: real tower ${towerReal} · ring ${towerRing} · CP/WIPE ${cpToolchange}`)
  return { r: result, towerSeg, toolChanges, towerReal, cpToolchange }
}

console.log('=== Prime tower path comparison (MM, 2 extruders) ===')
const ring = probe('default (square ring)', { wipe_tower_real: false })
const real = probe('wipe_tower_real', { wipe_tower_real: true })

console.log('\n=== Evidence ===')
if (ring && real) {
  let realPathVerdict = 'no (fell back)'
  if (real.towerReal > 0) realPathVerdict = 'yes (real path ran)'
  console.log(`Real WipeTower markers emitted: ${realPathVerdict}`)
  console.log(`Ring fallback markers: default ${ring.towerRing ?? '-'} / real path ${real.towerRing ?? '-'}`)
  console.log(`Tower toolpath segments: ring ${ring.towerSeg} vs real ${real.towerSeg}`)
}
process.exit(0)
