// Plate-parallel slicing (src/core/slice_pool.js): the worker-count policy and the run bookkeeping.
// The policy numbers are measured (see the module header); this pins that the code says what the measurement said.
//   run: node packages/viewer/test_slice_pool.mjs
import { resolveWorkerCount, memoryWorkerCap, makePlateRun, patchPlate, runSummary, PLATE_STATES } from './src/core/slice_pool.js'

let failures = 0
const check = (label, condition, detail = '') => {
  if (condition) console.log(`  ok: ${label}`)
  else { console.log(`  FAIL: ${label}${detail ? ' — ' + detail : ''}`); failures++ }
}

console.log('[worker count: Auto]')
check('mt Auto is half the cores, rounded up', resolveWorkerCount({ kernel: 'mt', cores: 15, plates: 30 }) === 8)
check('st Auto is cores - 1', resolveWorkerCount({ kernel: 'st', cores: 15, plates: 30 }) === 14)
check('unknown kernel is treated as mt', resolveWorkerCount({ kernel: null, cores: 8, plates: 30 }) === 4)
check('unknown core count falls back to 4', resolveWorkerCount({ kernel: 'mt', cores: 0, plates: 30 }) === 2)
check('never more workers than plates', resolveWorkerCount({ kernel: 'st', cores: 15, plates: 3 }) === 3)
check('one plate is one worker', resolveWorkerCount({ kernel: 'st', cores: 15, plates: 1 }) === 1)
check('two cores on st still give one worker', resolveWorkerCount({ kernel: 'st', cores: 2, plates: 9 }) === 1)

console.log('\n[worker count: memory cap — the browser measurement]')
const MB = 1024 ** 2
check('a 143MB plate (3M facets) gets 2 workers on Auto — 3 crashed a tab', resolveWorkerCount({ kernel: 'mt', cores: 15, plates: 9, largestBytes: 143 * MB }) === 2)
check('a 40MB plate is not memory-bound on 15 cores', resolveWorkerCount({ kernel: 'mt', cores: 15, plates: 9, largestBytes: 40 * MB }) === 8)
check('a 400MB plate still gets one worker, never zero', resolveWorkerCount({ kernel: 'mt', cores: 15, plates: 9, largestBytes: 400 * MB }) === 1)
check('the cap applies to st too', resolveWorkerCount({ kernel: 'st', cores: 15, plates: 9, largestBytes: 143 * MB }) === 2)
check('a manual count is capped by memory too — past it the tab dies, not a worker', resolveWorkerCount({ setting: 6, kernel: 'mt', cores: 15, plates: 9, largestBytes: 143 * MB }) === 2)
check('the cap itself is exported for the select to mark', memoryWorkerCap(143 * MB) === 2 && memoryWorkerCap(0) === Infinity)

console.log('\n[worker count: manual]')
check('a manual value wins over Auto', resolveWorkerCount({ setting: 3, kernel: 'mt', cores: 15, plates: 30 }) === 3)
check('manual is capped at the core count', resolveWorkerCount({ setting: 99, kernel: 'mt', cores: 15, plates: 30 }) === 15)
check('manual is capped at the plate count', resolveWorkerCount({ setting: 12, kernel: 'mt', cores: 15, plates: 9 }) === 9)
check('0 means Auto', resolveWorkerCount({ setting: 0, kernel: 'mt', cores: 15, plates: 30 }) === 8)
check('a string setting is read as a number', resolveWorkerCount({ setting: '5', kernel: 'mt', cores: 15, plates: 30 }) === 5)
check('garbage means Auto', resolveWorkerCount({ setting: 'lots', kernel: 'mt', cores: 15, plates: 30 }) === 8)

console.log('\n[run bookkeeping]')
const run0 = makePlateRun([0, 2, 5], 2, 'mt')
check('every plate starts queued', Object.values(run0.plates).every(p => p.state === PLATE_STATES.queued && p.progress === 0))
check('the pool size and kernel ride on the run', run0.workers.pool === 2 && run0.workers.kernel === 'mt' && run0.workers.active === 0)
const run1 = patchPlate(run0, 2, { state: PLATE_STATES.busy, progress: 0.4, rate: 120 })
check('patching returns a new object', run1 !== run0 && run1.plates !== run0.plates && run0.plates[2].state === PLATE_STATES.queued)
check('active counts the busy plates', run1.workers.active === 1)
check('an unknown plate is ignored', patchPlate(run1, 7, { state: PLATE_STATES.busy }) === run1)
const run2 = patchPlate(patchPlate(run1, 0, { state: PLATE_STATES.busy, progress: 0.2, rate: 30 }), 2, { state: PLATE_STATES.done })
check('done forces progress 1 and rate 0', run2.plates[2].progress === 1 && run2.plates[2].rate === 0)
check('done leaves the other plate busy', run2.workers.active === 1 && run2.plates[0].state === PLATE_STATES.busy)
const run3 = patchPlate(run2, 5, { state: PLATE_STATES.failed, progress: 0.7, rate: 50 })
check('failed keeps its progress but drops the rate', run3.plates[5].progress === 0.7 && run3.plates[5].rate === 0)

console.log('\n[run summary]')
const s = runSummary(run3)
check('progress is the mean over every plate', Math.abs(s.progress - (0.2 + 1 + 0.7) / 3) < 1e-9, String(s.progress))
check('rate sums the busy plates only', s.rate === 30)
check('counts', s.done === 1 && s.failed === 1 && s.busy === 1 && s.total === 3)
const e = runSummary(null)
check('no run is all zeros', e.progress === 0 && e.rate === 0 && e.total === 0)

console.log(failures ? `\n${failures} failure(s)` : '\nall ok')
process.exit(failures ? 1 : 0)
