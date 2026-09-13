// The undo/redo stack semantics — the part that is pure logic and therefore worth pinning:
//   node packages/viewer/test_history.mjs
import assert from 'node:assert'
import { createHistory } from './src/core/history.js'
import { undoRedoDirection } from './src/use_viewport_history.js'

// A stand-in scene: capture/restore of one value, which is all the stack machinery can see anyway.
function harness(opts = {}) {
  let scene = 'a'
  const history = createHistory({ capture: () => scene, restore: (s) => { scene = s }, ...opts })
  return { history, set: (v) => { history.record(opts.kind); scene = v }, get: () => scene }
}

// Undo walks back, redo walks forward, and both stop at the ends rather than throwing.
{
  const h = harness()
  h.set('b'); h.set('c')
  assert.strictEqual(h.get(), 'c')
  assert.strictEqual(h.history.travel('undo'), true); assert.strictEqual(h.get(), 'b')
  assert.strictEqual(h.history.travel('undo'), true); assert.strictEqual(h.get(), 'a')
  assert.strictEqual(h.history.travel('undo'), false); assert.strictEqual(h.get(), 'a')
  assert.strictEqual(h.history.travel('redo'), true); assert.strictEqual(h.get(), 'b')
  assert.strictEqual(h.history.travel('redo'), true); assert.strictEqual(h.get(), 'c')
  assert.strictEqual(h.history.travel('redo'), false)
}

// A new action after an undo abandons the redo branch — redoing into a state that no longer follows from the
// present is the classic way an undo stack starts producing states the user never had.
{
  const h = harness()
  h.set('b'); h.history.travel('undo')
  assert.strictEqual(h.history.can('redo'), true)
  h.set('c')
  assert.strictEqual(h.history.can('redo'), false)
  assert.deepStrictEqual(h.history.depth(), { undo: 1, redo: 0 })
}

// Capture happens at travel time, so an unrecorded mutation is folded into the next undo instead of being lost or
// restoring a state that never existed.
{
  let scene = 'a'
  const history = createHistory({ capture: () => scene, restore: (s) => { scene = s } })
  history.record(); scene = 'b'
  scene = 'b-plus-something-nobody-recorded'
  history.travel('undo'); assert.strictEqual(scene, 'a')
  history.travel('redo'); assert.strictEqual(scene, 'b-plus-something-nobody-recorded')
}

// Coalescing: a held arrow key must cost one undo, not one per repeat — and only for a same-kind run inside the window.
{
  let clock = 0
  let scene = 'a'
  const history = createHistory({ capture: () => scene, restore: (s) => { scene = s }, now: () => clock, coalesceMs: 500 })
  history.record('nudge'); scene = 'b'
  clock = 100; history.record('nudge'); scene = 'c'
  clock = 200; history.record('nudge'); scene = 'd'
  assert.deepStrictEqual(history.depth(), { undo: 1, redo: 0 })
  history.travel('undo'); assert.strictEqual(scene, 'a')       // back past the whole run at once
  assert.strictEqual(history.depth().undo, 0)                  // and that travel consumed the run's single entry

  clock = 1000; history.record('nudge'); scene = 'e'           // past the window: its own entry
  clock = 1050; history.record('rotate'); scene = 'f'          // different kind: its own entry too
  assert.strictEqual(history.depth().undo, 2)
  // An unnamed action never coalesces, even back to back.
  clock = 1060; history.record(); clock = 1061; history.record()
  assert.strictEqual(history.depth().undo, 4)
}

// The limit drops the OLDEST entry, so the most recent actions stay undoable.
{
  let scene = 0
  const history = createHistory({ capture: () => scene, restore: (s) => { scene = s }, limit: 3 })
  for (let i = 1; i <= 6; i++) { history.record(); scene = i }
  assert.strictEqual(history.depth().undo, 3)
  history.travel('undo'); assert.strictEqual(scene, 5)
  history.travel('undo'); history.travel('undo')
  assert.strictEqual(scene, 3)                                  // 0..2 fell off the bottom
  assert.strictEqual(history.travel('undo'), false)
}

// ---- the Ctrl+Z/Y binding, which is layout-independent for the same reason the other shortcuts are ----
//  A Korean layout reports 'ㅋ' for the Z key, so e.code is what decides and e.key is only the Latin fallback.
const key = (over = {}) => ({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, code: '', key: '', target: null, ...over })
assert.strictEqual(undoRedoDirection(key({ ctrlKey: true, code: 'KeyZ' })), 'undo')
assert.strictEqual(undoRedoDirection(key({ metaKey: true, code: 'KeyZ' })), 'undo', 'Cmd on macOS')
assert.strictEqual(undoRedoDirection(key({ ctrlKey: true, code: 'KeyZ', key: '\u314b' })), 'undo', 'IME on: e.code still matches')
assert.strictEqual(undoRedoDirection(key({ ctrlKey: true, shiftKey: true, code: 'KeyZ' })), 'redo')
assert.strictEqual(undoRedoDirection(key({ ctrlKey: true, code: 'KeyY' })), 'redo')
assert.strictEqual(undoRedoDirection(key({ ctrlKey: true, code: '', key: 'z' })), 'undo', 'remapped Latin layout falls back to e.key')
// Not ours:
assert.strictEqual(undoRedoDirection(key({ code: 'KeyZ' })), null, 'no modifier')
assert.strictEqual(undoRedoDirection(key({ ctrlKey: true, altKey: true, code: 'KeyZ' })), null, 'Alt is someone elses')
assert.strictEqual(undoRedoDirection(key({ ctrlKey: true, code: 'KeyC' })), null)
// A text field owns its own undo.
for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT'])
  assert.strictEqual(undoRedoDirection(key({ ctrlKey: true, code: 'KeyZ', target: { tagName } })), null, tagName)
assert.strictEqual(undoRedoDirection(key({ ctrlKey: true, code: 'KeyZ', target: { isContentEditable: true } })), null)
// The shadow root hides the real target behind the host element, so composedPath()[0] is what has to be read.
assert.strictEqual(undoRedoDirection({ ...key({ ctrlKey: true, code: 'KeyZ' }), nativeEvent: { composedPath: () => [{ tagName: 'INPUT' }] } }), null)

console.log('history: ok')
