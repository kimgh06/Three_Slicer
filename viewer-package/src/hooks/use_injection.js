import { useEffect, useState } from 'react'
import { parseGcode } from 'three-slicer-viewer/gcode'
import { platePosition, MAX_PLATES } from '../core/plate_layout.js'
import { asSl1File } from '../core/sl1_read.js'
import { log } from '../core/log.js'
import { DEFAULT_LINE_WIDTH } from '../core/viewer_defaults.js'

// The two injection props, `gcode` and `sl1`: an artifact rendered on the selected plate WITHOUT running the
// kernel. They are one contract with two file formats, so they live together — and one plate holds one artifact,
// which is the rule the `sl1` effect enforces below.

/**
 * G-code text -> the plate cache. The parser produces the very layer stream the kernel produces, so the result
 * goes in beside a real slice and showPlateResult draws it the same way.
 * Coordinates: a slice is centred on the origin and offset back by its own centre (use_three_scene
 * buildMergedSTL), but G-code is already in absolute bed millimetres — so the offset is the bed's own corner,
 * per the plate grid setPlates lays out (plate i sits at (i%cols)*step, floor(i/cols)*step; model y -> three -z).
 */
function useGcodeInjection(gcode, deps) {
  const { tech, kp, apiRef, selectedPlateRef, plateCountRef, plateOffsetsRef, plateResultsRef, lineWidthRef,
          refreshSlicedCount, setError, setSliceNotice, showPlateResult, selectPlate, growPlates } = deps
  useEffect(() => {
    if (gcode == null || tech === 'SLA') return   // injected G-code is an FFF artifact — a resin profile has no path that renders it
    // A string lands on the selected plate; a {plate: text} map (a .gcode.3mf, or a host's own per-plate files)
    //  lands on each plate it names, growing the bed to reach the last one first — the plate origins below are
    //  read from the grid, so it has to exist before anything is placed on it.
    const entries = typeof gcode === 'object'
      ? Object.entries(gcode).map(([plate, text]) => [Number(plate), String(text)]).filter(([plate]) => Number.isInteger(plate) && plate >= 0)
      : [[selectedPlateRef.current, String(gcode)]]
    if (!entries.length) return
    if (typeof gcode === 'object') growPlates?.(Math.max(...entries.map(([plate]) => plate)) + 1)
    const bw = kp.bed_width, bd = kp.bed_depth
    const shown = []
    try {
      for (const [idx, text] of entries) {
        if (idx >= plateCountRef.current) continue   // past MAX_PLATES: growPlates stopped short of it
        const parsed = parseGcode(text, { filamentDiameter: Number(kp.filament_diameter) || 1.75 })
        if (!parsed.layers.length) continue
        // api.platePos follows the heterogeneous layout when plates carry different beds; the corner offset
        //  below still uses the GLOBAL bed (ponytail: an injected artifact on a bed-override plate lands with
        //  the global corner — refine with that plate's dims if hosts actually combine the two features).
        const origin = apiRef?.current?.platePos?.(idx) ?? platePosition(idx, plateCountRef.current, bw, bd)
        plateOffsetsRef.current[idx] = { offX: origin.x - bw / 2, offZ: origin.z + bd / 2 }
        plateResultsRef.current[idx] = { stats: parsed.stats, layers: parsed.layers, gcode: text }
        shown.push(idx)
      }
    } catch (e) { setError('G-code parse failed: ' + (e?.message || e)); return }
    if (!shown.length) { setError('No printable moves found in the G-code'); return }
    lineWidthRef.current = kp.line_width || DEFAULT_LINE_WIDTH
    refreshSlicedCount()
    setError(''); setSliceNotice('')
    // The selected plate if it received one, else the first that did — upstream selects the first sliced plate.
    if (shown.includes(selectedPlateRef.current)) showPlateResult(selectedPlateRef.current)
    else (selectPlate ?? showPlateResult)(Math.min(...shown))
  }, [gcode])   // eslint-disable-line react-hooks/exhaustive-deps
}

/**
 * An .sl1 archive -> importSl1, the very function the picker and a drop use, so an injected archive behaves
 * identically: the raster preview, the background mesh reconstruction, and the archive's OWN settings applied to
 * the session. `printer_technology` is among them — an .sl1 opened in an FFF session has to switch it, or the
 * masks sit on a filament bed — and that setSettings is why the auto-re-slice guard names this prop too.
 * No `tech === 'SLA'` gate, unlike the G-code effect above: here the archive is what DECIDES the technology.
 */
function useSl1Injection(sl1, gcode, importSl1) {
  useEffect(() => {
    if (sl1 == null) return
    // One plate, one artifact — and the G-code effect has already claimed it.
    if (gcode != null) { log.warn('[viewport] both `gcode` and `sl1` are set — rendering the G-code, ignoring the archive'); return }
    importSl1(asSl1File(sl1))
  }, [sl1])   // eslint-disable-line react-hooks/exhaustive-deps
}

export function useInjection({ gcode, sl1, importSl1, ...deps }) {
  useGcodeInjection(gcode, deps)
  useSl1Injection(sl1, gcode, importSl1)
}

/**
 * An opened .gcode.3mf (write_3mf.js writeGcode3MF, or upstream's "Export all plate sliced file"): the third
 * source of injected G-code, beside the two props. It feeds the SAME path — `injectedGcode` is what Viewport hands
 * useInjection and every slice guard as their `gcode` — so nothing re-slices over it or invalidates it, exactly
 * as for a host's own G-code. The host's `gcode` prop wins while it is set.
 * While one is open the viewer is preview-only, as upstream is for a .gcode.3mf (Plater `m_exported_file`): there
 * is no model to prepare or re-slice. A model load or the close button ends it, and its plates' results go with it.
 */
export function useImportedGcode({
  gcode, apiRef, globalFrame, plateCountRef, selectedPlateRef, plateResultsRef, plateOffsetsRef,
  setPlateCount, setCanvasMode, setDragOver, disposePlateToolpath, refreshSlicedCount, showPlateResult,
}) {
  const [importedGcode, setImportedGcode] = useState(null)   // {name, plates: {plateIndex: text}}
  const injectedGcode = gcode ?? importedGcode?.plates ?? null
  const gcodeOnly = injectedGcode != null

  // The drop highlight ends with the drag, wherever the drop lands. The canvas's own onDrop clears it, but a host
  //  that takes the drop first (a capture handler that stops propagation — the demo app does, for .gcode) leaves
  //  that handler unrun, and a drag that ends in a drop fires no dragleave: the dashed border and the "Drop here"
  //  overlay stayed on screen. The window sees the drop in its capture phase, before any host handler can stop it.
  useEffect(() => {
    const endDrag = () => setDragOver(false)
    window.addEventListener('drop', endDrag, true)
    window.addEventListener('dragend', endDrag, true)
    return () => { window.removeEventListener('drop', endDrag, true); window.removeEventListener('dragend', endDrag, true) }
  }, [])   // eslint-disable-line react-hooks/exhaustive-deps

  // Grow the bed to `count` plates. setPlates writes the plate grid SYNCHRONOUSLY — the injection reads the plate
  //  origins right after — and setPlateCount keeps React in step: the same pair model_load's applyProjectPlates uses.
  function growPlates(count) {
    const target = Math.min(MAX_PLATES, count)
    if (target <= plateCountRef.current) return
    apiRef.current?.setPlates(target, globalFrame.bedW, globalFrame.bedD, selectedPlateRef.current)
    setPlateCount(target)
  }
  function closeImportedGcode() {
    if (!importedGcode) return
    for (const plate of Object.keys(importedGcode.plates)) {
      delete plateResultsRef.current[plate]; delete plateOffsetsRef.current[plate]; disposePlateToolpath(Number(plate))
    }
    setImportedGcode(null)
    refreshSlicedCount()
    showPlateResult(selectedPlateRef.current)
    setCanvasMode('prepare')
  }
  // A second print job replaces the first rather than leaving its plates behind on the ones it does not name.
  function openGcodePlates(plates, name) {
    closeImportedGcode()
    setImportedGcode({ name, plates: Object.fromEntries(plates.map(plate => [plate.index, plate.gcode])) })
  }
  // The tab and the shortcut into Prepare are refused while a print job is open.
  const enterCanvasMode = (mode) => { if (mode === 'prepare' && gcodeOnly) return; setCanvasMode(mode) }

  return { importedGcode, injectedGcode, gcodeOnly, growPlates, closeImportedGcode, enterCanvasMode, openGcodePlates }
}
