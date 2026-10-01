// Plate-parallel slicing: the worker-count policy and the per-run bookkeeping. Pure — the workers themselves
// live in actions/use_slicer.js, this decides how many and tracks what each plate is doing.
//
// The policy is measured, not designed (node harness, 3M-facet model, 15 cores, 30 plates, wall time vs serial):
//   mt kernel   classic/no-support: 1.15x from 5 workers on, flat to 15.   arachne+tree: 2.6x at 5, 3.3x at 15.
//   st kernel   one core per worker, so 14 workers gave 7.2x.
//   Worker count never made a run SLOWER up to the core count (17 = 15); what it costs is memory — measured
//   2.5GB for one worker, 8.8GB for five, 11.6GB for fifteen on that model. So Auto stops at half the cores on mt:
//   most of the gain (5 workers = 2.6x of 3.3x) for half the heap. The user can push it to the core count by hand.
//   Three things measured as NOT mattering, so they are deliberately absent: a per-worker thread budget (3x5
//   threads = 3x15 threads — the OS scheduler already does it), longest-plate-first ordering (FIFO won by a
//   second on a mixed run), and whether the count divides the plate count (7/11/13/17 sat on the same curve).
//
// The BROWSER is tighter than that harness: every worker's wasm heap lives in the one renderer process that also
//   holds each plate's STL buffer and three.js geometry. Measured in Chromium on the same 143MB-STL model over nine
//   plates (classic preset): 1 worker 17.8s, 2 workers 15.7s, 3 workers crashed the tab once and took 18.7s once,
//   Auto at 8 crashed the tab every time. Those crashes were the threaded glue inlining its wasm (every pthread
//   isolate held a copy, and all isolates of a tab share one 4GB V8 heap region — AGENTS.md, "The threaded kernel's
//   wasm is a file"): with the wasm split out, 5 and 8 workers ran that model with no crash (Chrome RSS peak 11.4GB
//   on a 24GB machine), and haaland.3mf ran 3-5 workers where 3 had crashed 4 times in 6. The cap below is still
//   applied, to Auto and to the select: a worker's heap is about HEAP_PER_STL_BYTE times the STL it slices (node
//   measured ~1.7GB for 143MB), and the pool gets POOL_HEAP_BUDGET — 2 for that model, no limit for a 40MB one (8 on
//   15 cores). ponytail: these constants were set from the cage crashes; re-derive them against physical memory
//   (a smaller-RAM machine) before raising them.
export const PLATE_STATES = Object.freeze({ queued: 'queued', busy: 'busy', done: 'done', failed: 'failed' })
export const HEAP_PER_STL_BYTE = 12
export const POOL_HEAP_BUDGET = 4 * 1024 ** 3

// How many workers the pool budget allows for the biggest plate — the ceiling for Auto AND for the select.
export function memoryWorkerCap(largestBytes = 0) {
  return largestBytes > 0 ? Math.max(1, Math.floor(POOL_HEAP_BUDGET / (largestBytes * HEAP_PER_STL_BYTE))) : Infinity
}

// `setting` is the host's `slice_workers` (0/absent = Auto), `kernel` what the worker loaded ('mt'|'st'|null),
//  `largestBytes` the biggest plate's merged STL — the memory cap above, applied to Auto.
export function resolveWorkerCount({ setting = 0, kernel = null, cores = 0, plates = 1, largestBytes = 0 } = {}) {
  const c = Math.max(1, Math.floor(cores) || 4)
  const manual = Math.floor(Number(setting)) || 0
  const byCores = kernel === 'st' ? Math.max(1, c - 1) : Math.ceil(c / 2)
  const byMemory = memoryWorkerCap(largestBytes)
  const wanted = manual > 0 ? Math.min(manual, c, byMemory) : Math.min(byCores, byMemory)
  return Math.max(1, Math.min(wanted, Math.max(1, Math.floor(plates) || 1)))
}

// A run's state, immutable so React can diff it: { workers: {pool, active, kernel}, plates: {[i]: {state, progress, rate}} }.
export function makePlateRun(plateIndices, pool, kernel = null) {
  const plates = {}
  for (const i of plateIndices) plates[i] = { state: PLATE_STATES.queued, progress: 0, rate: 0 }
  return { workers: { pool, active: 0, kernel }, plates }
}

export function patchPlate(run, plate, patch) {
  const prev = run.plates[plate]; if (!prev) return run
  const next = { ...prev, ...patch }
  if (next.state === PLATE_STATES.done) { next.progress = 1; next.rate = 0 }
  if (next.state === PLATE_STATES.failed) next.rate = 0
  const plates = { ...run.plates, [plate]: next }
  const active = Object.values(plates).filter(p => p.state === PLATE_STATES.busy).length
  return { workers: { ...run.workers, active }, plates }
}

// What the one slice button and the rate line show for a whole run: mean progress over every plate (queued = 0,
//  done = 1) and the summed rate of the busy ones.
export function runSummary(run) {
  const list = Object.values(run?.plates ?? {})
  if (!list.length) return { progress: 0, rate: 0, done: 0, failed: 0, busy: 0, total: 0 }
  const progress = list.reduce((a, p) => a + (p.state === PLATE_STATES.done ? 1 : p.progress), 0) / list.length
  const rate = list.reduce((a, p) => a + (p.state === PLATE_STATES.busy ? p.rate : 0), 0)
  const count = (s) => list.filter(p => p.state === s).length
  return { progress, rate, done: count(PLATE_STATES.done), failed: count(PLATE_STATES.failed), busy: count(PLATE_STATES.busy), total: list.length }
}
