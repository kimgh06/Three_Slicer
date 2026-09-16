import { log } from './core/log.js'
import { effectiveSettings, plateTechnology } from './core/plate_settings.js'
import { statsFromKernel } from './core/kernel_stats.js'
import { useEffect, useRef } from 'react'
import { deriveKernelParams, deriveSlaParams, settingRaw } from 'three-slicer-viewer/settings'
import { DEFAULT_BED } from './core/viewer_defaults.js'


// Worker lifecycle + progress mapping (SAB polling) + the stage-30 streaming/watchdog/OOM retry ladder.
// A real hook: it owns the refs nobody else touches (SAB view, poll timer, stream accumulator) and the two
//  worker lifetime effects; the refs shared with the other concerns (workerRef, layer range, apiRef, …) come in as deps.
// `makeWorker` is the ONLY tie to a kernel: a factory returning a Worker that speaks this hook's protocol. This
//  package ships no such worker — three-slicer/viewer binds its makeSlicerWorker (the WASM kernel, AGPL) and
//  re-exports the bound hook; a host with its own slicing worker passes its own. Everything else in here —
//  the message protocol, progress, the pool, the economy/classic ladder — is this package's.
export function useSlicer(deps) {
  const { makeWorker } = deps
  if (typeof makeWorker !== 'function') throw new Error('useSlicer: deps.makeWorker (a slicer worker factory) is required')
  const {
    settings, plateSettings, wipeTowerReal, workerRef, apiRef, layersDataRef, layerLoRef, layerHiRef,
    paintStateCountsRef, rebuildToolpaths, rebuildPaintOverlay,
    setProgress, setSliceRate, setSlicing, setError, setStats, setOverBed, setLayerCount,
    setLayerLo, setLayerHi, setGcodeUrl, setCanvasMode, setPaintCounts, setSliceNotice,
    // Which kernel the selector worker loaded ('mt'|'st'), for the UI badge and the pool size. Optional.
    setKernelKind,
    // features.warmup / features.logs — `quiet` rides on the worker messages because the worker is a separate
    //  module instance and cannot see this side's logging flag.
    warmup, quiet,
  } = deps

  const pendingSliceRef = useRef(null)  // promise-based slice (for the sequential all-plates run) + the stage-30 watchdog timer
  const streamAccumRef = useRef(null)   // stage 30: streamed layer accumulator {layers:[{z,paths,widths}], gcode:[chunk]}
  const downgradeRef = useRef(false)    // stage 30: a downgrade (simplified) retry is in progress — buildParams simplifies infill + economy
  const lastGeomRef = useRef(null)      // G003 incremental: geometry digest of the last successful slice (plate-agnostic — a different plate yields a different digest)
  const kernelKindRef = useRef(null)    // 'mt' | 'st' | null — what the selector worker's 'warm' reply said
  const poolRef = useRef(new Set())     // live pool contexts (an all-plates run's extra workers) — cancel and unmount reach them here
  // Where the selector worker's progress goes. Normally the component's own state; during an all-plates run the
  //  pool re-routes it to that run's plate entry, so the one worker that also paints reports like the others do.
  const progressSinkRef = useRef(null)
  const emitProgress = (v) => { const sink = progressSinkRef.current; if (sink) sink.progress(v); else setProgress(v) }
  const emitRate = (v) => { const sink = progressSinkRef.current; if (sink) sink.rate(v); else setSliceRate(v) }

  // ---- Live throughput: layers per second, while the slice runs ----
  // The two technologies feed this from OPPOSITE ends of the protocol, and each is the only usable source on its
  //  own path.
  //  · FFF takes the streamed 'layer' messages, so it reports during the EMISSION pass only. Not a choice: PASS1's
  //    live progress is the SAB counter, which is per-mille of the pass rather than a layer count (the total N
  //    arrives with the first progress message, at PASS1's END), and surfaces and support publish no per-layer
  //    news at all. Measured on a 38MB model: a 4.0s slice, 2.8s of it PASS1, rate shown for the last 0.6s at 379
  //    then 576 layers/s. On a support-heavy model emission is a far larger share (measured 38%).
  //  · SLA takes its progress messages instead (see the 'progress' branch), because slice_sla builds the whole
  //    scene and only then drains the sink: measured 1095 layer messages inside a 22ms burst at the end of a 2.8s
  //    run. Timing that burst would measure the drain, not the slicing.
  //  Batch mode (economy, MM) streams no layers and so shows no rate — it shows no preview either.
  const rateRef = useRef(null)      // { t, n, at } — window start, layers counted in it, last absolute count seen
  const RATE_WINDOW_MS = 250        // 400 was measured to fit only twice into a 0.6s emission; 250 reads sooner and still does not jitter
  const resetRate = () => { rateRef.current = null; emitRate(0) }
  // `absolute` is a layer count that only rises within one phase. A count that goes BACKWARDS is the next phase
  //  starting its own numbering, which restarts the window instead of subtracting into a negative rate.
  const noteLayers = (absolute) => {
    const now = performance.now()
    const window = rateRef.current
    if (!window || absolute < window.at) { rateRef.current = { t: now, n: 0, at: absolute }; return }
    window.n += absolute - window.at
    window.at = absolute
    const elapsed = now - window.t
    if (elapsed >= RATE_WINDOW_MS) { emitRate((window.n * 1000) / elapsed); window.t = now; window.n = 0 }
  }

  // ---- Progress: time-weighted mapping + real support progress (SAB polling) ----
  //  Measured time share per phase (774k tri): PASS1 7% · surfaces 6% · support 48% · emission 38% -> budget 15/5/40/40.
  const supSabRef = useRef(null)     // { arr: Uint32Array(SAB, ptr, 1) } — shared once by the mt worker
  const supPollRef = useRef(0)
  // Which support path the RUNNING slice takes — the progress counter behaves too differently between them to read
  //  the same way (see startSupPoll). A ref because the worker's message handler is installed once; written from the
  //  plate's own params at slice start, not from the global map (a tree override on one plate polled the wrong shape).
  const treeSupportRef = useRef(false)
  const stopSupPoll = () => { if (supPollRef.current) { clearInterval(supPollRef.current); supPollRef.current = 0 } }
  // G002: cancel an in-flight slice — written straight into the SAB flag (the kernel loop observes it even while the worker is blocked in wasm)
  const cancelSlice = () => {
    const sab = supSabRef.current; log.info('[vp-cancel] cancelSlice, hasView=', !!sab?.cancel)
    if (sab?.cancel) { try { Atomics.store(sab.cancel, 0, 1) } catch { sab.cancel[0] = 1 } }
    for (const ctx of poolRef.current) ctx.cancel()   // an all-plates run: every worker's flag, not just the selector's
  }
  const mapProgress = (done, total) => {
    const N = total > 2 ? (total - 2) / 2 : 0
    if (!N) return total ? done / total : 0
    if (done <= N) return 0.35 * (done / N)          // PASS1: 0 -> 35% (measured 2.8s/7.8s — real progress via SAB polling)
    if (done === N + 1) return 0.36                  // surfaces done -> entering support
    if (done === N + 2) return 0.87                  // support done (measured 4.0s)
    return 0.87 + 0.13 * ((done - N - 2) / N)        // emission: 87 -> 100% (measured 1.1s)
  }
  const startSupPoll = (N) => {
    const sab = supSabRef.current; if (!sab) return
    stopSupPoll()
    // The counter means different things on the two support paths, so one scale cannot serve both.
    //  · grid/snug run inside the tbb ParallelScope and emit ≈3.5xN items spread across the phase — real progress.
    //  · tree runs serial and emits tens of times more, front-loaded: the count saturates any fixed scale within
    //    seconds while the slow work emits almost none. There it can only say "still alive", not "how far".
    //  Reading it as progress on tree is what pinned the bar at 36% for 71.5s of a 76s slice (measured on a 53.9MB
    //  plate); rescaling alone just moved the freeze to whatever the cap was. So tree is driven by elapsed time on
    //  an asymptote — always moving, never claiming done. A real hang is still caught by the watchdog below.
    const tSup = Date.now()
    supPollRef.current = setInterval(() => { emitProgress(supportBand(sab, N, tSup)) }, 150)
  }
  // The two SAB-driven bands as functions of the counter, shared with the pool contexts below — the mapping is
  //  the measured thing here, and two copies of it would drift.
  const supportBand = (sab, N, tSup) => {
    const frac = treeSupportRef.current ? 1 - Math.exp(-(Date.now() - tSup) / 30000) : sab.arr[0] / (3.5 * N)
    return 0.36 + 0.51 * Math.min(0.95, frac)
  }
  const pass1Band = (sab) => 0.35 * Math.min(1, sab.arr[0] / 1000)
  // Real PASS1 progress (0 -> 35%): the kernel writes per-mille (0..1000) into the SAB counter — starts right after the slice is sent, ends on the first progress message
  const startP1Poll = () => {
    const sab = supSabRef.current; if (!sab) return
    stopSupPoll()
    supPollRef.current = setInterval(() => { emitProgress(pass1Band(sab)) }, 150)
  }
  function getWorker() {
    if (!workerRef.current) {
      const wk = makeWorker()   // the static worker pattern is isolated in make_worker.js (shipped unbundled, verbatim)
      wk.onmessage = (e) => {
        const d = e.data
        const pnd = pendingSliceRef.current
        if (d.type === 'progress') {   // stage 30: reset the watchdog (+record the phase) + weighted mapping + per-band polling control
          // An SLA slice reports layers linearly — the FFF phase weighting (and its SAB polling bands) would map
          //  a layer count onto surface/support phases that do not exist there.
          // SLA's rate comes from HERE, not from the layer stream the FFF path uses: measured on a 1095-layer
          //  resin slice, every layer message arrived inside a 22ms burst at the very end of a 2.8s run, because
          //  slice_sla produces the whole scene and only then drains the sink. Those timings describe the drain,
          //  not the slicing. Its progress counter is the opposite — linear in layers and spread across the run.
          if (pnd?.sla) { emitProgress(d.total ? d.done / d.total : 0); noteLayers(d.done); pnd?.kick?.(); return }
          const N = d.total > 2 ? (d.total - 2) / 2 : 0
          if (N && d.done <= N) stopSupPoll()          // first progress = PASS1 done -> stop P1 polling
          if (N && d.done === N + 1) startSupPoll(N)
          if (N && d.done >= N + 2) stopSupPoll()
          emitProgress(mapProgress(d.done, d.total)); pnd?.note?.(d.done, d.total); pnd?.kick?.()
        }
        else if (d.type === 'supsab') { try { supSabRef.current = { arr: new Uint32Array(d.buf, d.ptr, 1), cancel: d.cancelPtr ? new Uint32Array(d.buf, d.cancelPtr, 1) : null }; log.info('[vp-cancel] supsab cancelPtr=', d.cancelPtr) } catch (e) { log.info('[vp-cancel] supsab view fail', e) } }
        else if (d.type === 'layer') {   // stage-30 streaming: receive each layer immediately (transfer) -> accumulate, reset the watchdog
          pnd?.kick?.()
          const a = streamAccumRef.current
          if (a) { a.layers.push({ z: d.z, paths: d.paths, widths: d.widths }); if (d.gcode) a.gcode.push(d.gcode); noteLayers(a.layers.length) }
        }
        else if (d.type === 'done') { stopSupPoll(); if (pnd) { pendingSliceRef.current = null; pnd.stop?.(); pnd.resolve(assembleResult(d.result)) } else { handleResult(assembleResult(d.result)); setSlicing(false) } }
        else if (d.type === 'error') { stopSupPoll(); if (pnd) { pendingSliceRef.current = null; pnd.stop?.(); pnd.reject(new Error(d.error)) } else { setError('Slice failed: ' + d.error); setSlicing(false) } }
        else if (d.type === 'warm') { kernelKindRef.current = d.kernel ?? null; setKernelKind?.(kernelKindRef.current) }
        else if (d.type === 'prepared') { /* selector mesh registered */ }
        // The overlay request that follows a stroke is issued by support_paint.js, which is the one place that knows
        //  which states actually changed — asking for all of them on every sample is what made painting slow down as
        //  the painted area grew. This listener keeps only the enf/blk pair it has always kept.
        else if (d.type === 'painted') { setPaintCounts({ enf: d.enf, blk: d.blk }) }
        else if (d.type === 'overlay') { rebuildPaintOverlay(d.enf, d.blk, d.overlays) }
      }
      // Stage-30 OOM detection: worker error/messageerror -> reject the in-flight slice (the ladder decides on an economy retry).
      // Late errors from an already-discarded worker are ignored. An emscripten abort raises an error event per pthread, so
      //  the same worker fires onerror several times — the first rejected the pending slice and swapped the worker, and
      //  the rest used to overwrite the banner via setError, leaving a failure message even when the ladder succeeded.
      const killPending = (msg) => {
        if (workerRef.current !== wk) return
        stopSupPoll(); supSabRef.current = null
        const pnd = pendingSliceRef.current
        if (pnd) { pendingSliceRef.current = null; pnd.stop?.(); try { wk.terminate() } catch {} workerRef.current = null; pnd.reject(new Error(msg)) }
        else { setError(msg); setSlicing(false) }
      }
      wk.onerror = (ev) => killPending('Worker terminated (likely out of memory): ' + (ev.message || 'worker error'))
      wk.onmessageerror = () => killPending('Worker message error (structured clone failed)')
      workerRef.current = wk
      if (typeof window !== 'undefined') window.__vpWorker = wk   // dev/test aid: drive selector cmds directly
    }
    return workerRef.current
  }
  // Stage 30: assemble the streamed result — when streamed, g-code/layers already arrived as 'layer', so they are built from the accumulator.
  //  batch/MM keep gcode+layers in result as before. Economy mode yields an empty layers array (no toolpath) and g-code only.
  function assembleResult(result, a = streamAccumRef.current) {
    if (result && result.stats && result.stats.streamed) {
      a = a || { layers: [], gcode: [] }
      // Spread first: fields beside the stream (the SLA solid meshes) must survive assembly.
      return { ...result, stats: result.stats, layers: a.layers, gcode: a.gcode.join('') }
    }
    return result
  }
  function handleResult(result) {
    if (result.error) { setError(String(result.error)); return }
    layersDataRef.current = result.layers
    const n = result.layers.length
    layerLoRef.current = 0; layerHiRef.current = n - 1; setLayerLo(0); setLayerHi(n - 1)   // dual slider covers the full range
    rebuildToolpaths()
    apiRef.current?.onSliced()
    setCanvasMode('preview')   // S2: switch to Preview automatically once slicing finishes
    setStats(statsFromKernel(result.stats, result.throughput))
    setOverBed(!!result.stats.over_bed)
    setLayerCount(n)
    setGcodeUrl(prev => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(new Blob([result.gcode], { type: 'text/plain' })) })
  }

  useEffect(() => () => {
    if (workerRef.current) { workerRef.current.terminate(); workerRef.current = null }
    for (const ctx of Array.from(poolRef.current)) ctx.terminate()
  }, [])

  // Warmup: right after mount, create the worker and load the kernel (3.4MB parse, wasm compile, mt pthread pool) ahead of time.
  //  It finishes while the user picks and arranges models, so the first slice click no longer feels like a load.
  // Off (features.warmup === false) it is not merely deferred but never paid at all on a page that never slices —
  //  a G-code viewer driven by the `gcode` prop runs the parser and the renderer and touches the kernel nowhere,
  //  so warming it up downloads and compiles several megabytes of WASM for a code path that will not execute.
  useEffect(() => {
    if (warmup === false) return
    try { getWorker().postMessage({ cmd: 'warmup', quiet }) } catch { /* a load failure is reported properly on the first slice */ }
  }, [])   // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Slicing (derived from the right panel settings) — per plate (stage 29-2) + streaming/watchdog/OOM ladder (stage 30) ----
  const WATCHDOG_MS = 60000   // stage-30 hang watchdog: no progress/layer news for 60s -> declared dead
  const SILENT_STAGE_MS = 300000   // surface/support window (around 50% progress): the kernel is structurally silent — minutes are normal on large models. A relaxed limit to avoid false positives.
  function sliceOne(buf, paramsStr, cmd) {
    return new Promise((resolve, reject) => {
      // dev/test hooks (not set in production): __vpFail(n)=force a failure (ladder verification) · __vpStallNext=unresponsive worker (watchdog) · __vpWatchdogOnce=short watchdog (ms).
      if (typeof window !== 'undefined' && window.__vpFail && window.__vpFail(window.__vpSliceN = (window.__vpSliceN || 0) + 1)) { reject(new Error('forced failure (test hook)')); return }
      const stall = (typeof window !== 'undefined' && window.__vpStallNext) ? (window.__vpStallNext = false, true) : false
      const wdMs = (typeof window !== 'undefined' && window.__vpWatchdogOnce) ? ((v) => (window.__vpWatchdogOnce = 0, v))(window.__vpWatchdogOnce) : WATCHDOG_MS
      streamAccumRef.current = { layers: [], gcode: [] }   // reset the streaming accumulator (layers arrive one by one)
      resetRate()   // a retry in the OOM ladder is a fresh slice, and last attempt's rate is not this one's
      let t = 0
      let lastD = 0, lastT = 0
      const __ts = performance.now(); let __stage = ''   // [vp-prof] phase arrival timestamps (temporary)
      const note = (done, total) => {
        lastD = done; lastT = total
        const N = total > 2 ? (total - 2) / 2 : 0
        const st = !N ? '' : done < N ? 'PASS1…' : done === N ? 'PASS1-done' : done === N + 1 ? 'surf-done' : done === N + 2 ? 'support-done' : done === total ? 'emit-done' : 'emit…'
        if (st && st !== __stage) { log.info(`[vp-prof] ${st} +${((performance.now() - __ts) / 1000).toFixed(1)}s`); __stage = st }
      }
      // If the last progress was inside the surface/support window (d ∈ [N, N+2), N=(t−2)/2), use the relaxed limit — silence is normal there, so
      //  the 60s watchdog would kill a healthy slice (measured: 774k tri support takes 19s+, and over 60s on slow or loaded machines).
      const curWd = () => {
        const N = lastT > 2 ? (lastT - 2) / 2 : 0
        return (N && lastD >= N && lastD < N + 2) ? SILENT_STAGE_MS : wdMs
      }
      const stop = () => { if (t) { clearTimeout(t); t = 0 } }
      const kick = () => { stop(); const ms = curWd(); t = setTimeout(() => {
        pendingSliceRef.current = null
        stopSupPoll(); supSabRef.current = null   // worker gone -> drop the SAB polling/reference
        try { workerRef.current?.terminate() } catch {} ; workerRef.current = null   // force-terminate the stalled worker
        reject(new Error(`watchdog: no progress for ${ms}ms — assuming memory pressure`))
      }, ms) }
      pendingSliceRef.current = { resolve, reject, kick, stop, note, sla: cmd === 'sla' }
      kick()
      getWorker().postMessage({ ...(cmd ? { cmd } : {}), stl: buf, params: paramsStr, stall })
      if (cmd !== 'sla') startP1Poll()   // real PASS1 progress (0 -> 35%) — a no-op when SAB is unsupported (st); SLA reports linearly itself
    })
  }
  function recreateWorker() { try { workerRef.current?.terminate() } catch {} ; workerRef.current = null; getWorker() }
  // The selector worker, seen through the same interface a pool context has — so the ladder below runs on either.
  const selectorCtx = { sliceOne, recreate: recreateWorker }

  // ---- Plate-parallel slicing: a worker of its own for one plate at a time (core/slice_pool.js sizes the pool) ----
  // The selector worker's state is spread over the hook (the brush, the SAB bands, the incremental cache) because it
  //  lives as long as the component. A pool worker lives for one all-plates run and paints nothing, so everything it
  //  needs fits in this closure: its pending slice, its stream accumulator, its SAB view, its poll and its watchdog.
  //  It reports through `onProgress`/`onRate` instead of the component's state — the run collects those per plate.
  //  The STL is COPIED into it, not transferred: the ladder re-sends the same buffer on a classic/economy retry, and
  //  a transferred buffer is detached (measured: a 150MB copy is tens of ms against a 2s+ slice).
  function createPoolContext({ onProgress, onRate } = {}) {
    let wk = null, pending = null, accum = null, sab = null, poll = 0, watchdog = 0, rate = null
    let lastD = 0, lastT = 0, tSup = 0, readyResolve = null, loaded = false
    const ctx = { kernel: null, ready: new Promise(r => { readyResolve = r }) }
    const stopPoll = () => { if (poll) { clearInterval(poll); poll = 0 } }
    const stopWatchdog = () => { if (watchdog) { clearTimeout(watchdog); watchdog = 0 } }
    const settle = () => { stopPoll(); stopWatchdog(); const p = pending; pending = null; return p }
    const noteRate = (absolute) => {   // the same 250ms window the selector path uses (see noteLayers)
      const now = performance.now()
      if (!rate || absolute < rate.at) { rate = { t: now, n: 0, at: absolute }; return }
      rate.n += absolute - rate.at; rate.at = absolute
      const elapsed = now - rate.t
      if (elapsed >= RATE_WINDOW_MS) { onRate?.((rate.n * 1000) / elapsed); rate.t = now; rate.n = 0 }
    }
    const fail = (msg) => { const p = settle(); try { wk?.terminate() } catch {} ; wk = null; sab = null; p?.reject(new Error(msg)) }
    const kick = () => {
      stopWatchdog()
      const N = lastT > 2 ? (lastT - 2) / 2 : 0
      const ms = (N && lastD >= N && lastD < N + 2) ? SILENT_STAGE_MS : WATCHDOG_MS
      watchdog = setTimeout(() => fail(`watchdog: no progress for ${ms}ms — assuming memory pressure`), ms)
    }
    const spawn = () => {
      wk = makeWorker()
      wk.onmessage = (e) => {
        const d = e.data
        if (d.type === 'warm') { loaded = true; ctx.kernel = d.kernel ?? null; readyResolve?.(ctx.kernel); readyResolve = null }
        else if (d.type === 'supsab') { try { sab = { arr: new Uint32Array(d.buf, d.ptr, 1), cancel: d.cancelPtr ? new Uint32Array(d.buf, d.cancelPtr, 1) : null } } catch {} }
        else if (d.type === 'progress') {
          kick()
          if (pending?.sla) { onProgress?.(d.total ? d.done / d.total : 0); noteRate(d.done); return }
          const N = d.total > 2 ? (d.total - 2) / 2 : 0
          if (N && d.done === N + 1) tSup = Date.now()
          lastD = d.done; lastT = d.total
          onProgress?.(mapProgress(d.done, d.total))
        }
        else if (d.type === 'layer') { kick(); if (accum) { accum.layers.push({ z: d.z, paths: d.paths, widths: d.widths }); if (d.gcode) accum.gcode.push(d.gcode); noteRate(accum.layers.length) } }
        else if (d.type === 'done') { const p = settle(); p?.resolve(assembleResult(d.result, accum)) }
        else if (d.type === 'error') { const p = settle(); p?.reject(new Error(d.error)) }
      }
      // A worker that dies before it ever answered the warmup never ran the kernel — its SCRIPT did not load
      //  (measured: a dev server taken down under an open page fails every pool plate in 3s with the selector
      //  worker, already loaded, still slicing fine). Calling that "out of memory" sent the diagnosis the wrong way.
      wk.onerror = (ev) => fail(loaded
        ? 'Worker terminated (likely out of memory): ' + (ev.message || 'worker error')
        : 'Worker failed to load its script (server unreachable?): ' + (ev.message || 'worker error'))
      wk.onmessageerror = () => fail('Worker message error (structured clone failed)')
      wk.postMessage({ cmd: 'warmup', quiet })
    }
    ctx.sliceOne = (buf, paramsStr, cmd) => new Promise((resolve, reject) => {
      // dev/test hook (not set in production): __vpPoolFail = n fails the next n pool slices as a worker death,
      //  which is how the re-queue path is exercised without actually exhausting memory.
      if (typeof window !== 'undefined' && window.__vpPoolFail > 0) { window.__vpPoolFail--; reject(new Error('Worker terminated (likely out of memory): test hook')); return }
      if (!wk) spawn()
      accum = { layers: [], gcode: [] }; rate = null; lastD = 0; lastT = 0; onRate?.(0)
      pending = { resolve, reject, sla: cmd === 'sla' }
      kick()
      wk.postMessage({ ...(cmd ? { cmd } : {}), stl: buf, params: paramsStr })
      if (cmd !== 'sla') {   // the two SAB bands between progress messages, as the selector path polls them
        stopPoll()
        poll = setInterval(() => {
          if (!sab || !pending) return
          const N = lastT > 2 ? (lastT - 2) / 2 : 0
          if (!lastT) onProgress?.(pass1Band(sab))
          else if (N && lastD === N + 1) onProgress?.(supportBand(sab, N, tSup))
        }, 150)
      }
    })
    ctx.recreate = () => { try { wk?.terminate() } catch {} ; wk = null; sab = null; loaded = false; spawn() }
    ctx.cancel = () => { if (sab?.cancel) { try { Atomics.store(sab.cancel, 0, 1) } catch { sab.cancel[0] = 1 } } }
    ctx.terminate = () => { settle()?.reject(new Error('canceled')); try { wk?.terminate() } catch {} ; wk = null; sab = null; poolRef.current.delete(ctx) }
    poolRef.current.add(ctx)
    spawn()
    return ctx
  }
  const isWorkerDeath = (e) => /out of memory|failed to load|watchdog/.test(String(e?.message || e))
  // OOM retry ladder: (1) normal (streaming) -> on failure (error/abort/watchdog) (2) recreate the worker + retry with **classic walls**
  //  -> (3) recreate the worker + finish in economy mode (no toolpaths or time estimate, g-code only). If everything fails it throws -> the caller
  //  offers a downgrade (simplified) retry. Partial g-code is never handed out.
  //
  // Why (2) exists (measured): Arachne wall generation builds a Voronoi diagram, and meshes like CAD tessellations (STEP/OCCT) — whose
  //  vertices are unwelded and which contain sliver triangles — produce degenerate cells in the sliced polygons, killing the worker with
  //  "memory access out of bounds" (an assert at Voronoi.cpp:334 in upstream debug builds).
  //  The same model finishes fine with wall_generator=classic -> this rung comes before economy mode
  //  (economy only reduces infill, which does nothing for an Arachne crash).
  async function sliceLadder(buf, params, ctx = selectorCtx) {
    const isCancel = (e) => String(e?.message || e).includes('canceled')
    try { const r = await ctx.sliceOne(buf, JSON.stringify(params)); return { r, economy: !!(r.stats && r.stats.economy) } }
    catch (e1) {
      if (isCancel(e1)) throw e1   // G002: cancellation propagates without retrying
      // A pool worker's death is the POOL's problem, not this plate's: it died of the memory the other workers
      //  are holding, and retrying classic and economy under the same pressure is two more heaps for nothing.
      //  The run re-queues the plate for the selector worker once the pool has drained (plate_actions.js).
      if (ctx !== selectorCtx && isWorkerDeath(e1)) throw e1
      if (params.wall_generator !== 'classic') {
        ctx.recreate()
        try {
          const r = await ctx.sliceOne(buf, JSON.stringify({ ...params, wall_generator: 'classic', keep_stages: false, reuse_stages: 0 }))
          return { r, economy: !!(r.stats && r.stats.economy), classicWalls: true }
        } catch (e2) { if (isCancel(e2)) throw e2 }
      }
      ctx.recreate()
      // Economy retry: do not keep the stage cache (minimize the heap) and disable reuse (a new worker has no cache anyway)
      const r = await ctx.sliceOne(buf, JSON.stringify({ ...params, economy: true, keep_stages: false, reuse_stages: 0 }))   // a failure propagates as a throw
      return { r, economy: true, recovered: true }
    }
  }
  // G003 incremental: geometry digest (SHA-256, native — 37MB ≈ 0.1s). When it matches the last successful slice,
  //  the kernel stage cache is reused (reuse_stages=2) — if a parameter affects layers, the kernel's layerKey is the second line of defense.
  async function geomDigest(buf) {
    try { const d = await crypto.subtle.digest('SHA-256', buf); return Array.from(new Uint8Array(d, 0, 8)).map(b => b.toString(16).padStart(2, '0')).join('') }
    catch { return null }   // non-secure context and friends — incremental disabled (always a full slice)
  }
  function applyIncremental(params, dig) {
    if (params.economy) return   // economy mode: keeping the cache adds heap pressure — no incremental
    params.keep_stages = true
    params.reuse_stages = dig && dig === lastGeomRef.current ? 2 : 0
  }
  function buildParams(merged, { painted = true } = {}) {
    // The plate this merge cut — the per-plate override merges over the global map for it, and the wipe_tower_x/y
    //  arrays index by it. With no override `effective` IS `settings` (same reference), so the pre-feature
    //  behaviour is preserved byte for byte.
    const effective = effectiveSettings(settings, plateSettings, merged.plate)
    const params = deriveKernelParams(effective, { plate: merged.plate })
    if (merged.extruders >= 2 && merged.split > 0) {
      params.extruder_count = merged.extruders; params.mm_group_split = merged.split
      // One group per extruder run — mm_group_split alone can only express two.
      if (merged.splits?.length) { params.mm_group_splits = merged.splits; params.mm_group_tools = merged.tools }
      params.wipe_tower_real = wipeTowerReal
    }
    // Material painting assigns tools per facet, so `merged` — which reads whole-object assignment only — cannot
    //  see it. The kernel gates its multi-tool path on `extruder_count >= 2 && (groups || painted tools)`, so a
    //  painted-but-unassigned model short-circuits on the FIRST term and the paint is silently ignored: measured
    //  as a painted and an unpainted export coming out byte-identical. Selector state s addresses extruder s
    //  (ENFORCER==Extruder1), so the highest painted state is the extruder count the kernel has to allow for.
    // The paint counts describe the SELECTOR worker's mesh. A pool worker slices a plate the brush never touched,
    //  so for it they are someone else's facets — reading them would widen its extruder count for nothing.
    const paintedStates = !painted ? [] : Object.entries(paintStateCountsRef?.current ?? {})
      .filter(([, facetCount]) => facetCount > 0).map(([state]) => Number(state))
    const highestPaintedState = paintedStates.length ? Math.max(...paintedStates) : 0
    if (highestPaintedState >= 2) {                 // state 1 alone is the default tool — nothing to switch to
      params.extruder_count = Math.max(params.extruder_count ?? 1, highestPaintedState)
      params.wipe_tower_real = wipeTowerReal
    }
    // Filament identity and physical constants, straight from the settings map the filament card writes. Upstream
    //  reports all of these in the G-code footer; without them an export says how much filament it used but not
    //  what the filament was. Also switches on the two footer blocks — the kernel leaves them off so its own
    //  default output stays byte-identical, and the app is the thing that wants to behave like upstream.
    const perFilament = (key) => {
      const raw = settingRaw(effective, key)
      const list = Array.isArray(raw) ? raw : (raw == null || raw === '' ? [] : [raw])
      return list.length ? list : undefined
    }
    const asNumbers = (list) => list && list.map(v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0 })
    const filamentType = perFilament('filament_type')
    const filamentId   = perFilament('filament_settings_id')
    const density      = asNumbers(perFilament('filament_density'))
    const cost         = asNumbers(perFilament('filament_cost'))
    if (filamentType) params.filament_type = filamentType
    if (filamentId)   params.filament_settings_id = filamentId
    if (density)      params.filament_density = density
    if (cost)         params.filament_cost = cost
    params.gcode_stats_block = true
    params.gcode_config_block = true

    // Prime tower next to the model. The kernel's default corner (10,10) is wherever the bed is, not wherever the
    //  model is — measured 90mm of travel per tool change with a centred model. Only when nothing chose a position:
    //  deriveKernelParams already wrote prime_tower_x/y if the card or a drag set wipe_tower_x/y, and this used to
    //  overwrite that on every slice, so a tower dragged in Prepare sliced somewhere else.
    if ((params.extruder_count ?? 1) >= 2 && Number.isFinite(merged.minX) && params.prime_tower_x == null) {
      const towerSide = (params.wipe_tower_real ?? true) ? (params.prime_tower_width ?? 30) : 15
      const gap = 5
      const bedW = params.bed_width ?? DEFAULT_BED.width, bedD = params.bed_depth ?? DEFAULT_BED.depth
      // Slice frame -> bed frame is one addition (the kernel's own gw.offX), and both boxes are now in it.
      const modelLeft = merged.minX + bedW / 2, modelMidY = (merged.minY + merged.maxY) / 2 + bedD / 2
      params.prime_tower_x = Math.min(Math.max(modelLeft - gap - towerSide, 1), bedW - towerSide - 1)
      params.prime_tower_y = Math.min(Math.max(modelMidY - towerSide / 2, 1), bedD - towerSide - 1)
    }
    // Two ways a painted model slices exactly like an unpainted one, both of them by design and neither of them
    //  visible in the result — the export just comes out single-material. Said here, at the one place that knows
    //  both the paint and the settings, because the alternative is the user concluding the brush is broken.
    //  · support on: slicer_core.cpp keeps painted models on the single-material path (slice_multimaterial emits
    //    no support, and one selector state cannot say "blocker" and "Extruder2" apart).
    //  · only T1 painted: state 1 IS the default extruder, so there is no second tool to switch to.
    if (paintedStates.length) {
      // Support and material painting now slice together — the multi-material path runs the same support pass the
      //  single-material one does. What survives is the AMBIGUITY: one selector, and upstream's enum makes a support
      //  BLOCKER and Extruder2 the same mark, so a model carrying both reads the blocker as a material.
      if (params.enable_support && paintedStates.includes(2))
        setSliceNotice?.('Support is on and T2 is painted. One facet carries one mark, and a support blocker is ' +
                         'the same mark as T2 — the painted areas were sliced as T2, not as blocked support.')
      else if (highestPaintedState < 2)
        setSliceNotice?.('Only T1 was painted. T1 is the default extruder every unpainted facet already uses, ' +
                         'so the slice is unchanged — paint T2 or higher to get a second material.')
    }
    if (downgradeRef.current) { params.sparse_infill_pattern = 'rectilinear'; params.infill_density = Math.min(params.infill_density ?? 0.15, 0.08); params.economy = true }  // downgrade retry
    if (typeof window !== 'undefined' && window.__vpForceTree) { params.enable_support = true; params.support_style = 'tree'; params.support_threshold_angle = 40 }  // stage-31 test hook: force tree support (not set in production)
    if (painted && typeof window !== 'undefined') window.__vpParams = params   // dev/test aid: the parameters actually handed to the kernel (the selector worker's — a pool run would race it)
    return params
  }
  // One merged STL through the whole ladder: parameters + incremental digest + the last-successful-geometry bookkeeping.
  //  Finishing via economy/classic used different parameters, so the cache cannot be reused (lastGeom is cleared).
  // `ctx` is a pool context for a plate sliced beside the selected one; null is the selector worker itself.
  async function runSlice(merged, ctx = null) {
    // SLA routing: the technology key sends the merge to the pure-JS contour slicer instead of the kernel. No
    //  retry ladder and no incremental cache — there is no Arachne to crash and no stage cache to reuse — and the
    //  derived params ride on the result so the SL1 writer rasterizes with the values this slice actually used.
    //  PER-PLATE technology: each merge routes by its own plate's effective map, so an SLA-override plate goes
    //  to slice_sla while its FFF neighbours take the kernel — the mixed-technology stage's core switch.
    if (plateTechnology(settings, plateSettings, merged.plate) === 'SLA') {
      const slaParams = deriveSlaParams(effectiveSettings(settings, plateSettings, merged.plate))
      if (!ctx && typeof window !== 'undefined') window.__vpParams = slaParams   // dev/test aid, same as the FFF path
      const r = await (ctx ?? selectorCtx).sliceOne(merged.buf, JSON.stringify(slaParams), 'sla')
      // merged.buf survives (the post copies, it does not transfer) — the preview renders this exact geometry
      //  as a solid mesh, lifted by the elevation, beside the kernel's support/pad meshes.
      return { r: { ...r, gcode: '', slaParams, modelSTL: merged.buf }, params: slaParams }
    }
    const params = buildParams(merged, { painted: !ctx })
    if (ctx) {
      // A pool worker is thrown away after the run, so a stage cache in it is heap for nothing — and the digest
      //  bookkeeping belongs to the selector worker, which is the only one that ever slices the same plate twice.
      params.keep_stages = false; params.reuse_stages = 0
      const out = await sliceLadder(merged.buf, params, ctx)
      return { ...out, params }
    }
    treeSupportRef.current = params.support_style === 'tree'
    const dig = await geomDigest(merged.buf); applyIncremental(params, dig)
    try {
      const out = await sliceLadder(merged.buf, params)   // on a normal failure: classic walls -> economy retry
      lastGeomRef.current = (out.economy || out.classicWalls) ? null : dig
      return { ...out, params }
    } catch (e) { lastGeomRef.current = null; throw e }
  }

  return { getWorker, cancelSlice, runSlice, pendingSliceRef, downgradeRef, createPoolContext, kernelKindRef, progressSinkRef }
}
