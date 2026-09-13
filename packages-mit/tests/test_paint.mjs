// The pure side of painting: the per-extruder facet counts, the overlay/cursor colour mapping, and the brush's
// keyboard layer.
//   Run: node packages/viewer/test_paint.mjs
import assert from 'node:assert'
import { materialPaintCounts } from './src/core/paint_counts.js'
import { paintStateColor, SUPPORT_OVERLAY_COLOR, UNPAINTED_COLOR } from './src/core/paint_colors.js'
import { makeKeyHandler } from './src/core/shortcut_keymap.js'
import { kernelClipPlane, clipConstantForRatio } from './src/core/paint_clip.js'

// ── counts ────────────────────────────────────────────────────────────────────
// The worker's per-state map is the only place a tool above T2 is ever counted: measured, a T3 stroke replies
// {enf:0, blk:0, counts:{3:3762}}, so reading enf/blk alone pins T3 at zero forever.
assert.deepStrictEqual(materialPaintCounts(3, { 3: 3762 }, { enf: 0, blk: 0 }), [0, 0, 3762])
// enf/blk ARE states 1 and 2, so they stand in for exactly those two slots when a worker predates `counts`.
assert.deepStrictEqual(materialPaintCounts(3, {}, { enf: 7, blk: 9 }), [7, 9, 0])
// The per-state map wins where both speak, because it is the one the kernel actually answered with.
assert.deepStrictEqual(materialPaintCounts(2, { 1: 4 }, { enf: 7, blk: 9 }), [4, 9])
// Every input can be missing while a kernel side is still wiring up; a panel of zeroes beats a throw on pointermove.
assert.deepStrictEqual(materialPaintCounts(2, null, null), [0, 0])
assert.deepStrictEqual(materialPaintCounts(0, {}, {}), [])

// ── colours ───────────────────────────────────────────────────────────────────
// One facet holds one integer, so the same state number is "support enforcer" under one brush and "print with T1"
// under the other — the brush kind decides, not the state.
assert.strictEqual(paintStateColor(1, false, ['#aabbcc']), SUPPORT_OVERLAY_COLOR[1])
assert.strictEqual(paintStateColor(1, true, ['#aabbcc']), '#aabbcc')
assert.strictEqual(paintStateColor(3, true, ['#aabbcc']), UNPAINTED_COLOR)   // no filament loaded in that slot
assert.strictEqual(paintStateColor(5, false, []), UNPAINTED_COLOR)           // support has only two states

// ── the section plane, in both frames ─────────────────────────────────────────
// The renderer and the selector clip in different coordinate systems and opposite directions, so the only check
// worth having is that they agree about every point: a sign error here shows a correct cut while the brush paints
// the half that was cut away.
{
  const xform = { cx: 37, cy: -12.5, minz: 0 }
  const toKernel = (v) => [v[0] - xform.cx, -v[2] - xform.cy, v[1] - xform.minz]
  for (const normal of [[0, 0, -1], [1, 0, 0], [0, -1, 0], [0.577, 0.577, -0.577]]) {
    for (const constant of [-40, 0, 17.25]) {
      const { normal: kn, offset } = kernelClipPlane(normal, constant, xform)
      for (const v of [[0, 0, 0], [50, 10, -30], [-12, 80, 4], [37, 0, 12.5], [1e3, -1e3, 1e3]]) {
        const clippedByRenderer = normal[0] * v[0] + normal[1] * v[1] + normal[2] * v[2] + constant < 0
        const k = toKernel(v)
        const clippedByKernel = kn[0] * k[0] + kn[1] * k[1] + kn[2] * k[2] - offset > 0
        assert.strictEqual(clippedByKernel, clippedByRenderer,
          `plane ${normal}/${constant} disagrees at ${v}`)
      }
    }
  }
}
// The scrub runs 0..1 across the model's extent along the normal, with a little slack at each end so the two
// extremes really are "nothing cut" and "everything cut" rather than a plane tangent to the bbox.
{
  const bounds = { min: [-10, 0, -10], max: [10, 20, 10] }
  const normal = [0, 1, 0]
  const kept = (constant, p) => normal[0] * p[0] + normal[1] * p[1] + normal[2] * p[2] + constant >= 0
  const corners = [[-10, 0, -10], [10, 20, 10], [0, 10, 0]]
  const atZero = clipConstantForRatio(normal, bounds, 0)
  const atOne = clipConstantForRatio(normal, bounds, 1)
  assert.ok(corners.every(p => kept(atZero, p)), 'ratio 0 cuts nothing')
  assert.ok(corners.every(p => !kept(atOne, p)), 'ratio 1 cuts everything')
  // Monotone in between, or the wheel would not scrub in one direction.
  const halves = [0.25, 0.5, 0.75].map(r => clipConstantForRatio(normal, bounds, r))
  assert.ok(halves[0] > halves[1] && halves[1] > halves[2])
  assert.strictEqual(clipConstantForRatio(normal, bounds, -1), null)   // upstream's "no plane" value

  // The clipped set has to survive the trip to the kernel for a real scrub position too.
  const { normal: kn, offset } = kernelClipPlane(normal, halves[1], { cx: 5, cy: 5, minz: 0 })
  const point = [0, 30, 0]
  const k = [point[0] - 5, -point[2] - 5, point[1]]
  assert.strictEqual(kn[0] * k[0] + kn[1] * k[1] + kn[2] * k[2] - offset > 0,
                     normal[1] * point[1] + halves[1] < 0)
}

// ── the brush's keyboard layer ────────────────────────────────────────────────
const press = (event, { painting = true } = {}) => {
  const fired = []
  makeKeyHandler({
    isPreview: () => false, isPainting: () => painting,
    paintTool: (t) => fired.push('tool:' + t), paintCursor: (c) => fired.push('cursor:' + c),
    paintAxisLock: (l) => fired.push('lock:' + l), pickExtruder: (i) => fired.push('extruder:' + i),
    setGizmo: (m) => fired.push('gizmo:' + m), cancelTool: () => fired.push('cancel'),
    zoomAll: () => fired.push('zoomAll'), zoomBed: () => fired.push('zoomBed'),
    remove: () => {}, duplicate: () => {}, rotateSelected: () => {}, nudgeSelected: () => {},
    toggleHelp: () => {}, slice: () => {}, copy: () => {}, paste: () => {},
  })({ preventDefault() {}, stopPropagation() {}, composedPath: () => [{ tagName: 'CANVAS' }], ...event })
  return fired
}
// Upstream binds the tools to letters inside the gizmo (on_key_down_select_tool_type) and the filaments to the
// number row (on_number_key_down) — that pairing is what makes a two-colour paint job one hand on the mouse.
assert.deepStrictEqual(press({ key: 'c', code: 'KeyC' }), ['cursor:circle'])
assert.deepStrictEqual(press({ key: 's', code: 'KeyS' }), ['cursor:sphere'])
assert.deepStrictEqual(press({ key: 'f', code: 'KeyF' }), ['tool:smart'])
assert.deepStrictEqual(press({ key: 'b', code: 'KeyB' }), ['tool:bucket'])
assert.deepStrictEqual(press({ key: 't', code: 'KeyT' }), ['tool:triangle'])
assert.deepStrictEqual(press({ key: 'v', code: 'KeyV' }), ['lock:vertical'])
assert.deepStrictEqual(press({ key: 'h', code: 'KeyH' }), ['lock:horizontal'])
assert.deepStrictEqual(press({ key: '3', code: 'Digit3' }), ['extruder:2'])   // the row is 1-based, the API 0-based
assert.deepStrictEqual(press({ key: '0', code: 'Digit0' }), [])               // there is no T0
// The brush shadows the object shortcuts only while it is open: S is the scale gizmo again the moment it closes,
// and B goes back to framing the bed.
assert.deepStrictEqual(press({ key: 's', code: 'KeyS' }, { painting: false }), ['gizmo:scale'])
assert.deepStrictEqual(press({ key: 'b', code: 'KeyB' }, { painting: false }), ['zoomBed'])
// Anything the brush does not claim falls through, which is what keeps Escape able to close it.
assert.deepStrictEqual(press({ key: 'Escape' }), ['cancel'])
assert.deepStrictEqual(press({ key: 'z', code: 'KeyZ' }), ['zoomAll'])
// Physical-key matching, same reason as every other letter shortcut: under a Korean layout e.key for C is 'ㅊ'.
assert.deepStrictEqual(press({ key: 'ㅊ', code: 'KeyC' }), ['cursor:circle'])
assert.deepStrictEqual(press({ key: 'ㅅ', code: 'KeyS' }), ['cursor:sphere'])
// Ctrl combinations belong to the app, not to the brush — Ctrl+V must stay paste, not the vertical lock.
assert.deepStrictEqual(press({ key: 'v', code: 'KeyV', ctrlKey: true }), [])

console.log('paint counts + colours + section plane + brush keymap: ok')
