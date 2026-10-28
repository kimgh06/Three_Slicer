// 3MF parsing off the main thread. A real MakerWorld project is 52MB compressed, 316MB of XML and 3.8M triangles, and
//  every millisecond of reading it used to be a frozen UI — no spinner, no camera, no cancel.
// The parse is split by build item (parse_3mf.js runItemJob): each item's parts are inflated and read by a helper — a
//  second copy of this same script — so the slowest item, not the sum of them, bounds the parse. A browser that will
//  not start a worker from a worker gets the same jobs run here, one after another.
// The result's triangle arrays and scene geometry are TRANSFERRED rather than copied: they are the bulk of the payload
//  and the worker has no use for them afterwards. The input buffer is NOT transferred — neutering it would leave the
//  caller's in-thread fallback (model_loaders.js) with an empty buffer if this worker ever fails to start.
import { parse3MFProject, runItemJob, scanKeptObjects, runKeptItemJob, createKept } from './core/parse_3mf.js'
import { inflateSink, inflateEntryInBatches } from './core/zip_entries.js'

function builtBuffers(built) {
  if (!built) return []
  const buffers = [built.tris.buffer, ...built.modifiers.map(m => m.tris.buffer)]
  if (built.baked) buffers.push(built.baked.localPos.buffer)
  return buffers
}

// ---- Helpers: copies of this script that run item jobs -------------------------------------------------------------
// ponytail: helpers are kept for the worker's lifetime and capped at HELPER_LIMIT, each idle one holding a module
//  graph. The cap is a guess until measured per machine; the [vp-prof] parse line is where a wrong one would show.
const HELPER_LIMIT = 8
let helpers = null   // [{ worker, busy }] once started; [] where workers cannot start workers
let nextJobId = 0
const pendingJobs = new Map()

function startHelpers() {
  if (helpers) return helpers
  helpers = []
  const count = Math.min(HELPER_LIMIT, Math.max(1, (self.navigator?.hardwareConcurrency || 2) - 1))
  try {
    for (let k = 0; k < count; k++) {
      const worker = new Worker(self.location.href, { type: 'module' })
      const helper = { worker, failed: false }
      worker.onmessage = (event) => {
        const { id, result, error, batch } = event.data || {}
        const pending = pendingJobs.get(id)
        if (!pending) return
        if (batch) { pending.onBatch(batch); return }   // an inflater's output, the reply comes after the last one
        pendingJobs.delete(id)
        if (error) pending.reject(new Error(error))
        else pending.resolve(result)
      }
      // A helper that dies fails the job it held; the caller runs that job here instead, and the helper is not used again.
      worker.onerror = () => {
        helper.failed = true
        for (const [id, pending] of pendingJobs) if (pending.helper === helper) { pendingJobs.delete(id); pending.reject(new Error('3MF helper failed')) }
      }
      helpers.push(helper)
    }
  } catch {
    for (const helper of helpers) helper.worker.terminate()
    helpers = []
  }
  return helpers
}

function runOnHelper(helper, job) {
  return askHelper(helper, { type: 'item-job', job }, job.members.map(member => member.data.buffer))
}

function askHelper(helper, message, transfer, onBatch = null) {
  const id = ++nextJobId
  return new Promise((resolve, reject) => {
    pendingJobs.set(id, { resolve, reject, helper, onBatch })
    helper.worker.postMessage({ ...message, id }, transfer)
  })
}

// The pool parse3MFProject streams the root part's objects to (parse_3mf.js streamRoot): helper `slot` reads and keeps
//  the spans it is sent, then builds the items of what it kept. One parse at a time keeps one set of objects per
//  helper; release() drops them.
let nextParseId = 0
function makePool() {
  const pool = startHelpers().filter(helper => !helper.failed)
  if (pool.length < 2) return null
  const parseId = ++nextParseId
  // The first helper inflates the root part and posts it back in batches while this worker indexes and dispatches
  //  (the two no longer share a thread); the others read the spans. The member is copied for the transfer: it is a
  //  view into the whole archive, which stays here.
  const [inflater, ...readers] = pool
  const inflate = (data, entry, onBytes) => {
    const sink = inflateSink(entry, onBytes)
    // A Blob slice goes by reference and the inflater reads it from disk as it goes; bytes are a view into the whole
    //  archive, which stays here, so they are copied for the transfer.
    let payload = data, transfer = []
    if (!(data instanceof Blob)) { payload = data.slice(); transfer = [payload.buffer] }
    return askHelper(inflater, { type: 'inflate', data: payload, entry: { method: entry.method, size: entry.size } }, transfer, (batch) => sink.push(batch))
      .then(() => sink.finish())
  }
  if (readers.length < 1) return null
  return {
    inflate,
    size: readers.length,
    scan: (slot, data, options) => askHelper(readers[slot], { type: 'scan', parseId, data, options }, [data.buffer]),
    build: (slot, job) => askHelper(readers[slot], { type: 'build', parseId, job }, job.members.map(member => member.data.buffer)),
    release: () => { for (const helper of readers) helper.worker.postMessage({ type: 'release', parseId }) },
  }
}

// Jobs arrive largest first; each free helper takes the next one. A job whose helper fails runs here.
async function runJobs(jobs) {
  const pool = startHelpers().filter(helper => !helper.failed)
  if (!pool.length) return Promise.all(jobs.map(runItemJob))
  const results = new Array(jobs.length)
  let next = 0
  const drain = async (helper) => {
    while (next < jobs.length) {
      const index = next++
      const job = jobs[index]
      // The members are transferred to the helper; a copy stays here in case the helper fails.
      const kept = job.members.map(member => member.data.slice())
      try {
        results[index] = await runOnHelper(helper, job)
      } catch {
        results[index] = await runItemJob({ ...job, members: job.members.map((member, k) => ({ ...member, data: kept[k] })) })
      }
    }
  }
  await Promise.all(pool.slice(0, jobs.length).map(drain))
  return results
}

const keptByParse = new Map()   // a helper's kept objects, per parse: parseId -> Map(objectid -> object)

self.onmessage = async (event) => {
  const data = event.data || {}
  if (data.type === 'scan') {                             // this copy is a pool helper
    try {
      if (!keptByParse.has(data.parseId)) keptByParse.set(data.parseId, createKept())
      scanKeptObjects(data.data, keptByParse.get(data.parseId), data.options)
      self.postMessage({ id: data.id, result: true })
    } catch (err) {
      self.postMessage({ id: data.id, error: (err && err.message) || String(err) })
    }
    return
  }
  if (data.type === 'build') {
    try {
      const result = await runKeptItemJob(data.job, keptByParse.get(data.parseId))
      self.postMessage({ id: data.id, result }, result.items.flatMap(item => builtBuffers(item.built)))
    } catch (err) {
      self.postMessage({ id: data.id, error: (err && err.message) || String(err) })
    }
    return
  }
  if (data.type === 'release') { keptByParse.delete(data.parseId); return }
  if (data.type === 'inflate') {                          // this copy inflates for the parse worker
    try {
      await inflateEntryInBatches(data.data, data.entry, (batch) => self.postMessage({ id: data.id, batch }, [batch.buffer]))
      self.postMessage({ id: data.id, result: true })
    } catch (err) {
      self.postMessage({ id: data.id, error: (err && err.message) || String(err) })
    }
    return
  }
  if (data.type === 'item-job') {                         // this copy is a helper
    try {
      const result = await runItemJob(data.job)
      self.postMessage({ id: data.id, result }, result.items.flatMap(item => builtBuffers(item.built)))
    } catch (err) {
      self.postMessage({ id: data.id, error: (err && err.message) || String(err) })
    }
    return
  }
  if (data.type === 'warm') { startHelpers(); return }   // warmLoaderFor: the helpers start before the archive arrives
  const { id, source, baseName } = data
  try {
    // The caller's File arrives as a shared Blob and is read here, off the main thread, as slices: the archive's
    //  directory and small members, and the big part streamed into its inflater, never the whole file at once.
    const { objects, project } = await parse3MFProject(source, baseName, { runJobs, bake: true, pool: makePool() })
    // Maps (the paint slots, project.objectMeta) survive structured clone as Maps, so the shape the main thread
    //  receives is the shape parse3MFProject returns — no serialisation step to keep in sync.
    self.postMessage({ id, objects, project }, objects.flatMap(o => [o.tris.buffer, o.baked.localPos.buffer]))
  } catch (err) {
    self.postMessage({ id, error: (err && err.message) || String(err) })
  }
}
