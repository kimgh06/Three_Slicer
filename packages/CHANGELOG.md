# Changelog

## Unreleased

### Added

- The prime tower is set per plate. The Prime tower card carries the same Global | Plate switch as the Process,
  Printer and Filament cards: in plate scope its mode, width, purge destination and purging table become that
  plate's override. The position was already per plate (`wipe_tower_x/y[plate]`) and stays in the global map.
- A saved `.3mf` carries the per-plate overrides and the global map's non-schema keys (`wipe_tower_real`,
  `sla_antialias`) in a member of its own, `Metadata/three_slicer_settings.json`, and an import restores them.
  Upstream has no place for either and ignores the member, so OrcaSlicer still opens the file on the global preset.

### Changed

- The ring / real tower choice is the settings key `wipe_tower_real` (a viewer knob, like `sla_antialias`) instead
  of component state, so it follows plate overrides and survives a save. Absent means the ring, as before.
- The tower stand-ins are decided per plate: a plate gets one only when it changes tools itself, and each plate
  draws its own width and on/off. A dragged or typed tower position is kept on the bed.
- The tower stand-in is selected alone and only translated. It no longer joins a multi-selection, takes a
  rotate/scale gizmo, or adds an undo entry that undid nothing.

### Fixed

- Two objects on the same spot sliced to nothing. The kernel slices the merge of every object as one mesh and filled
  the layer loops even-odd, so coincident shells counted as "inside twice". Segments are now oriented by the facet
  normal and filled NonZero, upstream's Regular slicing mode, in the FFF, multi-material and SLA paths. Measured: a
  project imported twice printed 1,210 mm of a 42,984 mm model before, the full model now. Clean meshes slice the
  same regions (0 area difference on the fixtures, under 0.0003 mm² per layer on the Benchy), but a loop can start
  at a different vertex, so G-code of models other than the golden fixtures may differ in point order.
- A saved `.3mf` with a tower position on some plates and automatic placement on others wrote `null` into
  `wipe_tower_x/y`. OrcaSlicer's loader stops reading the whole file at an array entry that is not a string, which
  dropped the 17 settings after it, `z_hop` and `z_offset` among them. The hole is now written as the schema default
  for upstream and kept as a hole in `Metadata/three_slicer_settings.json`.
- The GPU SL1 mask path (`sla_antialias`, `sl1_parity_gpu.js`) counted surfaces above the plane as a parity, so two
  coincident objects came out empty in the masks while the slice and its supports treated them as solid. The count
  is now signed by facing (NonZero), the kernel's fill rule.
- Painting one plate and then another discarded the first plate's paint, and a copy placed where the original sits on
  its own plate took the original's paint over (the original then sliced single-material, the copy printed both).
  Paint now lives on each object (`core/paint_store.js`): the selector is written back to it before it switches
  mesh and loaded from it after; slice-all pool workers load their plate's paint; a 3mf save writes every plate's
  brush strokes (it used to save them only for a single-plate project); copy, duplicate and paste carry the paint.
  Every plate's paint stays drawn, not only the plate being painted.

## 0.3.1 — 2026-09-16

### Added

- `three-slicer-viewer/settings` (and so `three-slicer/settings`) exports the kernel derivation's own fallbacks:
  `FFF_FALLBACKS`, `SLA_FALLBACKS`, `AUTO_LINE_WIDTH`, `BED_FALLBACK`, `MACHINE_LIMITS`. Frozen; they are the values
  `deriveKernelParams` / `deriveSlaParams` use when neither the settings map nor the schema gives one, and they are
  deliberately not the schema defaults.
- Theming: both shadow roots take their colours from 43 custom properties (`--vp-accent`, `--vp-dark-surface`,
  `--vp-light-text`, …) a host can set on any ancestor. `VIEWER.md` ("Theming") lists them with their defaults.

### Changed

- `deriveKernelParams` with an empty or malformed `printable_area` now derives a 200 x 200 bed (the schema's own
  default), not 256 x 256. Every viewer fallback already assumed 200; a well-formed value is unaffected.
- `buildSegmentData(layers)` without a default line width falls back to 0.42 (the kernel's auto width), not 0.4.
  Callers that pass one, as the viewer does, are unaffected.
- One grey for "no colour to read": a blank filament slot, a stats swatch past the palette, an unparseable hex in
  the toolpath palette and an unpainted facet (`UNPAINTED_COLOR`) are all `#888888` (were four different greys).
- The toolpath legend (speed / fan / temperature views) falls back to the schema default for a value the settings
  map holds but cannot parse, instead of literals that disagreed with it (support speed 35 vs 80, nozzle 210 vs 200).
- The stylesheets carried 152 literal colours, many of them near-identical shades of one role; each group now uses
  its most common member, so a few shades move slightly. Visible: the "advanced" badge is the info blue
  (`#2b6cff`, was `#3673c3`), the "simple" badge the accent green, and the prime-tower card's number inputs are
  light like every other sidebar input (they were styled for the dark viewport).
- Vendor process presets now carry `support_type`, so applying one sets the support type it was authored with.

### Fixed

- Importing a project that places objects on more than one plate failed with "dropPlateResult is not defined"
  and left every object on the selected plate (since 0.2.5). `test_3mf_project.mjs` now loads a two-plate project
  through the model loader.
- The Process card's Global|Plate toggle has the ↺ that drops the plate's whole override, like the other settings
  cards; the viewer never passed it the handler.
- Importing a project kept its filament colours in the viewer but not in the settings map, so a blank entry saved
  back as blank and a list past 16 filaments saved whole.
- `three-slicer@0.3.0` shipped a tool-state file under `types/.omc/`, and `three-slicer-viewer` would have shipped
  one from `src/settings/.omc/`. Both `files` lists now end in `!**/.omc`, and `pack_check.sh` fails on any
  dot-path in either tarball.

## 0.3.0 — 2026-09-08

The viewer is its own package. Everything that displays — model loading, G-code parsing, the GPU toolpath
renderer, the settings transforms, `<Viewport/>` and `<SettingsPanel/>` — now ships as
[`three-slicer-viewer`](https://www.npmjs.com/package/three-slicer-viewer) under **MIT**, so it can go into
closed-source products. `three-slicer` stays AGPL and keeps every entry point it had: `three-slicer/viewer` and
`three-slicer/components` are now thin wrappers that plug the WASM kernel and the vendor catalog into the
permissive package. Which files could carry which license, and why, is `packages/PROVENANCE.md`; the plan the
split followed is `packages/RELICENSE.md`.

### Added

- `three-slicer-viewer` (MIT): `<Viewport/>` with `slicer` and `catalog` props (defaults: a no-op slicer and an
  empty catalog), `useSlicer({ makeWorker })` — the slicing hook with the kernel injected —, `/toolpath`,
  `/gcode`, `/loaders`, `/settings`, `/data`, `/toggle`, `/components`, and the `.d.ts` for each.
- `makeSlicerWorker` in `three-slicer/client` and `bundledCatalog` in `three-slicer/settings`: the two things
  that cannot be permissive, exported from where they live so a host can compose the viewer with the kernel
  by hand (`web/viewer/src/Prepare.jsx` does).
- `three-slicer-viewer/toggle`: `makeToggle(rules, schema)` — the field enable/disable evaluator, unbound;
  `three-slicer/toggle` is the same bound to upstream's rules.
- The `/slice` page opens and drops a `.gcode` file, parsed by the permissive parser.
- Third-party notices for both packages (`THIRD-PARTY-NOTICES.md`).

### Changed

- The toolpath renderer is a rewrite from `TOOLPATH_SPEC.md`, not a port. Two behaviours changed with it:
  `rangeColorAt` no longer extrapolates below the range's low end, and the `ColorContext` type matches what
  the renderer actually reads (a `NaN` in the context is coerced instead of propagating).
- `<SettingsPanel/>` takes `schema`, `uiTree` and `toggle` as props. Without them it labels every field by its
  key and disables nothing — the upstream labels and tooltips are AGPL prose and stay in `three-slicer/data`.
- The two packages publish as a **locked pair**: same version, and `three-slicer` pins `three-slicer-viewer`
  exactly (`test_version_lockstep.mjs`). A release goes through the root `Makefile` (`make publish`), which
  publishes the viewer first — the pin means `three-slicer@0.3.0` cannot be installed before it exists.
- `viewer-package/` is mirrored to `github.com/kimgh06/three-slicer-viewer` (a `git subtree split`); the monorepo
  stays the source of truth.

### Fixed

- A `three-slicer/settings` import that survived the split inside the slicing hook, which only tree-shaking
  kept out of the MIT bundle. The license boundary test now scans raw specifiers in `.js/.jsx/.mjs/.d.ts/.css/
  .json` (it used to strip string literals first — and an import path is one) and the built `dist/` too.

## 0.2.5 — 2026-09-06

The per-plate release. A plate is a printer now, not just a position.

### Added

- Per-plate settings: `plateSettings` (`{[plateIndex]: sparse map}`) beside `settings` — one plate, one printer,
  one bed, one technology. A plate override is additive over the global map; with no override the global map
  is used by identity, which is what keeps the pre-feature output byte-identical. A bed override resizes that
  plate's grid cell (`plateLayoutHetero`), and a `printer_technology` override routes that plate to SLA beside
  FFF neighbours. What a 3mf cannot represent is refused typed at export: `UNSUPPORTED_MIXED_TECH_3MF`,
  `UNSUPPORTED_MIXED_BED_3MF`.
- `plateContext(settings, plateSettings, plate, dims)`: the one derivation of what a plate prints with —
  effective map, technology, derived params, enforced frame. Everything that used to read the global `kp`
  reads this.
- Slice every plate through a worker pool the viewer orchestrates (`slice_pool.js`): the selected plate first
  on the selector worker, the rest on K pool workers; a pool worker that dies re-queues its plate to run alone
  after the pool drains. K is capped by the largest plate's STL size — measured, not designed (README tables).
- Every resin plate keeps a preview in the scene, not only the focused one.
- SL1 masks are rasterized in-house (`raster_mask.js`, gray8 PNG) with an opt-in GPU anti-aliasing path
  (`sla_antialias: 1|2|4`) and a slice-by-rendering parity path when the merged STL is still at hand.
- The SLA kernel reports progress from inside its contour phase, so an SLA plate no longer looks idle beside
  FFF plates.
- The settings panel marks a plate's overridden keys.

### Fixed

- A plate-scope profile pick is written whole and describes its own machine — a diff left keys shared with the
  global printer off the override, and the next global printer change moved them.
- A model load drops only the plate it lands on, not every plate's cached result.

## 0.2.4 — 2026-09-03

The painting release: the brush behaves like upstream's.

### Added

- The brush draws itself (a ring for the circle cursor, a translucent ball for the sphere), and a stroke is a
  capsule between samples rather than a row of spheres — a fast drag no longer leaves gaps.
- The brush's own tools and modifiers: fill, the section plane, the overhang limit, `Ctrl`+wheel for the
  radius, `Alt`+wheel for the plane, `Shift`+drag to erase — upstream's bindings. The bare wheel is the camera
  zoom again.
- Four kernel-side brush behaviours the bridge never exposed (`selector_paint_stroke`, the fill preview, the
  clip plane, the overhang gate), each feature-detected so an older kernel keeps working.

### Fixed

- The paint overlay no longer draws through the model.
- The filament colour and the filament selection are one thing: `extruderColors` and the `filament_colour`
  settings key are written together (`actions/filament_colors.js`), so a project saved after recolouring comes
  back in the new colours.

## 0.2.3 — 2026-08-29

A developer-experience release: everything here comes from a log of what integrating the package actually
cost while building the four `examples/` demos and the live landing embed (`packages/FRICTION.md`). The
theme is the one failure mode they shared — wrong input returning something plausible instead of an error.

### Added

- `sliceRequest` on `<Viewport/>`: a token whose identity change requests one slice. The component's
  contract stays props-only, but a host that hides the built-in chrome no longer has to remount the whole
  viewer to start a slice (which blanked the scene and re-parsed the model — measured as a visible
  double-flip on the landing embed).
- `result.warnings`, a `string[]` naming what a **successful** slice got away with. Today's one entry is
  `'over_bed_model'`: a bed-centred model sliced outside the printable area with plausible time and
  material and no error. Present on the direct handle, through `createSlicerClient()`, and on the raw
  worker's `done` reply. The `stats` flags are unchanged.
- `result.throughput` — how fast the slice ran: `ms` (wall time around the call), `kernelMs` (the kernel's own
  phase total, so `ms - kernelMs` is the WASM boundary cost), `layersPerSecond`, and `msPerMsegment`. The last
  one is the field to compare runs with: the kernel is not deterministic in segment count, so raw milliseconds
  compare two different amounts of work. Same three paths as `warnings`, and on the SLA routes as well —
  `kernelMs` there sums the resin passes (contours, sample, tree, raster, emit), since the two technologies
  share only the name `t_emit_ms`.
- Throughput in the viewer, in three places: the slice bar shows layers/second **while** a slice runs, the stats
  card shows the finished figure ("Sliced in 4.0s · 166 layers/s", with the kernel share and ms/Msegment on the
  tooltip), and hosts receive both — `sliceRate` on `onEvent` and `throughput` beside `stats` on `onSliced`.
  An SLA slice reports the live figure throughout; an FFF slice reports it once the emission pass starts
  streaming layers, since its earlier passes publish no per-layer progress and none is invented. It therefore
  reads higher than the whole-slice average, which counts the passes that emit nothing (measured on a 38MB
  model: 306–707 layers/s live, 166 over the whole 4.0s slice).
- `applyPreset(settings, preset, keys)` in `three-slicer/settings` — clear-then-merge, so a preset switch
  cannot leave the previous material's keys underneath. All four demos had written this by hand.
- `kernelSettingKeys` and `ignoredKernelSettings(settings)`: the 128 schema keys the FFF derivation reads,
  and which of yours it does not. A key it does not read is accepted and does nothing.
- The raw worker's slice request accepts an object `params`, not only a JSON string — the direct handle
  and the client already did, and the worker's own SLA branch always had.

### Fixed

- The prime tower stand-in is drawn only when the plate actually changes tools — objects on more than one
  extruder, or material paint reaching extruder 2 or higher — instead of whenever a second filament happened to
  be loaded. With everything on T1 the slice emits no tool change and generates no tower, so the box promised
  one that would not be printed.
- The viewer no longer shows a slice result that the current settings would not produce. A change to `settings`
  drops the cached results and returns to Prepare, instead of leaving a preview, a print estimate and an enabled
  G-code export describing the settings the slice ran with. An injected (`gcode` / `sl1`) plate and an opened
  `.sl1` archive are left alone — neither claims to be a slice of these settings.
- **`createSlicerClient()` with no argument now works after `vite build`.** Its default worker is written
  as the literal `new Worker(new URL(…), { type: 'module' })` that bundlers recognize as a worker entry;
  routed through `engineWorkerURL()` it matched Vite's plain-asset rule instead and was copied verbatim,
  still importing an unhashed `./slicer_core.js` that the build never emitted — a 404 on the first message,
  invisible until a production build. Measured on a Vite 5 consumer: a 21KB copy in a 40KB dist with no
  kernel at all, versus a 12KB worker chunk importing the emitted kernels. `pack_check.sh` now fails when
  a worker chunk imports a file the build did not produce.
- `support_type: 'tree(auto)'` selects tree supports. Tree vs grid was routed from `support_style` alone,
  so an imported OrcaSlicer project asking for tree supports sliced grid, silently.
- A `files` prop changed after mount warns once instead of being ignored in silence.

### Changed

- `engineWorkerURL()` is documented as the **no-bundler** path (native ESM, an import map, a CDN). Under
  Vite or webpack use `createSlicerClient()` or `three-slicer/worker?worker`. The function is unchanged.
- Since tree vs grid now reads `support_type`, a settings map carrying `support_type: 'tree(auto)'` with
  `support_style: 'default'` produces different G-code than it did in 0.2.2 — tree, as upstream does.

## 0.2.2 — 2026-08-22

### Added

- SL1 import in the viewer: an `.sl1` archive opens through the file picker, drag & drop, or the new `files`
  prop — rendered as a raster preview, with the model shape reconstructed from the masks in the background
  (two passes: a coarse mesh in under a second, then full resolution). This viewer's own exports carry scene
  and role sidecars, so reopening one shows the exported surface itself, in the sliced preview's colours, and
  re-exports byte-identical. Opening an `.sl1` applies the archive's job description to the settings
  (`printer_technology` first), so a fresh FFF session switches to the SLA route.
- SL1 export: role/scene sidecar members, off-thread mask encoding, and a save window.
- Move scrub in Preview: a horizontal slider that walks the top layer move by move with a screen-fixed nozzle
  marker — upstream's sequential view. Position changes reach the host as the `moveScrub` event.
- `files` and `sl1` Viewport props: models, `.3mf` projects, `.sl1` archives and preset files handed in once
  at mount.

### Fixed

- The SLA print area is the resin display size, not `printable_area`.

## 0.2.1 — 2026-08-21

### Added

- `pad_around_object` (embed) is now supported in the SLA path — the `SLA_PAD_AROUND_OBJECT_UNSUPPORTED`
  capability gate is gone. It forces zero elevation (upstream `is_zero_elevation`), and an empty embed pad is
  legal: the ring survives only where supports stand.

### Performance

- SLA slicing: the raster fallback was rewritten, and slicing/prepare run layer-parallel on the multithreaded
  kernel — byte-identical output, with progress bands matched to measured time.

## 0.2.0 — 2026-08-19

SLA (resin) printing lands as a second technology in the same kernel, routed by `printer_technology`.

### Added

- SLA slicing in the WASM kernel: `slicer.sliceSla(stl, params)` on the engine handle,
  `client.sliceSla` / `client.sliceSlaJob` on the worker client. Results carry per-layer mask segment
  streams, generated support and pad meshes, `resin_ml` / `time_estimate` stats and `lift_layers`
  (pad + elevation) — no G-code.
- The support chain is PrusaSlicer 2.9.6's own, ported verbatim: support-point generator
  (SupportPointGenerator + SupportIslands), the default support tree, and the real pad geometry. Built
  against vendored NLopt 2.5.0, Prusa's bundled libigl, SGI glu-libtess, and CGAL headers.
- `deriveSlaParams(settings)`, `printerTechnology(settings)`, `resinCatalog` / `resinSettingsFor(name)`
  in `three-slicer/settings`; SLA machine profiles and the resin material catalog in the data files.
- Typed capability errors instead of silent approximation: `SLA_UNSUPPORTED_HOLLOWING` (hollowing/drain
  holes), `SLA_UNSUPPORTED_ORGANIC` (organic trees), `SLA_PAD_AROUND_OBJECT_UNSUPPORTED` (zero-elevation
  pad embedding). `SLA_CAPABILITIES` from `three-slicer/client` is the machine-readable map.
- Viewer: an SLA printer profile swaps the filament card for the resin card, previews the support/pad
  meshes with the lifted layer frame, and exports `.sl1` archives — portrait PNG masks (the SL1 family's
  panel mounting) plus upstream's `config.ini` field set.
- `<SettingsPanel/>` renders the SLA tabs for an SLA profile — no prop, it follows the settings map.
- `.3mf` SLA records (manual support points, drain holes) survive import/export round-trip.
- A runnable SLA example: `node node_modules/three-slicer/engine/examples/sla_headless.mjs`.
- `THIRD-PARTY-NOTICES.md` documenting the licenses compiled into the shipped kernels.

### Notes

- The multithreaded kernel carries the SLA path too and is pinned byte-identical to the single-threaded
  one over the same SLA slice.
- FFF output is unchanged: the golden byte-identical G-code check holds across this release.

Earlier releases (0.1.x) predate this changelog.
