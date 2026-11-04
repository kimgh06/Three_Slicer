// Progress renders once per frame, and the last state of a run is not left waiting for one.
//   Run: node viewer-package/tests/test_frame_coalesce.mjs
import assert from 'node:assert/strict'
import { frameCoalesce } from '../src/core/frame_coalesce.js'

let frames = [], applied = 0, cancelled = 0
const schedule = (run) => { frames.push(run); return frames.length }
const cancel = () => { cancelled++ }
const coalesced = frameCoalesce(() => { applied++ }, schedule, cancel)

for (let i = 0; i < 612; i++) coalesced.request()   // one plate's progress messages
assert.equal(frames.length, 1, 'one frame asked for, however many requests')
assert.equal(applied, 0, 'nothing renders before the frame')
frames.shift()()
assert.equal(applied, 1)
coalesced.request()
assert.equal(frames.length, 1, 'a request after the frame asks for the next one')
coalesced.flush()
assert.equal(applied, 2, 'flush applies at once')
assert.equal(cancelled, 1, 'and drops the frame it no longer needs')
coalesced.flush()
assert.equal(applied, 3, 'flush with nothing pending still applies the current state')
console.log('frame_coalesce: ok')
