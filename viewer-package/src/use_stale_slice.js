import { useEffect, useRef } from 'react'
import { sameSettings, changedPlates, stalePlateKeys } from './core/slice_staleness.js'
import { dropStaleTechOverrides } from './core/plate_settings.js'
import { printerTechnology } from 'three-slicer-viewer/settings'

// A settings change invalidates every result on screen.
//
// Everything shown after a slice — the toolpaths, the stats card, the layer slider, the G-code export — describes
// the settings it was sliced with. Change one and the picture stops matching the panel next to it, silently: the
// preview still renders, the estimate still reads plausibly, and the Export button still hands out G-code the
// current settings would not produce. With auto-slice on, that window is the 0.8s debounce; with it off, it lasts
// until the user happens to slice again.
//
// So the result is dropped and the viewer goes back to Prepare. Auto-slice then re-slices into the empty preview,
// which is the honest sequence: the old picture is gone before the new one exists.
//
// Two kinds of plate are NOT invalidated, because neither claims to be a slice of these settings:
//  · an INJECTED plate (the `gcode` / `sl1` props) — the same guard autoSlice and sliceRequest use; it is the
//    host's content, not ours to discard.
//  · an OPENED `.sl1` archive (`stats.sla_raster`) — and this one is not merely allowed but required. The import
//    applies the archive's own settings through setSettings (plate_actions.js) and then populates the plate, so
//    invalidating on that write would erase the very result the file was opened to show.
//
// An in-flight slice is deliberately left running: it was asked for, and cancelling it would make a settings nudge
// silently discard work in progress. Its result lands under the new settings and is invalidated on the NEXT change.

// Both decisions — "did the values actually change" and "does this result survive" — live in
// core/slice_staleness.js, where they are node-testable.
export function useStaleSlice({
  settings, plateSettings, setPlateSettings, setStatus, gcode, sl1,
  plateResultsRef, selectedPlateRef, canvasModeRef,
  clearToolpaths, showPlateResult, refreshSlicedCount, setCanvasMode,
}) {
  const seenRef = useRef(settings)
  const seenPlateRef = useRef(plateSettings)
  useEffect(() => {
    const previous = seenRef.current
    const previousPlates = seenPlateRef.current
    seenRef.current = settings
    seenPlateRef.current = plateSettings
    if (gcode != null || sl1 != null) return
    // Two invalidation scopes (core/slice_staleness.js): the global map feeds every plate, a plate override
    //  feeds only its own — so a per-plate edit drops that plate's result and leaves the rest cached.
    const globalChanged = !sameSettings(previous, settings)
    const plateIndices = globalChanged ? [] : changedPlates(previousPlates, plateSettings)
    if (!globalChanged && !plateIndices.length) return

    const results = plateResultsRef.current
    const stale = stalePlateKeys(results, globalChanged, plateIndices)
    for (const key of stale) delete results[key]
    if (!stale.length) return
    // showPlateResult's own "plate without a result" branch is what clears the stats, the layer range, the SLA
    //  preview meshes and the G-code URL — reached here by having just removed the entry it looks for.
    clearToolpaths()
    refreshSlicedCount()
    showPlateResult(selectedPlateRef.current)
    // Leaving the user on a Preview tab that has nothing left to preview: the tab disables itself once the layer
    //  count drops to 0, but the canvas would stay on it.
    if (canvasModeRef.current === 'preview') setCanvasMode('prepare')
  }, [settings, plateSettings])   // eslint-disable-line react-hooks/exhaustive-deps

  // The other consequence of a settings change, and the reason it lives beside the invalidation rather than in
  //  Viewport: a GLOBAL technology switch invalidates the plate OVERRIDES the same way it invalidates the results.
  //  A plate that declares its own printer_technology describes its own machine (every plate-scope pick writes
  //  one) and is not about the global switch; an override without it is a handful of hand-edited values authored
  //  against the technology that just went away — under the new one they are resin values wearing filament key
  //  names — and is dropped, saying so (plate_settings.js dropStaleTechOverrides).
  const tech = printerTechnology(settings)
  const techRef = useRef(tech)
  useEffect(() => {
    const from = techRef.current
    techRef.current = tech
    if (from === tech) return
    const { plateSettings: kept, dropped } = dropStaleTechOverrides(plateSettings)
    if (!dropped.length) return
    setPlateSettings?.(kept)
    setStatus?.(`${dropped.map(i => `Plate ${i + 1}`).join(', ')}: ${from} settings dropped — the printer is now ${tech}`)
  }, [tech])   // eslint-disable-line react-hooks/exhaustive-deps
}
