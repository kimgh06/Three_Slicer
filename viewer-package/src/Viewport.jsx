import React, { useEffect, useRef, useState } from 'react'
import { deriveKernelParams, deriveSlaParams, settingRaw } from 'three-slicer-viewer/settings'
import ShadowHost from './shadow_host.jsx'
import { useSliceRequest, useAutoSlice } from './hooks/use_slice_request.js'
import { useStaleSlice } from './hooks/use_stale_slice.js'
import { useInitialFiles } from './hooks/use_initial_files.js'
import shadowCss from '../styles.css?inline'   // Shadow DOM isolation — inlined as a string at build time
import { SUPPORTED_EXT } from './scene/model_loaders.js'
import { MAX_PLATES } from './core/plate_layout.js'
import { useSliceRun } from './hooks/use_slice_run.js'
import { objectTools } from './core/toolbar_items.js'
import { makeKeyHandler } from './core/shortcut_keymap.js'
import { setLogging } from './core/log.js'
import { useStateRef } from './hooks/use_state_ref.js'
import { useHostEvents } from './hooks/use_host_events.js'
import { useInjection } from './hooks/use_injection.js'
import { useMoveScrub } from './hooks/use_move_scrub.js'
import { useViewportHistory, undoRedoDirection } from './hooks/use_viewport_history.js'
import { useThreeScene } from './scene/use_three_scene.js'
import {
  makeToolpathView, useNoopSlicer, makeSupportPaint, MAX_PAINT_EXTRUDERS,
  makePlateActions, makeModelLoad, makeExportActions, makePresetActions, PRESET_ACCEPT, makeObjectActions,
  makeFilamentColors, DEFAULT_FILAMENT_COLORS, makePreviewControls,
} from './actions/index.js'
import { bedOverflow, overflowText, bedRectangle } from './core/bed_bounds.js'
import { materialPaintCounts as paintedCountsPerExtruder } from './core/paint_counts.js'
import { withToolBreakdown } from './core/stats_view.js'
import { towerBoxes, usesMultipleTools, towerResultStats, towerFootprint, clampTowerPosition } from './core/tower_layout.js'
import { storedPaintStates } from './core/paint_store.js'
import { overriddenPlateKeys, plateTechnology, plateContext, plateDimsList } from './core/plate_settings.js'
import { makeSupportSettings } from './core/support_settings.js'
import { objectRows } from './core/object_rows.js'
import {
  TopBar, GizmoRail, ObjectToolbar, ContextMenu, HelpOverlay, PaintPanel, MaterialPaintPanel, PlateBar,
  PreviewControls, StatsCard, PrinterCard, ProcessCard, FilamentCard, ResinCard, ObjectList, SliceBar, TowerCard, writeTowerPosition,
} from './ui/index.js'
import { DEFAULT_BED, DEFAULT_LINE_WIDTH } from './core/viewer_defaults.js'
import { THEME_CSS } from './core/theme.js'

// 3D viewport + browser-only slicing (WASM, track C stage 4).
//  - Slice parameters are derived from the right-hand editor panel values (deriveKernelParams) — no duplicate form.
//  - Multiple objects (cumulative upload + merged TransformControls transforms), support/raft/bed/pattern/cooling/arc/seam.
//  - Toolpaths: stage 24 — the upstream libvgcode approach (GPU instancing, toolpath_gpu.js). The CPU geometry builder is gone.
//    Coordinates: kernel z-up -> toolpathGroup rotation.x=-90° (the shader computes in local z-up, view_matrix compensates).

// A sidebar panel can also be shown but not editable (`panels={{ printerCard: 'readonly' }}`) — the case a host
//  that presets printer/process/filament itself actually wants, and which hiding the card does not cover.
//  One inert wrapper per card, rather than a `disabled` prop threaded through five card components and every
//  input inside them. That also locks the host's OWN nodes (motionPanel, filamentPanel, processPanel) for free,
//  which is the right reading: a read-only printer card with a live motion panel inside it would be strange.
//  `inert=''` and not `inert={true}` — React only learned `inert` as a real boolean prop in 19, and the peer
//  range here starts at 18, where a boolean is dropped and the empty string is what gets through.
//  Only the sidebar panels are lockable (types/viewer.d.ts LockablePanel); elsewhere 'readonly' reads as visible.
//  Module scope on purpose: defined inside the component its function identity would change every render, which
//  React reads as a NEW component type and answers by remounting the whole subtree — measured on the layer
//  slider, whose <input type=range> was replaced mid-drag on the first onChange, killing the native drag after
//  one step. Any state-carrying child (focus, an IME composition, a drag) breaks the same way.
const Panel = ({ panels, name, children }) => (panels?.[name] === 'readonly'
  ? <div className="vp-readonly" inert="">{children}</div>
  : children)

// Embedding surface (all optional — omitting every one of them is the standalone app this component has always been):
//  · panels    — per-panel visibility, {name: false} hides. Everything defaults to visible, so a host opts OUT only.
//  · gcode     — G-code text rendered instead of a slice result (no kernel run). See the injection effect below.
//  · sl1       — the SLA half of the same contract: an .sl1 archive rendered as a raster preview, no kernel run.
//  · files     — content imported once on mount (File or {name,data}), through the same extension dispatch as a
//                drop: models/3mf projects, .sl1 raster archives, and preset files.
//  · default*  — initial value for state this component owns; the host reads changes back through onEvent.
//  · sliceRequest — the host's Slice button: an identity CHANGE requests one slice of the current plate,
//                the mount value is inert (use_slice_request.js has the full contract).
//  · onEvent   — one channel for every value change ({type, value}), rather than a prop per value.
//  · onSliced  — the finished slice ({plate, stats, gcode, throughput}), the payload too big to belong on onEvent.
export default function Viewport({
  settings = {}, setSettings = () => {}, plateSettings = {}, setPlateSettings = () => {},
  processPanel = null, motionPanel = null, filamentPanel = null,
  panels = null, features = null, gcode = null, sl1 = null, files = null, defaultExtruderColors = null, defaultAutoSlice = false,
  sliceRequest = null, onEvent = null, onSliced = null, onSliceRun = null, onExport = null, catalog: catalogProp, slicer: useSlicer = useNoopSlicer,
}) {
  // Two frames, one derivation (core/plate_settings.js plateContext): `globalFrame` is the GLOBAL map's own —
  //  what is laid out once (the uniform grid cell, a project import's fallback bed, the 3mf stride, the global
  //  bed inputs); `ctx` (assigned below the state block — it needs selectedPlate; showPanel closes over `tech`)
  //  is the SELECTED PLATE's, and every per-plate decision reads it or `frameOf(plate)`. Nothing reads the
  //  global map for a plate-level fact any more — test_layers.mjs guards that.
  const DIMS = { fffDims: deriveKernelParams, slaDims: deriveSlaParams }
  const globalFrame = plateContext(settings, null, 0, DIMS)
  const globalTech = globalFrame.tech
  // A panel is shown unless the host explicitly said false — an unknown key is therefore visible, so a panel added
  //  later does not silently disappear for hosts that listed the ones they wanted.
  //  A second, technology-driven cut on top of the host contract: the FFF-only panels (extruder colours, the prime
  //  tower, the support/material brushes) make no sense against a resin printer and are dropped as a set — the
  //  mirror of how upstream tabs declare supports_printer_technology(). The resin card takes the filament card's
  //  place through the same mechanism.
  const FFF_PANELS = ['filamentCard', 'towerCard', 'paintPanel']
  const showPanel = (name) => panels?.[name] !== false
    && !(tech === 'SLA' && FFF_PANELS.includes(name))
    && !(tech !== 'SLA' && name === 'resinCard')
  // Opening the file dialog goes through here from all three entry points (top bar, empty hint, object toolbar),
  //  so features.filePicker cannot be honoured in two of them and forgotten in the third.
  const openFilePicker = () => { if (feature('filePicker')) fileInputRef.current?.click() }
  // `features` is the same contract for BEHAVIOUR that `panels` is for visibility: opt-out only, everything on by
  //  default, an unknown key enabled. Two axes rather than one because "is this panel drawn" and "does this
  //  component take over the page's keyboard" are different questions, and a host usually has an opinion on one
  //  without having one on the other.
  const feature = (name) => features?.[name] !== false
  // Console output is module-level (log.js) rather than threaded through every factory — see the note there.
  useEffect(() => { setLogging(feature('logs')) }, [features])   // eslint-disable-line react-hooks/exhaustive-deps
  // Read through refs: both are called from effects and from callbacks built in other modules, which capture the
  //  props of the render they were created in. The ref is always the latest one the host passed.
  const onEventRef = useRef(onEvent); onEventRef.current = onEvent
  const onSlicedRef = useRef(onSliced); onSlicedRef.current = onSliced

  const apiRef = useRef(null)
  const workerRef = useRef(null)
  const objectsRef = useRef([])        // [{id,name,mesh,localPos}]
  const layersDataRef = useRef(null)   // layer data of the focused (selected) plate — alias
  const toolpathRef = useRef(null)     // stage 24: the makeToolpath() controller — alias for the focused plate (slider/travel target)
  const segDataRef = useRef(null)      // stage 25: buildSegmentData result — alias for the focused plate (for recomputing view-type colors)
  const plateTpRef = useRef({})        // the real per-plate toolpaths {idx: {group, ctl, seg}} — all plates render at once
  const keyRef = useRef(null)          // shortcut handler (component scope — captures the latest state). The effect only forwards.
  const clipboardRef = useRef(null)    // in-app copy buffer (object snapshot) — the OS clipboard is not used
  const canvasModeRef = useRef('prepare')  // S2: interaction gating (gizmo/painting disabled in preview)
  const lineWidthRef = useRef(DEFAULT_LINE_WIDTH)    // line_width of the last slice (default width; layer height is derived from the z increment by buildSegmentData)
  // Stage 20: manual support painting (enforcer/blocker), extended to material painting (paint a region onto
  //  another extruder). One mode variable, because one facet carries one selector state — see support_paint.js.
  const paintModeRef = useRef('off')   // 'off' | 'enforcer' | 'blocker' | 'material'
  const paintXformRef = useRef(null)    // {cx,cy,minz} kernel transform (object STL bbox)
  const paintOverlayRef = useRef(null)  // Mesh[] — one per painted selector state (1..16)
  const selectorGeomRef = useRef(null)  // {identity, topology} of the mesh the kernel's selector holds (null = none)
  const registerSelectorRef = useRef(null)  // set below, from makeSupportPaint — the scene hook is built first
  const flushPaintRef = useRef(null)        // same factory: the selector's strokes back onto the objects (paint_store.js)
  const selectPlateRef = useRef(null)       // set below, from makePlateActions — same reason
  const recordHistoryRef = useRef(null)     // set below, from the undo history — the scene hook is installed first
  // Stage 29-2: multiple plates (minimal S7). Plate i sits at three-x offset PX_i = i*(bedW+GAP).
  const plateResultsRef = useRef({})    // {plateIdx: sliceResult} cache
  const plateOffsetsRef = useRef({})    // {plateIdx: {offX, offZ}} toolpath display offset (the plate's own origin)
  const selectedPlateRef = useRef(0)
  const plateCountRef = useRef(1)
  const placeXRef = useRef(0)           // object placement cursor within the selected plate (plate-relative)

  const [ok, setOk] = useState(true)
  const [gmode, setGmode] = useState('translate')
  const [status, setStatus] = useState('Initializing…')
  const [objects, setObjects] = useState([])
  const [triWarn, setTriWarn] = useState('')
  const [slicing, setSlicing] = useState(false)
  // The label an export is currently showing, or null when idle. A string rather than a boolean because the two
  //  export buttons say different things, and the one that is running is the one that has to say it.
  const [exporting, setExporting] = useState(null)
  // Set to the filename once an SL1 is BUILT but could not be downloaded on the same click (see exportPlateSl1).
  const [sl1Ready, setSl1Ready] = useState(null)
  const [autoSlice, setAutoSlice] = useState(!!defaultAutoSlice)   // G004: debounced auto re-slice on settings change
  const autoTimerRef = useRef(0)
  const [progress, setProgress] = useState(0)
  const [sliceRate, setSliceRate] = useState(0)   // layers/second while a slice runs, 0 between them (use_slicer computes it)
  const [kernelKind, setKernelKind] = useState(null)   // 'mt' | 'st' once the worker has loaded — a measured 9.8x apart, so it is shown
  const [error, setError] = useState('')
  const [stats, setStats] = useState(null)
  const [overBed, setOverBed] = useState(false)
  // The same verdict as overBed, but reached without slicing: recomputed whenever the plate's contents move, so a
  //  model dragged off the bed says so immediately instead of after the next slice. Null = everything fits.
  const [bedOver, setBedOver] = useState(null)
  const [layerCount, setLayerCount] = useState(0)
  const [segCount, setSegCount] = useState(0)   // stage 24: number of rendered segments (instances)
  const [plateCount, setPlateCount] = useState(1)       // stage 29-2: plate count
  const [settingsScope, setSettingsScope] = useState('global')  // process panel writes: 'global' | 'plate' (the selected one)
  const [selectedPlate, setSelectedPlate] = useState(0) // selected plate (0-based)
  const { plateRun, setPlateRun, autoWorkers, cores, memoryWorkers } = useSliceRun({ onSliceRun, kernelKind, plateCount, objects })   // an all-plates run's state (use_slice_run.js)
  const ctx = plateContext(settings, plateSettings, selectedPlate, DIMS)   // the SELECTED plate (see the note at globalFrame)
  const tech = ctx.tech
  const overridePlates = Object.keys(plateSettings ?? {}).filter(i => overriddenPlateKeys(plateSettings, i).length).map(Number)   // PlateBar dots + object-list headers
  const onResetPlate = overridePlates.includes(selectedPlate) ? () => setPlateSettings(ps => { const next = { ...ps }; delete next[selectedPlate]; return next }) : null
  const scopeProps = { plateSettings, setPlateSettings, plateCount, selectedPlate, settingsScope, setSettingsScope, onResetPlate }   // the settings cards' shared scope
  const [sliceMenu, setSliceMenu] = useState(false)     // whether the [Slice ▾] dropdown is open
  const [showHelp, setShowHelp] = useState(false)       // '?' shortcut help overlay
  const [slicedPlateCount, setSlicedPlateCount] = useState(0)   // number of plates holding a result (drives the export-all button)
  const [ctxMenu, setCtxMenu] = useState(null)          // right-click context menu {x, y, onObject}
  // The scene owns the selection; this is a read-only mirror so the object list and the context menu can render
  //  from it. Pushed by the scene through onSelectionChanged rather than polled, because a click has to repaint
  //  the list in the same frame it repaints the highlight.
  const [selectedIds, setSelectedIds] = useState([])
  // Stage 25 S6: view type + dual slider + gradient legend
  const [viewType, setViewType, viewTypeRef] = useStateRef('feature')   // stage 25: view type (feature/speed/height/width/fan/temp)
  const [colorRange, setColorRange] = useState(null)   // {min,max,label,unit,cont}
  const [layerLo, setLayerLo, layerLoRef] = useStateRef(0)   // stage 25: dual slider lower/upper bound (0-based layer)
  const [layerHi, setLayerHi, layerHiRef] = useStateRef(0)
  const [singleLayer, setSingleLayer] = useState(false)
  const [roleLegend, setRoleLegend] = useState([])          // S6.3: length share per role
  const [canvasMode, setCanvasMode] = useState('prepare')   // S2: 'prepare' (model+gizmo+painting) | 'preview' (toolpaths)
  const [dragOver, setDragOver] = useState(false)           // stage 26 R4: drag-and-drop highlight
  const fileInputRef = useRef(null)
  const presetInputRef = useRef(null)     // its own picker: the model picker's accept list is model formats
  const settingsForPresetRef = useRef(settings); settingsForPresetRef.current = settings
  // Stage 27 S4: filament (extruder) colors — applied to object meshes and the prime tower. Defaults to T1/T2.
  const initialColors = (Array.isArray(defaultExtruderColors) && defaultExtruderColors.length)
    ? defaultExtruderColors.slice(0, MAX_PAINT_EXTRUDERS) : DEFAULT_FILAMENT_COLORS.slice(0, 2)
  const [extruderColors, setExtruderColors, extruderColorsRef] = useStateRef(initialColors)
  const [gcodeUrl, setGcodeUrl] = useState('')
  const [showTravel, setShowTravel, showTravelRef] = useStateRef(false)
  // Ring or real WipeTower, per plate: the settings key `wipe_tower_real` (a viewer knob, not a schema key). Off
  //  until the ported WipeTower is deterministic. It was briefly the default here on the grounds that the fallback
  //  ring purges nothing — true, but the real tower emits F0 feedrates and produces a different file on every run
  //  of the same input (see params.h), and shipping unreproducible G-code by default is the worse of the two.
  //  The card still offers it. This is the SELECTED plate's value, for the card; the boxes read each plate's own.
  const [paintMode, setPaintModeState] = useState('off')      // stage 20: painting mode (support brush or material brush)
  const [materialExtruder, setMaterialExtruder, materialExtruderRef] = useStateRef(0)   // 0-based extruder the material brush writes (null = eraser)
  // "Which filament am I working on" is ONE choice with two places to make it — the card's rows and the brush's
  //  chips (and the number row) — so it is held here rather than inside either. The brush's own value can also be
  //  null, which the card has no equivalent for: that is the eraser, not a filament, so it leaves this alone.
  const [activeFilament, setActiveFilament] = useState(0)
  const [brushRadius, setBrushRadius, brushRadiusRef] = useStateRef(5)
  // Painting tool selection, shared by both brushes (they drive one selector — see support_paint.js). The pointer
  //  handler reads it through a ref because it lives in an effect that must not be rebuilt on every slider move.
  const [paintTool, setPaintTool] = useState('brush')      // 'brush' | 'smart' | 'bucket' | 'triangle'
  // Circle is upstream's default brush (GLGizmoMmuSegmentation is constructed with CircleButtonIcon), and the
  //  reason is the one visible in any hull: the sphere is a ball around the hit, so on a thin wall it paints the
  //  far side too. Sphere stays one click away for when reaching through IS what you want.
  const [brushCursor, setBrushCursor] = useState('circle') // 'sphere' | 'circle' — brush only
  const [fillAngle, setFillAngle] = useState(30)           // smart/bucket fill angle limit, degrees
  const [axisLock, setAxisLock] = useState('none')         // 'none' | 'vertical' | 'horizontal' — upstream's Vertical/Horizontal checkboxes
  const [overhangOnly, setOverhangOnly] = useState(false)  // upstream's "on overhangs only" (m_paint_on_overhangs_only)
  const paintToolRef = useRef({ tool: 'brush', cursor: 'circle', angle: 30, axisLock: 'none' })
  useEffect(() => { paintToolRef.current = { tool: paintTool, cursor: brushCursor, angle: fillAngle, axisLock } }, [paintTool, brushCursor, fillAngle, axisLock])
  const [paintCounts, setPaintCounts] = useState({ enf: 0, blk: 0 })
  // Painted facets per selector state (1..16) as the worker reports them, kept apart from the enf/blk pair above
  //  because the two arrive through different worker listeners — see support_paint.js. Empty until a stroke lands.
  const [paintStateCounts, setPaintStateCounts] = useState({})
  // buildParams reads the painted states at slice time, which is a user action and so always follows a render —
  //  but it runs inside useSlicer's closure, so it needs a ref rather than the value captured when that hook ran.
  const paintStateCountsRef = useRef({})
  useEffect(() => { paintStateCountsRef.current = paintStateCounts }, [paintStateCounts])
  // Stage 30 OOM ladder UI: economy-mode completion notice + downgrade offer (simplified retry)
  const [sliceNotice, setSliceNotice] = useState('')       // e.g. "Memory pressure — finished in economy mode (no preview)"
  const [downgradeOffer, setDowngradeOffer] = useState(null) // {scope} — even economy mode failed -> offer a simplified retry

  // ---- Host change notifications (onEvent) — the effects live in use_host_events.js ----
  useHostEvents(onEventRef, {
    canvasMode, objects, selectedPlate, plateCount, extruderColors, autoSlice, slicing, progress, sliceRate,
    viewType, paintMode, layerCount, error, notice: sliceNotice, layerLo, layerHi,
  })

  // ---- The shared wiring: every ref and setter that more than one module needs, written down ONCE ----
  //  Measured before this existed: 13 factory calls listing 124 names across 137 lines, of which 43 names were
  //  being spelled out again in a second, third or seventh call (`setError` and `apiRef` seven times each). The
  //  factories destructure only the names they use, so handing each one the whole set costs nothing at runtime and
  //  loses no documentation — the destructuring block at the top of every actions/ file is still the list of what
  //  that module actually touches, and it is the one worth reading.
  //  Rebuilt every render, exactly as the individual literals were: the factories are rebuilt every render too.
  //  Not in here: `fileInputRef`/`presetInputRef` (one picker each, and makePresetActions takes the OTHER one under
  //  the same key — a spread would make that a silent ordering question), and anything produced by a factory
  //  further down, which cannot exist yet.
  const wiring = {
    catalog: catalogProp, settings, setSettings, plateSettings, setPlateSettings,
    apiRef, workerRef, objectsRef, keyRef, clipboardRef, onSlicedRef, flushPaintRef,
    layersDataRef, toolpathRef, segDataRef, plateTpRef, lineWidthRef, plateResultsRef, plateOffsetsRef,
    selectedPlateRef, plateCountRef, placeXRef, canvasModeRef, selectorGeomRef, registerSelectorRef,
    paintXformRef, paintOverlayRef, paintModeRef, paintToolRef,
    brushRadiusRef, materialExtruderRef, extruderColorsRef, showTravelRef, viewTypeRef, layerLoRef, layerHiRef,
    setOk, setStatus, setGmode, setCtxMenu, setBrushRadius, setObjects, setTriWarn, setDragOver, setExporting, setSl1Ready,
    setProgress, setSliceRate, setSlicing, setError, setStats, setOverBed, setLayerCount, setLayerLo, setLayerHi,
    setPlateRun, setSegCount, setColorRange, setRoleLegend, setGcodeUrl, setCanvasMode, setSliceNotice, setDowngradeOffer,
    setPaintCounts, setPaintModeState, setPaintStateCounts, setFillAngle,
    setSlicedPlateCount, setSliceMenu, setPlateCount, setSelectedPlate,
  }

  // ---- three.js scene (renderer/camera/controls/pointer handlers + the imperative apiRef surface) ----
  const { mountRef, three } = useThreeScene({
    ...wiring,
    contextMenu: feature('contextMenu'),
    // Dragging the tower box is how a position becomes chosen: it writes the same wipe_tower_x/y the card edits,
    //  so the two controls are one setting seen two ways.
    //  The drop lands in world coordinates and the setting is a bed coordinate, so the plate's origin comes back
    //  off — the same conversion the box's placement makes going the other way.
    // A move/rotate/scale changes the coordinates the kernel's selector holds, so it has to be handed the new
    //  ones — otherwise the overlay stays where the model was and a slice projects the paint there too. Gated on
    //  the selector EXISTING, not on paint mode being on: in paint mode the gizmo is detached, so every real move
    //  happens with the panel closed — a paint-mode gate would never fire. Through a ref because the paint module
    //  is built further down and this handler is installed once.
    onTransformCommitted: () => { if (selectorGeomRef.current) registerSelectorRef.current?.(); refreshObjects() },   // refreshObjects re-annotates plate membership + runs checkBed
    // A gizmo/corner drag reports only that it ENDED, and by then the mesh already holds the new pose — so the
    //  undo entry is taken at the start of the drag, where the old one is still readable.
    onTransformStarted: () => recordHistoryRef.current?.('drag'),
    // Clicking a plate in the viewport selects it, so the tab bar is no longer the only way to switch. Through a
    //  ref because the scene installs its handlers once and makePlateActions is built further down.
    onPlateClicked: (i) => { if (i !== selectedPlateRef.current) selectPlateRef.current?.(i) },
    onSelectionChanged: () => setSelectedIds(apiRef.current?.selectedObjectIds?.() ?? []),
    //  The drag can land on any plate's box, and each plate's position is its own array entry — the origin
    //  subtracted is the dragged box's own plate, and only that plate's entry is written, so the other plates'
    //  towers stand still (writeTowerPosition owns the array/legacy-scalar mechanics).
    onTowerMoved: (x, y, plate) => {
      const idx = plate ?? selectedPlateRef.current
      const o = apiRef.current?.platePos?.(idx) ?? { x: 0, z: 0 }
      const frame = frameOf(idx)
      // Kept on the plate's bed: a drop past the edge lands at the edge instead of slicing a tower off the bed.
      const [bedX, bedY] = clampTowerPosition(x - o.x + frame.bedW / 2, y + o.z + frame.bedD / 2,
        { bedW: frame.bedW, bedD: frame.bedD, size: towerFootprint(frame.params, !!frame.effective.wipe_tower_real) })
      setSettings(s => writeTowerPosition(s, idx, plateCountRef.current,
        Math.round(bedX * 10) / 10, Math.round(bedY * 10) / 10))
    },
  })

  // The frame of any plate, read through refs: the scene installs its handlers once, and checkBed runs from
  //  effects and callbacks that would otherwise see the render they were created in.
  const frameOf = (plate) => plateContext(settingsRef.current, plateSettingsRef.current, plate, DIMS)
  // The global frame in ref form for the 3mf writer's plate stride (uniform by construction — mixed beds are refused).
  const bedRef = useRef({ bedW: DEFAULT_BED.width, bedD: DEFAULT_BED.depth, bedH: 0 })
  bedRef.current = { bedW: globalFrame.bedW, bedD: globalFrame.bedD, bedH: globalFrame.bedH }
  // checkBed rides along because the bed can change WITHOUT anything moving — a printer pick, or the FFF->SLA
  //  switch (the resin display is a fraction of a filament bed); a stale null here hid the over-bed state until
  //  the slice reported it, which surfaced as an Export button disabled for no visible reason.
  useEffect(() => {
    const moved = apiRef.current?.setPlates(plateCount, globalFrame.bedW, globalFrame.bedD, selectedPlate, plateDimsList(settings, plateSettings, plateCount, { w: globalFrame.bedW, d: globalFrame.bedD }, deriveKernelParams, deriveSlaParams))
    if (moved && selectorGeomRef.current) registerSelectorRef.current?.()   // objects followed their plates — same re-registration a drag commit runs
    if (moved) refreshObjects(); else checkBed()   // refreshObjects re-annotates plate membership and runs checkBed itself
  }, [globalFrame.bedW, globalFrame.bedD, plateCount, selectedPlate, plateSettings])   // eslint-disable-line react-hooks/exhaustive-deps

  // "Does this fit on the bed?" for the plate on screen — reads refs only (the scene installs handlers once).
  function checkBed() {
    const api = apiRef.current; if (!api) { setBedOver(null); return }
    const plate = selectedPlateRef.current
    const { bedW, bedD, bedH } = frameOf(plate)   // the plate's own frame — display or bed
    const origin = api.platePos?.(plate) ?? { x: 0, z: 0 }
    setBedOver(bedOverflow(api.modelBounds?.(plate), origin, bedW, bedD, bedH))
  }
  useEffect(checkBed, [objects.length, selectedPlate, plateSettings, globalFrame.bedW, globalFrame.bedD, globalFrame.bedH])   // eslint-disable-line react-hooks/exhaustive-deps

  // The tower stand-in follows the same rules the slicer applies, PER PLATE: a plate gets a tower when it changes
  //  tools itself, its effective settings leave the tower on, and it is not resin; its footprint is its own derived
  //  width (or the ring's 15mm), and an unset position means "beside the model". Before this the whole scene was
  //  asked once — a plate printing on T1 alone got a box because another plate switched tools, one plate's Off hid
  //  every box, and a per-plate width drew the global one. Recomputed here so the box and the slice read one source.
  useEffect(() => {
    const api = apiRef.current; if (!api) return
    if (extruderColors.length < 2 || canvasMode !== 'prepare' || objects.length === 0) { api.setPrimeTower?.(null); return }
    const frames = Array.from({ length: plateCount }, (_, plate) => plateContext(settings, plateSettings, plate, DIMS))
    // Two filaments LOADED is not a tower — a tool change is (usesMultipleTools). The live paint counts are the
    //  selector's and speak for the plate it holds; every other plate's paint is on its objects (paint_store.js).
    const selectorPlate = selectorGeomRef.current?.plate
    const changesTools = (plate) => {
      const onPlate = objects.filter(o => o.plate === plate)
      const stored = () => storedPaintStates(onPlate.map(row => objectsRef.current.find(o => o.id === row.id)).filter(o => o && o.visible !== false))
      return usesMultipleTools(onPlate, plate === selectorPlate ? paintStateCounts : stored())
    }
    // enable_prime_tower is read the way deriveKernelParams reads it: absent leaves the kernel's tower on.
    const towerOn = (effective) => !('enable_prime_tower' in effective) || !!effective.enable_prime_tower
    api.setPrimeTower?.(towerBoxes({
      plateCount, settings,
      bedOf: (plate) => ({ w: frames[plate].bedW, d: frames[plate].bedD }),
      towerOf: (plate) => ({
        on: frames[plate].tech !== 'SLA' && towerOn(frames[plate].effective) && changesTools(plate),
        size: towerFootprint(frames[plate].params, !!frames[plate].effective.wipe_tower_real),
      }),
      modelBounds: (plate) => api.modelBounds?.(plate),
      plateOrigin: (plate) => api.platePos?.(plate),
    }))
  }, [extruderColors.length, canvasMode, objects, paintStateCounts, settings, plateSettings, selectedPlate, plateCount])   // eslint-disable-line react-hooks/exhaustive-deps

  // S2: Prepare|Preview modes — group visibility + interaction gating
  useEffect(() => {
    canvasModeRef.current = canvasMode
    const t = three.current; if (!t.toolpathGroup) return
    const preview = canvasMode === 'preview'
    t.toolpathGroup.visible = preview
    if (t.objectsGroup) t.objectsGroup.visible = !preview && objectsRef.current.length > 0
    if (preview) {                                   // Preview: force gizmo/painting off
      apiRef.current?.detachTransform()
      if (paintModeRef.current !== 'off') setPaintMode('off')
    }
  }, [canvasMode])

  // ---- Toolpath build (stage 24: upstream libvgcode GPU instancing / all plates rendered at once) ----
  const {
    disposePlateToolpath, clearToolpaths, buildPlateToolpath, ensurePlateToolpaths,
    applyViewColors, rebuildToolpaths, applyLayerRange,
  } = makeToolpathView({ ...wiring, three })

  // ---- Worker lifecycle + progress (SAB polling) + streaming/watchdog/OOM ladder (stage 30) ----
  const { getWorker, cancelSlice, runSlice, pendingSliceRef, downgradeRef, createPoolContext, kernelKindRef, progressSinkRef } = useSlicer({
    ...wiring, paintStateCountsRef, setKernelKind, rebuildToolpaths,
    // Deferred through a lambda: makeSupportPaint is built below and cannot be in `wiring` yet.
    rebuildPaintOverlay: (enf, blk, overlays) => rebuildPaintOverlay(enf, blk, overlays),
    warmup: feature('warmup'), quiet: !feature('logs'),
  })

  // ---- Stage 20: manual painting — the support brush (enforcer/blocker) and the material brush ----
  const { rebuildPaintOverlay, setPaintMode, clearPaint, registerSelector, flushPaint } = makeSupportPaint({
    ...wiring, three, getWorker, paintStateCountsRef,
  })
  registerSelectorRef.current = registerSelector
  flushPaintRef.current = flushPaint

  // ---- Per-plate slicing/caching/export + the plate tabs (stage 29-2) ----
  const {
    showPlateResult, refreshSlicedCount, exportAllGcode, exportPlateSl1, importSl1, onSlice, retryDowngrade, addPlate, deletePlate, selectPlate,
  } = makePlateActions({
    ...wiring, canvasMode, downgradeOffer, onExport, downgradeRef,
    runSlice, createPoolContext, kernelKindRef, progressSinkRef,
    ensurePlateToolpaths, buildPlateToolpath, applyViewColors, disposePlateToolpath,
    // The selector worker's kernel reads its painting from the selector, so before it cuts ANY plate the selector
    //  must hold that plate's mesh — loaded from the per-object store when it is another one. A move can also reach
    //  a slice without a gizmo commit (keyboard nudge, plate re-arrange). Needed when a selector exists (it may hold
    //  another plate) or the plate carries stored paint; the caller awaits it before posting the slice.
    syncPaintSelector: (merged) => (selectorGeomRef.current || merged?.paint?.color || merged?.paint?.supports)
      ? registerSelectorRef.current?.(merged) : Promise.resolve(),
  })
  selectPlateRef.current = selectPlate

  // Presets before model loading: loadFiles routes preset extensions to loadPresetFile, so the reader has to
  //  exist first. (The file side of the printer card; also reached by drop and the `files` prop.)
  const { exportPrinterPreset, loadPresetFile, openPresetPicker } = makePresetActions({
    ...wiring, onExport, settingsRef: settingsForPresetRef, fileInputRef: presetInputRef,
  })

  // The filament palette (actions/filament_colors.js) — it also mirrors every change into `filament_colour`,
  //  which is the settings key the panel edits and a 3mf save writes. Built before the model loader because a
  //  project import adopts its filament list through `replaceAll`, and that has to run BEFORE the per-object
  //  extruder assignment: setObjectExtruder colours an object by looking its extruder up in this list, so with the
  //  default two cards every object above T2 would stay T1-coloured.
  const { setExtColor, addFilament, removeFilament, replaceAll: applyProjectFilaments } = makeFilamentColors({
    ...wiring, setExtruderColors, refreshObjects, applyViewColors, selectFilament,
  })

  // ---- Stage 26: model loading (STL/OBJ/3MF/AMF/PLY, cumulative) — shared by the file picker, drag-and-drop
  //  and the `files` prop ----
  const { loadFiles, onFiles, removeObject, onDrop, onDragOver, onDragLeave } = makeModelLoad({
    ...wiring, dragOver, clearToolpaths, refreshSlicedCount, applyProjectFilaments, importSl1, loadPresetFile,
    selectedPlateRef, disposePlateToolpath, bedRef,
  })

  // Initial content (the `files` prop): mount-only import + a warning on a later change (use_initial_files.js).
  useInitialFiles({ files, loadFiles })

  // ---- Project export: "save as" a 3mf project, or the plain geometry as an STL ----
  //  settings/bed are read through refs because the actions are async (the painting comes back from the worker) and
  //  must use the values in effect when they FINISH, not when the button was bound.
  const settingsRef = useRef(settings); settingsRef.current = settings
  const plateSettingsRef = useRef(plateSettings); plateSettingsRef.current = plateSettings   // same reason, same shape
  const { exportProject, exportSTL, exportSelectedProject, exportSelectedSTL } = makeExportActions({
    ...wiring, onExport, getWorker, settingsRef, plateSettingsRef, bedRef,
  })

  // Auto re-slice after a settings or model change (use_slice_request.js has the debounce and the guards).
  useAutoSlice({ autoSlice, settings, plateSettings, objectCount: objects.length, gcode, sl1, pendingSliceRef, cancelSlice, onSlice, autoTimerRef })

  // The host's Slice button — an identity change on the prop requests one slice (use_slice_request.js).
  useSliceRequest({ sliceRequest, objectCount: objects.length, gcode, sl1, pendingSliceRef, cancelSlice, onSlice, autoTimerRef })

  // A settings change makes every cached result stale — drop them rather than keep showing one (use_stale_slice.js).
  useStaleSlice({ settings, plateSettings, setPlateSettings, setStatus, gcode, sl1, plateResultsRef, selectedPlateRef, canvasModeRef,
    clearToolpaths, showPlateResult, refreshSlicedCount, setCanvasMode })

  // ---- The move scrub: how far into the top shown layer the print has got (use_move_scrub.js) ----
  const moveScrub = useMoveScrub({
    layerLo, layerHi, layerCount, canvasMode,
    apiRef, toolpathRef, plateOffset: plateOffsetsRef.current[selectedPlate], onEventRef,
  })

  // ---- Injection: the `gcode` and `sl1` props, rendered on the selected plate without running the kernel ----
  useInjection({
    gcode, sl1, importSl1, tech, kp: { ...ctx.params, bed_width: ctx.bedW, bed_depth: ctx.bedD },   // the SELECTED plate's params — injected content renders on it
    apiRef, selectedPlateRef, plateCountRef, plateOffsetsRef, plateResultsRef,
    lineWidthRef, refreshSlicedCount, setError, setSliceNotice, showPlateResult,
  })

  // Editing bed width x depth on the printer card — reduced to a printable_area rectangle (origin preserved). Circular/custom shapes belong to the panel editor.
  //  Under SLA the same inputs edit the resin display's physical size instead: display_width/display_height are
  //  what slice_sla judges over-bed against and what the SL1 raster maps mm onto — printable_area never reaches it.
  function setBedSize(w, d) {
    if (!(w > 0) || !(d > 0)) return
    if (globalTech === 'SLA') { setSettings(s => ({ ...s, display_width: w, display_height: d })); return }   // global map only (inputs disabled in plate scope)
    setSettings(s => ({ ...s, printable_area: bedRectangle(settingRaw(settings, 'printable_area'), w, d) }))
  }
  function setObjExtruder(id, e) { recordHistoryRef.current?.(); apiRef.current?.setObjectExtruder(id, e); setObjects(objectRows(objectsRef.current, apiRef.current)) }

  // The preview card's controls — the dual layer slider, single-layer mode, the view type, travel (actions/preview_controls.js).
  const { setRange, onLo, onHi, toggleSingle, onViewType, onToggleTravel } = makePreviewControls({
    ...wiring, layerCount, singleLayer, setSingleLayer, setViewType, setShowTravel, applyLayerRange, applyViewColors,
  })
  // A multi-tool slice landing on the Feature type view paints walls orange and infill blue — which reads as "my
  //  filaments are gone", when the data has them (measured complaint: painted model, by-tool split present, screen
  //  all orange). Land on the Filament view instead. Only from the untouched default: a view the user picked stays.
  useEffect(() => {
    if (!stats) return
    const perTool = plateResultsRef.current[selectedPlateRef.current]?.stats?.filament_mm_by_tool
    const usedTools = Array.isArray(perTool) ? perTool.filter(mm => mm > 0).length : 0
    if (usedTools > 1 && viewTypeRef.current === 'feature') {
      setViewType('filament'); applyViewColors()
    }
  }, [stats])   // eslint-disable-line react-hooks/exhaustive-deps
  // Plate-scoped support state for the Objects card (core/support_settings.js — reads the selected plate's
  //  effective map, writes its override; overhang shading below uses the same threshold the kernel slices with).
  const { writePlateKey, onToggleSupport, supportOn, supportOnOf, supportStyles, supportStyle,
    supportFilament, supportInterfaceFilament, overhangAngle } =
    makeSupportSettings({ settings, plateSettings, setPlateSettings, setSettings, plateCount, selectedPlate })
  const [overhangOn, setOverhangOn] = useState(false)
  useEffect(() => {
    apiRef.current?.setOverhang(overhangOn && canvasMode === 'prepare' ? overhangAngle : null)
  }, [overhangOn, overhangAngle, canvasMode, objects.length])   // eslint-disable-line react-hooks/exhaustive-deps
  // "On overhangs only" restricts every stroke to facets steeper than the SUPPORT threshold — the same angle the
  //  overhang view shades, which is upstream's pairing too (m_highlight_by_angle_threshold_deg serves both).
  useEffect(() => {
    getWorker()?.postMessage({ cmd: 'paintMode', overhangDeg: overhangOnly ? overhangAngle : 0 })
  }, [overhangOnly, overhangAngle, paintMode])   // eslint-disable-line react-hooks/exhaustive-deps
  // Stage 27 S4: filament colors/count + per-object print toggle + painting gizmo mode
  function refreshObjects() { setObjects(objectRows(objectsRef.current, apiRef.current)); checkBed() }

  // ---- Undo/redo, viewport scope (use_viewport_history.js; history.js holds the reasoning and the boundary) ----
  const { depth: historyDepth, record: recordHistory, travel: travelHistory } = useViewportHistory({
    capture: () => apiRef.current?.sceneSnapshot() ?? [],
    //  Restoring is a move like any other, so it has to do a move's commit work: hand the kernel's selector the
    //  new coordinates and re-run the bed check, or the paint overlay stays where the model used to be.
    onRestore: (snapshot) => {
      apiRef.current?.restoreScene(snapshot)
      refreshObjects()
      if (selectorGeomRef.current) registerSelectorRef.current?.()
    },
    isPreview: () => canvasModeRef.current === 'preview',
  })
  recordHistoryRef.current = recordHistory
  //  Bound to the component root (see the JSX), so it never reaches the host application's own Ctrl+Z.
  function onShellKey(e) {
    if (!feature('shortcuts')) return
    const direction = undoRedoDirection(e)
    if (!direction) return
    e.preventDefault(); e.stopPropagation()
    travelHistory(direction)
  }
  function toggleObjVisible(id) { recordHistoryRef.current?.(); const o = objectsRef.current.find(x => x.id === id); apiRef.current?.setObjectVisible(id, !(o?.visible !== false)); refreshObjects() }
  // Both brushes take the pointer away from the gizmos, so the rail/object-card toggle reads "a brush is active"
  //  rather than "the support brush is active": while material painting, the move gizmo must not look selected.
  //  Which brush is active is what the two floating panels below say.
  const supportPainting = paintMode === 'enforcer' || paintMode === 'blocker'
  // The rail button and the object card's button are the SUPPORT brush's entry point, so pressing them always ends
  //  up in support painting — from material painting that means switching, which is what "entering one leaves the
  //  other" has to look like from the user's side. Only pressing it while already support painting turns it off.
  function togglePaintGizmo() { if (tech === 'SLA') return; setPaintMode(supportPainting ? 'off' : 'enforcer') }
  // Entering material painting from a filament chip: pick the extruder first, then switch the brush, so the first
  //  stroke after the click already carries the right selector state (support_paint stamps it from these refs).
  function startMaterialPaint(extruderIndex) {
    if (tech === 'SLA') return   // the selector paints FFF support/material states — nothing to paint onto a resin slice yet
    const index = Number.isInteger(extruderIndex) ? extruderIndex : null
    setMaterialExtruder(index)
    if (index != null) setActiveFilament(index)   // the eraser is not a filament, so it leaves the card where it was
    if (paintModeRef.current !== 'material') setPaintMode('material')
  }
  // Picking a row in the filament card. It aims the brush too while one is open, which is the whole point of the
  //  two being one selection: the chip you can see lit is the tool the next stroke uses.
  function selectFilament(index) {
    setActiveFilament(index)
    if (paintModeRef.current === 'material') setMaterialExtruder(index)
  }
  // Painted facets per extruder chip (0-based) — the panel and the filament rows both read this by index.
  const materialPaintCounts = paintedCountsPerExtruder(extruderColors.length, paintStateCounts, paintCounts)

  // Object actions (duplicate/copy/paste/delete/split + gizmo mode) — the bodies live in object_actions.js.
  const {
    duplicateSelected, copySelected, pasteClipboard, deleteSelected, deleteAllObjects, splitSelected, setGizmo,
  } = makeObjectActions({ ...wiring, setPaintMode, removeObject, refreshObjects, recordHistory })

  // Object toolbar — the button list lives in toolbar_items.js; only the actions are bound here.
  const OBJECT_TOOLS = objectTools({
    add: openFilePicker,
    remove: deleteSelected,
    removeAll: deleteAllObjects,
    duplicate: duplicateSelected,
    split: splitSelected,
    placeOnBed: () => { recordHistory(); apiRef.current?.placeOnBed() },
    // The toolbar is upstream's entry point for the MMU brush; the filament rows' brush buttons are this viewer's
    //  addition on top, not a replacement. Opening it on T1 is what upstream does — the gizmo starts at
    //  m_selected_extruder_idx 0 — and the panel's chips are one click from any other filament.
    paintMaterial: () => startMaterialPaint(0),
    objectCount: () => objects.length,
  })

  // ---- Keyboard shortcuts (upstream SPECS §4 + PrusaSlicer/Cura conventions) ----
  //  Which keys are live depends on Prepare/Preview. All are ignored while an input widget has focus.
  // features.shortcuts === false leaves keyRef null. The window listener in use_three_scene calls keyRef.current?.(e),
  //  so nothing is matched and nothing is preventDefault'd — which is the point: these bindings are global while the
  //  viewer is mounted, and Ctrl+C in particular would otherwise swallow a host page's own copy.
  keyRef.current = !feature('shortcuts') ? null : makeKeyHandler({
    slicing,
    isPreview: () => canvasModeRef.current === 'preview',
    slice: onSlice, copy: copySelected, paste: pasteClipboard, remove: deleteSelected, duplicate: duplicateSelected,
    stepLayer: (d) => { const v = layerHiRef.current + d; singleLayer ? setRange(v, v) : setRange(layerLoRef.current, v) },
    toggleSingleLayer: toggleSingle,
    toggleTravel: () => onToggleTravel({ target: { checked: !showTravelRef.current } }),
    zoomAll: () => apiRef.current?.frame(), zoomBed: () => apiRef.current?.frameBed(),
    leavePreview: () => setCanvasMode('prepare'),
    setGizmo,
    // The brush's own keys, live only while one is open. V/H toggle the axis lock off when pressed again, because a
    //  lock you cannot see is a lock you cannot leave; the number row is the material brush's alone.
    isPainting: () => paintModeRef.current !== 'off',
    paintTool: setPaintTool, paintCursor: (shape) => { setPaintTool('brush'); setBrushCursor(shape) },
    paintAxisLock: (lock) => setAxisLock(current => (current === lock ? 'none' : lock)),
    pickExtruder: (index) => { if (paintModeRef.current === 'material') startMaterialPaint(index) },
    cancelTool: () => { if (paintModeRef.current !== 'off') setPaintMode('off'); apiRef.current?.detachTransform() },
    selectAll: () => apiRef.current?.selectAllObjects(),
    // Both repeat while the key is held, so they record under a kind: history.js folds a run of them into the one
    //  entry that takes the object back to where it stood before the run started.
    rotateSelected: (rad) => { recordHistory('rotate'); apiRef.current?.rotateSelectedY(rad) },
    nudgeSelected: (dx, dy) => { recordHistory('nudge'); apiRef.current?.nudgeSelected(dx, dy); refreshObjects() },
    toggleHelp: () => setShowHelp(v => !v),
  })

  const nozzleDia = globalFrame.nozzle || settingRaw(settings, 'nozzle_diameter') || '0.4'
  three.current.invalidate?.()   // render on demand: invalidate one frame per React re-render (slider/toggle/state change)

  // Preview controls (view type + dual slider + legend) — placed in the sidebar
  const previewControls = layerCount > 0 && (
    <PreviewControls
      viewType={viewType} onViewType={onViewType} layerCount={layerCount}
      layerLo={layerLo} layerHi={layerHi} segCount={segCount} singleLayer={singleLayer}
      onLayerLo={onLo} onLayerHi={onHi} onToggleSingle={toggleSingle}
      showTravel={showTravel} onToggleTravel={onToggleTravel}
      colorRange={colorRange} roleLegend={roleLegend} extruderColors={extruderColors}
      moveScrub={!stats?.sla && showPanel('moveBar') ? moveScrub : null} />
  )
  // The per-tool filament split and the purge total are kernel stats of the focused plate's cached result
  //  (`filament_mm_by_tool` / `filament_mm_purge` — the names wasm-core/tests/test.mjs asserts). The `stats` state was
  //  reduced in use_slicer/plate_actions before those fields existed, so they are picked up from the raw result here
  //  instead of reshaping that reduction. A kernel that reports neither leaves both undefined, and StatsCard then
  //  renders exactly the single Filament line it always has.
  const statsWithTools = withToolBreakdown(stats, plateResultsRef.current[selectedPlateRef.current]?.stats)
  // The material each filament is, read from the same settings map the filament card writes — so the legend says
  //  "T2 ABS 203.6 mm" rather than leaving the colour swatch to carry the whole identity.
  const asList = (key) => { const raw = settingRaw(settings, key); return Array.isArray(raw) ? raw : (raw ? [raw] : []) }
  const towerStats = towerResultStats(plateResultsRef.current[selectedPlateRef.current], plateResultsRef.current[selectedPlateRef.current]?.towerParams)
  // Once a slice exists the kernel's measurement is the better one — it was taken on the toolpaths that were
  //  actually emitted, so it counts support/skirt/brim, which the viewer's model-bbox check cannot see. Before the
  //  first slice there is nothing to read, and the viewer's own pre-slice measure is all there is.
  const slicedOver = stats?.overBedBy && (stats.overBedBy.x > 0 || stats.overBedBy.y > 0 || stats.overBedBy.z > 0)
    ? stats.overBedBy : null
  const bedOverShown = slicedOver ?? bedOver
  const bedOverText = overflowText(bedOverShown)

  const statsBlock = <StatsCard stats={statsWithTools} overBed={overBed} overBedText={bedOverText}
    overBedModel={stats?.overBedModel !== false} extruderColors={extruderColors}
    filamentTypes={asList('filament_type')} filamentIds={asList('filament_settings_id')} />

  // registerLoader() can add formats, so this is computed at render time.
  // .sl1 rides on the same picker but is not in SUPPORTED_EXT — that list is the MESH loaders', and an archive
  //  of raster masks must not reach them (model_load routes it to importSl1 instead).
  const PICKER_EXT = [...SUPPORTED_EXT, 'sl1']
  const EXT_LABEL = PICKER_EXT.map(e => e.toUpperCase()).join(' · ')

  return (
    <ShadowHost css={THEME_CSS + shadowCss}>
    {/* Ctrl+Z is bound HERE, on the component's own root, not on window like the other shortcuts. It is the one
        shortcut a host application is likely to own as well (text fields, its own editor), so it must not leak out
        of the viewer — an element listener only fires when focus is inside, which is exactly the rule wanted. The
        canvas is given a tabIndex below so that clicking it counts as being inside. */}
    <div className="app-shell" onKeyDown={onShellKey}>
      {/* Shared hidden file input */}
      <input ref={fileInputRef} type="file" accept={PICKER_EXT.map(e => '.' + e).join(',')} multiple onChange={e => { recordHistory(); onFiles(e) }} title={`${EXT_LABEL} (multiple files allowed)`} data-testid="stl-input" style={{ display: 'none' }} />
      <input ref={presetInputRef} type="file" accept={PRESET_ACCEPT}
        onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) loadPresetFile(f) }}
        data-testid="preset-input" style={{ display: 'none' }} />

      {showPanel('topBar') && (
        <TopBar showTabs={ok} canvasMode={canvasMode} onCanvasMode={setCanvasMode}
          previewEnabled={layerCount > 0} onOpen={openFilePicker}
          onSaveProject={exportProject} onExportSTL={exportSTL} canSave={objects.length > 0} exporting={exporting}
          onUndo={() => travelHistory('undo')} onRedo={() => travelHistory('redo')}
          canUndo={historyDepth.undo > 0 && canvasMode === 'prepare'}
          canRedo={historyDepth.redo > 0 && canvasMode === 'prepare'} />
      )}

      <div className="app-body">
        {ok && canvasMode === 'prepare' && showPanel('gizmoRail') && (
          <GizmoRail gizmoMode={gmode} paintMode={paintMode}
            onGizmo={m => { setPaintMode('off'); apiRef.current?.setMode(m) }}
            onTogglePaint={togglePaintGizmo} paintEnabled={tech !== 'SLA'} />
        )}

        {/* Center viewport */}
        <div className="viewport-col">
          {/* tabIndex + focus on press: a plain div cannot receive key events, which is why every other shortcut
              had to live on window. Ctrl+Z is scoped to this component instead, and this is what lets a click on
              the 3D view count as "inside" it. */}
          <div className={(ok ? 'vp-canvas' : 'vp-canvas fail') + (dragOver ? ' drag-over' : '')} ref={mountRef}
            tabIndex={0} onPointerDown={() => mountRef.current?.focus({ preventScroll: true })}
            {...(feature('drop') ? { onDrop: e => { recordHistory(); onDrop(e) }, onDragOver, onDragLeave } : {})} data-testid="drop-zone">
            {!ok && <div className="vp-fallback">⚠ {status}</div>}
            {ok && objects.length === 0 && canvasMode !== 'preview' && showPanel('emptyHint') && (
              <div className="empty-hint" data-testid="empty-hint">
                <div className="eh-icon">📦</div>
                <div className="eh-title">Drag in a file or pick one</div>
                <div className="eh-sub">{EXT_LABEL}</div>
                <button className="eh-btn" onClick={openFilePicker} data-testid="empty-pick" title={`Pick a ${EXT_LABEL} file (multiple allowed)`}>Choose file</button>
              </div>
            )}
            {dragOver && <div className="drop-overlay" data-testid="drop-overlay">Drop here (STL/OBJ/3MF/AMF/PLY)</div>}
            {ctxMenu && (
              <ContextMenu menu={ctxMenu} onClose={() => setCtxMenu(null)} canPaste={!!clipboardRef.current}
                selectedCount={selectedIds.length}
                actions={{
                  duplicate: duplicateSelected, copy: copySelected, split: splitSelected,
                  placeOnBed: () => apiRef.current?.placeOnBed(), remove: deleteSelected,
                  openFile: openFilePicker, paste: pasteClipboard,
                  zoomAll: () => apiRef.current?.frame(), zoomBed: () => apiRef.current?.frameBed(),
                  exportSelectedSTL, exportSelectedProject,
                }} />
            )}
            {showHelp && <HelpOverlay onClose={() => setShowHelp(false)} />}
          </div>

          {ok && canvasMode === 'prepare' && showPanel('objectToolbar') && <ObjectToolbar tools={OBJECT_TOOLS} />}

          {/* One brush, two targets — the panels are exclusive because the mode is. */}
          {ok && canvasMode === 'prepare' && supportPainting && showPanel('paintPanel') && (
            <PaintPanel paintMode={paintMode} onPaintMode={setPaintMode} onClear={clearPaint}
              overhangOnly={overhangOnly} onOverhangOnly={setOverhangOnly} overhangAngle={overhangAngle}
              brushRadius={brushRadius} paintCounts={paintCounts}
              paintTool={paintTool} onPaintTool={setPaintTool} brushCursor={brushCursor} onBrushCursor={setBrushCursor}
              fillAngle={fillAngle} onFillAngle={setFillAngle} axisLock={axisLock} onAxisLock={setAxisLock}
              onBrushRadius={setBrushRadius} />
          )}

          {ok && canvasMode === 'prepare' && paintMode === 'material' && showPanel('paintPanel') && (
            <MaterialPaintPanel colors={extruderColors} activeExtruder={materialExtruder}
              onSelectExtruder={startMaterialPaint} onClear={clearPaint} onClose={() => setPaintMode('off')}
              brushRadius={brushRadius} paintCounts={materialPaintCounts}
              paintTool={paintTool} onPaintTool={setPaintTool} brushCursor={brushCursor} onBrushCursor={setBrushCursor}
              fillAngle={fillAngle} onFillAngle={setFillAngle} axisLock={axisLock} onAxisLock={setAxisLock}
              onBrushRadius={setBrushRadius} />
          )}

          {/* Over-bed warning while arranging — the answer the stats card only gives after a slice */}
          {ok && canvasMode === 'prepare' && bedOver && showPanel('bedWarn') && (
            <div className="bed-warn" data-testid="bed-warn"
                 title="The printer cannot reach outside its printable volume. Move or rescale the model to export its G-code.">
              ⚠ Beyond the bed by {overflowText(bedOver)}
            </div>
          )}

          {/* Preview stats card, bottom left */}
          {ok && canvasMode === 'preview' && stats && showPanel('statsCard') && (
            <div className="stats-card" data-testid="slice-stats">{statsBlock}</div>
          )}

          {ok && showPanel('plateBar') && (
            <PlateBar plateCount={plateCount} selectedPlate={selectedPlate} maxPlates={MAX_PLATES} overridePlates={overridePlates}
              plateRun={plateRun} onSelect={selectPlate} onAdd={addPlate} onDelete={deletePlate} />
          )}

          {ok && showPanel('status') && <div className="vp-status" data-testid="vp-status">{status}</div>}
        </div>

        {/* S4 right sidebar */}
        {ok && showPanel('sidebar') && (
          <Panel panels={panels} name="sidebar"><aside className="sidebar">
            <div className="sidebar-scroll">
              {showPanel('printerCard') && (
                <Panel panels={panels} name="printerCard">
                  <PrinterCard catalog={catalogProp} bedWidth={globalFrame.bedW} bedDepth={globalFrame.bedD} nozzleDia={nozzleDia} onBedSize={setBedSize}
                    plateFrame={{ w: ctx.bedW, d: ctx.bedD, nozzle: ctx.nozzle }}
                    settings={settings} setSettings={setSettings} motionPanel={motionPanel} {...scopeProps}
                    onExportPreset={exportPrinterPreset}
                    onImportPreset={feature('filePicker') ? openPresetPicker : null} />
                </Panel>
              )}

              {showPanel('filamentCard') && (
                <Panel panels={panels} name="filamentCard">
                  <FilamentCard catalog={catalogProp} colors={extruderColors} onColor={setExtColor} onAdd={addFilament} onRemove={removeFilament}
                    active={activeFilament} onActive={selectFilament}
                    settings={settings} setSettings={setSettings} filamentPanel={filamentPanel} {...scopeProps}
                    paintMode={paintMode} onPaintExtruder={startMaterialPaint} paintCounts={materialPaintCounts} />
                </Panel>
              )}

              {/* The resin card stands where the filament card stood — showPanel routes the two by technology. */}
              {showPanel('resinCard') && (
                <Panel panels={panels} name="resinCard">
                  <ResinCard catalog={catalogProp} settings={settings} setSettings={setSettings} stats={statsWithTools} {...scopeProps} />
                </Panel>
              )}

              {objects.length > 0 && showPanel('objectList') && (
                <Panel panels={panels} name="objectList">
                <ObjectList objects={objects} extruderColors={extruderColors}
                  plateCount={plateCount} selectedPlate={selectedPlate} onSelectPlate={selectPlate} globalTech={globalTech} plateTechOf={(i) => plateTechnology(settings, plateSettings, i)} overridePlates={overridePlates} selectedIds={selectedIds}
                  onSelect={(id, additive) => apiRef.current?.selectObjects([id], additive)}
                  onToggleVisible={toggleObjVisible} onExtruder={setObjExtruder}
                  onSplit={id => { apiRef.current?.selectObject(id); splitSelected() }}
                  onRemove={id => { recordHistory(); removeObject(id) }}
                  supportOn={supportOn} onToggleSupport={onToggleSupport} fffSupport={tech !== 'SLA'}
                  supportOnOf={supportOnOf} onPlateSupport={(p, on) => writePlateKey(p, 'enable_support', on)}
                  overhangOn={overhangOn} onToggleOverhang={e => setOverhangOn(e.target.checked)}
                  overhangAngle={overhangAngle} paintMode={paintMode} onTogglePaint={togglePaintGizmo}
                  supportStyle={supportStyle} supportStyles={supportStyles}
                  onSupportStyle={v => writePlateKey(selectedPlate, 'support_style', v)}
                  supportFilament={supportFilament}
                  onSupportFilament={v => writePlateKey(selectedPlate, 'support_filament', v)}
                  supportInterfaceFilament={supportInterfaceFilament}
                  onSupportInterfaceFilament={v => writePlateKey(selectedPlate, 'support_interface_filament', v)} />
                </Panel>
)}

              {/* A prime tower only exists with a second filament, so the card appears with one. */}
              {extruderColors.length > 1 && showPanel('towerCard') && (
                <Panel panels={panels} name="towerCard">
                <TowerCard settings={settings} setSettings={setSettings} extruderColors={extruderColors} {...scopeProps}
                  towerStats={towerStats}
                  towerFrame={{ bedW: ctx.bedW, bedD: ctx.bedD, size: towerFootprint(ctx.params, !!ctx.effective.wipe_tower_real) }} />
                </Panel>
)}
              {triWarn && <div className="slice-warn side-warn">⚠ {triWarn}</div>}
              {sliceNotice && <div className="slice-warn side-warn" data-testid="slice-notice">ℹ {sliceNotice}</div>}
              {error && <div className="slice-err side-warn" data-testid="slice-err">{error}</div>}
              {downgradeOffer && <button className="slice-btn" data-testid="downgrade-retry" onClick={retryDowngrade} title="Simplify the infill and lower its density to reduce memory pressure, then retry">Simplified retry (simple infill, economy mode)</button>}

              {/* Preview controls (view type / slider / legend) */}
              {canvasMode === 'preview' && previewControls && showPanel('previewControls') && (
                <Panel panels={panels} name="previewControls">
                <section className="side-card">
                  <div className="sc-head">🎚 Preview</div>
                  {previewControls}
                </section>
                </Panel>
)}

              {/* (3) Process (settings panel) — ProcessCard.jsx holds the per-plate scope toggle/projection. */}
              {showPanel('processCard') && (
                <Panel panels={panels} name="processCard">
                <ProcessCard processPanel={processPanel} settings={settings} setSettings={setSettings} {...scopeProps} />
                </Panel>
)}
            </div>

            {showPanel('sliceBar') && (
              <Panel panels={panels} name="sliceBar">
              <SliceBar autoSlice={autoSlice} onAutoSlice={setAutoSlice} slicing={slicing} progress={progress} sliceRate={sliceRate}
                plateCount={plateCount} selectedPlate={selectedPlate} sliceMenuOpen={sliceMenu}
                plateRun={plateRun} kernelKind={kernelKind} workers={Number(settings?.slice_workers) || 0} autoWorkers={autoWorkers} maxWorkers={cores} memoryWorkers={memoryWorkers}
                onWorkers={(n) => setSettings?.(prev => ({ ...prev, slice_workers: n }))}
                onSliceMenu={() => setSliceMenu(v => !v)} slicedPlateCount={slicedPlateCount}
                canSlice={objects.length > 0} onSlice={onSlice} onCancel={cancelSlice}
                onExportAll={exportAllGcode} gcodeUrl={gcodeUrl}
                slaResult={!!plateResultsRef.current[selectedPlate]?.stats?.sla} slaTech={tech === 'SLA'}
                onExportSl1={() => exportPlateSl1()} exporting={exporting} sl1Ready={sl1Ready}
                bedWarning={bedOver || overBed
                  ? `${stats?.overBedModel === false ? 'the toolpaths extend' : 'the model extends'} beyond the ${tech === 'SLA' ? 'resin display' : 'bed'}`
                    + (bedOverText ? ` by ${bedOverText}` : '')
                  : ''} />
              </Panel>
)}
          </aside></Panel>
        )}
      </div>
    </div>
    </ShadowHost>
  )
}
