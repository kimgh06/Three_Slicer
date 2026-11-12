// How a finished FFF slice becomes what the viewer shows: the G-code gets what upstream writes once the estimate exists
//  (finalizeGcode: M73, file totals), and the slice is previewed from that G-code read back (previewFromGcode), in the
//  frame of the params it was sliced with — the toolpaths, and the layer, segment and filament figures counted from the
//  same text, so a sliced plate and the saved file opened again show the same thing. The time estimate and the bed
//  verdicts stay the kernel's. Economy mode keeps no toolpath to save memory, and the resin path has no G-code: both
//  stay as they are.
// Two callers, one owner: the slicer worker runs it beside the kernel when the slice asks for it (`exportedPreview`
//  on the slice message), so the main thread neither joins the streamed text nor parses it; the viewer's slicing hook
//  runs it itself for a worker that did not (measured on a 28-plate project, dev build: the main thread was busy 33 s
//  of a 25 s run, ~6 s of it this read-back, the largest single part).
import { finalizeGcode } from './finalize_gcode.js'
import { previewFromGcode } from './gcode_parse.js'
import { bedCenter } from '../settings/bed_frame.js'

// A slice-all puts the read-back off until its last plate is cut (`deferPreview` on the slice message): the pool keeps
//  every core busy, so each plate's read-back delayed the plates behind it (measured on a 28-plate project, 8 cores:
//  the run without any read-back was 0.7 s shorter). Such a result is `finalizedExport` with the kernel's own layers
//  and `previewPending`, and `readBack` makes it what `asExported` would have.

/** The result with the G-code a file gets (M73, file totals); its layers are still the kernel's stream. */
export function finalizedExport(result) {
  return { ...result, gcode: finalizeGcode(result.gcode, result.stats) }
}

/** Whether a finalized result has G-code to preview: not resin, not economy mode (which keeps no toolpath). */
export function hasReadBack(finalized) {
  return !finalized.sla && !!finalized.layers?.length && !!finalized.gcode
}

/**
 * @param {{ stats: object, layers: Array, gcode: string }} finalized  a `finalizedExport` result that `hasReadBack`
 * @param {object|string} params  the kernel params it was sliced with (object or JSON text)
 * @returns the result previewed from its G-code: the read-back layers and the figures counted from the same text
 */
export function readBack(finalized, params) {
  let kernelParams = params
  if (typeof params === 'string') kernelParams = JSON.parse(params)
  const parsed = previewFromGcode(finalized.gcode, { center: bedCenter(kernelParams), filamentDiameter: kernelParams.filament_diameter, layerHeight: kernelParams.layer_height })
  if (!parsed.layers.length) return finalized
  const { layers, path_segments, filament_mm, filament_mm_by_tool } = parsed.stats
  return { ...finalized, layers: parsed.layers, stats: { ...finalized.stats, layers, path_segments, filament_mm, filament_mm_by_tool } }
}

/**
 * @param {{ stats: object, layers?: Array, gcode: string, sla?: boolean }} result  a slice result with its raw G-code
 * @param {object|string|null} params  the kernel params it was sliced with (object or JSON text); null skips the read-back
 * @returns the result with the finalized G-code, and with the read-back layers and figures when it has toolpaths
 */
export function asExported(result, params) {
  const finalized = finalizedExport(result)
  if (!params || !hasReadBack(finalized)) return finalized
  return readBack(finalized, params)
}
