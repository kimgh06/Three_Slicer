# Developer-interface friction log

What integrating this package actually feels like, recorded from two real exercises: building the
landing page's live embed (2026-08-25) and the four `examples/` demos. Every item below was hit, not
imagined — each carries the measurement or the source line that proves it. The list is a backlog:
items are ordered by how much host-side code they force, and each ends with the fix that would retire
it.

The pattern across both layers is the same, and it is the one worth fixing wholesale: **wrong input
fails silently.** An ignored prop, an ignored settings key, a worker that 404s only in production, a
model sliced off the bed — all of them return something plausible instead of an error. The SLA path
already has the opposite principle (a typed refusal for everything the port cannot do); the FFF
surface does not.

## Layer 1 — the `<Viewport/>` component

### 1.1 A host cannot trigger a slice — severity: high — FIXED 2026-08-28 (`sliceRequest` prop)

The component's contract is "props are the whole interface, no imperative handle"
(`../viewer-package/VIEWER.md`, *What the host cannot drive*), but slicing starts only from the built-in UI or
from `defaultAutoSlice` at mount. Hide the built-in chrome (`panels`) and put your own Slice button
next to the frame — the landing embed's exact shape — and the only mechanism left is remounting the
component with a changed `key` and `defaultAutoSlice` set.

Measured cost of that workaround (landing embed, 100–120ms sampling): the remount blanks the scene
and re-parses the model; the buttons stayed enabled for ~960ms after the click, then disabled for
240ms, then enabled again — a visible double-flip. Masking it required a host-side phase state
machine (`idle → preparing → slicing → done`), an overlay veil for the remount's blank frame, and a
fixed button width (`web/viewer/src/Landing.jsx`, `LiveSlicer`).

**Fix**: a slice-trigger surface — either a `sliceRequest` prop (a counter/token whose identity
change requests one slice) or a minimal imperative handle scoped to `slice()`/`cancel()`. The
"host cannot drive the scene" boundary can survive; slicing is an action, not scene state.

### 1.2 Prop lifetime contracts differ silently between look-alike props — severity: medium — MITIGATED 2026-08-28 (a post-mount `files` change now warns once)

Four props that all "hand content in" have three different lifetimes, distinguishable only by
reading `viewer.d.ts` comments closely:

| Prop | Lifetime |
| --- | --- |
| `defaultAutoSlice`, `defaultExtruderColors` | initial value only — later changes ignored |
| `files` | mount-only import — later changes ignored |
| `gcode`, `sl1` | re-injected whenever the value's identity changes |

Passing a new `files` array does nothing, silently. **Fix**: unify on identity-based injection, or
encode the contract in the name (`initialFiles`), and warn in dev when a mount-only prop changes.

### 1.3 "Missing key = schema default" has unadvertised exceptions — severity: medium

The prime tower ghost draws whenever two extruders are loaded, even though the schema default for
`enable_prime_tower` is `false` — the viewer honours only an explicit `false` in the map
(`viewer-package/src/Viewport.jsx:306`, deliberate: "the map, not the schema — the schema default
is off-bed"). The reason is sound; the surprise is that the exception is discoverable only in
source. **Fix**: document the map-not-schema keys in viewer-package/VIEWER.md, or emit the resolved value
through `onEvent` so a host can see what the component actually decided.

## Layer 2 — the parameter surface (`deriveKernelParams`, `slice(stl, params)`)

### 2.1 976 keys in, 127 keys effective, 849 keys silent — severity: high — FIXED 2026-08-28 (`support_type` routes tree; `ignoredKernelSettings()` + generated `kernelSettingKeys`)

The settings map accepts every schema key; `deriveKernelParams` maps a curated 127 of them onto the
kernel's 159 params, and the rest do nothing without feedback. Measured this week:
`support_type: 'tree(auto)'` — the key upstream uses to choose tree supports — is not consulted at
all (`packages/engine/src/settings.js:340-344` routes tree vs grid from `support_style` only), so
the request sliced grid with no warning. The same divergence applies to an imported Orca project:
`support_type: tree(auto)` + `support_style: default` slices grid here, tree upstream.

**Fix**: (a) make `support_type` participate in the routing (needs golden verification), and
(b) return `{params, ignored}` from `deriveKernelParams` the way `normalizeProjectSettings` already
returns `{settings, applied, skipped}` — the model answer exists in the same file.

### 2.2 Two vocabularies with different names and units — severity: medium

Schema key and kernel param differ in name (`initial_layer_print_height` → `first_layer_height`),
scale (`sparse_infill_density` 15 → `infill_density` 0.15), and shape (a point list → a bbox). The
mapping is unguessable by rule — which is why `engine/PARAMS.md` is generated by probing one key at
a time rather than parsed. Consumers permanently carry the question "which layer's key am I looking
at?" **Fix**: none cheap — the two vocabularies are load-bearing (upstream compatibility vs kernel
contract). The generated reference is the mitigation; keep it prominent.

### 2.3 Two disagreeing defaults per key — severity: medium

Schema defaults and kernel defaults disagree for several keys (`independent_support_layer_height`
true vs false, `printable_height` 100 vs 250 — `AGENTS.md`), which is why omission is the rule and
why the empty-map param count (93) is a test invariant. Correct, but it means "what happens if I
don't set this key" has a different answer per layer, learned from footnotes.

### 2.4 28 params reachable only by hand — severity: low

`extruder_count`, `economy`, `tree_lite_*`, `pe_lite` and 24 others have no schema key, so real
integrations always mix layers: `{...deriveKernelParams(settings), extruder_count: 2}`. Every
multi-material example in the docs has this shape. **Fix**: document as the intended idiom (done in
PARAMS.md's classification); consider schema-side keys for the few that hosts routinely need
(`extruder_count` above all).

### 2.5 Serialization contract differs per call path — severity: low — FIXED 2026-08-29 (the worker takes an object too)

The direct handle's `slice()` accepts an object and stringifies it; the raw worker required `params`
as a JSON **string** (the kernel parses text). Same object, two shapes, discovered at the boundary —
and arbitrary rather than principled, since the worker's own SLA branch had always taken either.
Below that sits the percent trap the JS side pre-resolves: `support_line_width` is `coFloatOrPercent`
but the kernel reads it with a plain number reader, so a raw `"120%"` would reach `strtod` and
resolve to 0 == auto (`AGENTS.md`). **Fix**: accept objects at the worker boundary too.

### 2.6 Positional vectors and the clear-then-merge preset contract — severity: medium — PARTLY FIXED 2026-08-28 (`applyPreset` exported; positional vectors unchanged)

Per-extruder vectors are positional and a hole must carry tool 0's resolved value — the kernel
cannot tell "absent" from 0. Presets carry only the keys they set, so applying one over another
without first deleting the catalog's `keys` leaves the previous material's values underneath (an ABS
chamber temperature under a PLA pick). All four demos re-implement the same `without()` helper.
**Fix**: an `applyPreset(settings, preset, keys)` export in `three-slicer/settings` — it is five
lines, but it is the five lines every consumer writes.

## Layer 3 — results and environment

### 3.1 The production-only worker 404 — severity: high (first-run experience) — FIXED 2026-08-29 (the client's default worker uses the bundler-recognized pattern)

`createSlicerClient()` with no argument built its worker through `engineWorkerURL()`, and a function
call does not match the `new Worker(new URL('literal', import.meta.url))` shape bundlers treat as a
worker entry — so Vite fell back to its plain-asset rule and copied the source in verbatim; the copy
imports an unhashed `./slicer_core.js` and 404s **only after `vite build`** — dev passes (measured in
instant-quote; all four demos hand-create the worker via `three-slicer/worker?worker` as the
workaround).

Reproduced on a Vite 5 app importing `three-slicer/client` and nothing else: dist held a 21KB
`slicer.worker-<hash>.js` — the untouched source — importing `./slicer_core.js`,
`./slicer_core.mt.js`, `./sla_request.js` and `./sla_core.js`, **none** of which were emitted; total
dist 40KB, i.e. no kernel at all. With the literal expression inline in `client.js`: a 12KB minified
worker chunk importing the hashed kernels beside it, dist 18MB. `pack_check.sh` now fails when a
worker chunk imports a file the build did not emit — verified against both builds, it fails on the
first and passes on the second.

One claim above was wrong, and is corrected rather than deleted: the mt kernel appearing twice in dist
is **not** a side effect of this. It is emscripten's own pthread bootstrap — `allocateUnusedWorker()`
in the mt glue does `new Worker(new URL("…/slicer_core.mt-<hash>.js", import.meta.url), {type:
"module"})`, so the bundler emits that module a second time as a worker entry. Removing it means
changing the emscripten build, not the JS surface.

### 3.2 Silent off-bed slicing — severity: high — FIXED 2026-08-29 (`result.warnings`)

Hand the kernel a bed-centered model and the plate-local contract adds the offset twice: a 20mm cube
sliced at X 234.7–265.4 on a 250-wide bed with plausible time and material and no error. The only
signal was `stats.over_bed_model` — one flag among twenty numbers; visually it shows only once a
toolpath is drawn (`examples/DEMOS.md` §4.5), which is why all four demos hand-wrote the same check.

Every slice result now carries `warnings: string[]` (`'over_bed_model'` today) — on the direct handle,
through `createSlicerClient()`, and on the raw worker's `done` reply. Not a typed refusal: the slice
is legitimate output for a caller who meant it, and refusing would break the plate-relative workflow
the viewer itself uses. `over_bed` (support/skirt/brim reaching past the model outline) deliberately
does not warn — upstream prints those outside the outline by design, and raising it on every brimmed
plate would train hosts to ignore the channel.

### 3.3 Result units and kernel-dependent numbers — severity: medium

`filament_mm` is a length; every consumer rewrites the grams conversion (diameter/density). The st
and mt kernels report `time_estimate` 25% apart on identical geometry (12m vs 15m, measured), so
deployment headers change a quote's price. `SegmentData.position` is stride 4 while the type says
only `Float32Array` — stride-3 reads shuffle coordinates (farm-dashboard, measured). Kernel G-code
carries no `;TYPE:` comments, so re-parsed toolpaths lose roles (Wall 94% vs the true Sparse 43% ·
Wall 38% · Solid 16% · Skirt 3%). **Fixes**: a `grams(stats, settings)` helper; document the st/mt
estimate divergence at the API (not only in a demo README); stride and role caveats into the d.ts.

## What to do first

The first four are done — 2.1 and 1.1 in 0.2.3's first pass, 3.1 and 3.2 in its second.

1. ~~`{params, ignored}` from `deriveKernelParams` + `support_type` routing (2.1)~~ — retired the
   whole "silent key" class and the worst real-world divergence (imported Orca projects).
2. ~~A slice-trigger surface on `<Viewport/>` (1.1)~~ — retired the remount workaround and its state
   machine.
3. ~~The production-only worker 404 (3.1)~~ — retired the only trap that broke a consumer's first
   production build.
4. ~~Prop-lifetime dev warnings (1.2), `applyPreset` helper (2.6), off-bed warning (3.2)~~.

What is left, in the order it is worth doing:

1. Unify prop lifetimes or rename the mount-only ones (1.2 is mitigated by a warning, not fixed) —
   a breaking change, so it wants a minor version.
2. `grams(stats, settings)` and the stride/role caveats in the d.ts (3.3).
3. The map-not-schema keys through `onEvent` (1.3), a schema key for `extruder_count` (2.4).
