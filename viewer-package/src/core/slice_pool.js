// Plate-parallel slicing: the worker-count policy and the per-run bookkeeping. Pure — the workers themselves
// live in actions/use_slicer.js, this decides how many and tracks what each plate is doing.
//
// The policy is measured, not designed (node harness, 3M-facet model, 15 cores, 30 plates, wall time vs serial):
//   mt kernel   classic/no-support: 1.15x from 5 workers on, flat to 15.   arachne+tree: 2.6x at 5, 3.3x at 15.
//   st kernel   one core per worker, so 14 workers gave 7.2x.
//   Worker count never made a run SLOWER up to the core count (17 = 15); what it costs is memory — measured
//   2.5GB for one worker, 8.8GB for five, 11.6GB for fifteen on that model. Auto on mt was half the cores for that
//   reason, each worker free to start a thread per core. It is the core count now, every worker with a share of the
//   threads (threadsPerWorker below), and the memory cap further down still bounds it by the largest plate. That
//   harness found a thread budget made no difference (3x5 threads = 3x15), when tree support ran on one thread; with
//   it threaded, measured in Chrome on 8 cores over a 28-plate project: 4 workers unlimited 20.2-20.8 s, 8 workers at
//   2 threads 19.4-19.5 s. Whether the count divides the plate count did not matter
//   (7/11/13/17 sat on the same curve). Longest-plate-first ordering won nothing there (FIFO won by a second on a
//   mixed run) but does in the browser on 8 cores, where the largest plates of a project came last in index order
//   and ran alone at the end: sliceOrder below (28-plate project, 4 workers: 26.2 -> 25.3-25.7 s).
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
  let byCores = c
  if (kernel === 'st') byCores = Math.max(1, c - 1)
  const byMemory = memoryWorkerCap(largestBytes)
  const wanted = manual > 0 ? Math.min(manual, c, byMemory) : Math.min(byCores, byMemory)
  return Math.max(1, Math.min(wanted, Math.max(1, Math.floor(plates) || 1)))
}

// How often an all-plates run publishes its progress to React. Per animation frame, the viewport re-rendered up to 60
//  times a second for the whole run, on a machine whose every core is slicing (measured on a 28-plate project, 8
//  workers: 19.9-20.1 -> 19.4-19.5 s at this interval).
export const RUN_PROGRESS_INTERVAL_MS = 200

// The most threads each worker of a pool runs at once on the threaded kernel (the slice message's `threads`): twice the
//  cores shared out over the workers and never under two, because a slice has serial stretches in which a worker with
//  one thread's share would leave its core idle. 0 is no limit: one worker alone, or the single-threaded kernel.
export const MIN_WORKER_THREADS = 2
export function threadsPerWorker({ kernel = null, cores = 0, workers = 1 } = {}) {
  if (kernel === 'st' || workers <= 1) return 0
  const c = Math.max(1, Math.floor(cores) || 4)
  return Math.max(MIN_WORKER_THREADS, Math.ceil((2 * c) / workers))
}

// The order plates are handed to the workers: `first` (the selected plate, which goes to the selector worker) and then
//  the rest largest merged STL first, ties by index. A plate's STL size stands in for its slice time (facets correlated
//  0.87 with it over a 28-plate project); started last, the largest plates ran alone at the end of the run.
// With `workers` given, every worker but the selector's opens on one of the smallest plates, and the largest follow.
//  Started together, the largest plates reach the GPU support pipeline together, and every worker of a tab shares one
//  GPU: each waited for the others' fields while its threads stood idle. Measured on that project in Chrome, 8 workers,
//  GPU on, classic walls, three runs each: 9.1-9.2 s all largest first, 8.0-8.4 s with every other worker opening small,
//  7.7-7.9 s with seven of eight (the large plates then arrive at the GPU one small plate apart). Alternating large and
//  small after the opening measured 7.6-7.8 s, inside that spread, and was not kept.
export function sliceOrder(plates, sizes, first, workers = 1) {
  const sizeOf = new Map(plates.map((plate, position) => [plate, sizes[position] ?? 0]))
  const rest = plates.filter(plate => plate !== first).sort((a, b) => sizeOf.get(b) - sizeOf.get(a) || a - b)
  const order = []
  if (sizeOf.has(first)) order.push(first)
  const opening = Math.min(Math.max(0, workers - 1), Math.floor(rest.length / 2))
  const small = rest.splice(rest.length - opening, opening).reverse()
  return [...order, ...small, ...rest]
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
