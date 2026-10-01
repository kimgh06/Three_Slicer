// A streamed slice is the batch slice cut into chunks: joining the chunks the layer sink receives must give the
//  batch G-code byte for byte, on the mt kernel as on st. The browser slices streamed on mt whenever it is
//  cross-origin isolated, while every other test slices batch, so a divergence here shipped silently: the mt
//  parallel emission sent each layer's writer text alone and held the preamble back until the footer flush, so an
//  exported file started at "; LAYER 0" and set M83 and the temperatures after the last layer (a reader then took
//  every relative E as absolute; a printer would print cold). A raft hid it: raft layers flush through the serial
//  path, which takes the preamble along.
import assert from 'node:assert/strict'
import createSlicer from '../../engine/src/slicer_core.js'
import createSlicerMt from '../../engine/src/slicer_core.mt.js'

function boxSTL(size, height) {
  const h = size / 2
  const vertices = [[-h,-h,0],[h,-h,0],[h,h,0],[-h,h,0],[-h,-h,height],[h,-h,height],[h,h,height],[-h,h,height]]
  const faces = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]]
  const buffer = Buffer.alloc(84 + faces.length * 50)
  buffer.writeUInt32LE(faces.length, 80)
  faces.forEach((face, index) => {
    let offset = 84 + index * 50 + 12
    for (const vertexIndex of face) for (const value of vertices[vertexIndex]) {
      buffer.writeFloatLE(value, offset)
      offset += 4
    }
  })
  return new Uint8Array(buffer)
}

function streamed(kernel, stl, params) {
  const chunks = []
  kernel.set_layer_sink((z, index, gcode) => { chunks.push(gcode) })
  try { kernel.slice(stl, params, () => {}) }
  finally { kernel.clear_layer_sink() }
  return chunks
}

const st = await createSlicer()
const mt = await createSlicerMt()
const stl = boxSTL(20, 6)
let checks = 0
for (const raft_layers of [0, 2]) {
  const params = JSON.stringify({ layer_height: 0.2, first_layer_height: 0.2, wall_loops: 2, infill_density: 0.15, raft_layers })
  const batch = st.slice(stl, params, () => {}).gcode
  for (const [name, kernel] of [['st', st], ['mt', mt]]) {
    const chunks = streamed(kernel, stl, params)
    assert.ok(chunks[0].startsWith('; OrcaSlicer'), `${name} raft=${raft_layers}: the first chunk carries the preamble, got ${JSON.stringify(chunks[0].slice(0, 30))}`)
    assert.equal(chunks.join(''), batch, `${name} raft=${raft_layers}: joined chunks == the batch G-code`)
    console.log(`  ok: ${name} raft=${raft_layers}: ${chunks.length} chunks join to the batch G-code (${batch.length} bytes)`)
    checks++
  }
}
console.log(`ALL STREAM CHECKS PASSED (${checks})`)
process.exit(0)
