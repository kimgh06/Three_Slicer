# three-slicer-viewer — the viewer

(Published as `three-slicer-viewer`, MIT. `three-slicer/viewer` is the same component with the WASM kernel and the
vendor catalog plugged in; everything below applies to both.)

3D slicer viewer as a React component: three.js viewport (orbit/transform gizmos), model import (STL/OBJ/3MF/AMF/PLY + pluggable formats such as STEP, multi-object, drag & drop), Web Worker slicing via `three-slicer`, support and material painting, per-extruder filament presets, multi-plate, and a GPU-instanced volumetric toolpath preview ported from OrcaSlicer's libvgcode (millions of segments in a single draw path, per-feature colors, layer range slider, G-code export).

![The Prepare tab — drag-and-drop viewport with the printer, filament and process cards in the right sidebar](../../slice-sidebar.png)

```bash
npm i three-slicer react react-dom three     # the three are optional peers; the viewer needs all of them
```

```jsx
import { useState } from 'react'
import Viewport from 'three-slicer/viewer'

function App() {
  const [settings, setSettings] = useState({})   // OrcaSlicer schema keys; sparse — defaults fill the rest
  // The container matters — see Layout below.
  return (
    <div style={{ position: 'relative', width: '100%', height: '100vh' }}>
      <Viewport settings={settings} setSettings={setSettings} />
    </div>
  )
}
```

Styles are injected into the component's Shadow DOM root — nothing to import, and host CSS cannot collide.

## Layout

**Give it a positioned, sized container.** The shadow host is `display: contents`, so it contributes no box of its
own, and the shell inside is `position: absolute; inset: 0`. It therefore fills the nearest *positioned* ancestor —
`position: relative` (or absolute/fixed) with a real height. Drop it into a plain static `<div>` and it escapes to
the initial containing block instead, which usually looks like the viewer covering the whole page.

There is no width or height prop: the component always fills that container, and resizes with it.

Slice parameters are derived from `settings` via `three-slicer`'s schema mapping — pair it with `three-slicer/components`' `<SettingsPanel/>` sharing the same state for a full slicer UI.

A `.3mf` written by a slicer (OrcaSlicer/BambuStudio save, MakerWorld download) imports as a **project**: plate layout, project settings, and support/material painting are restored, not just the meshes. Where a facet carries both paint kinds, material paint wins and the dropped support paint is reported.

Props: `settings`, `setSettings`, and three optional sidebar slots — `processPanel` (the process card) and
`motionPanel` (folded into the printer card) take a React node; `filamentPanel` (folded into the filament card,
next to the material picker) takes a **function** `(settings, setSettings) => ReactNode`, because the filament
card binds each extruder's per-extruder values.

Subpath exports for custom UIs (framework-free, no React):
- `three-slicer/viewer/toolpath` — GPU toolpath renderer (`buildSegmentData`, `makeToolpath`, view-type colorers)
- `three-slicer/viewer/loaders` — model loaders returning unified triangle soup
- `three-slicer/viewer/gcode` — `parseGcode(text)`, G-code back into the layer stream the renderer consumes

## Embedding it without the panels

Every panel can be switched off, and the values the component owns can be seeded and watched, so the same
`<Viewport/>` also works as a bare G-code viewer or as a headless slicer inside another app's UI.

```jsx
// A G-code viewer: no kernel run, no panels.
<Viewport gcode={text} panels={{ sidebar: false, topBar: false, gizmoRail: false, plateBar: false }} />

// A headless slicer: the host drives it and takes the result.
<Viewport panels={{ sidebar: false }} defaultAutoSlice onSliced={({ stats, gcode }) => save(gcode)} />
```

- **`panels`** — `{name: false}` hides one. Everything is visible by default, so a host only ever opts out and a
  panel added in a later version does not vanish for hosts that listed the ones they wanted. `sidebar: false` drops
  the whole right column; the rest are `topBar`, `gizmoRail`, `objectToolbar`, `paintPanel`, `statsCard`, `plateBar`,
  `emptyHint`, `status`, `printerCard`, `filamentCard`, `resinCard`, `towerCard`, `objectList`, `previewControls`,
  `processCard`, `sliceBar`, `moveBar`, `bedWarn` (the off-bed warning strip). Which of `filamentCard`/`resinCard` renders follows the printer profile's technology: a profile whose
  `printer_technology` says SLA swaps the filament card (and the prime tower, and the painting brushes) for the
  resin card, and slicing routes to the kernel's `slice_sla` — PrusaSlicer's ported support/pad chain — with an
  `.sl1` export instead of G-code (portrait masks, like every SL1-family machine). The preview lifts the model by
  `stats.lift_layers` (pad + elevation), and a request the port does not cover (hollowing, organic trees)
  surfaces as a typed error instead of a wrong print.
  An `.sl1` can also be OPENED (file picker or drag & drop). This viewer's own exports carry a SCENE sidecar
  (`Metadata/threeslicer_scene.bin`: the model STL plus the support and pad meshes the preview was showing, ~3%
  of the archive), so reopening one shows the exported surface ITSELF — no reconstruction, nothing approximated,
  and the whole import lands in ~0.3s. A foreign SL1 has no such record, and there its SHAPE is reconstructed
  from the masks —
  every layer streamed through surface nets in workers (six producers turning masks into occupancy slices, one
  sequential consumer sweeping them). It runs in TWO passes: a quarter-resolution one lands a real shaded mesh
  in well under a second, then the full one replaces it (measured 0.7s and 4.2s on a 1095-layer archive), at the archive's own layer height in z and ~0.12mm
  in xy, with the anti-aliased mask grays interpolated for sub-voxel edges and both the surface and its normals
  relaxed (the layer ripple a mask grid leaves behind is largely a shading artefact) — and shown as a solid mesh on the
  selected plate, with the layer slider section-cutting it like any sliced result. While the reconstruction
  runs a translucent stack of sampled masks stands in, until the coarse pass replaces it.
  Colours: a mask records what cures, not which pixels were model, support or pad — so this viewer's own
  exports carry a role sidecar (`Metadata/threeslicer_roles.bin`, the support/pad segments per layer; every
  other consumer ignores the unknown member) and reconstruct in the sliced preview's three colours. A foreign
  SL1 has no such record and reconstructs in one colour. Opening one applies what the archive states —
  `printer_technology` first of all, then the exposure family, the layer height and the pixel grid read off a
  mask header — so a file opened in a fresh FFF session switches the whole route to SLA instead of stranding
  resin masks on a filament bed. The one number it cannot supply is the display's PHYSICAL size: millimetres
  appear nowhere in an SL1, so the preview is scaled by the printer set in the viewer and the import notice says
  so. Export hands an imported archive back byte-identical rather than re-rasterizing empty geometry.
- **`gcode`** — G-code text drawn on the selected plate instead of a slice result. `parseGcode` recovers roles from
  `;TYPE:` (OrcaSlicer/PrusaSlicer/Cura), from `;_EXTRUSION_ROLE:` tags and from this kernel's own feature comments;
  bead width comes from `;WIDTH:` or, absent that, from E. What the file never states cannot be recovered: an
  unmarked run reads as wall, and there is no print-time estimate (that needs the machine's acceleration limits).
- **`sl1`** — the SLA half of that contract: an `.sl1` archive (`File`, raw bytes, or `{name, data}`) rendered as a
  raster preview on the selected plate, again without starting the kernel. It routes into the same import the
  picker and a drop use, so it behaves identically — including the two things `gcode` does not do: it writes the
  archive's own job description into your `settings` (`printer_technology` among them, per the paragraph above),
  and it reconstructs a surface from the masks in the background. Set both and the G-code wins; one plate holds one
  artifact. It re-injects on the value's IDENTITY, so hold the File in state rather than rebuilding it each render.
- **The move scrub** (`panels.moveBar`) — the horizontal counterpart of the layer slider, under the canvas in
  Preview: the vertical one picks WHICH layers are shown, this one walks inside the top one. It is upstream's
  sequential view (`GCodeViewer`'s `update_sequential_view_current`) in this viewer's terms. On an FFF result it
  cuts that layer at a move — extrusions and travels together, in the order the printer performs them, which the
  two draw lists do not store and `moveCursor` recovers — and marks where the nozzle is: a solid cone at the
  current position and a translucent one where the layer ends. Both are fixed SCREEN size and drawn over
  everything, because a marker that scales with the scene is a speck zoomed out and a marker that respects depth
  is buried in the bead it is pointing at. Position changes reach the host as the `moveScrub` event.
  FFF only, and deliberately: mSLA cures a whole layer in one exposure, so a resin layer has no intra-layer
  order to walk — the same conclusion upstream reaches, PrusaSlicer's SLA preview having a layer slider and no
  horizontal one.
- **`files`** — content imported once on mount, through the same extension dispatch as a drop: models and 3mf
  projects, `.sl1` archives, and preset files. Mount-only on purpose — a host that rebuilds the array each render
  must not re-import its models; runtime loading stays with the picker and drop.
- **`sliceRequest`** — the host's Slice button: a token whose identity change requests one slice of the current
  plate. The mount value is inert, so hold a counter in state and bump it. Ignored under the same conditions
  the built-in slice bar is not pressable (empty scene, an injected `gcode`/`sl1` plate); a change during a
  running slice cancels and re-slices, so the last request wins.
- **`defaultExtruderColors`**, **`defaultAutoSlice`** — initial values for state the component owns. Unlike the
  in-app toggle, `defaultAutoSlice` also performs the *first* slice, which is what makes a panel-less embed able to
  slice at all.
- **`onEvent`** — one channel for every change: `canvasMode`, `objects`, `selectedPlate`, `plateCount`,
  `extruderColors`, `autoSlice`, `slicing`, `progress`, `sliceRate`, `viewType`, `paintMode`, `layerCount`,
  `layerRange`, `moveScrub`, `error`, `notice`. Initial values are not announced — the host passed them.
  `progress` and `sliceRate` fire several times a second while slicing.
- **`onSliced`** — `{plate, stats, gcode, throughput}` when a slice is cached. Switching plate tabs does not
  re-fire it. `throughput` sits beside `stats` rather than inside it, because that is where the engine puts it:
  it is measured around the call, not reported by the kernel.
- **`onSliceRun`** — an all-plates run as it moves: `{workers: {pool, active, kernel}, plates: {[i]: {state,
  progress, rate}}}` on every change, `null` between runs. For a host drawing its own per-plate progress.

`sliceRate` is live throughput — layers finished per second over a 250ms window, `0` between slices, and shown in
the slice bar as well. When it appears depends on the technology, because the two publish per-layer news at
opposite ends of the run:

- **SLA** reports it throughout: its progress counter is linear in layers. (Its layer *stream* is not usable for
  this — `slice_sla` builds the whole scene and then drains the sink, measured as 1095 layer messages inside a
  22ms burst at the end of a 2.8s run, which would time the drain rather than the slicing.)
- **FFF** reports it once the emission pass starts streaming layers. PASS1 publishes per-mille of itself rather
  than a layer count (the total only arrives when it ends), and surfaces and support publish nothing per layer,
  so there is nothing to measure before that and nothing is invented. Measured on a 38MB model: a 4.0s slice,
  2.8s of it PASS1, the rate shown for the final 0.6s. On a support-heavy model emission is a much larger share.

The whole-slice figure is `throughput` on `onSliced`, and it is present on both technologies — wall milliseconds,
the kernel's own share, layers/second, and ms per million segments. It reads lower than the live figure whenever
the live one covers only part of the run.

## Keyboard and mouse

Which keys are live depends on the tab, and every one is ignored while an input has focus. Letter shortcuts match
the **physical** key, so they keep working under a non-Latin keyboard layout — with an IME on, the Korean layout
reports `'ㅁ'` for M, and matching on the character would silently kill every letter shortcut while leaving the
arrows and Delete working.

| Both tabs | |
| --- | --- |
| `Ctrl/⌘ + R` | Slice the current plate |
| `Ctrl/⌘ + C` / `V` / `X` | Copy · paste · cut the selection |
| `Ctrl/⌘ + K` or `Ctrl/⌘ + D` | Duplicate |
| `Ctrl/⌘ + A` | Select all |
| `Ctrl/⌘ + Z` | Undo — bound to the component root, so it never reaches your app's own Ctrl+Z |
| `Ctrl/⌘ + Shift + Z` or `Ctrl/⌘ + Y` | Redo |

| Prepare | |
| --- | --- |
| `M` or `G` · `R` · `S` | Move · rotate · scale gizmo |
| `Arrow keys` | Nudge 10mm — `Shift` for 1mm |
| `PageUp` / `PageDown` | Rotate ±45° |
| `Delete` / `Backspace` | Remove the selection |
| `Z` · `B` | Zoom to all · zoom to bed |
| `Esc` | Cancel the current tool |
| `?` | Shortcut help overlay |

| Preview | |
| --- | --- |
| `↑` / `↓` | Step one layer — `Shift` for ten |
| `L` · `T` | Single-layer view · travel moves |
| `Z` · `B` | Zoom to all · zoom to bed |
| `Esc` | Back to Prepare |

While a brush is open these take over the same letters — the object shortcuts come back the moment it closes.

| Painting | |
| --- | --- |
| `C` · `S` | Brush shape: circle (the visible surface) · sphere (reaches through a thin wall) |
| `F` · `B` · `T` | Smart fill · bucket fill · single triangle |
| `V` · `H` | Lock the stroke to a vertical · horizontal line — press again to release |
| `1`…`9` | Paint with that filament (material brush only) |
| `Shift + drag` | Erase instead of paint |
| Drag off the model | Rotate the camera — a press that misses the model is not the brush's, so orbiting never means closing it |
| `Ctrl/⌘ + wheel` | Brush radius, or the fill angle for a fill tool — the bare wheel stays the camera zoom |
| `Alt + wheel` | Scrub the section plane, which is what lets a brush reach a surface inside the model |
| `Esc` | Close the brush, and put back whatever the section plane cut away |

The brush draws itself while it is open — a ring for the circle cursor, a translucent ball for the sphere — and a
fill tool shades what a click would flood before you click it. A drag paints the **capsule** swept between samples
rather than one ball per sample, so a fast stroke is continuous instead of a row of blobs. A press that misses the
model falls through to the camera, so the view can be turned mid-paint without closing the brush. The support brush also
offers *on overhangs only*, which restricts every stroke to facets steeper than the support threshold.

Mouse selection follows upstream's rules: a plain click **replaces** the selection, `Ctrl/⌘ + click` adds or
removes, a plain click on something already selected **keeps** the set (which is what makes dragging several
objects work), `Shift + drag` is a box select, and clicking empty space clears. Alt is not a de-select, in
upstream or here.

## Undo and redo

The history covers the viewport's **own** state: object transforms, additions, removals, per-object extruder and
visibility. Fifty steps, with repeats of the same action inside half a second folded into one — so a held arrow key
undoes as a single move rather than forty.

What it deliberately does not cover, and why the boundary sits there: `settings` is **yours**, passed in as a prop,
so nothing inside the component can put it back. Painting is outside it too (restoring a step would need a kernel
re-`prepare` for every entry), as are the prime tower and the plate count, which write host settings. If you want
those undoable, undo them on your side of the prop.

## Materials and painting

The filament card holds **one material per extruder**: add an extruder, pick its colour, and pick its filament preset from the vendor catalog (`filamentPresets()` in `three-slicer/settings` — the shortlist is the printer model's own recommendation, the full list everything compatible). Selecting a row aims the material picker and the settings form at that extruder; the colours feed the object meshes, the prime tower and the preview's **Filament** view type, which colours every segment by the extruder that printed it.

The brush has two targets sharing one shell: **support painting** (enforcer / blocker) and **material painting** (one chip per extruder, plus an eraser that returns facets to the default extruder). They are mutually exclusive, and that is a data constraint rather than a UI choice — upstream's `EnforcerBlockerType` is a single enum in which ENFORCER *is* Extruder1 and BLOCKER *is* Extruder2, so one integer per facet means a support mark and a material mark cannot coexist there.

Two limits to expect while using it:

- Painting a region onto a second extruder only takes effect with **support turned off**. The painted multi-material path emits no support, so a support-enabled slice deliberately stays on the single-material path (where painted support keeps working as before).
- On a machine with two or more extruders, a support *blocker* paint and an *Extruder 2* paint are the same mark and cannot be told apart.

If you consume `three-slicer/viewer/toolpath` directly, note that the stride-8 role field `paths[k+3]` now carries the printing extruder alongside the role as `role + tool * 16`. Mask it — `& 15` for the role, `>>> 4` for the tool. Streams produced before this encoding are entirely below 16 and decode to their own role with tool 0, so older data still reads correctly.

## Turning behaviour off

`panels` controls what is drawn; `features` controls what the component *does* outside its own box. Same rule —
opt-out only, everything on unless you say `false`, an unknown key stays on.

```jsx
<Viewport
  gcode={text}
  panels={{ sidebar: false, topBar: false }}
  features={{ warmup: false, shortcuts: false, logs: false }}
/>
```

| Key | Off means |
| --- | --- |
| `shortcuts` | No keyboard bindings. They are installed on `window`, so while the viewer is mounted they fire wherever focus is (inputs excepted) — and `Ctrl+C` preventDefaults, which takes a host page's own copy. Turn them off when your app has its own. |
| `warmup` | The WASM kernel is not loaded on mount. Nothing is downloaded or compiled until something actually slices — which for a `gcode`-only viewer is never, so this is several megabytes and a thread pool you stop paying for. |
| `drop` | No drag and drop onto the canvas. |
| `filePicker` | The file dialog never opens, from any of the buttons that open it. |
| `contextMenu` | No right-click menu. The browser's own menu stays suppressed over the canvas either way — OrbitControls preventDefaults `contextmenu` itself. |
| `logs` | No console output, from the component or from the slice worker. |

### Read-only panels

A sidebar panel can also be shown but not editable — the shape you want when the host picks the printer, process
and filament itself and does not want the user changing them. It is a third value on the same `panels` key:

```jsx
<Viewport
  settings={presetSettings}
  panels={{ printerCard: 'readonly', filamentCard: 'readonly', processCard: 'readonly' }}
/>
```

Lockable: `sidebar`, `printerCard`, `filamentCard`, `objectList`, `towerCard`, `previewControls`, `processCard`,
`sliceBar`. `sidebar: 'readonly'` locks the whole column at once; the per-card keys are for mixing, such as a
locked printer card above a live object list. Every other panel takes `true`/`false` only — a `'readonly'` that
silently did nothing on half the keys would be worse than not offering it.

The panel is drawn normally and keeps showing real values; it just cannot be clicked, typed into or tabbed to, and
that includes any node you passed into it (`motionPanel`, `filamentPanel`, `processPanel`). Implemented with the
`inert` attribute, so it needs Chrome 102+, Safari 15.5+ or Firefox 112+.

**It locks the UI path, not the value.** `settings` is still your prop, and other paths inside the viewer still
write it — importing a 3mf project applies that project's settings whether or not the cards are locked.

### Printer preset files

The printer card carries **Load** and **Save**. Save writes an OrcaSlicer preset: a machine `.json` on its own, or
an `.orca_printer` bundle when the settings map also names a process or filament preset (the cards record those as
`printer_settings_id` / `print_settings_id` / `filament_settings_id`, so nothing extra has to be tracked). Load
accepts the same set upstream's dialog does — `.json`, `.orca_printer`, `.orca_bundle`, `.orca_filament`, `.zip` —
and applies every preset it finds, clearing that type's keys first.

`inherits` is followed through the shipped printer catalog, so a vendor file loads with its bed intact; when the
parent is unknown the file's own values are still applied and the notice says so. Codec details and the reason
that matters are in the [package README](../README.md#preset-files).

Load opens a file dialog, so it respects `features.filePicker`; Save goes through `onExport` like every other
download.

### Taking the saves

The save buttons are inside the component, so `onExport` is the only way to send a file somewhere other than the
browser's download folder. It sees every save: the 3mf project, the STL, each plate's G-code, an SLA plate's
`.sl1` archive, and preset files. Return truthy to say you handled it:

```jsx
<Viewport onExport={(file, filename) => { uploadToServer(file, filename); return true }} />
```

Return nothing and the download happens as well, which is useful for logging what was saved without changing it.

## What the host cannot drive

The component owns its scene, and the props are the whole interface — there is no ref, no imperative handle, and no
`models` prop. Worth knowing before you design around it:

- **Models enter through the UI, or once at mount through `files`** — after mount, runtime loading stays with the
  file dialog and drag and drop. A host cannot remove or transform an object, or hand a mesh in mid-session. What
  it *can* do is watch: the `objects` event reports `{id, name, extruder, visible}` for every object as the set
  changes.
- **Slicing is triggered from the UI, by `defaultAutoSlice`, or by bumping `sliceRequest`** — a token prop whose
  identity change requests one slice of the current plate (the mount value is inert), which is what a host with
  the built-in chrome hidden wires its own Slice button to. The result arrives on `onSliced`.
- **The prime tower stand-in appears only when the plate actually changes tools** — objects assigned to more
  than one extruder, or material paint reaching extruder 2 or higher. Loading a second filament is not enough:
  with everything on T1 the slice emits no tool change and builds no tower, so drawing the box would promise one.
- **A settings change discards every slice result.** Everything a slice puts on screen — the toolpaths, the stats
  card, the layer slider, the G-code export — describes the settings it ran with, and none of it says so. So when
  a value in `settings` changes, the results are dropped and the viewer returns to Prepare; with `autoSlice` on
  the re-slice then fills the empty preview. Two exceptions, neither of which claims to be a slice of these
  settings: a plate injected through `gcode` / `sl1`, and an opened `.sl1` archive (that import applies the
  archive's own settings, so invalidating on it would erase what the file was opened to show). Comparison is by
  value, so a host that rebuilds its settings object every render does not lose its preview to it.
- **`gcode` is one-way**: pass G-code text and it is drawn on the selected plate instead of a slice result, and
  auto re-slice leaves that plate alone while it is set.
- Everything else the component owns — camera, selection, plate count, paint state — is reported through `onEvent`
  and settable only by the user.

If you need programmatic control over the scene, build on the subpath exports (`three-slicer/viewer/toolpath`,
`/loaders`, `/gcode`) and `three-slicer/client` rather than on `<Viewport/>`.

## Multithreaded slicing (automatic)

The engine ships two WASM kernels: single-threaded (default) and `-pthread` multithreaded (~2× wall-clock on layer-parallel wall generation, measured 12× on the wall pass itself). The worker picks the mt kernel automatically when the page is [cross-origin isolated](https://developer.mozilla.org/en-US/docs/Web/API/Window/crossOriginIsolated) — i.e. served with:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

No headers → falls back to the single-threaded kernel. Nothing else to change. Which one loaded is shown as a
badge (`mt`/`st`) beside the Workers select in the slice menu, and the `warmup()` client call resolves with it —
the two are a measured 9.8x apart on a 3M-facet model, which is too much to leave to the console.

### Slicing several plates at once

**All plates** in the slice menu drains the plates through a pool of workers instead of one after another. The
**Workers** select beside it sets the pool: *Auto* is half the cores on the threaded kernel and one per core on the
single-threaded one, capped at the plate count and by model size (below); the select offers every value up to
that memory cap and nothing past it, because past it the tab itself dies (measured: five workers on a 143MB
model), which nothing in the page can catch. The plate tabs show each plate's state (queued, slicing with its own percentage, done, failed)
independently of which one is selected, and the slice bar lists them on one row. Cancel stops every worker. A worker that dies mid-run (memory, most
often) is dropped and its plate is re-run alone once the others finish, so a count that was too high for the
model costs time rather than results; the notice says which plates that happened to.

The numbers behind Auto (node harness, 3M-facet model, 15 cores, 30 plates, wall time against one worker):

| kernel | preset | 3 workers | 5 | 10 | 15 |
|---|---|---|---|---|---|
| mt | classic walls, no support | 1.10x | 1.15x | 1.15x | 1.14x |
| mt | arachne + tree support | 2.08x | 2.60x | 3.16x | 3.31x |
| st | classic walls, no support | — | — | — | 7.2x (14 workers) |

The gain is the kernel's serial share: with classic walls one worker already keeps ~77% of the cores busy, with
arachne (whose emission pass runs serial) and tree support far less, and the extra workers fill that. More workers
than cores gained nothing (17 = 15), and no count ever made a run slower — what a worker costs is memory: each
holds its own copy of the model and its own wasm heap, measured 2.5GB for one, 8.8GB for five and 11.6GB for
fifteen on that model. That is why Auto stops at half the cores and why the select goes higher only by hand.
Three things were measured NOT to matter and are deliberately absent: giving each worker a thread budget, slicing
the largest plate first, and whether the count divides the plate count. The value is `slice_workers` in the
settings map (0 = Auto), a viewer knob like `sla_antialias`, and it does not reach a 3mf.

The browser is tighter than that harness, because every worker's wasm heap lives in the one renderer process that
already holds each plate's STL buffer and three.js geometry. Measured in Chromium on the same 143MB-STL model
over nine plates (classic preset, 15 cores):

| workers | wall | Chromium RSS peak |
|---|---|---|
| 1 | 17.8s | 10.4GB |
| 2 | 15.7s (1.13x) | 13.7GB |
| 3 | crashed the tab once; 18.7s once | 10.2GB |
| 8 (Auto by cores) | crashed the tab | 11.6GB |

So Auto is also capped by model size — a worker's heap is taken as 12x the STL it slices (node measured ~1.7GB
for 143MB) against a 4GB pool budget, which gives 2 for that model and does not bind below ~40MB per plate. A
manual count is capped the same way. What the browser has NOT measured yet is
the arachne + tree-support preset, where the harness gains were largest.

## Theming

Both shadow roots (the viewer and `<SettingsPanel/>`) paint their chrome from one palette, `UI_TOKENS` in
`src/core/theme.js`. Each entry is a custom property a host can set on any ancestor of the component — custom
properties are the one thing that inherits across a shadow boundary, so this is the only styling hook the isolation
leaves open:

```css
.my-slicer-page { --vp-accent: #0a84ff; --vp-light-bg: #f4f4f6; }
```

An unset property falls back to the default below. The 3D scene (the selection tint, plate borders, grid, SLA preview
colours) is drawn by three.js from `THEME` in the same file and does not read these properties.

| Property | Default |
|---|---|
| `--vp-accent` | `#00ae42` |
| `--vp-accent-hover` | `#06c04d` |
| `--vp-accent-deep` | `#23402c` |
| `--vp-accent-ink` | `#167a3a` |
| `--vp-accent-on-dark` | `#9fe3bd` |
| `--vp-accent-soft` | `#e3f6ea` |
| `--vp-accent-soft-border` | `#9adfb6` |
| `--vp-on-accent` | `#ffffff` |
| `--vp-dark-base` | `#0e1216` |
| `--vp-dark-surface` | `#161b21` |
| `--vp-dark-control` | `#1a2027` |
| `--vp-dark-control-hover` | `#28313a` |
| `--vp-dark-border` | `#2c353d` |
| `--vp-dark-border-strong` | `#3a4550` |
| `--vp-dark-text` | `#cdd6dd` |
| `--vp-dark-text-muted` | `#aebcc6` |
| `--vp-dark-text-faint` | `#8b98a2` |
| `--vp-dark-text-disabled` | `#5a6570` |
| `--vp-light-bg` | `#eef0f2` |
| `--vp-light-surface` | `#ffffff` |
| `--vp-light-subtle` | `#f6f7f8` |
| `--vp-light-control` | `#dfe6ea` |
| `--vp-light-control-hover` | `#d3dee4` |
| `--vp-light-border` | `#d5d8dd` |
| `--vp-light-divider` | `#e3e6ea` |
| `--vp-light-text` | `#24282e` |
| `--vp-light-text-muted` | `#5a6069` |
| `--vp-light-text-faint` | `#8a9099` |
| `--vp-info` | `#2b6cff` |
| `--vp-info-soft` | `#e6efff` |
| `--vp-tech-badge` | `#6d7ce0` |
| `--vp-danger` | `#e23b3b` |
| `--vp-danger-ink` | `#a33b37` |
| `--vp-danger-soft` | `#fbeaea` |
| `--vp-danger-on-dark` | `#ff8b8b` |
| `--vp-danger-deep` | `#4a2229` |
| `--vp-warn` | `#f0a542` |
| `--vp-warn-ink` | `#a86a12` |
| `--vp-warn-soft` | `#fdf4e3` |
| `--vp-warn-border` | `#d8b48a` |
| `--vp-warn-on-dark` | `#f0c060` |
| `--vp-warn-deep` | `#3a2a10` |
| `--vp-warn-deep-border` | `#7a5a1e` |

## Bundler notes

- **Vite:** two config lines (worker code-splitting + top-level await in the mt glue; Chrome 89+/Safari 15+):

```js
// vite.config.js
export default defineConfig({
  worker: { format: 'es' },
  build: { target: 'es2022' },
})
```

- **Next.js / webpack:** render client-side (`dynamic(..., { ssr: false })`) and alias the emscripten glue's Node-only guards away:

```js
// next.config.js
module.exports = {
  webpack: (config) => {
    for (const m of ['node:module', 'node:fs', 'node:path', 'node:url', 'node:crypto', 'node:worker_threads'])
      config.resolve.alias[m] = false
    return config
  },
}
```

`three` is a peer dependency pinned to `^0.160` (TransformControls API; r169+ changed its Object3D contract).

## License

AGPL-3.0-or-later (derived from OrcaSlicer). A web app embedding this package must comply with AGPL — including offering its source to network users.
