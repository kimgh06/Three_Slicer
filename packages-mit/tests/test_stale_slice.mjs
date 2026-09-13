// What a settings change does to a result already on screen (src/core/slice_staleness.js).
//
// The behaviour it guards: everything shown after a slice — toolpaths, the stats card, the layer slider, the
// G-code export — describes the settings it was sliced with, and none of it says so. Change a setting and the
// preview keeps rendering, the estimate keeps reading plausibly, and Export keeps handing out G-code the current
// settings would not produce.
//   run: node packages/viewer/test_stale_slice.mjs
import { sameSettings, survivesSettingsChange, changedPlates, stalePlateKeys } from './src/core/slice_staleness.js'

let failures = 0
const check = (label, condition, detail = '') => {
  if (condition) console.log(`  ok: ${label}`)
  else { console.log(`  FAIL: ${label}${detail ? ' — ' + detail : ''}`); failures++ }
}

console.log('\n[staleness: did the settings actually change]')
check('the same object is the same settings', sameSettings({ layer_height: 0.2 }, { layer_height: 0.2 }))
check('a changed value is a change', !sameSettings({ layer_height: 0.2 }, { layer_height: 0.3 }))
check('an added key is a change', !sameSettings({ layer_height: 0.2 }, { layer_height: 0.2, wall_loops: 3 }))
check('a removed key is a change', !sameSettings({ layer_height: 0.2, wall_loops: 3 }, { layer_height: 0.2 }))
// A host that rebuilds its settings object every render must not wipe the preview on every render — which is
//  what an identity comparison would do, since every render hands over a fresh object.
check('a rebuilt object with equal values is not a change',
  sameSettings({ layer_height: 0.2, spiral_mode: false }, { ...{ layer_height: 0.2, spiral_mode: false } }))
// printable_area is written as a FRESH array whenever the bed is set, so identity alone reports an unchanged
//  bed as a change and would invalidate on every bed write that changed nothing.
const bed = [[0, 0], [200, 0], [200, 200], [0, 200]]
check('an equal array rebuilt is not a change',
  sameSettings({ printable_area: bed }, { printable_area: [[0, 0], [200, 0], [200, 200], [0, 200]] }))
check('a different array IS a change',
  !sameSettings({ printable_area: bed }, { printable_area: [[0, 0], [250, 0], [250, 200], [0, 200]] }))
check('an empty map equals an empty map', sameSettings({}, {}))
check('null is handled like an empty map', sameSettings(null, {}))

console.log('\n[staleness: which results survive]')
// An imported archive is not a slice of these settings and never claimed to be — and the import itself WRITES
//  settings (it applies the archive's own), so invalidating on that write would erase what was just opened.
check('an opened .sl1 archive survives', survivesSettingsChange({ stats: { sla: true, sla_raster: true } }))
check('an SLA slice does not survive', !survivesSettingsChange({ stats: { sla: true } }))
check('an FFF slice does not survive', !survivesSettingsChange({ stats: { layers: 100 } }))
check('a result without stats does not survive', !survivesSettingsChange({ layers: [] }))
check('an empty slot is not mistaken for a keeper', !survivesSettingsChange(undefined))

console.log('\n[per-plate staleness: which plates\' overrides changed]')
check('identical maps change no plates', changedPlates({ 0: { layer_height: 0.3 } }, { 0: { layer_height: 0.3 } }).length === 0)
check('a rebuilt equal override is not a change (hosts rebuild objects every render)',
  changedPlates({ 1: { wall_loops: 3 } }, { 1: { ...{ wall_loops: 3 } } }).length === 0)
check('a changed override names its plate', JSON.stringify(changedPlates({ 1: { wall_loops: 3 } }, { 1: { wall_loops: 4 } })) === '[1]')
check('an override appearing is a change for that plate', JSON.stringify(changedPlates({}, { 2: { layer_height: 0.1 } })) === '[2]')
check('an override disappearing is a change for that plate', JSON.stringify(changedPlates({ 2: { layer_height: 0.1 } }, {})) === '[2]')
check('an empty override appearing equals no override (omission)', changedPlates({}, { 0: {} }).length === 0)
check('undefined maps are empty maps', changedPlates(undefined, undefined).length === 0)

console.log('\n[per-plate staleness: which results drop]')
const results = { 0: { stats: { layers: 10 } }, 1: { stats: { layers: 20 } }, 2: { stats: { sla: true, sla_raster: true } } }
check('a global change drops every non-survivor', JSON.stringify(stalePlateKeys(results, true, [])) === '["0","1"]')
check('a plate-1 override change drops plate 1 alone', JSON.stringify(stalePlateKeys(results, false, [1])) === '["1"]')
check('an .sl1 archive survives even a targeted change', stalePlateKeys(results, false, [2]).length === 0)
check('no change drops nothing', stalePlateKeys(results, false, []).length === 0)

// The cache-identity chain: tune plate 1, re-slice it, then tune plate 2 — plate 1's fresh result must ride
// through untouched (not merely "not listed": the same object, byte for byte the same reference).
console.log('\n[per-plate staleness: cache identity across the chain]')
const chain = { 0: { stats: { layers: 10 } }, 1: { stats: { layers: 20 } } }
let ps = { }
let step = { ...ps, 1: { layer_height: 0.1 } }                       // edit plate 1's override
let stale = stalePlateKeys(chain, false, changedPlates(ps, step)); ps = step
check('step 1: editing plate 1 drops plate 1 only', JSON.stringify(stale) === '["1"]')
for (const key of stale) delete chain[key]
const plate0Result = chain[0]
chain[1] = { stats: { layers: 30 } }                                 // the re-slice lands plate 1's new result
step = { ...ps, 2: { wall_loops: 4 } }                               // now edit plate 2's override
stale = stalePlateKeys(chain, false, changedPlates(ps, step)); ps = step
check('step 2: editing plate 2 does not drop the others', stale.length === 0)
check('step 2: plate 0\'s result is the same object', chain[0] === plate0Result)
check('step 2: plate 1\'s re-sliced result is kept', chain[1]?.stats.layers === 30)

console.log(failures ? `\n${failures} CHECK(S) FAILED\n` : '\nALL STALE-SLICE CHECKS PASSED\n')
process.exit(failures ? 1 : 0)
