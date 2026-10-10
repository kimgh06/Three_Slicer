// finalizeGcode: the placeholders a slice leaves for its finished estimate, filled as upstream's GCodeProcessor
// post-process fills them (M73 progress, file_start_gcode's totals).
//   Run: node viewer-package/tests/test_finalize_gcode.mjs
import assert from 'node:assert'
import { finalizeGcode } from '../src/core/finalize_gcode.js'

const stats = { time_estimate: 600, filament_mm: 1234.5, layer_times: [120, 240, 240] }
const gcode = [
  ';TIME:@PRINT_TIME_SEC@', ';Filament used:@USED_FILAMENT_LENGTH@m',
  ';_GP_FIRST_LINE_M73_PLACEHOLDER',
  '; LAYER 0 Z0.200', 'G1 X1 Y1 E1',
  '; LAYER 1 Z0.400', 'G1 X2 Y2 E1',
  '; LAYER 2 Z0.600', 'G1 X3 Y3 E1',
  ';_GP_LAST_LINE_M73_PLACEHOLDER',
].join('\n')
const out = finalizeGcode(gcode, stats).split('\n')
assert.strictEqual(out[0], ';TIME:600.00', 'print_time_sec is the estimate in seconds, two decimals')
assert.strictEqual(out[1], ';Filament used:1.23m', 'used_filament_length is metres, two decimals')
assert.strictEqual(out[2], 'M73 P0 R10', 'the first line: 0% and the whole print in minutes')
// Layer 0 starts at 0% with 10 minutes left (same as the first line, so not repeated); layer 1 after 120 s: 20%, 8 min;
//  layer 2 after 360 s: 60%, 4 min.
assert.deepStrictEqual(out.slice(3), ['; LAYER 0 Z0.200', 'G1 X1 Y1 E1', '; LAYER 1 Z0.400', 'M73 P20 R8', 'G1 X2 Y2 E1',
  '; LAYER 2 Z0.600', 'M73 P60 R4', 'G1 X3 Y3 E1', 'M73 P100 R0'])
assert.strictEqual(finalizeGcode('G1 X1\n; LAYER 0 Z0.2', stats), 'G1 X1\n; LAYER 0 Z0.2', 'no placeholder: unchanged')
console.log('finalize_gcode: all assertions passed')
