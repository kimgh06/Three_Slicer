// The object actions that wait for the paint write-back (flushPaint) before they act, driven through the REAL
//  makeObjectActions with a flush the test resolves by hand:
//   · a paste pressed while a copy is still waiting pastes THAT copy (it used to paste the previous clipboard, or
//     nothing after a first copy)
//   · a second delete pressed meanwhile (a double press, key repeat) adds no second undo entry
//   · a copy, a duplicate and the parts of a split keep the object's filament
//   Run: node viewer-package/tests/test_object_actions_async.mjs
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { makeObjectActions } from '../src/actions/object_actions.js'
import { makeFilamentColors } from '../src/actions/filament_colors.js'

const TWO_TRIANGLES = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 5, 0, 0, 6, 0, 0, 5, 1, 0])   // two connected components

const setup = () => {
  const objects = [{ id: 1, name: 'A', extruder: 2, paint: null }, { id: 2, name: 'B', extruder: 1, paint: null }]
  let finishFlush = () => {}
  const flushes = []
  const history = [], spawned = [], spawnedExtruders = [], removed = []
  const clipboardRef = { current: null }
  const objectsRef = { current: objects }
  const actions = makeObjectActions({
    apiRef: { current: {
      selectedObjectId: () => 1,
      getSnapshot: (id) => {
        const object = objects.find(candidate => candidate.id === id)
        return { name: object?.name, extruder: object?.extruder, localPos: TWO_TRIANGLES }
      },
      spawnSnapshot: (snap) => { spawned.push(snap.name); spawnedExtruders.push(snap.extruder); return { id: 100 + spawned.length } },
      removeObject: (id) => removed.push(id),
    } },
    objectsRef, clipboardRef, paintModeRef: { current: 'off' },
    flushPaintRef: { current: () => { const flush = new Promise(resolve => { finishFlush = resolve }); flushes.push(flush); return flush } },
    selectorGeomRef: { current: null }, registerSelectorRef: { current: null },
    setPaintMode() {}, removeObject: (id) => removed.push(id), refreshObjects() {}, setError() {}, setSliceNotice() {}, clearError() {},
    recordHistory: () => history.push(history.length),
  })
  return { actions, history, spawned, spawnedExtruders, removed, clipboardRef, objectsRef, finish: () => finishFlush(), flushes }
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

// ---- every spawn from an object keeps its filament ----
{
  const { actions, spawnedExtruders, finish } = setup()
  const copying = actions.copySelected(); finish(); await copying
  await actions.pasteClipboard()
  const duplicating = actions.duplicateSelected(); await settle(); finish(); await duplicating
  const splitting = actions.splitSelected(); await settle(); finish(); await splitting
  assert.deepEqual(spawnedExtruders, [2, 2, 2, 2], 'paste, duplicate and both split parts stay on T2')
}

// ---- the scene half: the snapshot carries the filament and the spawn applies it ----
{
  const scene = readFileSync(new URL('../src/scene/use_three_scene.js', import.meta.url), 'utf8')
  assert.match(scene, /getSnapshot:[\s\S]*?return \{[^}]*extruder: o\.extruder/, 'getSnapshot carries the extruder')
  assert.match(scene, /spawnSnapshot:[\s\S]*?spawnMesh\([^\n]*extruder: snap\.extruder/, 'spawnSnapshot applies it')
}

// ---- deleting a filament moves the clipboard's slot as it moves the scene's ----
{
  const { actions, clipboardRef, objectsRef, finish } = setup()
  const copying = actions.copySelected(); finish(); await copying
  const palette = (colorsRef) => makeFilamentColors({
    extruderColorsRef: colorsRef, setExtruderColors: next => { colorsRef.current = next },
    apiRef: { current: { recolorObjects() {}, setObjectExtruder() {} } }, objectsRef, clipboardRef, refreshObjects() {},
  })
  clipboardRef.current.extruder = 3
  palette({ current: ['#111111', '#222222', '#333333'] }).removeFilament(1)
  assert.equal(clipboardRef.current.extruder, 2, 'a later slot shifts down')
  palette({ current: ['#111111', '#222222'] }).removeFilament(1)
  assert.equal(clipboardRef.current.extruder, 1, 'a deleted slot falls back to T1')
}

console.log('object_actions_async: ok')
