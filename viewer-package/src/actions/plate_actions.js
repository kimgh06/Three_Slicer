import { log } from '../core/log.js'
import { deriveKernelParams, deriveSlaParams, settingRaw } from 'three-slicer-viewer/settings'
import { roleRatios } from 'three-slicer-viewer'
import { MAX_PLATES } from '../core/plate_layout.js'
import { effectiveSettings, truncatePlateSettings } from '../core/plate_settings.js'
import { slaPreviewPayload } from '../core/sla_preview.js'
import { resolveWorkerCount, makePlateRun, patchPlate, runSummary, PLATE_STATES } from '../core/slice_pool.js'
import { makeSL1 } from '../core/sl1_write.js'
import { parseSl1, sl1DisplayAffine, sl1SettingsFrom } from '../core/sl1_read.js'
import { makeSlaReconstructWorker, makeSlaSliceWorker, makeSl1EncodeWorker } from '../make_worker.js'
import { makeSl1GpuRaster } from '../core/sl1_raster_gpu.js'
import { makeSl1ParityGpu } from '../core/sl1_parity_gpu.js'
import { acquireGpuDevice } from '../scene/gpu_device.js'
import { statsFromKernel } from '../core/kernel_stats.js'
import { download, saveWindowOpen } from './export_actions.js'

// SL1 reconstruction tuning. Every number here is measured on the same 1095-layer archive (15-core machine,
// click to mesh on screen), and the ones that did NOT work are recorded with them so they are not retried:
//   producers   4: 2663ms | 6: 2421ms | 8: 2714ms   -- 8 loses; createImageBitmap runs on ONE shared browser
//                                                      decode pool, so extra producers only add contention
//   readback batch  6: 2106ms | 12: 2689ms          -- bigger batches make drawImage worse, not better
//   ghost planes   64: 2106ms | 32: 2185ms | 0: 2484ms (measured before the other fixes) -- not the lever
// What did work, in order of size: pipelining the fan-out (5.5s -> 2.5s), per-row occupancy ranges in the nets
// sweep, halving the smoothing rounds (finish 609 -> 343ms), spawning the workers at import start so their
// module load overlaps the unzip, and skipping the role pass for batches with no support/pad segments.
// Together: 5.5s -> ~2.0s. The remaining cost is per-layer pixel work (decode/draw/readback), so the next real
// gain is fewer pixels per layer, not more workers.
const SL1_TUNE = (key, dflt) => {
  const q = typeof location !== 'undefined' && Number(new URLSearchParams(location.search).get(key))
  return Number.isFinite(q) && q > 0 ? q : dflt
}
const SL1_SLICE_WORKERS = SL1_TUNE('sl1Workers', 6)

// Per-plate slicing/caching/export (stage 29-2) + the plate tabs (add/delete/select).
// The component keeps owning the refs/state; this factory only receives what it uses and is rebuilt each
//  render so the values it closes over (settings, canvasMode, downgradeOffer) stay fresh.
export function makePlateActions(deps) {
  const {
    apiRef, selectedPlateRef, plateCountRef, placeXRef, plateResultsRef, plateOffsetsRef, plateTpRef,
    layersDataRef, toolpathRef, segDataRef, layerLoRef, layerHiRef, lineWidthRef, downgradeRef,
    settings, plateSettings, setPlateSettings, canvasMode, downgradeOffer, onExport,
    runSlice, createPoolContext, kernelKindRef, progressSinkRef, setPlateRun, setSliceRate,
    ensurePlateToolpaths, buildPlateToolpath, applyViewColors, disposePlateToolpath,
    setStats, setOverBed, setLayerCount, setSegCount, setColorRange, setRoleLegend, setGcodeUrl, setExporting, setSl1Ready,
    setLayerLo, setLayerHi, setCanvasMode, setSlicedPlateCount, setSliceMenu, setError, setSliceNotice,
    setDowngradeOffer, setSlicing, setProgress, setPlateCount, setSelectedPlate, setSettings, syncPaintSelector,
    onSlicedRef,
  } = deps

  // Hands a finished slice to the host (the Viewport `onSliced` prop). Fired where the result is cached, not where
  //  it is displayed, so switching plate tabs — which re-displays a cached result — does not re-announce it.
  //  `throughput` rides along beside `stats` rather than inside it, because that is where the engine puts it: it is
  //  measured around the call (wall ms, layers/second, ms per million segments), not reported by the kernel.
  const announceSlice = (plate, r) => { if (r && !r.error) onSlicedRef?.current?.({ plate, stats: r.stats, gcode: r.gcode, throughput: r.throughput }) }

  // Shows a cached result in Preview — every cached plate's toolpath renders at its own offset simultaneously,
  //  and idx becomes the focus (target of the slider/stats/G-code). Focusing a plate with no cache = empty state (leftovers cleared).
  function showPlateResult(idx) {
    ensurePlateToolpaths()                                   // all plates viewable at once
    const prev = toolpathRef.current
    if (prev) prev.setLayerRange(0, 1e9)                     // the previous focus goes back to its full range
    const r = plateResultsRef.current[idx]
    if (!r || r.error || !r.layers || !r.layers.length) {    // plate without a result: clear the focus UI
      layersDataRef.current = null; toolpathRef.current = null; segDataRef.current = null
      setStats(null); setOverBed(false); setLayerCount(0); setSegCount(0); setColorRange(null); setRoleLegend([])
      setGcodeUrl(prevUrl => { if (prevUrl) URL.revokeObjectURL(prevUrl); return '' })
      apiRef.current?.setSlaPreview?.(null)
      apiRef.current?.setSlaRaster?.(null)
      return
    }
    layersDataRef.current = r.layers
    const n = r.layers.length
    layerLoRef.current = 0; layerHiRef.current = n - 1; setLayerLo(0); setLayerHi(n - 1)
    // A resin result previews as SOLID meshes (the model lifted by its elevation + the kernel's support/pad
    //  meshes) — upstream's architecture; the layer stream stays raster-only. An FFF focus tears that down.
    const isSla = !!r.stats?.sla
    // The focused resin plate moves from its static preview (ensurePlateToolpaths gave every resin plate one)
    //  to the clipped slot the layer slider cuts; a raster import without meshes yet shows the ghost stack instead.
    if (isSla) apiRef.current?.setSlaStatic?.(idx, null)
    apiRef.current?.setSlaPreview?.(isSla ? slaPreviewPayload(r, plateOffsetsRef.current[idx]) : null)
    // Before reconstruction an imported SL1 has no meshes — the raster plane stack stands in for it.
    const rasterOnly = !!r.slaRaster && !r.modelIndexed && !r.modelSTL
    apiRef.current?.setSlaRaster?.(rasterOnly ? slaRasterPayload(r, idx) : null)
    if (rasterOnly) apiRef.current?.setSlaRasterLayer?.(n - 1)
    const cached = plateTpRef.current[idx]
    const entry = isSla ? null : ((cached && cached.layers === r.layers) ? cached : buildPlateToolpath(idx, r.layers))
    if (entry) {
      toolpathRef.current = entry.ctl; segDataRef.current = entry.seg
      entry.ctl.setLayerRange(0, n - 1)
      applyViewColors()
      setSegCount(entry.seg.nSeg); setRoleLegend(roleRatios(entry.seg.typeLengths))
    } else if (isSla) {
      toolpathRef.current = null; segDataRef.current = null
      setSegCount(r.stats.path_segments || 0); setRoleLegend([])
    }
    apiRef.current?.onSliced()
    setCanvasMode('preview')
    setStats(statsFromKernel(r.stats, r.throughput))
    setOverBed(!!r.stats.over_bed); setLayerCount(n)
    // A resin result has no G-code; its export (.sl1) is built on click by exportPlateSl1 — see SliceBar.
    setGcodeUrl(prevUrl => { if (prevUrl) URL.revokeObjectURL(prevUrl)
      return r.stats.sla ? '' : URL.createObjectURL(new Blob([r.gcode], { type: 'text/plain' })) })
  }
  // Build and save the focused plate's SL1 archive. Built on demand — rasterizing hundreds of layer PNGs is
  //  seconds of work, and paying it on every plate focus for a file that may never be saved is the same waste
  //  the kernel warmup opt-out refuses. The `exporting` label is what keeps the button honest while it runs.
  // What the scene needs to draw an imported archive's masks: sizes and the archive->display affine from the
  //  params captured at import time, decode on demand (a whole archive as RGBA is gigabytes).
  //  ponytail: no decode cache — every slider step re-decodes one PNG (tens of ms); add a small LRU if scrubbing stutters.
  function slaRasterPayload(r, idx) {
    const off = plateOffsetsRef.current[idx]
      ?? (() => { const o = apiRef.current?.platePos?.(idx); return o ? { offX: o.x, offZ: o.z } : { offX: 0, offZ: 0 } })()
    return {
      width: r.slaRaster.params.display_width, height: r.slaRaster.params.display_height,
      affine: sl1DisplayAffine(r.slaRaster.params),
      zOf: (i) => r.layers[i]?.z ?? 0,
      layerCount: r.layers.length,
      getImage: (i) => createImageBitmap(new Blob([r.slaRaster.pngs[i]], { type: 'image/png' })),
      offX: off.offX, offZ: off.offZ,
    }
  }

  // Import an .sl1 archive onto the SELECTED plate as a raster preview — the counterpart of the `gcode` prop's
  //  injection, not of model loading: the masks' mesh is gone, so nothing lands in Prepare. The archive's own
  //  bytes are kept so a re-export hands back the file untouched. Physical size comes from the CURRENT printer's
  //  display params — an SL1's config.ini records pixels and seconds, never millimetres.
  // The reconstruction fleet. Spawned as early as possible — module load is ~200ms that otherwise lands
  //  inside the pipeline; started here it overlaps the file read and unzip.
  function spawnSl1Workers() {
    const n = Math.max(1, Math.min(SL1_SLICE_WORKERS, (navigator.hardwareConcurrency || 4) - 1))
    return { nets: makeSlaReconstructWorker(), producers: Array.from({ length: n }, () => makeSlaSliceWorker()) }
  }

  async function importSl1(file) {
    const spawned = spawnSl1Workers()
    try {
      const __t0 = performance.now()   // [vp-prof] sl1 import timing
      const bytes = new Uint8Array(await file.arrayBuffer())
      const __tRead = performance.now()
      const { config, layers, layerHeight, rolePaths, scene } = parseSl1(bytes)
      log.info(`[vp-prof] sl1 import ${file.name}: read ${(__tRead - __t0).toFixed(0)}ms, unzip+parse ${(performance.now() - __tRead).toFixed(0)}ms`)
      const idx = selectedPlateRef.current
      const empty = new Float32Array(0)
      // What the archive itself states, applied to the session — `printer_technology` above all: opening an
      //  .sl1 in a fresh (FFF) session otherwise left the plate at the filament bed with the resin masks
      //  stranded on it, and the sidebar offering filaments and a prime tower for a resin print.
      const applied = sl1SettingsFrom(config, layers[0]?.png, settingRaw(settings, 'display_orientation'))
      const merged = { ...settings, ...applied }
      setSettings(s => ({ ...s, ...applied }))
      plateResultsRef.current[idx] = {
        // Synthetic layer list so the slider and labels see real heights; paths stay empty — raster masks
        //  cannot be turned back into the segment stream without vectorizing them.
        layers: layers.map((_, i) => ({ z: (i + 1) * layerHeight, paths: empty })),
        gcode: '',
        // MERGED, not `settings`: setSettings has not landed yet, and the payload's mm/orientation have to be
        //  the ones just applied — the same trap the 3mf project import documents for its bed.
        slaRaster: { pngs: layers.map(l => l.png), bytes, rolePaths, params: deriveSlaParams(merged), name: file.name },
        // An archive of ours carries the meshes the preview was showing: take them verbatim — that IS the
        //  original surface, so there is nothing to reconstruct and nothing to approximate.
        ...(scene ? { modelSTL: scene.modelSTL, support_mesh: scene.supportMesh, pad_mesh: scene.padMesh } : {}),
        stats: {
          sla: true, sla_raster: true, layers: layers.length, layer_height: layerHeight,
          time_estimate: Number(config.printTime) || 0, resin_ml: Number(config.usedMaterial) || 0,
          path_segments: 0, over_bed: false,
          lift_layers: scene ? scene.lift / layerHeight : 0,
        },
      }
      refreshSlicedCount()
      showPlateResult(idx)
      setCanvasMode('preview')
      // Naming the print area matters: it is the one number on screen the archive did NOT supply (an SL1
      //  records pixels and seconds, never millimetres), so it comes from the printer set here.
      const area = deriveSlaParams(merged)
      setSliceNotice(`Imported ${file.name}: ${layers.length} layers @ ${layerHeight}mm — reconstructing the shape`
        + ` on this printer's ${area.display_width}×${area.display_height}mm display…`)
      if (scene) {
        // Nothing to reconstruct — the fleet spawned for it is not needed.
        spawned.nets.terminate(); for (const w of spawned.producers) w.terminate()
        setSliceNotice(`Imported ${file.name}: ${layers.length} layers @ ${layerHeight}mm`
          + ' — the original scene came with the archive, so this is the exported surface itself, not a reconstruction')
      } else {
        reconstructSl1Mesh(idx, spawned).catch(e => log.warn('[sl1] reconstruction failed, keeping the raster preview:', e?.message || e))
      }
    } catch (e) {
      spawned.nets.terminate(); for (const w of spawned.producers) w.terminate()
      setError(`Failed to import ${file.name}: ${e?.message || e}`)
    }
  }

  // Turn the imported masks back into a SURFACE: every mask streamed through surface nets in a worker
  //  (sla_reconstruct.worker.js). The streaming core keeps memory O(nx*ny), so z runs at the archive's OWN
  //  layer height and xy at 768 columns (~0.16mm) — as close to "the original" as a mesh the GPU can still
  //  hold allows; the full 0.047mm pixel grid would be a 4GB volume and a ~20M-face mesh, which no tab
  //  survives. The result rides the normal solid SLA preview (setSlaPreview + the slider's section cut) as
  //  r.modelIndexed, replacing the ghost stack — cross-sections alone read as smoke, not as the object. What
  //  a mask CANNOT give back stays absent: which pixels were model vs support vs pad (one colour).
  // One reconstruction pass at a given resolution. `NX` is the xy sample width; `KZ` takes every KZth layer.
  //  Returns the indexed mesh, or null if the plate was replaced while it ran.
  async function runSl1Pass(idx, spawned, { NX, KZ: kzWanted, smoothRounds, normalRounds = 0 }) {
    const r = plateResultsRef.current[idx]
    if (!r?.slaRaster) return null
    const p = r.slaRaster.params
    const affine = sl1DisplayAffine(p)
    const scale = NX / affine.width
    const NY = Math.max(2, Math.round(affine.height * scale))
    const n = r.slaRaster.pngs.length
    const KZ = Math.max(1, kzWanted)
    const NZ = Math.ceil(n / KZ)
    const lh = r.stats.layer_height || 0.05
    // COPIES, because transferring would detach the archive bytes the byte-identical re-export depends on.
    const __tCopy = performance.now()   // [vp-prof] reconstruction timing
    const pngs = []
    for (let j = 0; j < NZ; j++) pngs.push(r.slaRaster.pngs[Math.min(n - 1, j * KZ)].slice().buffer)
    // The role sidecar (support/pad segments), sampled the same way — our own exports carry it, foreign
    //  archives reconstruct without colours.
    const rolePaths = r.slaRaster.rolePaths
      ? Array.from({ length: NZ }, (_, j) => r.slaRaster.rolePaths[Math.min(n - 1, j * KZ)].slice())
      : null
    const __tWorker = performance.now()
    // N slice producers -> one nets consumer. The producers take STRIDED layers so they stay in step and the
    //  reorder buffer here holds a handful of slices rather than a third of the archive; this thread only
    //  forwards (transfers, ~150KB each) and never touches the pixels.
    // Workers are spawned by importSl1 the moment it knows the file is an SL1, so their module load overlaps
    //  the unzip instead of adding to the pipeline (measured 234ms of spin-up when created here).
    const { nets, producers } = spawned
    const nWorkers = producers.length
    const mesh = await new Promise((resolve, reject) => {
      const fail = (e) => reject(e instanceof Error ? e : new Error(e?.message || 'reconstruction failed'))
      nets.onmessage = (event) => {
        if (event.data.error) fail(new Error(event.data.error))
        else if (event.data.positions) resolve(event.data)
      }
      nets.onerror = fail
      nets.postMessage({
        init: true, nx: NX, ny: NY,
        sx: p.display_width / NX, sy: p.display_height / NY, sz: KZ * lh,
        ox: -p.display_width / 2, oy: -p.display_height / 2, oz: 0,
      })
      const pending = new Map()
      let next = 0, live = producers.length
      let firstSliceAt = 0, lastSliceAt = 0
      const producerTimings = []
      const drain = () => {
        while (pending.has(next)) {
          const s = pending.get(next); pending.delete(next); next++
          const transfer = [s.slice.buffer, s.ranges.buffer]
          if (s.roles) transfer.push(s.roles.buffer)
          nets.postMessage({ slice: s.slice, ranges: s.ranges, roles: s.roles }, transfer)
        }
        if (next === NZ && live === 0) nets.postMessage({ finish: true, producerTimings, spin: { firstSliceAt, lastSliceAt }, smoothRounds, normalRounds })
      }
      producers.forEach((w, i) => {
        w.onerror = fail
        w.onmessage = (event) => {
          const d = event.data
          if (d.error) return fail(new Error(d.error))
          if (d.done) { producerTimings.push(d.timings); live--; drain(); return }
          if (!firstSliceAt) firstSliceAt = performance.now()
          lastSliceAt = performance.now()
          pending.set(d.index, d); drain()
        }
        const mine = []
        for (let j = i; j < NZ; j += nWorkers) mine.push(j)
        const myPngs = mine.map(j => pngs[j])
        const myRoles = rolePaths ? mine.map(j => rolePaths[j]) : null
        w.postMessage({
          indices: Int32Array.from(mine), pngs: myPngs, rolePaths: myRoles, batch: SL1_TUNE('sl1Batch', 6),
          nx: NX, ny: NY, matrix: affine.matrix, scale,
          width: p.display_width, height: p.display_height,
        }, myRoles ? [...myPngs, ...myRoles.map(a => a.buffer)] : myPngs)
      })
    })
    if (!mesh.indices.length || plateResultsRef.current[idx] !== r) return null
    const w = mesh.timings ?? {}
    const pt = mesh.producerTimings ?? []
    const sum = (k) => pt.reduce((a, x) => a + (x?.[k] ?? 0), 0)
    const worst = pt.map(x => (x?.decode ?? 0) + (x?.draw ?? 0) + (x?.read ?? 0) + (x?.roles ?? 0)).sort((a, b) => b - a)[0] ?? 0
    log.info(`[vp-prof] sl1 pass ${NX}px/z${KZ}: copy ${(__tWorker - __tCopy).toFixed(0)}ms, pipeline ${(performance.now() - __tWorker).toFixed(0)}ms`
      + ` over ${nWorkers} slice workers (slowest producer ${worst.toFixed(0)}ms; summed decode ${sum('decode').toFixed(0)},`
      + ` draw ${sum('draw').toFixed(0)}, read ${sum('read').toFixed(0)}, fill ${sum('fill').toFixed(0)}, roles ${sum('roles').toFixed(0)})`
      + ` (nets ${(w.nets ?? 0).toFixed(0)}, finish ${(w.finish ?? 0).toFixed(0)})`
      + (mesh.spin ? ` [spin-up ${(mesh.spin.firstSliceAt - __tWorker).toFixed(0)}ms]` : ''))
    return { mesh, NX, KZ, lh, n, mm: p.display_width / NX }
  }

  // Two passes, coarse then fine. A full-resolution pass is seconds of pixel work and there is no way around
  //  that — the producers already run at ~97% duty — but a quarter-resolution pass is ~16x less of it and lands
  //  a real, shaded, correctly-coloured mesh in well under a second. So the coarse mesh replaces the ghost
  //  stack first and the fine one replaces IT a few seconds later; the object is on screen either way, and only
  //  the surface detail arrives late.
  //  That split is also why the fine pass can afford to be SLOW and smooth. Measured (1095-layer archive,
  //  coarse always ~0.66s):
  //    768px / 2 rounds  2.8s, 4.57M faces, 0.16mm — visible layer ridges on curved walls
  //    1024px / 5 rounds 4.0s, 6.54M faces, 0.12mm — ridges gone
  //  The ridges come from xy voxels being ~2.4x coarser than the layer height, so each layer's contour
  //  quantizes differently. Three knobs attack it, cheapest first: `?sl1NormalSmooth=` relaxes the NORMALS
  //  (shading only, geometry untouched, and most of the visible ripple is shading), `?sl1Smooth=` adds Taubin
  //  rounds, `?sl1Nx=` lowers the quantization at the source and costs faces and seconds quadratically.
  async function reconstructSl1Mesh(idx, spawned = null) {
    const fleet = spawned ?? spawnSl1Workers()
    const r = plateResultsRef.current[idx]
    if (!r?.slaRaster) return
    const n = r.slaRaster.pngs.length
    const apply = (pass, coarse) => {
      if (!pass || plateResultsRef.current[idx] !== r) return
      const { mesh, KZ, lh, mm } = pass
      r.modelIndexed = { positions: mesh.positions, indices: mesh.indices, normals: mesh.normals, colors: mesh.colors ?? null }
      const __tShow = performance.now()
      if (selectedPlateRef.current === idx) showPlateResult(idx)
      const __tGeom = performance.now()
      requestAnimationFrame(() => log.info(`[vp-prof] sl1 render${coarse ? ' (coarse)' : ''}:`
        + ` geometry+upload ${(__tGeom - __tShow).toFixed(0)}ms, first frame ${(performance.now() - __tShow).toFixed(0)}ms`))
      setSliceNotice(`Imported ${r.slaRaster.name}: ${n} layers @ ${lh}mm — shape reconstructed from the masks`
        + ` (${(mesh.indices.length / 3).toFixed(0)} faces at ~${mm.toFixed(2)}mm xy / ${(KZ * lh).toFixed(2)}mm z`
        + (coarse ? '; refining…)' : '')
        + (coarse ? '' : (mesh.colors ? '; support/pad coloured from the archive’s role sidecar)' : '; one colour — this archive carries no role sidecar)')))
    }
    try {
      apply(await runSl1Pass(idx, fleet, { NX: SL1_TUNE('sl1CoarseNx', 384), KZ: Math.max(1, Math.ceil(n / SL1_TUNE('sl1CoarseZ', 260))), smoothRounds: 1, normalRounds: 2 }), true)
      apply(await runSl1Pass(idx, fleet, { NX: SL1_TUNE('sl1Nx', 1024), KZ: 1, smoothRounds: SL1_TUNE('sl1Smooth', 4), normalRounds: SL1_TUNE('sl1NormalSmooth', 3) }), false)
    } finally {
      fleet.nets.terminate(); for (const w of fleet.producers) w.terminate()
    }
  }

  async function exportPlateSl1(idx = selectedPlateRef.current) {
    const r = plateResultsRef.current[idx]
    const name = r?.slaRaster?.name || `plate_${idx + 1}.sl1`
    // An imported archive re-exports as itself — its layers hold no geometry to rasterize.
    if (r?.slaRaster?.bytes) { await download(r.slaRaster.bytes, name, 'application/zip', onExport); return }
    if (!r || r.error || !r.stats?.sla || !r.layers?.length) { setError('No resin slice on this plate — slice first'); return }
    // A click that already carries finished bytes IS the save — see the hand-off below.
    if (r.sl1Pending) { const pending = r.sl1Pending; r.sl1Pending = null; setSl1Ready?.(null); await download(pending, name, 'application/zip', onExport); return }
    setExporting?.('Building SL1…')
    try {
      // Anti-aliasing is opt-in via the host's settings map (sla_antialias: 1|2|4 — a viewer knob,
      //  not a schema key). At aa>1 the GPU MSAA rasterizer takes the masks when a device exists
      //  (measured 11.8x at 1440x2560, 13.8x on a 12K display vs CPU supersampling); the CPU
      //  supersample path is the always-available reference (test_sl1_gpu.mjs pins the parity).
      const aa = Math.max(1, settings?.sla_antialias | 0 || 1)
      const gpuDevice = aa > 1 ? await acquireGpuDevice() : null
      // Two GPU raster backends, tried in fidelity order. PARITY slices the mesh itself (stencil
      //  even-odd per layer plane — immune to whatever contour stitching drops; measured 0.007%
      //  avg pixel diff vs the contour reference on a 775k-facet scan), and needs the merged STL
      //  the SLA slice kept for the scene sidecar. The contour MSAA raster is the fallback for a
      //  result without modelSTL (an imported archive re-export never reaches here).
      let gpuRaster = null
      if (gpuDevice && r.modelSTL) {
        const parity = makeSl1ParityGpu(gpuDevice)
        if (parity.prepare(new Uint8Array(r.modelSTL))) {
          const lh = r.stats.layer_height || 0.05
          gpuRaster = (paths, t, aa2, layer) => parity.rasterize(layer.z - lh / 2, t, aa2)
        }
      }
      if (gpuDevice && !gpuRaster) gpuRaster = makeSl1GpuRaster(gpuDevice).rasterize
      const bytes = await makeSL1({
        layers: r.layers, params: r.slaParams ?? {}, stats: r.stats,
        jobName: `plate_${idx + 1}`, timestamp: new Date().toISOString(),
        aa, gpuRaster,
        // The worker pool rasterizes on the CPU; at aa>1 with a GPU the sequential gpuRaster path
        //  is faster than 8 CPU workers supersampling, so the pool stands down.
        makeWorker: gpuRaster ? null : makeSl1EncodeWorker,
        workerCount: SL1_TUNE('sl1Encode', Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 6) - 2))),
        // The scene sidecar: what the preview is showing right now, so a reimport gets the ORIGINAL surface
        //  back instead of a voxel reconstruction of it.
        scene: r.modelSTL ? {
          modelSTL: r.modelSTL, supportMesh: r.support_mesh, padMesh: r.pad_mesh,
          lift: (r.stats.lift_layers ?? r.stats.elevation_layers ?? 0) * (r.stats.layer_height || 0.05),
        } : null,
        onProgress: (done, total) => setExporting?.(`Building SL1… ${Math.round(done / total * 100)}%`),
      })
      // Rasterizing a thousand masks takes ~12s and a browser's user activation lapses after ~5, so a download
      //  fired now would be the AUTOMATIC kind Chrome blocks without saying so. When the window has closed the
      //  finished bytes wait for one more click instead of being thrown at a blocked download.
      if (onExport || saveWindowOpen()) { await download(bytes, name, 'application/zip', onExport); return }
      r.sl1Pending = bytes
      setSl1Ready?.(name)
      setSliceNotice(`${name} is ready (${(bytes.length / 1048576).toFixed(0)} MB) — click Save SL1 to keep it`)
    } catch (e) {
      setError('SL1 export failed: ' + (e?.message || e))
    } finally {
      setExporting?.(null)
    }
  }
  // Shares the host's export hook with the 3mf/STL writers — a host that takes one save should take all of them.
  function downloadGcode(gcode, name) { download(gcode, name, 'text/plain', onExport) }
  const _sleep = (ms) => new Promise(r => setTimeout(r, ms))
  // plateResultsRef is a ref, so the UI does not refresh on its own — mirror the count into state wherever it changes.
  function refreshSlicedCount() {
    setSlicedPlateCount(Object.values(plateResultsRef.current).filter(r => r && !r.error && (r.gcode || r.stats?.sla)).length)
  }
  // Saves the G-code of every sliced plate at once — only when the user explicitly asks (never automatically).
  //  Browsers throttle back-to-back downloads, so the files are spaced out.
  async function exportAllGcode() {
    setSliceMenu(false)
    const sliced = Object.entries(plateResultsRef.current)
      .filter(([, r]) => r && !r.error && (r.gcode || r.stats?.sla))
      .sort((a, b) => Number(a[0]) - Number(b[0]))
    // Same rule the single-plate export follows, applied per plate: a plate whose model leaves the printable
    //  volume is skipped rather than silently written, and the notice names it so it is not just missing.
    const done = sliced.filter(([, r]) => !r.stats?.over_bed)
    const skipped = sliced.length - done.length
    if (!done.length) {
      setError(skipped ? 'Every sliced plate extends beyond the bed — nothing exported' : 'No slice results to export — slice first')
      return
    }
    for (const [i, r] of done) {
      if (r.stats?.sla) await exportPlateSl1(Number(i))
      else downloadGcode(r.gcode, `plate_${Number(i) + 1}.gcode`)
      await _sleep(350)
    }
    setSliceNotice(`Exported ${done.length} plate(s)`
      + (skipped ? ` — skipped ${skipped} that extend beyond the bed` : ''))
  }
  async function onSlice(scope = 'current') {
    setSliceMenu(false); setError(''); setSliceNotice(''); setDowngradeOffer(null)
    const idx0 = selectedPlateRef.current
    // Per plate, not once for the run: a plate override can change line_width, and the toolpath mesh built when
    //  that plate's result lands reads whatever this ref holds at the time.
    const plateLineWidth = (i) => { lineWidthRef.current = deriveKernelParams(effectiveSettings(settings, plateSettings, i)).line_width }
    plateLineWidth(idx0)
    setPlateRun(null)   // a fresh slice of either scope drops the last run's tab marks
    if (scope === 'all') {
      // Plate-parallel (core/slice_pool.js): every plate with objects goes into one queue that K workers drain.
      //  The selector worker is one of the K — it takes the selected plate FIRST, because that is the mesh the
      //  brush painted and the pool workers hold no selector — and the other K-1 are spawned for this run and
      //  terminated after it (their wasm heaps do not shrink; measured 8.8GB for five on a 3M-facet model).
      //  Selection does not move during the run any more: the pool has no single "current" plate to follow.
      // The queue holds plate INDICES; each worker builds the merge when it takes the plate and drops it after.
      //  Building all of them up front held N x 143MB of STL for the whole run in the one renderer process the
      //  workers' heaps also live in — on a five-plate scene that is 715MB before a single worker has started.
      const plates = []; const sizes = []
      for (let i = 0; i < plateCountRef.current; i++) {
        const m = apiRef.current?.buildMergedSTL(i); if (!m) continue
        plates.push(i); sizes.push(m.buf.byteLength)
      }
      if (!plates.length) { setError('No plate has objects'); return }
      const queue = plates.filter(i => i !== idx0)
      if (plates.includes(idx0)) queue.unshift(idx0)
      const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 0
      const largestBytes = Math.max(...sizes)
      const pool = resolveWorkerCount({ setting: settings?.slice_workers, kernel: kernelKindRef.current, cores, plates: plates.length, largestBytes })
      let run = makePlateRun(plates, pool, kernelKindRef.current)
      // The one button and the rate line show the run as a whole; the tabs and the per-plate row read the map.
      const publish = () => { setPlateRun(run); const sum = runSummary(run); setProgress(sum.progress); setSliceRate(sum.rate) }
      const patch = (i, p) => { run = patchPlate(run, i, p); publish() }
      setSlicing(true); publish()
      const started = performance.now()
      let sliced = 0, anyEconomy = false, anyClassic = false, canceled = false; const failed = []
      // Plates whose pool worker died (memory, most likely): re-run alone on the selector worker after the pool
      //  has drained, with the full ladder. The dead worker is dropped, so the pool shrinks by itself.
      const deferred = []
      const slicePlate = async (i, ctx) => {
        const merged = apiRef.current?.buildMergedSTL(i)
        if (!merged) { failed.push(i + 1); patch(i, { state: PLATE_STATES.failed, error: 'plate is empty' }); return }
        if (i === idx0) syncPaintSelector?.(merged)
        plateOffsetsRef.current[i] = { offX: merged.offX, offZ: merged.offZ }
        ;(ctx ? ctx.holder : sink).plate = i   // route this worker's progress to the plate it is on
        patch(i, { state: PLATE_STATES.busy })
        try {
          const { r, economy, classicWalls } = await runSlice(merged, ctx)
          plateLineWidth(i)
          plateResultsRef.current[i] = r; refreshSlicedCount(); announceSlice(i, r); sliced++   // no automatic download — switch tabs to inspect, save via an explicit export
          if (economy) anyEconomy = true
          if (classicWalls) anyClassic = true
          patch(i, { state: PLATE_STATES.done })
        } catch (e) {   // E1: even on failure, g-code from plates that already finished is preserved and available
          const why = String(e?.message || e)
          if (why.includes('canceled')) canceled = true
          else if (ctx && /out of memory|failed to load|watchdog/.test(why)) {
            log.warn(`[vp-pool] plate ${i + 1}: pool worker died (${why}) — dropping the worker, re-queued for the selector worker`)
            ctx.dead = true; ctx.terminate(); deferred.push(i); patch(i, { state: PLATE_STATES.queued, progress: 0, rate: 0 })
            return
          }
          else log.warn(`[vp-pool] plate ${i + 1} failed on ${ctx ? 'a pool worker' : 'the selector worker'}: ${why}`)
          failed.push(i + 1); patch(i, { state: PLATE_STATES.failed, error: why })   // the reason rides on the tab
        }
      }
      const drain = async (ctx) => { while (!canceled && !ctx?.dead) { const job = queue.shift(); if (job === undefined) return; await slicePlate(job, ctx) } }   // plate 0 is a job too
      // The selector worker reports through the hook's own progress path; the sink re-routes that to its plate.
      const sink = { plate: idx0, progress: (v) => patch(sink.plate, { progress: v }), rate: (v) => patch(sink.plate, { rate: v }) }
      const makeCtx = () => {
        const holder = { plate: -1 }
        const ctx = createPoolContext({ onProgress: (v) => patch(holder.plate, { progress: v }), onRate: (v) => patch(holder.plate, { rate: v }) })
        ctx.holder = holder
        return ctx
      }
      const extras = Array.from({ length: pool - 1 }, makeCtx)
      progressSinkRef.current = sink
      try {
        await Promise.all([drain(null), ...extras.map(drain)])
        // A dead pool worker can leave plates in the queue too (it stopped draining); everything left runs alone.
        for (const job of [...deferred, ...queue.splice(0)]) { if (canceled) break; await slicePlate(job, null) }
      }
      finally { progressSinkRef.current = null; for (const ctx of extras) ctx.terminate(); setSliceRate(0) }
      setSlicing(false)
      if (canceled) { setSliceNotice('Slice canceled' + (sliced ? ` — ${sliced} finished result(s) are kept` : '')); setError(''); }
      else if (!sliced) { setDowngradeOffer({ scope: 'all' }); setError('All plates failed to slice (economy mode included) — try the simplified retry'); return }
      else if (failed.length) {
        // Say WHY, not just which: every reason the ladder can end on names memory, and a row of crosses does not.
        const reasons = [...new Set(failed.map(n => run.plates[n - 1]?.error).filter(Boolean))]
        setError(`Plate ${failed.join(', ')} failed — the ${sliced} finished result(s) are kept (inspect/export from the tabs)`
          + (reasons.length ? `. ${reasons[0]}` : '') + (reasons.length > 1 ? ` (+${reasons.length - 1} more, see the tab tooltips)` : ''))
      }
      else { setError(''); setDowngradeOffer(null) }
      if (anyEconomy) setSliceNotice('Memory pressure — some plates finished in economy mode (no preview, G-code is fine)')
      else if (anyClassic) setSliceNotice('Arachne wall generation failed (degenerate geometry) — finished with classic walls (G-code is fine)')
      else if (!canceled && !failed.length) setSliceNotice(`Sliced ${sliced} plate${sliced === 1 ? '' : 's'} in ${((performance.now() - started) / 1000).toFixed(1)}s with ${pool} worker${pool === 1 ? '' : 's'}`
        + (deferred.length ? ` — ${deferred.length} re-run alone after a worker ran out of memory (pick fewer workers for this model)` : ''))
      // Show the selected plate's result, or the first plate that produced one if the selected plate failed.
      const landOn = plateResultsRef.current[idx0] ? idx0 : Object.keys(plateResultsRef.current).map(Number)[0]
      if (landOn == null) return
      if (landOn !== idx0) { selectedPlateRef.current = landOn; setSelectedPlate(landOn); placeXRef.current = 0 }
      plateLineWidth(landOn)
      showPlateResult(landOn)
    } else {
      const __tm0 = performance.now()   // [vp-prof] preprocessing timing (temporary)
      const merged = apiRef.current?.buildMergedSTL(idx0)
      if (!merged) { setError(`Plate ${idx0 + 1} has no objects`); return }
      log.info(`[vp-prof] buildMergedSTL ${(performance.now() - __tm0).toFixed(0)}ms (${(merged.buf.byteLength / 1048576).toFixed(1)}MB)`)
      if (idx0 === selectedPlateRef.current) syncPaintSelector?.(merged)
      plateOffsetsRef.current[idx0] = { offX: merged.offX, offZ: merged.offZ }
      setSlicing(true); setProgress(0)
      try {
        const { r, economy, classicWalls, params } = await runSlice(merged)
        if (r?.stats) log.info(`[vp-prof] kernel stages p1=${(r.stats.t_pass1_ms/1000).toFixed(1)}s surf=${(r.stats.t_surface_ms/1000).toFixed(1)}s sup=${(r.stats.t_support_ms/1000).toFixed(1)}s emit=${(r.stats.t_emit_ms/1000).toFixed(1)}s reuse=${params.reuse_stages}`)
        plateResultsRef.current[idx0] = r; refreshSlicedCount(); announceSlice(idx0, r); setSlicing(false); showPlateResult(idx0)
        setError(''); setDowngradeOffer(null)   // a lower rung of the ladder succeeded — do not leave the failed first attempt's banner up
        // The SLA support tree can fail while the slice itself stands — saying so beats a silently bare model.
        if (r?.stats?.support_error) setSliceNotice(`Support generation failed (${r.stats.support_error}) — the slice contains the model only`)
        if (economy) setSliceNotice('Memory pressure — finished in economy mode (no preview, G-code can still be downloaded)')
        else if (classicWalls) setSliceNotice('Arachne wall generation failed (degenerate geometry) — finished with classic walls (G-code is fine)')
      } catch (e) {
        setSlicing(false)
        if (String(e?.message || e).includes('canceled')) { setSliceNotice('Slice canceled'); return }
        setDowngradeOffer({ scope: 'current' }); setError('Slice failed (economy mode failed too): ' + e.message)
      }
    }
  }
  // Downgrade retry: simplify the infill pattern (rectilinear) + lower density + economy mode, run again (user's choice). buildParams applies it.
  async function retryDowngrade() {
    const off = downgradeOffer; setDowngradeOffer(null); if (!off) return
    downgradeRef.current = true
    try { await onSlice(off.scope) } finally { downgradeRef.current = false }
  }
  // Add/remove/select plates
  function addPlate() { setPlateCount(n => Math.min(MAX_PLATES, n + 1)) }
  function deletePlate() {
    setPlateCount(n => {
      if (n <= 1) return n
      const last = n - 1; delete plateResultsRef.current[last]; disposePlateToolpath(last); refreshSlicedCount()
      // Per-plate settings shrink with the plate list (upstream erases the same index, PartPlate.cpp:4722) — a
      //  stale trailing entry would come back as the wrong plate's position the moment a plate is re-added.
      //  Only the LAST plate is ever deletable here, so truncation IS the erase.
      setSettings?.(s => (Array.isArray(s?.wipe_tower_x) || Array.isArray(s?.wipe_tower_y))
        ? { ...s,
            wipe_tower_x: Array.isArray(s.wipe_tower_x) ? s.wipe_tower_x.slice(0, last) : s.wipe_tower_x,
            wipe_tower_y: Array.isArray(s.wipe_tower_y) ? s.wipe_tower_y.slice(0, last) : s.wipe_tower_y }
        : s)
      // The plate's own override follows the same truncation rule (identity-preserving when there is none, so
      //  a delete with no overrides does not read as a plate-settings change to the staleness watcher).
      setPlateSettings?.(ps => truncatePlateSettings(ps, last))
      if (selectedPlateRef.current >= last) selectPlate(last - 1)
      return last
    })
  }
  function selectPlate(i) {
    selectedPlateRef.current = i; setSelectedPlate(i); placeXRef.current = 0
    // The focus UI (layer count, stats, the G-code link) follows the plate in BOTH modes: a plate's cached result
    //  is its own, and in Prepare it is what enables the Preview tab. Preview-only meant a plate sliced earlier
    //  read as unsliced after a model was added elsewhere, because a load zeroes the focus and nothing refilled it.
    showPlateResult(i)
  }

  return { showPlateResult, refreshSlicedCount, exportAllGcode, exportPlateSl1, importSl1, onSlice, retryDowngrade, addPlate, deletePlate, selectPlate }
}
