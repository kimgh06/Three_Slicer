// three-slicer/viewer
import type * as React from 'react'
import type { SlicerSettings } from './settings-keys.d.ts'
import type { ProcessPresetsApi, FilamentPresetsApi } from './settings.d.ts'

export interface ViewportProps {
  /**
   * Sparse settings map. Defaults to `{}`. Two viewer knobs ride in it beside the schema keys: `sla_antialias`
   * (SL1 mask MSAA, 1|2|4) and `slice_workers` — how many plates an all-plates run slices at once (0/absent =
   * Auto: half the cores on the threaded kernel, one per core on the single-threaded one; the in-app select
   * writes it). Neither reaches a 3mf.
   */
  settings?: SlicerSettings
  /** React setState shape. Defaults to a no-op. */
  setSettings?: React.Dispatch<React.SetStateAction<SlicerSettings>>
  /**
   * Per-plate overrides: `{[plateIndex]: sparse map}`, merged over `settings` for that plate's slice only —
   * a key's absence means "follow the global value" (delete the key to clear an override). Plate identity is
   * the plate index; deleting the last plate truncates its entry. Editing one plate's override invalidates only
   * that plate's cached result. Any key can be overridden: `printer_technology` routes that plate to the
   * FFF or SLA slicer (an SLA plate's grid cell is sized to its resin display), and a bed override
   * (`printable_area`/`printable_height`) resizes that plate's own grid cell. What a 3mf cannot represent —
   * a mixed-technology or mixed-bed project — is refused at project export with a typed error
   * (`error.code` `'UNSUPPORTED_MIXED_TECH_3MF'` / `'UNSUPPORTED_MIXED_BED_3MF'`); per-plate G-code/.sl1
   * exports always work. Defaults to `{}`.
   */
  plateSettings?: Record<number, SlicerSettings>
  /** React setState shape for {@link ViewportProps.plateSettings}. Defaults to a no-op. */
  setPlateSettings?: React.Dispatch<React.SetStateAction<Record<number, SlicerSettings>>>
  /**
   * Left process-panel slot — usually `<SettingsPanel embedded/>`. Defaults to null.
   *
   * Pass a FUNCTION to opt into the per-plate scope toggle (shown with more than one plate): in plate scope
   * the panel receives the selected plate's EFFECTIVE map and a setter that writes only the changed keys into
   * {@link ViewportProps.plateSettings}; `meta.overriddenKeys`/`meta.onRevertKey` drive the override badges
   * (`<SettingsPanel overriddenKeys={...} onRevertKey={...}/>`). In global scope the pair is simply
   * `settings`/`setSettings`. A plain node keeps the global-only binding.
   */
  processPanel?: React.ReactNode
    | ((settings: SlicerSettings, setSettings: React.Dispatch<React.SetStateAction<SlicerSettings>>,
        meta: { scope: 'global' | 'plate', selectedPlate: number, overriddenKeys: string[],
                onRevertKey: ((key: string) => void) | null }) => React.ReactNode)
  /** Motion-limits editor, folded into the printer card — usually `<SettingsPanel only={{builder:'TabPrinter::build_kinematics_page'}}/>`. */
  motionPanel?: React.ReactNode
  /**
   * Filament editor, folded into the filament card. Pass a function rather than a node: with more than one
   * extruder loaded the card projects that extruder's slice of the per-extruder columns and writes the form's
   * edits back at its index, so the panel must bind to the pair it is given.
   */
  filamentPanel?: React.ReactNode
    | ((settings: SlicerSettings, setSettings: React.Dispatch<React.SetStateAction<SlicerSettings>>) => React.ReactNode)
  /**
   * Per-panel visibility. Every panel is visible unless its key is explicitly `false`, so a host only opts out —
   * and a panel added in a later version does not disappear for hosts that listed the ones they wanted.
   *
   * A {@link LockablePanel} also accepts `'readonly'`: the panel is drawn but nothing inside it can be clicked,
   * typed into or tabbed to — including any node the host passed into it. That is the shape a host wants when it
   * presets the printer, process and filament itself and does not want the user changing them.
   *
   * Note what it locks: the UI path, not the value. `settings` is still the host's own prop, and other paths
   * inside the viewer still write it — importing a 3mf project applies that project's settings either way.
   */
  panels?: Partial<Record<ViewportPanel, boolean>> & Partial<Record<LockablePanel, boolean | 'readonly'>>
  /**
   * Behaviour switches, following the same opt-out rule as {@link ViewportProps.panels}: everything is on unless
   * its key is explicitly `false`. These are the things the component does *outside* its own box — take the page's
   * keyboard, load the WASM kernel, write to the console — which a host embedding it in a larger app may already
   * be doing itself. See {@link ViewportFeature}.
   */
  features?: Partial<Record<ViewportFeature, boolean>>
  /**
   * Intercepts every file the viewer would otherwise hand to the browser as a download — the 3mf project, the STL,
   * and each plate's G-code. Return anything truthy to say it is handled and suppress the download; return nothing
   * to let it proceed as well. This is the only way in: the save buttons live inside the component.
   *
   * ```jsx
   * <Viewport onExport={(blob, filename) => { upload(blob, filename); return true }} />
   * ```
   */
  onExport?: (file: Blob, filename: string) => boolean | void
  /**
   * G-code text to render instead of a slice result. Parsed into the same layer stream the kernel produces and
   * shown on the selected plate; the kernel is never started. While it is set, auto re-slice leaves that plate alone.
   */
  gcode?: string | null
  /**
   * An `.sl1` archive rendered as a raster preview — the SLA half of {@link ViewportProps.gcode}'s contract: it
   * lands on the selected plate and the kernel is never started. Set both and the G-code wins; one plate holds
   * one artifact.
   *
   * Two things it does that `gcode` does not. It writes to your `settings` — the archive's own job description,
   * `printer_technology` included, because an .sl1 opened in an FFF session has to switch it. And it reconstructs
   * a surface from the masks in the background, so the preview fills in a moment after the layers appear.
   *
   * Re-injects whenever the value's IDENTITY changes, so hold the File/buffer in state rather than building it
   * during render — a fresh `new Uint8Array(...)` each render re-imports each render. `{name, data}` exists
   * because the name is the import notice's subject and the filename a re-export hands back.
   */
  sl1?: File | Blob | ArrayBuffer | Uint8Array | { name?: string, data: ArrayBuffer | Uint8Array } | null
  /**
   * Content imported once on mount, through the same extension dispatch as a drop: models (STL/OBJ/3MF/AMF/PLY —
   * a 3mf project applies its settings, plates and painting), `.sl1` raster archives, and preset files
   * (`.json` / `.orca_printer` / `.orca_bundle` / `.orca_filament` / `.zip`). The `{name, data}` form exists
   * because the dispatch runs on the file NAME's extension. Deliberately mount-only — recreating the array on a
   * later render does not re-import; runtime loading is the picker, drop, or a remount.
   */
  files?: Array<File | { name: string, data: ArrayBuffer | Uint8Array }>
  /**
   * The slicing implementation — a React hook with the shape of three-slicer's `useSlicer`. This package ships
   * none: without it the viewer runs on a no-op slicer that loads, displays and exports but never slices.
   * Must be stable for the life of the mount (it is called as a hook).
   */
  slicer?: (deps: Record<string, unknown>) => SlicerHandle
  /**
   * The vendor preset catalog. This package ships none — nothing passed means empty pickers. `three-slicer/viewer`
   * passes its bundled OrcaSlicer extraction; a host with its own fleet passes its own (a partial object is
   * merged over the empty catalog).
   */
  catalog?: Catalog | null
  /**
   * A token whose identity CHANGE requests one slice of the current plate — the host's Slice button:
   * keep a counter in state and bump it. The mount value is inert (0 and null both slice nothing), so is
   * setting it back to `null`. Ignored while a `gcode`/`sl1` injection holds the plate or the scene is
   * empty — the same conditions under which the built-in slice bar is not pressable. A change while a
   * slice is running cancels it and re-slices: the last request wins.
   */
  sliceRequest?: number | string | object | null

  /** Initial filament colours (hex), one per extruder. Defaults to the built-in T1/T2 pair. */
  defaultExtruderColors?: string[] | null
  /**
   * Start with auto re-slice on. Unlike the in-app toggle's original behaviour this also performs the FIRST slice,
   * which is what makes a panel-less embed able to slice at all.
   */
  defaultAutoSlice?: boolean
  /** Every value change in one channel. See {@link ViewportEvent}. */
  onEvent?: (event: ViewportEvent) => void
  /** A finished slice, fired where the result is cached — switching plate tabs does not re-fire it. */
  /** `throughput` is how fast the slice ran — see `SliceThroughput` in the engine entry. Absent on a kernel
   *  result that carried none (a cached plate re-announced from before the field existed). */
  onSliced?: (result: {
    plate: number; stats: Record<string, unknown>; gcode: string
    throughput?: { ms: number; kernelMs: number | null; layersPerSecond: number; msPerMsegment: number | null }
  }) => void
  /**
   * An all-plates run as it moves: the run map on every change, `null` when none is on. `workers.pool` is how
   * many slice at once, `workers.kernel` which kernel loaded ('mt' threads / 'st'); each plate carries its state
   * and its own progress (0..1) and layers/second. Fired several times a second while a run is on.
   */
  onSliceRun?: (run: {
    workers: { pool: number; active: number; kernel: 'mt' | 'st' | null }
    plates: Record<number, { state: 'queued' | 'busy' | 'done' | 'failed'; progress: number; rate: number }>
  } | null) => void
}

/**
 * Behaviour keys accepted by {@link ViewportProps.features}. All default to enabled.
 *
 * - `shortcuts` — the keyboard bindings. They are installed on `window`, so while the viewer is mounted they fire
 *   wherever focus is (except inside inputs) and `Ctrl+C` in particular preventDefaults. Turn them off when the
 *   host page has its own.
 * - `warmup` — loading the WASM kernel on mount, ahead of the first slice. Off, nothing is downloaded or compiled
 *   until something actually slices — which for a `gcode`-only viewer is never.
 * - `drop` — drag and drop onto the canvas.
 * - `filePicker` — the file dialog, from every button that opens it.
 * - `contextMenu` — the right-click menu. Note that the browser's own menu stays suppressed over the canvas either
 *   way: OrbitControls preventDefaults `contextmenu` itself.
 * - `logs` — console diagnostics, from the component and from the slice worker.
 */
export type ViewportFeature = 'shortcuts' | 'warmup' | 'drop' | 'filePicker' | 'contextMenu' | 'logs'

/**
 * The panels that accept `'readonly'` as well as `true`/`false` — the right column and the cards in it. Everything
 * else takes a boolean only: locking the gizmo rail or the plate tabs is what `features` and `panels: false` are
 * for, and pretending otherwise would mean a `'readonly'` that silently does nothing on half the keys.
 *
 * `sidebar: 'readonly'` locks the whole column in one go, so the per-card keys are for mixing — a locked printer
 * card above a live object list, say.
 */
export type LockablePanel =
  | 'sidebar' | 'printerCard' | 'filamentCard' | 'objectList' | 'towerCard'
  | 'previewControls' | 'processCard' | 'sliceBar'

/** Panel keys accepted by {@link ViewportProps.panels}. `sidebar: false` hides the whole right column at once. */
export type ViewportPanel =
  | 'topBar' | 'gizmoRail' | 'objectToolbar' | 'paintPanel' | 'statsCard' | 'plateBar' | 'emptyHint' | 'status'
  | 'sidebar' | 'printerCard' | 'filamentCard' | 'objectList' | 'previewControls' | 'processCard' | 'sliceBar'
  /** The horizontal move scrub under the canvas — how far into the top shown layer the print has got. Preview
   *  and FFF only: a resin layer is cured in one exposure and has no intra-layer order to walk. */
  | 'moveBar'
  /** The over-the-bed warning, shown in Prepare when something leaves the printable area. */
  | 'bedWarn'
  /** The prime tower card. Only rendered anyway once a second filament exists. */
  | 'towerCard'
  /** The resin (SLA) card. Takes the filament card's place when the printer profile declares SLA. */
  | 'resinCard'

/** Value changes reported through {@link ViewportProps.onEvent}. Not fired for the initial values. */
export type ViewportEvent =
  | { type: 'canvasMode'; value: 'prepare' | 'preview' }
  | { type: 'objects'; value: Array<{ id: number; name: string; extruder: number; visible: boolean }> }
  | { type: 'selectedPlate'; value: number }
  | { type: 'plateCount'; value: number }
  | { type: 'extruderColors'; value: string[] }
  | { type: 'autoSlice'; value: boolean }
  | { type: 'slicing'; value: boolean }
  /** 0..1. Fires several times a second while slicing — throttle on the host side if that matters. */
  | { type: 'progress'; value: number }
  /**
   * Live throughput: layers finished per second over a 250ms window, `0` between slices. An SLA slice reports it
   * throughout. An FFF slice reports it only once the emission pass begins streaming layers — the earlier passes
   * publish no per-layer progress, so nothing is measured there and none is invented. For the whole-slice figure
   * use `throughput` from `onSliced`.
   */
  | { type: 'sliceRate'; value: number }
  | { type: 'viewType'; value: 'feature' | 'speed' | 'height' | 'width' | 'fan' | 'temp' | 'filament' }
  | { type: 'paintMode'; value: 'off' | 'enforcer' | 'blocker' | 'material' }
  | { type: 'layerCount'; value: number }
  | { type: 'layerRange'; value: { lo: number; hi: number } }
  /** The move scrub's position within the top shown layer; `max` is that layer's move count, extrusions and
   *  travels together. Not fired while the whole layer is shown. */
  | { type: 'moveScrub'; value: { at: number; max: number } }
  | { type: 'error'; value: string }
  | { type: 'notice'; value: string }

declare const Viewport: React.FC<ViewportProps>
export default Viewport

export interface SlicerHandle {
  getWorker(): Worker | { postMessage(msg: unknown): void }
  cancelSlice(): void
  runSlice(merged: unknown, ctx?: unknown): Promise<unknown>
  pendingSliceRef: { current: unknown }
  downgradeRef: { current: boolean }
  createPoolContext(opts: Record<string, unknown>): { cancel(): void; terminate(): void }
  kernelKindRef: { current: 'mt' | 'st' | null }
  progressSinkRef: { current: unknown }
}
export interface Catalog {
  printerKeys: string[]
  printerSettings(profileName: string): Record<string, unknown> | null
  printersByVendor: Record<string, unknown>
  printerTechByVendor: Record<string, unknown>
  printerDefaultPreset(profileName: string): string | null
  processPresets(): Promise<ProcessPresetsApi>
  filamentPresets(): Promise<FilamentPresetsApi>
  resinCatalog: unknown[]
  resinSettingsFor(name: string): Record<string, unknown> | null
}
export const emptyCatalog: Catalog
export function resolveCatalog(catalog?: Partial<Catalog> | null): Catalog
export function useNoopSlicer(): SlicerHandle

/** The slicing hook, unbound. `deps.makeWorker` must return a Worker speaking this package's slice protocol —
 *  three-slicer/viewer supplies its WASM kernel worker and re-exports the bound hook. */
export function useSlicer(deps: Record<string, unknown> & { makeWorker: () => Worker }): SlicerHandle
