// The section plane's kernel copy, driven through the REAL createSectionPlane: the kernel clips in the held plate's
//  local frame (paint_clip.js), so the plane may only be sent with the frame it was converted in.
//   · a brush-kind switch nulls the paint transform while its swap runs; a refresh in that window converted the plane
//     as if the plate origin were 0,0, and on any plate but the first the kernel kept that shifted plane
//   Run: node viewer-package/tests/test_section_plane_sync.mjs
import assert from 'node:assert'
import * as THREE from 'three'
import { createSectionPlane } from '../src/scene/section_plane.js'

const SECOND_PLATE_ORIGIN_X = 240
const sent = []
const paintXformRef = { current: { cx: SECOND_PLATE_ORIGIN_X, cy: 0, minz: 0 } }
const mesh = new THREE.Mesh(new THREE.BoxGeometry(20, 20, 20), new THREE.MeshBasicMaterial())
mesh.position.set(SECOND_PLATE_ORIGIN_X, 10, 0)
mesh.updateMatrixWorld(true)
const camera = new THREE.PerspectiveCamera()
camera.position.set(SECOND_PLATE_ORIGIN_X, 100, 100); camera.lookAt(SECOND_PLATE_ORIGIN_X, 0, 0); camera.updateMatrixWorld(true)
const section = createSectionPlane({
  renderer: { localClippingEnabled: false }, camera, objectsRef: { current: [{ mesh }] },
  workerRef: { current: { postMessage: (message) => sent.push(message) } }, paintXformRef, invalidate() {},
})
const clipMessages = () => sent.filter(message => message.cmd === 'paintMode' && message.clipPlane)
const CUT_MORE = 1
section.scrub(CUT_MORE)
const inFrame = clipMessages().at(-1).clipPlane
assert.ok(inFrame, 'a scrub sends the plane')

// A brush-kind switch: the transform is null until the swap lands, and the brush opening refreshes the plane.
paintXformRef.current = null
const before = clipMessages().length
section.refresh()
assert.equal(clipMessages().length, before, 'no plane is sent without the frame to convert it in')

// The swap lands (same plate, same frame) and the job refreshes again.
paintXformRef.current = { cx: SECOND_PLATE_ORIGIN_X, cy: 0, minz: 0 }
section.refresh()
assert.deepEqual(clipMessages().at(-1).clipPlane, inFrame, 'the plane the kernel ends up with is in the plate\'s frame')

console.log('section_plane_sync: ok')
