# three-slicer

Browser/WASM 3D-slicing kernel reverse-engineered from [OrcaSlicer](https://github.com/OrcaSlicer/OrcaSlicer). Slices binary STL to G-code entirely client-side (or in Node) — no server, no native binaries.

**No three.js dependency.** This is a headless SDK with zero runtime dependencies; the config metadata it reads ships inside the same package (`three-slicer/data`). For a ready-made React viewer see [`three-slicer-viewer`](../../viewer-package/VIEWER.md), which takes this package's kernel worker as a prop.

Ported from the original C++ sources: Clipper polygon ops, Arachne variable-width walls, real fill patterns (gyroid TPMS / honeycomb / 3D-honeycomb / crosshatch / concentric), tree supports, pressure equalizer, arc fitting (G2/G3), scarf seams, ironing, multi-material with prime tower. Kernel changes are gated by a 120+ invariant test suite and golden byte-identical G-code checks.

## Install

```bash
npm i three-slicer
```

## Usage

```js
import { createSlicer } from 'three-slicer'

const slicer = await createSlicer()               // loads the WASM kernel (embedded in the ~4.8 MB JS glue)

// Batch: full result at once
const r = slicer.slice(stlArrayBuffer, { layer_height: 0.2, wall_loops: 2 })
console.log(r.stats.layers, r.gcode.length)

// Streaming: per-layer callbacks, frees each layer (OOM-resilient); result carries stats only
slicer.slice(stlArrayBuffer, params, {
  onProgress: (done, total) => {},
  onLayer: ({ z, idx, gcode, paths, widths }) => { /* accumulate */ },
})
slicer.dispose()
```

Off-main-thread (browser): `new Worker(engineWorkerURL(), { type: 'module' })` — the worker speaks a streaming protocol (`{type: 'layer' | 'done' | 'error' | 'progress'}`). Subpath `three-slicer/worker` exposes the worker entry for bundler-specific setups, and `three-slicer/client` wraps the protocol in promises (`createSlicerClient()` — `warmup()`, `slice()`, `sliceSla()`, `cancel()`; cancellation needs the multithreaded kernel, i.e. a cross-origin-isolated page).

The handle also carries `sliceSla(stl, slaParams)` for the resin path (see [SLA parameters](#sla-parameters)) and the painting surface `paintPrepare` / `paint` / `paintClear` / `overlay`.

## Parameters

Two levels — use whichever fits:

1. **Kernel params (this package's native contract)** — a flat JSON object (`layer_height`, `wall_loops`, `infill_density` 0–1, `sparse_infill_pattern`, `enable_support`, `wall_generator: 'classic' | 'arachne'`, …). Every accepted key is listed in [PARAMS.md](PARAMS.md).
2. **OrcaSlicer settings map** — a sparse `{schemaKey: value}` map using original OrcaSlicer option keys (976 defined in `three-slicer/data`); unset keys fall back to schema defaults:

```js
import { deriveKernelParams } from 'three-slicer/settings'
slicer.slice(stl, deriveKernelParams({ layer_height: 0.25, sparse_infill_density: 15 }))
```

**Known limit:** `deriveKernelParams` maps a curated subset of schema keys to kernel params. Editing other schema keys has no slicing effect (they exist for UI/metadata). Scalar options use their first element only; the filament options listed under *Materials* below are the exception — those keep every extruder's entry. Kernel parameters with no schema key behind them are reachable only by writing the params object yourself — [PARAMS.md](PARAMS.md) marks which those are.

## Kernel parameter reference

The full table — 159 parameters, generated from the kernel's own reader (`params.cpp`) so it cannot drift from
what `slice()` actually honours — lives in [PARAMS.md](PARAMS.md), including the classification of the 28
parameters no setting reaches. Regenerate with `node types/gen_kernel_params.mjs`.

## Materials and multi-material

A material is a **filament preset**: a set of schema values (temperatures, flow, diameter, cooling, retraction/z-hop overrides) that a printer profile declares itself compatible with. Read the catalog through the facade, never by decoding `three-slicer/data/filaments.js` by hand:

```js
import { filamentPresets, applyPreset, deriveKernelParams } from 'three-slicer/settings'

const filaments = await filamentPresets()               // lazy — the artifact loads on first call
filaments.listFor('Bambu Lab X1 Carbon 0.4 nozzle')     // [{name, type, vendor}, …]
filaments.recommendedFor('Bambu Lab X1 Carbon 0.4 nozzle')  // the vendor's shortlist, filtered to the compatible set

// Applying one: applyPreset CLEARS the preset's key set first. A preset carries only the keys it sets, so a
//  plain merge leaves behind whatever the previous material set and this one does not — a PLA pick after an
//  ABS pick keeps ABS's chamber temperature. `keys` is the exact set to clear, the filament and process key
//  sets are disjoint (clearing one never disturbs the other), and a null preset applies nothing.
settings = applyPreset(settings, filaments.settingsFor('Bambu PLA Basic @BBL X1C'), filaments.keys)
```

**One material per extruder.** Upstream stores every filament option as one entry per extruder, so a multi-material settings map writes each extruder's material at its own index:

```js
const params = {
  ...deriveKernelParams({
    nozzle_temperature: [255, 220],      // T0 ABS, T1 PLA
    filament_flow_ratio: [0.95, 1.0],
  }),
  // -> { extruder_nozzle_temp: [255, 220], extruder_flow_ratio: [0.95, 1.0], … }
  extruder_count: 2,                     // not a derived key — set it on the params directly
}
```

The kernel reads those arrays **positionally** and reloads the whole loaded-filament set — diameter, flow, retraction length/speed, z-hop, plus an `M109` when the temperatures actually disagree — at every `T` change. A single-element (or absent) option produces **no** `extruder_*` array at all, and the kernel then reads its scalars exactly as before, so a single-material slice is byte-identical to what it was before this feature existed.

`support_filament` / `support_interface_filament` are 1-based filament indices (`0` = "Default", keep the loaded tool) selecting which extruder prints the support base/raft and the support interface. `0` is omitted from the params rather than sent, so it emits no `T` command anywhere and leaves the support G-code byte-identical.

### Painting a region onto another extruder

Painting is the only way a **single** object can print in two materials — there is no triangle boundary to split on, only painted facets. The painted facets of each state are projected per layer and the sliced polygon is partitioned against them; where two extruders claim the same area the higher-numbered one wins (a total order on a small integer, so the result never depends on paint or clipper ordering).

Painting states are upstream's `EnforcerBlockerType`, one enum serving two jobs: `1` = ENFORCER = **Extruder1**, `2` = BLOCKER = **Extruder2**, `3..16` = Extruder3..16. The state-addressed protocol lives on the worker (`three-slicer/worker`); the direct handle's `slicer.paint({enforcer})` is the original boolean pair only.

```js
worker.postMessage({ cmd: 'prepare', stl })                          // -> {type:'prepared', facets}
worker.postMessage({ cmd: 'paint', state: 3, facet, hx, hy, hz, cx, cy, cz, radius, states: [1,2,3] })
//   -> {type:'painted', enf, blk, counts: {1: n, 2: n, 3: n}}
worker.postMessage({ cmd: 'erase', facet, hx, hy, hz, cx, cy, cz, radius })   // back to the default extruder
```

`erase` is its **own command**, not `{cmd:'paint', state: 0}`: embind coerces a JS `false` to the int `0` == NONE, and the legacy blocker brush sends exactly that `false` — so the state path rejects `0` outright and only `erase`, which takes no state argument, can clear anything. A message without `state`/`states` gets the original reply verbatim, so existing listeners are unaffected.

One consequence worth knowing before you build on this: because one selector serves both jobs, **a support BLOCKER paint and an Extruder2 paint are the same mark**, and a facet can hold only one of them. The two brushes are therefore mutually exclusive on a model, which is a data constraint, not a UI simplification. (Support itself is fine — the painted multi-material path runs the same support pass the single-material path does, so paint and generated support coexist on one slice.)

Results carry the split: `stats.filament_mm_by_tool` (indexed by tool number, one slot per extruder, sums to `filament_mm`) and `stats.filament_mm_purge` (the prime/wipe tower share, already included in the per-tool figures). In the streamed toolpath, `paths[k+3]` encodes `role + tool * 16` — mask with `& 15` for the role and `>>> 4` for the tool.

## SLA parameters

The table in [PARAMS.md](PARAMS.md) is the FFF kernel's reader. The SLA entry (`slice_sla`) reads its own parameter set, produced
by `deriveSlaParams(settings)` — unlike `deriveKernelParams` it always emits every key (54 today), filling
schema/reference-machine defaults, because the SLA keys are not shared with another technology whose defaults
could disagree. The groups:

| Group | Keys |
| --- | --- |
| Layers and exposure | `layer_height`, `initial_layer_height`, `exposure_time`, `initial_exposure_time`, `faded_layers` |
| Display (doubles as the bed) | `display_width/height`, `display_pixels_x/y`, `display_orientation` (portrait default), `display_mirror_x/y`, `bed_width/depth` |
| Archive identity (config.ini) | `printer_model`, `printer_variant`, `printer_settings_id`, `sla_print_settings_id`, `sla_material_settings_id`, `material_print_speed` |
| Supports (upstream `SupportTreeConfig`) | `supports_enable`, `support_tree_type`, `support_pillar_diameter`, `support_head_*`, `support_points_density_relative`, `support_critical_angle`, `support_max_bridge_length`, `support_max_pillar_link_distance`, `support_base_*`, `support_small_pillar_diameter_percent`, `support_pillar_widening_factor`, `support_max_bridges_on_pillar`, `support_max_weight_on_model`, `support_object_elevation`, `support_pillar_connection_mode`, `support_buildplate_only`, `slice_closing_radius` |
| Pad (upstream `PadConfig`) | `pad_enable`, `pad_brim_size`, `pad_wall_thickness`, `pad_wall_height`, `pad_wall_slope`, `pad_max_merge_distance`, `pad_around_object` (embed — forces zero elevation), `pad_around_object_everywhere`, `pad_object_gap`, `pad_object_connector_width/stride/penetration` |
| Capability gate | `hollowing_enable` — `true` is refused with `SLA_UNSUPPORTED_HOLLOWING`, never sliced solid |

The result has no G-code: `stats.sla` is `true`, layers carry the same stride-8 segment stream, `support_mesh`
and `pad_mesh` are triangle soups for the preview, and `stats.lift_layers` (pad + elevation) is what a preview
must lift the model by.

## License

AGPL-3.0-or-later (derived from OrcaSlicer). A web app embedding this package must comply with AGPL — including offering its source to network users.
