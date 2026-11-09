// The kernel's size discipline (build.sh, "Size"). Three things keep the wasm small and each is pinned here by what
//  its loss leaves in the bytes: the PrintConfig UI strings are stripped (a tooltip text is the marker), the nlopt
//  algorithms the SLA port never selects are stubbed (DIRECT's assertion message is the marker), and the kernels stay
//  under a byte budget with about 4% headroom over the build this landed with (st 5,741,239, mt 5,988,970; before:
//  6,506,892 and 6,750,898). A legitimate growth raises the budget here, with the measurement beside it.
import { readFileSync } from 'node:fs'

const BUDGET_BYTES = { 'slicer_core': 6_000_000, 'slicer_core.mt': 6_250_000 }
const LEFTOVER_MARKERS = [
  ['Enable this option if machine has auxiliary part cooling fan', 'a PrintConfig tooltip: strip_ui_strings.pl no longer runs over PrintConfig.cpp'],
  ['DIRECT assertion failure', "nlopt's DIRECT algorithm is linked again: NLOPT_SRC lost its slim list or the stub"],
]
const failures = []
const report = []
for (const [name, budget] of Object.entries(BUDGET_BYTES)) {
  const wasm = readFileSync(new URL(`../src/${name}.wasm`, import.meta.url))
  if (wasm.length > budget) failures.push(`${name}.wasm is ${wasm.length} bytes, over the ${budget} budget`)
  const text = wasm.toString('latin1')
  for (const [marker, meaning] of LEFTOVER_MARKERS) if (text.includes(marker)) failures.push(`${name}.wasm holds "${marker}": ${meaning}`)
  report.push(`${name}.wasm ${wasm.length} bytes (budget ${budget})`)
}
if (failures.length) { console.error('FAIL\n  ' + failures.join('\n  ')); process.exit(1) }
console.log(`ok: ${report.join('; ')}, no stripped string came back`)
