// Profile settings the template path reads but does not do yet (settings_core.js partialSupport): named, never
//  dropped silently, and only where they would change the output.
//   run: node viewer-package/tests/test_partial_support.mjs
import assert from 'node:assert'
import { partialSupport, PARTIAL_SUPPORT_CODE } from '../src/settings/index.js'

const template = { machine_start_gcode: 'G28' }
const keys = (settings, toolCount) => partialSupport(settings, { toolCount }).map(gap => gap.key)

assert.deepStrictEqual(keys({ retract_length_toolchange: ['2'] }, 2), [], 'no custom G-code: the raw path, nothing to report')
assert.deepStrictEqual(keys({ ...template, retract_length_toolchange: ['2'] }, 1), [], 'one tool: no tool change')
assert.deepStrictEqual(keys({ ...template, retract_length_toolchange: ['2', '0'] }, 2), ['retract_length_toolchange'])
assert.deepStrictEqual(keys({ ...template, retract_length_toolchange: ['0', '0'] }, 2), [], 'a zero length changes nothing')
assert.deepStrictEqual(keys({ ...template }, 2), ['retract_length_toolchange'], 'absent: upstream\'s schema default (10) applies')
assert.deepStrictEqual(keys({ ...template, retract_length_toolchange: ['0'], ooze_prevention: '1' }, 2), ['ooze_prevention'])
assert.deepStrictEqual(keys({ ...template, retract_length_toolchange: ['0'], ooze_prevention: '0' }, 2), [])
const [gap] = partialSupport({ ...template, retract_length_toolchange: ['2'] }, { toolCount: 2 })
assert.strictEqual(gap.code, PARTIAL_SUPPORT_CODE)
assert.ok(gap.effect.length > 0, 'each gap says what happens instead')
console.log('partial support: all assertions passed')
