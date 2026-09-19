// "Save project as" / "Export as STL" — the write half of the 3mf project support (parse_3mf.js is the read half).
// The kernel's painting only exists inside the worker's TriangleSelector, so a 3mf save has to ASK for it and wait:
//  that is the one asynchronous step here, and it is why this is a module rather than two lines in the toolbar.
import { log } from '../core/log.js'
import { write3MFProject, writeSTL } from '../core/write_3mf.js'
import { assertUniformTechnology, assertHomogeneousBeds } from '../core/plate_settings.js'
import { DEFAULT_BED } from '../core/viewer_defaults.js'

// The kernel is not guaranteed to answer (an old build has no selector_export_paint binding, and a worker that is
//  busy slicing replies late), so the wait is bounded. On timeout the save proceeds with whatever painting was
//  IMPORTED — losing the brush strokes is bad, losing the whole file because a worker was slow is worse.
const PAINT_EXPORT_TIMEOUT_MS = 4000

/**
 * Is the click that started this still "recent" as far as the browser is concerned?
 *
 * Transient user activation expires after about five seconds. A download started once it has lapsed counts as
 * an AUTOMATIC one, which Chrome blocks outright after the first, showing a small icon in the omnibox and
 * nothing on the page. Measured here: an SL1 of a 1095-layer model takes ~12s to build, so EVERY such export
 * lands on the wrong side of that line. Callers that take seconds must therefore check before saving and, when
 * this says no, hold the finished bytes for a second click rather than dropping them into a blocked download.
 *
 * `undefined` (Safari before 16.4) is treated as lapsed: asking for one more click is the safe direction to
 * be wrong in — a file that needs a click always arrives, a blocked one never does.
 */
export const saveWindowOpen = () =>
  typeof navigator !== 'undefined' && navigator.userActivation?.isActive === true

// The host can take the bytes instead of having the browser download them — an app that saves to its own server,
//  or through the File System Access API, has no other way in: the toolbar's save buttons are inside this
//  component. Returning anything truthy means "handled", and the anchor is never created.
export async function download(bytes, name, type, onExport) {
  const blob = new Blob([bytes], { type })
  if (onExport && onExport(blob, name)) return
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url; anchor.download = name; anchor.style.display = 'none'
  document.body.appendChild(anchor); anchor.click()
  // Revoking is what frees the bytes, but doing it before the browser has finished READING them truncates the
  //  download. 4s was fine for a G-code file and is not for a 100MB SL1, so the wait scales with the size
  //  (~10MB/s, floor 4s) instead of being one constant tuned on the smallest case.
  setTimeout(() => { anchor.remove(); URL.revokeObjectURL(url) }, Math.max(4000, blob.size / 10000))
}

function requestPaintExport(worker) {
  if (!worker) return Promise.resolve(null)
  return new Promise((resolve) => {
    let done = false
    const finish = (value) => { if (!done) { done = true; worker.removeEventListener('message', onMessage); resolve(value) } }
    const onMessage = (event) => { if (event.data?.type === 'paintExport') finish(event.data.supported ? event.data : null) }
    worker.addEventListener('message', onMessage)
    setTimeout(() => finish(null), PAINT_EXPORT_TIMEOUT_MS)
    worker.postMessage({ cmd: 'exportPaint' })
  })
}

// Show the busy label BEFORE doing the work. Setting React state does not paint — the browser only does that on
//  the next frame, and the synchronous half of a save (the geometry gather, the STL buffer) would otherwise run
//  first and the label would appear only in time to disappear. One rAF hands the paint over before the work
//  starts, which is the whole difference between "the button says Saving…" and "the button did nothing".
const nextFrame = () => new Promise(resolve => requestAnimationFrame(() => resolve()))

// The kernel numbers facets across the merge of every VISIBLE object, so exporting a subset cannot hand that
//  numbering straight to the writer — object 3's facet 0 is not facet 0 of the file. This walks each mark back to
//  the object that owns it (via the full merge order) and forwards it onto the subset's own running offset,
//  dropping marks whose object is not being exported. Without it, "export selected" paints the wrong triangles.
export function rebasePaintOntoSubset(paintExport, allObjects, subset) {
  if (!paintExport?.facets?.length) return null
  const baseOf = (list) => {
    const bases = new Map()
    let running = 0
    for (const object of list) { bases.set(object.id, running); running += object.faceCount }
    return bases
  }
  const inMerge = baseOf(allObjects), inFile = baseOf(subset)
  const hexLines = String(paintExport.hex ?? '').split('\n')
  const facets = [], hex = []
  for (let i = 0; i < paintExport.facets.length; i++) {
    const facet = paintExport.facets[i]
    const owner = allObjects.find(o => facet >= inMerge.get(o.id) && facet < inMerge.get(o.id) + o.faceCount)
    if (!owner || !inFile.has(owner.id)) continue
    facets.push(inFile.get(owner.id) + (facet - inMerge.get(owner.id)))
    hex.push(hexLines[i] ?? '')
  }
  return facets.length ? { facets, hex: hex.join('\n') } : null
}

export function makeExportActions(deps) {
  const { apiRef, getWorker, settingsRef, plateSettingsRef, plateCountRef, bedRef, setError, setSliceNotice, setExporting, onExport } = deps

  const baseName = (objects) => {
    const first = objects?.[0]?.name ?? apiRef.current?.exportObjects?.()[0]?.name ?? 'project'
    return String(first).replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_') || 'project'
  }

  // Every export runs through here so the busy flag can never be left on by an early return or a throw.
  //  `which` names the export, not what the button should say — the wording belongs to the UI, and having the two
  //  agree on a display string would mean the same sentence living in two files.
  async function busy(which, work) {
    setExporting?.(which)
    try {
      await nextFrame()                        // let the busy label paint before anything blocks
      apiRef.current?.suspendRendering?.(true)  // ...and only then stop drawing, so the label is the last frame
      await work()
    }
    finally { apiRef.current?.suspendRendering?.(false); setExporting?.(null) }
  }

  /** A .3mf project — geometry, settings, plate layout and painting. `selectedOnly` narrows it to the current
   *  selection, upstream's `export_stl(..., selection_only, ...)` applied to the project writer. */
  async function runProjectExport(selectedOnly = false) {
    const started = performance.now()
    const objects = apiRef.current?.exportObjects?.({ selectedOnly }) ?? []
    if (!objects.length) {
      setError?.(selectedOnly ? 'Nothing selected — click an object first' : 'Nothing to export — load a model first')
      return
    }
    // A mixed-technology or mixed-bed project has no 3mf representation — refuse with the typed errors (their
    //  messages name the plates and the way out) instead of writing a file that silently drops the routing.
    try { assertUniformTechnology(settingsRef.current, plateSettingsRef?.current); assertHomogeneousBeds(plateSettingsRef?.current) }
    catch (err) { setError?.(err.message); return }
    const gathered = performance.now()
    // The selector holds ONE plate's merge, so its numbering is only meaningful when the whole export sits on that
    //  plate; rebasing across plates would be guesswork. Judged on every VISIBLE object rather than on the subset,
    //  because that merge is what the kernel numbered. Otherwise each object keeps the paint it was imported with.
    const allVisible = selectedOnly ? (apiRef.current?.exportObjects?.() ?? objects) : objects
    const singlePlate = new Set(allVisible.map(o => o.plate)).size <= 1
    const kernelPaint = singlePlate ? await requestPaintExport(getWorker?.()) : null
    const exported = selectedOnly ? rebasePaintOntoSubset(kernelPaint, allVisible, objects) : kernelPaint
    const gotPaint = performance.now()
    try {
      const bytes = await write3MFProject(objects, settingsRef.current, {
        paintExport: exported,
        paintKind: getWorker?.()?.__paintImportKind === 'supports' ? 'supports' : 'color',
        bedWidth: bedRef.current?.bedW ?? DEFAULT_BED.width,
        bedDepth: bedRef.current?.bedD ?? DEFAULT_BED.depth,
        plateCount: plateCountRef.current ?? 1,
        plateSettings: plateSettingsRef?.current ?? null,   // our own member — upstream has no place for it
      })
      // Same [vp-prof] channel the model load uses — the three stages have very different cost profiles (the
      //  geometry gather is per vertex, the paint fetch is a worker round trip, the write is deflate-bound), so a
      //  single total would say nothing about which one a slow save was.
      const facets = objects.reduce((sum, o) => sum + o.faceCount, 0)
      log.info(`[vp-prof] export 3mf: ${facets} facets, gather ${(gathered - started).toFixed(0)}ms,`
        + ` paint ${(gotPaint - gathered).toFixed(0)}ms, write ${(performance.now() - gotPaint).toFixed(0)}ms`
        + ` -> ${(bytes.byteLength / 1e6).toFixed(2)}MB`)
      download(bytes, `${baseName(objects)}.3mf`, 'model/3mf', onExport)
      const painted = exported?.facets?.length ?? 0
      setSliceNotice?.(`Saved ${objects.length} ${selectedOnly ? 'selected ' : ''}object(s) as a 3mf project`
        + (painted ? ` with ${painted} painted facets.` : '.')
        + (!singlePlate ? ' Brush strokes are exported only for a single-plate project — this one kept the painting it was imported with.' : ''))
    } catch (err) { setError?.(`Export failed: ${err?.message || err}`) }
  }

  /** One binary STL in the same world frame the 3mf uses (geometry only — no settings, no painting).
   *  `selectedOnly` is upstream's `export_stl(false, true)`, the object context menu's "Export as STL". */
  function runSTLExport(selectedOnly = false) {
    const objects = apiRef.current?.exportObjects?.({ selectedOnly }) ?? []
    if (!objects.length) {
      setError?.(selectedOnly ? 'Nothing selected — click an object first' : 'Nothing to export — load a model first')
      return
    }
    const total = objects.reduce((sum, o) => sum + o.tris.length, 0)
    const merged = new Float32Array(total)
    let at = 0
    for (const object of objects) { merged.set(object.tris, at); at += object.tris.length }
    download(writeSTL(merged), `${baseName(objects)}.stl`, 'model/stl', onExport)
    setSliceNotice?.(`Exported ${objects.length} ${selectedOnly ? 'selected ' : ''}object(s) as STL (${(total / 9) | 0} triangles).`)
  }

  return {
    exportProject: () => busy('project', () => runProjectExport(false)),
    exportSelectedProject: () => busy('project', () => runProjectExport(true)),
    // The STL path is fully synchronous, so without the frame the busy() helper yields it would freeze with the
    //  button still unchanged — the same reason, just more visible because nothing else is async to break it up.
    exportSTL: () => busy('stl', () => runSTLExport(false)),
    exportSelectedSTL: () => busy('stl', () => runSTLExport(true)),
  }
}
