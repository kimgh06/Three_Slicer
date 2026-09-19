// "Save project as" / "Export as STL" — the write half of the 3mf project support (parse_3mf.js is the read half).
// Painting lives on each object (core/paint_store.js); the selector's strokes are written back to it before a save
//  (flushPaint, support_paint.js) — the one asynchronous step here, and why this is a module rather than two lines.
import { log } from '../core/log.js'
import { write3MFProject, writeSTL } from '../core/write_3mf.js'
import { assertUniformTechnology, assertHomogeneousBeds } from '../core/plate_settings.js'
import { DEFAULT_BED } from '../core/viewer_defaults.js'

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

// Show the busy label BEFORE doing the work. Setting React state does not paint — the browser only does that on
//  the next frame, and the synchronous half of a save (the geometry gather, the STL buffer) would otherwise run
//  first and the label would appear only in time to disappear. One rAF hands the paint over before the work
//  starts, which is the whole difference between "the button says Saving…" and "the button did nothing".
const nextFrame = () => new Promise(resolve => requestAnimationFrame(() => resolve()))

export function makeExportActions(deps) {
  const { apiRef, getWorker, flushPaintRef, settingsRef, plateSettingsRef, plateCountRef, bedRef, setError, setSliceNotice, setExporting, onExport } = deps

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
    // The selector's strokes back onto the objects first; then every object — on any plate, selected or not —
    //  carries its own paint in its own facet numbering, which is what the writer stores. This used to take the
    //  kernel's merge numbering directly, which only meant anything when the whole project sat on one plate.
    await flushPaintRef?.current?.()
    const gotPaint = performance.now()
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
    const kind = getWorker?.()?.__paintImportKind === 'supports' ? 'supports' : 'color'
    const paintedFacets = objects.reduce((sum, o) => sum + (o.paint?.[kind]?.size ?? 0), 0)
    try {
      const bytes = await write3MFProject(objects, settingsRef.current, {
        paintKind: kind,
        bedWidth: bedRef.current?.bedW ?? DEFAULT_BED.width,
        bedDepth: bedRef.current?.bedD ?? DEFAULT_BED.depth,
        plateCount: plateCountRef.current ?? 1,
        plateSettings: plateSettingsRef?.current ?? null,   // our own member — upstream has no place for it
      })
      // Same [vp-prof] channel the model load uses — the three stages have very different cost profiles (the
      //  geometry gather is per vertex, the paint fetch is a worker round trip, the write is deflate-bound), so a
      //  single total would say nothing about which one a slow save was.
      const facets = objects.reduce((sum, o) => sum + o.faceCount, 0)
      log.info(`[vp-prof] export 3mf: ${facets} facets, paint ${(gotPaint - started).toFixed(0)}ms,`
        + ` gather ${(gathered - gotPaint).toFixed(0)}ms, write ${(performance.now() - gathered).toFixed(0)}ms`
        + ` -> ${(bytes.byteLength / 1e6).toFixed(2)}MB`)
      download(bytes, `${baseName(objects)}.3mf`, 'model/3mf', onExport)
      setSliceNotice?.(`Saved ${objects.length} ${selectedOnly ? 'selected ' : ''}object(s) as a 3mf project`
        + (paintedFacets ? ` with ${paintedFacets} painted facets.` : '.'))
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
