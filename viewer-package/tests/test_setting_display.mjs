// What the settings form displays for a value, against the real schema entries.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { zeroMeansAuto, cleanDefaultText, rowLabel } from '../src/core/setting_display.js'

const schemaFile = JSON.parse(readFileSync(new URL('../../packages/data/config-schema.json', import.meta.url)))
const schema = schemaFile.options ?? schemaFile

assert.equal(zeroMeansAuto('line_width', schema.line_width, '0'), true)
assert.equal(zeroMeansAuto('initial_layer_line_width', schema.initial_layer_line_width, '0.'), true)
assert.equal(zeroMeansAuto('line_width', schema.line_width, '0.4'), false, 'a set width is not auto')
assert.equal(zeroMeansAuto('line_width', schema.line_width, ''), false, 'an emptied field is not 0')
assert.equal(zeroMeansAuto('bridge_line_width', schema.bridge_line_width, '0'), false, 'a percentage default reads 0 literally')
assert.equal(zeroMeansAuto('skin_infill_line_width', schema.skin_infill_line_width, '0'), false)
assert.equal(zeroMeansAuto('seam_slope_start_height', schema.seam_slope_start_height, '0'), false, 'not a line width')

assert.equal(cleanDefaultText('0.'), '0')
assert.equal(cleanDefaultText('100.%'), '100%')
assert.equal(cleanDefaultText('0.4'), '0.4')
assert.equal(cleanDefaultText(0.2), 0.2)

assert.equal(rowLabel({ label: 'First layer' }, 'key', 'Nozzle'), 'Nozzle · First layer')
assert.equal(rowLabel({ label: 'During print' }, 'key', 'During print'), 'During print', 'a title repeating the label reads once')
assert.equal(rowLabel({}, 'fan_speedup_time', 'Fan speed-up time'), 'Fan speed-up time')
assert.equal(rowLabel({ full_label: 'Layer height' }, 'layer_height'), 'Layer height')
assert.equal(rowLabel(undefined, 'some_key'), 'some_key')

console.log('test_setting_display: ok')
