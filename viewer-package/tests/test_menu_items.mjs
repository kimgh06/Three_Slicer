// The application menu against the real key handler: a shortcut the menu prints is one the handler answers.
import assert from 'node:assert/strict'
import { menuBar } from '../src/core/menu_items.js'
import { makeKeyHandler } from '../src/core/shortcut_keymap.js'
import { GIZMO_TOOLS, SUPPORT_PAINT_TOOL, objectTools, ribbonGroups } from '../src/core/toolbar_items.js'
import { isClick } from '../src/core/click.js'
import { undoRedoDirection } from '../src/hooks/use_viewport_history.js'

const run = () => {}
const allActions = {
  open: run, saveProject: run, exportStl: run, exportResult: run, undo: run, redo: run, cut: run, copy: run, paste: run,
  selectAll: run, prepareMode: run, previewMode: run, zoomAll: run, zoomBed: run, sliceCurrent: run, sliceAll: run,
  cancelSlice: run, shortcuts: run,
  gizmos: GIZMO_TOOLS.map(tool => ({ ...tool, run })), paintSupport: { ...SUPPORT_PAINT_TOOL, run },
  tools: [{ id: 'delete', label: 'Delete', run }, { sep: true }, { id: 'duplicate', label: 'Duplicate', run }, { id: 'cut', label: 'Cut plane' }],
}
const openState = {
  prepare: true, gizmoMode: 'translate', painting: false, hasObjects: true, hasSelection: true, canPaste: true, canSave: true, canExport: true, exportLabel: 'Export G-code…',
  canUndo: true, canRedo: true, canPrepare: true, canPreview: true, canSlice: true, slicing: false, shortcuts: true,
}
const itemsOf = (menus) => menus.flatMap(menu => menu.items).filter(item => !item.sep)
const item = (menus, id) => itemsOf(menus).find(entry => entry.id === id)

function eventFor(shortcut) {
  const parts = shortcut.split('+')
  const name = parts[parts.length - 1]
  const event = { ctrlKey: parts.includes('Ctrl'), metaKey: false, shiftKey: false, altKey: false, target: {}, preventDefault() {}, stopPropagation() {} }
  if (name === 'Del') return { ...event, key: 'Delete', code: 'Delete' }
  if (name === '?') return { ...event, key: '?', code: 'Slash' }
  return { ...event, key: name.toLowerCase(), code: 'Key' + name }
}
function keyHandlerCalls(shortcut) {
  const calls = []
  const deps = new Proxy({ slicing: false, isPreview: () => false, isPainting: () => false }, {
    get: (target, name) => target[name] ?? ((...args) => { calls.push(name) }),
  })
  makeKeyHandler(deps)(eventFor(shortcut))
  return calls
}

// What each shortcut item must reach. A new item with a shortcut and no line here fails below.
const EXPECTED = {
  'gizmo-move': ['setGizmo'], 'gizmo-rotate': ['setGizmo'], 'gizmo-scale': ['setGizmo'],
  'copy': ['copy'], 'cut': ['copy', 'remove'], 'paste': ['paste'], 'select-all': ['selectAll'], 'delete': ['remove'],
  'duplicate': ['duplicate'], 'zoom-all': ['zoomAll'], 'zoom-bed': ['zoomBed'], 'slice-current': ['slice'], 'shortcuts': ['toggleHelp'],
}
const UNDO_ITEMS = { undo: 'undo', redo: 'redo' }
const menus = menuBar(allActions, openState)
for (const entry of itemsOf(menus).filter(candidate => candidate.shortcut)) {
  if (UNDO_ITEMS[entry.id]) {
    assert.equal(undoRedoDirection(eventFor(entry.shortcut)), UNDO_ITEMS[entry.id], entry.id)
    continue
  }
  assert.ok(EXPECTED[entry.id], `${entry.id} prints a shortcut this test does not check`)
  assert.deepEqual(keyHandlerCalls(entry.shortcut), EXPECTED[entry.id], `${entry.id} (${entry.shortcut})`)
}

// Unavailable entries: left out, with no separator stranded at an edge or doubled.
const bare = menuBar({ tools: [], gizmos: [], zoomAll: run }, openState)
assert.deepEqual(bare.map(menu => menu.id), ['view'])
for (const menu of menuBar({ ...allActions, sliceCurrent: undefined, sliceAll: undefined }, openState)) {
  assert.ok(!menu.items[0].sep && !menu.items[menu.items.length - 1].sep, menu.id)
  menu.items.forEach((entry, index) => assert.ok(!(entry.sep && menu.items[index + 1]?.sep), menu.id))
}
assert.equal(item(menus, 'cut').label, 'Cut')

// A tool with no `run` is not implemented, so it is not offered.
assert.ok(!itemsOf(menus).some(entry => entry.label === 'Cut plane'))

// Selection and mode decide what can run.
const nothingSelected = menuBar(allActions, { ...openState, hasSelection: false })
for (const id of ['copy', 'cut', 'delete', 'duplicate']) assert.equal(item(nothingSelected, id).disabled, true, id)
const previewing = menuBar(allActions, { ...openState, prepare: false })
assert.equal(item(previewing, 'paste').disabled, true)
assert.equal(item(previewing, 'preview').checked, true)

// The Object menu mirrors the gizmo group: the active one is checked, the brush takes the check while it is open.
assert.equal(item(menus, 'gizmo-move').checked, true)
assert.equal(item(menus, 'gizmo-rotate').checked, false)
const painting = menuBar(allActions, { ...openState, painting: true })
assert.equal(item(painting, 'gizmo-paint').checked, true)
assert.equal(item(painting, 'gizmo-move').checked, false)
assert.equal(item(previewing, 'gizmo-move').disabled, true)
assert.equal(item(menuBar({ ...allActions, paintSupport: undefined }, openState), 'gizmo-paint'), undefined)

// The ribbon opens a group at each `sep`, so the list starts with one and every group has its own caption.
const toolList = objectTools({})
assert.ok(toolList[0].sep)
const captions = toolList.filter(tool => tool.sep).map(tool => tool.group)
assert.ok(captions.every(Boolean))
assert.equal(new Set(captions).size, captions.length)

// A right press that moved is a camera pan, and a release with no press on the canvas is nobody's click.
assert.equal(isClick({ x: 10, y: 10 }, { x: 12, y: 11 }), true)
assert.equal(isClick({ x: 10, y: 10 }, { x: 60, y: 10 }), false)
assert.equal(isClick(null, { x: 10, y: 10 }), false)

// The ribbon offers only what runs, and a group left empty goes with its tools.
const wiredTools = objectTools({ add: run, remove: run, paintMaterial: run })
const ribbon = ribbonGroups(wiredTools)
assert.deepEqual(ribbon.map(group => group.caption), ['Objects', 'Surface'])
assert.deepEqual(ribbon[1].tools.map(tool => tool.id), ['mmu'])

// features.shortcuts off: no key is advertised.
assert.ok(itemsOf(menuBar(allActions, { ...openState, shortcuts: false })).every(entry => !entry.shortcut))

console.log('test_menu_items: ok')
