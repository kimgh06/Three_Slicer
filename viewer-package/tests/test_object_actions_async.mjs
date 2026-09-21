// The object actions that wait for the paint write-back (flushPaint) before they act, driven through the REAL
//  makeObjectActions with a flush the test resolves by hand:
//   · a paste pressed while a copy is still waiting pastes THAT copy (it used to paste the previous clipboard, or
//     nothing after a first copy)
//   · a second delete pressed meanwhile (a double press, key repeat) adds no second undo entry
//   Run: node viewer-package/tests/test_object_actions_async.mjs
import assert from 'node:assert'
import { makeObjectActions } from '../src/actions/object_actions.js'

const setup = () => {
  const objects = [{ id: 1, name: 'A', paint: null }, { id: 2, name: 'B', paint: null }]
  let finishFlush = () => {}
  const flushes = []
  const history = [], spawned = [], removed = []
  const clipboardRef = { current: null }
  const objectsRef = { current: objects }
  const actions = makeObjectActions({
    apiRef: { current: {
      selectedObjectId: () => 1,
      getSnapshot: (id) => ({ name: objects.find(object => object.id === id)?.name, localPos: new Float32Array(9) }),
      spawnSnapshot: (snap) => { spawned.push(snap.name); return { id: 100 + spawned.length } },
      removeObject: (id) => removed.push(id),
    } },
    objectsRef, clipboardRef, paintModeRef: { current: 'off' },
    flushPaintRef: { current: () => { const flush = new Promise(resolve => { finishFlush = resolve }); flushes.push(flush); return flush } },
    selectorGeomRef: { current: null }, registerSelectorRef: { current: null },
    setPaintMode() {}, removeObject: (id) => removed.push(id), refreshObjects() {}, setError() {}, setSliceNotice() {}, clearError() {},
    recordHistory: () => history.push(history.length),
  })
  return { actions, history, spawned, removed, clipboardRef, finish: () => finishFlush(), flushes }
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

// ---- copy, then paste before the copy's flush lands ----
{
  const { actions, spawned, finish } = setup()
  actions.copySelected()
  const pasting = actions.pasteClipboard()
  await settle()
  assert.deepEqual(spawned, [], 'the paste waits for the copy it follows')
  finish(); await pasting
  assert.deepEqual(spawned, ['A'], 'and pastes that copy')
}

// ---- delete pressed twice while the first one waits ----
{
  const { actions, history, removed, finish, flushes } = setup()
  const first = actions.deleteSelected()
  const second = actions.deleteSelected()
  assert.equal(flushes.length, 1, 'the second press starts no second delete')
  finish(); await first; await second
  assert.equal(history.length, 1, 'one undo entry')
  assert.deepEqual(removed, [1])
  // Once it is done, the next delete runs again.
  const third = actions.deleteObject(2); finish(); await third
  assert.deepEqual(removed, [1, 2])
}

console.log('object_actions_async: ok')
