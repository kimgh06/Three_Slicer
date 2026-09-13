// Guards viewer/README.md against the code it describes: the shortcut table against the keymap, and the `features`
// opt-out keys against both their declaration and their use.
//
// Both are documentation nobody re-reads after writing it, sitting next to code that is edited whenever an action
// gains an entry point — so the two drift silently, and the reader finds out by pressing a key that does nothing
// or setting a flag that turns nothing off.
//   run: node packages/viewer/test_viewer_docs.mjs
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
let failures = 0
// src/ is laid out in layers (core/ scene/ actions/ ui/). Look a file up by NAME so that moving one between
//  layers does not silently turn this gate into a crash — the gate is about content, not about paths.
const srcFile = (name) => {
  for (const dir of ['', 'core', 'scene', 'actions', 'ui']) {
    const path = join(here, 'src', dir, name)
    if (existsSync(path)) return readFileSync(path, 'utf8')
  }
  throw new Error(`no such source file: ${name}`)
}

const check = (label, condition, detail = '') => {
  if (condition) console.log(`  ok: ${label}`)
  else { console.log(`  FAIL: ${label}${detail ? ' — ' + detail : ''}`); failures++ }
}

const keymap = srcFile('shortcut_keymap.js')
const readme = readFileSync(join(here, 'VIEWER.md'), 'utf8')
const table = readme.slice(readme.indexOf('## Keyboard and mouse'), readme.indexOf('## Undo and redo'))

// Letter bindings are written `key('m')`; named keys are compared against e.key as 'Delete', 'ArrowUp', …
const letters = [...new Set([...keymap.matchAll(/\bkey\('([a-z])'\)/g)].map(m => m[1].toUpperCase()))]
// `typeof k === 'string'` is a type guard sitting in the same shape as a key comparison — it is not a binding.
const named = [...new Set([...keymap.matchAll(/[^f] k === '([A-Za-z]+)'/g)].map(m => m[1]))]
// How a keyboard prints the key, versus how the DOM names it. The table uses the printed form.
const PRINTED_AS = { Escape: 'Esc', Backspace: 'Backspace', Delete: 'Delete', PageUp: 'PageUp', PageDown: 'PageDown' }

console.log('\n[viewer shortcuts: the table covers the keymap]')
check('the keymap defines letter shortcuts', letters.length >= 8, letters.join(''))
check('the README has a shortcut table', table.length > 200)

// A letter appears in the table as a `X` cell — as its own code span, so `L` does not match the word "layer".
const documentedLetter = (letter) => new RegExp('`[^`]*\\b' + letter + '\\b[^`]*`').test(table)
const missingLetters = letters.filter(letter => !documentedLetter(letter))
check('every letter shortcut is in the table', missingLetters.length === 0, missingLetters.join(' '))

const missingNamed = named.filter(name => !table.includes(PRINTED_AS[name] ?? name) &&
  // The arrow keys are written as the symbols a keyboard actually prints.
  !(name.startsWith('Arrow') && /[↑↓]|Arrow keys/.test(table)))
check('every named key is in the table', missingNamed.length === 0, missingNamed.join(' '))

console.log('\n[viewer shortcuts: modifiers and scope]')
check('Ctrl/⌘ combinations are marked as such', /Ctrl\/⌘/.test(table))
check('Shift variants are described', /Shift/.test(table))
// Ctrl+Z is bound to the component root rather than window, which is the fact an embedder needs: it does not
//  reach the host app's own undo. If that binding moves, this line has to be revisited.
const shell = srcFile('Viewport.jsx')
const historyHook = srcFile('use_viewport_history.js')
// Bound on the shell element itself, not on window — an element listener only fires when focus is inside.
check('undo/redo is still bound on the component root', /className="app-shell" onKeyDown={onShellKey}/.test(shell))
check('...and the key matching is layout-independent', /KeyZ/.test(historyHook) && /KeyY/.test(historyHook))
check('...and the table says it does not escape to the host', /never reaches your app/.test(table))

console.log('\n[viewer features: declared, honoured, documented]')
// Three places have to agree, and each can be edited without the other two: the union in types/viewer.d.ts, the
//  `feature('x')` call that actually gates something, and the README row telling a host the key exists.
const viewerTypes = readFileSync(join(here, 'types', 'viewer.d.ts'), 'utf8')   // this package's own declaration; three-slicer's is a re-export stub
const declared = (viewerTypes.match(/export type ViewportFeature =([^\n]*(?:\n\s*\|[^\n]*)*)/)?.[1] ?? '')
  .match(/'([a-zA-Z]+)'/g)?.map(s => s.replace(/'/g, '')) ?? []
check('ViewportFeature declares keys', declared.length >= 5, declared.join(' '))

// use_slicer.js is the AGPL package's now; the features it consumed (warmup, quiet) are read where Viewport
//  hands them to the slicer hook, so Viewport.jsx still covers them.
const sources = ['Viewport.jsx', 'use_three_scene.js', 'log.js']
  .map(name => srcFile(name)).join('\n')
const unwired = declared.filter(key => !sources.includes(`feature('${key}')`))
check('every declared feature gates something', unwired.length === 0, unwired.join(' '))

const undocumented = declared.filter(key => !readme.includes(`\`${key}\``))
check('every declared feature is in the README', undocumented.length === 0, undocumented.join(' '))

console.log('\n[viewer panels: every showPanel key is declared]')
// The same three-way agreement as the features, minus the README (the panel list is long and lives in the props
//  section rather than a table of its own). `bedWarn` and `towerCard` reached a release undeclared because nothing
//  compared these two lists.
const shellSource = srcFile('Viewport.jsx')
const used = [...new Set([...shellSource.matchAll(/showPanel\('([a-zA-Z]+)'\)/g)].map(m => m[1]))]
const panelUnion = viewerTypes.slice(viewerTypes.indexOf('export type ViewportPanel'),
                                     viewerTypes.indexOf('export type ViewportEvent'))
const undeclaredPanels = used.filter(key => !panelUnion.includes(`'${key}'`))
check('every showPanel() key is in ViewportPanel', undeclaredPanels.length === 0, undeclaredPanels.join(' '))
const unusedPanels = [...panelUnion.matchAll(/'([a-zA-Z]+)'/g)].map(m => m[1]).filter(key => !used.includes(key))
check('ViewportPanel declares no key the shell ignores', unusedPanels.length === 0, unusedPanels.join(' '))

console.log('\n[viewer panels: every lockable panel is actually wrapped]')
// `'readonly'` is only real where the shell wraps the panel in <Panel>. A key that is in the union but never
//  wrapped would type-check for a host and then do nothing at all, which is the worst of the three outcomes.
const lockable = (viewerTypes.match(/export type LockablePanel =([^\n]*(?:\n\s*\|[^\n]*)*)/)?.[1] ?? '')
  .match(/'([a-zA-Z]+)'/g)?.map(s => s.replace(/'/g, '')) ?? []
check('LockablePanel declares keys', lockable.length >= 5, lockable.join(' '))
// The wrapper takes `panels` explicitly because it lives at module scope — an inner component would be a new
//  type every render and React would remount the subtree (measured: the layer slider died mid-drag).
const unwrapped = lockable.filter(key => !shellSource.includes(`<Panel panels={panels} name="${key}">`))
check('every lockable panel is wrapped in <Panel>', unwrapped.length === 0, unwrapped.join(' '))
check('every lockable panel is a real panel', lockable.every(key => used.includes(key)),
  lockable.filter(key => !used.includes(key)).join(' '))
// React 18 drops inert={true}; the empty string is what survives to the DOM.
check('the wrapper uses inert="" rather than a boolean', /inert=""/.test(shellSource))
const unlisted = lockable.filter(key => !readme.includes(`\`${key}\``))
check('every lockable panel is named in the README', unlisted.length === 0, unlisted.join(' '))

console.log('\n[viewer: exports are interceptable]')
// Every file the viewer hands to the browser goes through one helper that offers it to the host first. A second
//  path that builds its own anchor would be a save the `onExport` prop silently cannot see.
const exportActions = srcFile('export_actions.js')
// Async since the File System Access path writes through a stream — the host offer still happens first, and
//  before any await, so an intercepted save never touches the browser.
check('the download helper offers the blob to the host first',
  /export async function download\([^)]*onExport/.test(exportActions) && /if \(onExport && onExport\(/.test(exportActions))
const anchorSites = ['Viewport.jsx', 'export_actions.js', 'plate_actions.js', 'model_load.js', 'object_actions.js']
  .filter(name => srcFile(name).includes('document.body.appendChild'))
check('and it is the only place that creates one', anchorSites.join(' ') === 'export_actions.js', anchorSites.join(' '))

// The interception itself runs here rather than being read: a save that silently reaches neither the host nor the
//  download folder is the one failure mode worth a real call. Node has no URL.createObjectURL, which is exactly
//  what makes this work — a handled export must return before touching it, so an unhandled one would throw.
const { download } = await import('./src/actions/export_actions.js')
{
  const seen = []
  download(new Uint8Array([1, 2, 3]), 'part.3mf', 'model/3mf', (file, name) => { seen.push([file, name]); return true })
  check('a handled export never reaches the browser', seen.length === 1)
  check('...and the host gets a Blob and the filename', seen[0]?.[0] instanceof Blob && seen[0][1] === 'part.3mf')
  check('...with the right content type', seen[0]?.[0]?.type === 'model/3mf')
  let threw = null
  try { await download(new Uint8Array([1]), 'x.stl', 'model/stl', () => false) } catch (error) { threw = error }
  check('a declined export falls through to the download path', threw !== null,
    'expected the DOM path to be attempted (no URL.createObjectURL in Node)')
}

console.log(failures ? `\n${failures} CHECK(S) FAILED\n` : '\nALL VIEWER-DOC CHECKS PASSED\n')
process.exit(failures ? 1 : 0)
