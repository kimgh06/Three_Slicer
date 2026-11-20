# AGENTS.md

Three_Slicer — a browser/WASM slicer reverse-engineered from OrcaSlicer. The root holds three folders:

- **`slicers/`** — the upstream reference checkouts, untracked: OrcaSlicer at `slicers/slicer` (the extraction/porting source — its own guide is `slicers/slicer/AGENTS.md`) and PrusaSlicer at `slicers/PrusaSlicer` (comparison only).
- **`packages/`** — the published npm package `three-slicer` (AGPL) plus the kernel sources. Zero build or runtime dependency on `slicers/`.
- **`viewer-package/`** — the published npm package `three-slicer-viewer` (MIT): the viewer without the slicer — model loading, G-code parsing, GPU toolpath rendering, the catalog-free settings transforms, the toggle evaluator (unbound), `<SettingsPanel/>` and `<Viewport/>` themselves. A host plugs the kernel worker and the vendor catalog into it through props (`web/viewer/src/kernel_viewport.jsx` and `settings_panel.jsx` are the demo's binding); `three-slicer` itself has no React code. The two publish as a locked pair (same version, exact pin — `packages/RELICENSE.md`).
- **`web/`** — the demo app shell. It consumes the package as a workspace (no relative-path imports). Details: `web/README.md` (the stage log is split out as `web/HISTORY.md`), `web/GUIDE.md`, `web/SPECS.md`. `web/extension/` is the browser extension: the app's `/slice` screen built a second time as an extension page, plus the link, download and Thingiverse hand-off (`web/extension/README.md`).

The root `package.json` is the npm workspaces root (`viewer-package`, `packages`, `web/viewer`, `web/extension`) — a single `npm i` at the root installs everything. `viewer-package` comes first because `packages` depends on it.

## Core rules

- **Never modify `slicers/`.** All development happens in `packages/` and `web/`.
- **No ternary operator (`cond ? a : b`), in any language or test.** Not nested, not single, not in JSX. A ternary
  packs a branch into an expression, where the condition, the two values and their order all have to be read at
  once — and a single one invites the next one inside it. Write an early `return`, an `if`/`else` assignment, a
  lookup table with `??` when the choice maps names to values (`{ key: value }[name] ?? fallback`), and `cond &&
  <Element/>` for conditional JSX. `?.` and `??` are not ternaries and stay. Existing code is converted as it is
  touched.
- **A value that has a named owner is read from it, never typed out again.** A list, label, limit or conversion
  written a second time is right only until the owner changes, and nothing fails when the copy drifts. The format
  list is the case that happened: `SUPPORTED_EXT` (`scene/model_loaders.js`) grows through `registerLoader()`, while
  the drop overlay and the load-rejection message spelled out `STL/OBJ/3MF/AMF/PLY`, so neither named STEP, which
  the demo registers, and the overlay named neither SL1 nor G-code. Derive the text from the owner (`EXT_LABEL` in
  `Viewport.jsx`, `SUPPORTED_EXT` in `model_load.js`); where a value has no owner yet, make one constant and read it
  everywhere. `test_layers.mjs` fails on the format list spelled out in code.
  A plain `''` or `0` has no owner and never changes, so it is not a constant. An empty value that carries a
  meaning is named instead: "clear the message" is `clearError()` / `clearSliceNotice()` / `clearTriWarn()`
  (`Viewport.jsx` wiring), not `setError('')` at each call site, and "no value" is `null`. `test_layers.mjs` fails on
  a `set…('')` outside those definitions.
  Tests and guards read the owner too. A guard that types out the list it protects checks the old list once the
  owner grows, and passes over a copy of the new entry. The fill tools are the example: `FILL_TOOLS`
  (`core/paint_tools.js`, exported as `three-slicer-viewer/paint` so the AGPL slicer worker reads the same set) was
  spelled out by the brush input, both paint panels and the worker, and the guard in `test_layers.mjs` that now
  catches that builds its pattern from `FILL_TOOLS`. The same applies to a list the test file itself repeats
  (`SOURCE_DIRS` there, typed three times before).
- `packages/` and `web/` must run, build and publish without `slicers/` (demonstrated in stage 34). Do not make changes that break this independence.
- Changes to the kernel (`packages/wasm-core/`) must pass the golden byte-identical check (`golden.mjs`) and the `test.mjs` invariant suite.
- Multi-material widened what "byte-identical" has to cover. Three conditions, each with its own `test.mjs` invariant, must keep producing the output the kernel produced before the feature existed: **no painted facets**, **no per-extruder arrays** (`extruder_nozzle_temp`, `extruder_flow_ratio`, `extruder_retract_*`, `extruder_z_hop`), **`support_filament` 0**. All three hold by omission rather than by a default: `deriveKernelParams` leaves those keys out of the params object entirely (93 keys from an empty settings map today), and `Params::forTool` / `support_tool_of` fall back to the scalar and to "emit no `T` command at all".
- **Omission is now the general rule, not a multi-material special case.** The kernel reads 159 parameters and
  `deriveKernelParams` can produce 131 of them; the `PASSTHROUGH_*` lists in `settings.js` are the ones whose schema
  key carries the same name, and every one is emitted **only when the settings map actually holds the key**. Filling
  in a schema default would be wrong rather than merely noisy: the two defaults disagree for several keys
  (`independent_support_layer_height` is true in the schema and false in the kernel, `printable_height` 100 vs 250),
  so a default-filled param would silently reslice every existing caller's model. The empty-map key count is the
  invariant that catches a violation. Two traps live in that list: `support_line_width` is `coFloatOrPercent` but is
  read by the kernel's plain number reader, not the percent-aware `json_width_raw` the per-feature widths get, so a
  `"120%"` would reach `strtod` as a quoted string and resolve to 0 == auto — it is resolved against the nozzle on
  the JS side instead; and the tree-support shape options exist upstream under two spellings (`…_organic` and
  suffix-less), which the kernel accepts both of and prefers `_organic`, so both are passed as written.
- **The kernel parameter reference is generated, and must stay that way** (`types/gen_kernel_params.mjs` ->
  `engine/PARAMS.md`). Its key column comes from the `json_*(params_json,"…")` reader call sites in `params.cpp`,
  which are the definition of the accepted set; its *From setting* column comes from PROBING `deriveKernelParams`
  with one schema key at a time rather than parsing it, because that mapping includes renames, rescales (`sparse_infill_density` 15
  -> `infill_density` 0.15) and a bbox over a point list, and a regex would have to re-implement each. Hand-written
  counts in docs drift — these ones did, from 89 to 93, before anything generated them. `test_kernel_params.mjs`
  fails the build if the table is stale or if a parameter no setting reaches is left unclassified in the prose
  below it.
- One material per extruder. Upstream stores every filament option as one entry per extruder, so the kernel takes per-extruder vectors and reads them **positionally** — a hole must be filled with the value tool 0 resolved to, because the kernel cannot tell "absent" from 0. On every `T` change `slice_multimaterial` reloads the whole loaded-filament set (diameter, flow, retraction length/speed, z-hop, and `M109` when the temperatures actually disagree).
- Support painting and material painting are **one** ported TriangleSelector, because upstream's `EnforcerBlockerType` is one enum: `ENFORCER`==Extruder1, `BLOCKER`==Extruder2, `Extruder3..16`==3..16. So a facet holds one integer, and a support BLOCKER paint is indistinguishable from an Extruder2 paint. The routing gate that used to send painted models to `slice_multimaterial` only when support was **off** is gone: `slice_mm.cpp` now runs the same `support_run` pass the single-material path does, so paint and generated support coexist on one slice (`slicer_core.cpp`). What remains is the ambiguity the gate papered over: a support BLOCKER paint and an Extruder2 paint are the same mark, so the two brushes cannot mark one model independently — upstream avoids this by keeping `supported_facets` and `mmu_segmentation_facets` as separate per-volume annotations (`Model.hpp:869`), and splitting the selector the same way is what would lift it.
- Painted regions come from upstream's exact per-layer segmentation, `MultiMaterialSegmentation.cpp`, ported to `packages/wasm-core/treesupport_port/libslic3r/`. Everything above its driver is upstream verbatim; the driver was rewritten because upstream's takes a `PrintObject` (nothing in this kernel has one) — it now takes the sliced contour of every layer plus the selector's painted facets, through `selector_bridge::segment_prepare` / `segment_regions`. Two consequences: `slice_mm.cpp` must slice **every** layer up front (the segmentation is a whole-object pass, and it reuses those contours so nothing is sliced twice), and a painted flat face reaches the print only through `segmentation_top_and_bottom_layers` — a horizontal facet cuts no slicing plane, so that pass is not optional. Its Voronoi/EdgeGrid/MutablePolygon dependencies were already linked for Arachne; only the one new TU was added to `build.sh`.
- **One coordinate frame per plate.** The viewer hands the kernel plate-local coordinates (world minus the plate
  origin) and nothing else. It used to subtract the content's own bbox centre instead, so the slice frame moved
  whenever the model did and every bed-anchored thing needed its own correction — the prime tower drifted by the
  model's off-centre amount and a paint stroke after a drag landed where the model used to be. That centring was a
  workaround for `infill_lines` (`clip_util.h`), which drew each pattern line through the origin-projected foot and
  extended it by the region's own SIZE, so a region further from the origin than that got no infill and no error
  (measured on a 20mm cube: sparse 828 -> 414, solid 427 -> 183). Fixed by adding the region's distance from the
  origin to the reach; the `[position invariance]` invariant in `test.mjs` pins it at six placements.
- **A pointer stream is sampled, not continuous, so a brush stroke is a CAPSULE and not a ball.** Upstream builds a
  `DoublePointCursor` between every adjacent pair of projected mouse positions (`GLGizmoPainterBase.cpp:878`);
  painting one sphere per sample leaves a fast drag as a row of blobs with gaps between them. `paint_input.js`
  carries the previous sample of the current stroke and `selector_bridge::paint_stroke` builds `Capsule3D`/`Capsule2D`
  from it — both were already ported for the single-point brush, only the bridge entry point was missing. The field
  is optional on the wire and feature-detected on the kernel (`Module.selector_paint_stroke`), so an older kernel
  keeps painting single points instead of failing.
- **A filament colour lives in two places and both have to be written.** `extruderColors` (viewer state) is what
  the viewer DRAWS — object bodies, paint chips, the paint overlay, the toolpath Filament view — and `filament_colour`
  is the SETTINGS key upstream stores the palette under, so it is what `<SettingsPanel/>` edits, what a "Save as 3mf"
  writes and what a project import reads back. Only the import direction existed: picking a colour moved the state
  and left the settings map alone, so a project saved after recolouring came back in the old colours (measured: the
  archive had no `project_settings.config` member at all). `actions/filament_colors.js` owns every mutation and
  mirrors the list into the settings map; nothing else may write either half on its own.
- **The brush must draw itself.** Upstream renders the cursor every frame (`render_cursor`, a ring for CIRCLE and a
  translucent ball for SPHERE); without it the radius slider is a number with no referent and the stroke is the
  first place its reach is visible. The viewer's default cursor is **circle**, as upstream's MMU gizmo is
  (`ImGui::CircleButtonIcon`) — sphere is a ball around the hit, so on a thin wall it paints the far side too
  (measured on the 3DBenchy hull: a few 5mm sphere strokes across the bow marked 21933 facets, most of them on
  surfaces the user could not see).
- **The section plane is clipped by two consumers in two frames, in opposite directions.** three.js keeps
  `normal·p + constant >= 0` in VIEWER coordinates; the kernel clips `normal·p - offset > 0` in KERNEL coordinates.
  The conversion is `core/paint_clip.js` and nowhere else, with a test that asserts the two agree point by point —
  a sign error there shows a correct-looking cut while the brush paints the half that was cut away.
- **`Ctrl`+wheel sizes the brush; the bare wheel stays the camera zoom.** It used to be the bare wheel, which took
  zooming away for as long as a brush was open. `Alt`+wheel scrubs the section plane, `Shift`+drag erases — all
  three are upstream's own bindings, and the erase modifier is why the box select refuses to start in paint mode.
- Painting is per facet, so a move must not cost it. `selector_reprepare` (bindings) rebuilds the selector on the
  moved coordinates — which the brush and the layer projection both need — and carries the marks across through
  upstream's own `TriangleSelector::serialize`/`deserialize`. It reports false and starts clean when the face count
  differs, because a different model's facet 7 is not this one's. The viewer decides which case it is from a
  TOPOLOGY key (`objectId:extruder:faces` per object), not from the vertex bytes: bytes change on every move.
- **Paint lives on each object; the selector is a working copy of one plate's.** The kernel's selector holds one
  merged mesh, so painting used to live nowhere else: painting a second plate discarded the first, and a copy on
  another plate whose plate-local merge was byte-identical to the original's was taken for it — it inherited the
  paint and the original lost it, in the G-code too. `object.paint` (the 3mf parser's shape: one Map per
  annotation, local facet -> split-tree hex) is now the store (`core/paint_store.js`). Four rules hold it together.
  **(1)** "Same mesh" is identity AND topology; bytes alone equate a copy with its original. **(2)** A swap to other
  objects writes the held marks back (`exportPaint`, split per `merged.members`), prepares, then loads the new
  mesh's marks from the store (`importPaint`) — one serialized chain per worker (`serial` in `support_paint.js`),
  strokes blocked by a null `paintXformRef` meanwhile, and the write-back waits with NO timeout: its reply queues
  behind a running slice, and giving up would prepare the next mesh over paint never saved. **(3)** Anything that
  reads `object.paint` for objects the selector holds flushes first (`flushPaint`: 3mf save, copy, slice-all), and
  every slice on the selector worker awaits `syncPaintSelector` for its own plate — a deferred pool plate included.
  **(4)** A pool worker loads its plate's stored paint (`ctx.loadPaint`) and its reply's counts decide the extruder
  count; a plate the selector does not hold reads its tool changes from the store (`storedPaintStates`, which
  decodes upstream's split-tree hex — pinned against kernel strings in `test_paint_export.mjs`). A copy carries a
  deep copy of the paint, as upstream's ModelVolume does. Paint is still outside undo. **(5)** Only the held mesh
  has a kernel overlay, so every other object draws its stored paint itself (`refreshStoredOverlays`, run after each
  selector job): `paintTriangles` replays upstream's split rule in JS — exact midpoints, the special-side rotation,
  children in reverse stream order — and the result is pinned against the kernel overlay's triangle count and area.
  Without it a plate's paint looked erased the moment another plate was painted. **(6)** Every wait on a worker ends
  (`core/worker_reply.js` `request`): on its reply, on its own `{type:'error'}` (the worker echoes `requestId` on
  every reply, so another command's error cannot end it), on an error event, or on `terminate()` — which
  `makeTerminationObservable` turns into an event. The echo is pinned against the REAL worker
  (`packages/engine/tests/test_worker_replies.mjs`, every paint command's reply type, contents and id): the viewer's
  tests drive a fake worker, and a local `const reply` shadowing the echo helper once broke overlay, clear and import
  with none of them noticing. A hung write-back once left "Saving…" and a blank viewport
  (rendering stays suspended until the export ends). **(7)** The selector record belongs to one worker
  (`record.worker`): after the watchdog or the memory ladder replaces it, nothing is written back from the new, empty
  selector (that wiped the store: 208 -> 0) and the next registration reloads the store. **(8)** The record carries
  the KIND of its marks — set when paint is loaded and when a stroke lands — and the write-back files them under it;
  reading the brush mode at write time filed material paint as support paint. **(9)** A pool worker's selector must
  hold exactly its plate's paint: slicing never resets it, so an unpainted plate after a painted one is sliced after
  a `clear` (`poolPaintAction`; measured without it: T2 314 -> 1215 mm). **(10)** The 3mf writes each object's
  `color` and `supports` marks under their own attribute; an empty map is no paint. **(11)** Every worker the retry
  ladder recreates gets its plate's paint back before the retry (`sliceLadder`'s `afterRecreate`: `ctx.syncPaint`
  for a pool worker, `syncPaintSelector` — which flushes first — for the selector worker); a retried painted plate
  came out single-material with "G-code is fine". The overlay colour reads the recorded kind, never the last brush
  opened. **(12)** The selector holds ONE annotation — upstream keeps material and support paint as two annotations
  of a volume. Opening a brush of the other kind swaps it (`registerSelector(merged, {kind})`: the held marks go back
  under their own kind, the requested kind is loaded), and a slice asks for `'auto'` (material first). Brushing
  material over loaded support paint used to file every support mark as material paint (supports 208 -> 0, color
  278). While the support annotation is held, the held objects' material paint is drawn from the store. A save
  waits at most `PAINT_EXPORT_TIMEOUT_MS` for the write-back — the store is flushed before every selector slice, so
  only strokes made during a running slice can be missing, and the notice says so. A pool worker whose plate paint
  fails to load fails the plate ("failed to load" -> re-queued on the selector worker) rather than slicing it bare.
  `test_paint_swap.mjs` drives the real `makeSupportPaint` against a fake selector worker for all of this.
  **(13)** No stroke reaches the selector while it slices: a slice start closes the brush (its 'auto' swap could
  otherwise file the open brush's strokes under the other kind), and the store is flushed right before it. So a
  flush during a selector slice has nothing to fetch and answers `'busy'` at once — a save, copy or duplicate used to
  queue behind the whole slice. **(14)** A load the worker fails leaves the selector empty while the store is not:
  the swap returns 'load-failed', clears the record's kind (nothing may be written back over the store) and keeps
  strokes blocked; the pre-slice sync turns it into a failed slice rather than a bare one. **(15)** Undo restores a
  DELETED object's paint (the snapshot carries `paint` by reference — the store never mutates a map — and delete
  flushes first); a live object keeps its own, so undoing a move does not roll back strokes made after it. Strokes
  themselves are still outside undo. **(16)** A raycast reports the facet in the HIT OBJECT's numbering and the
  selector numbers across its merge, so every stroke goes through `mergedFacetOf(members, id, facet)` — it used to
  send the raw index, and only the merge's first object could be painted. A stroke that reaches an object of
  another plate selects that plate and swaps the selector to it with the open brush's kind (`onPaintPlateNeeded`);
  the samples arriving during the swap are held (the latest one is painted once it lands, which is what makes a
  fill click on another plate work), the capsule restarts, and the section plane is re-sent in the new plate's
  frame. A hover never swaps. An object on the held plate that the merge predates (an unpainted file dropped with
  the brush open, an object shown again) takes the same path — its strokes used to vanish — and one the
  registration still leaves out is not asked for again until the merge changes. `test_paint_plate_switch.mjs`
  drives the real `createPaintInput`. Paint for a filament that is not configured is left out of the extruder count
  on every path (`paintedExtruderCount`, `usesMultipleTools`) and named in a notice: the selector worker reported
  only the configured states and a pool worker all 16, so one plate sliced with two different counts.
  **(17)** The kernel overlay is one mesh per state across every held object, so it cannot follow one dragged
  object (moving it carried the other objects' paint along until the drop). A transform drag (gizmo or scale
  corner) flushes the selector, hides the kernel overlay and lets every held object draw its stored marks as its own
  children (`beginPaintDrag`); the drop's re-registration awaits the rebuilt overlay and shows it again.
  **(18)** A slice on the selector worker queues a hold right behind its paint load (`holdSelectorForSlice`) and
  releases it once the slice is posted: a drag committed in between took the move path, whose `prepare` reached the
  worker ahead of the slice. Any swap to another plate re-sends the section plane, not only a stroke's. A copy's
  paste waits for the copy (`clipboardRef.copying`), and one delete runs at a time, so a repeat adds no undo entry.
  **(19)** A write-back the worker FAILS (error reply, death, timeout) is not "nothing to write": `writeBack`
  resolves 'failed', and a swap stops there with the selector and its unsaved strokes as they were ('export-failed',
  which the pre-slice sync turns into a failed slice). Only a kernel without the export binding still swaps on.
  Clear is a selector job too: sent straight to the worker it landed between a swap's export and load, and the load
  put the paint back; it also empties the held objects' stored marks and the remembered counts. Opening a brush of
  the other kind nulls `paintXformRef` at once: its swap queues behind any running selector job while the brush
  switches immediately, and strokes in between were filed under the old kind. **(20)** The section plane reaches the
  kernel only with a frame to convert it in (`section_plane.js` skips while `paintXformRef` is null), and every swap
  that leaves an open brush with a frame re-sends it — a same-plate brush-kind switch used to leave the kernel a plane
  converted against 0,0. A held object draws from the store the kind it would show unheld when that is not the held
  kind (support-only paint vanished after a drag kept the selector on material). A load no brush asked for (a
  slice's 'auto', an import, a move) reports support paint left out under material paint.
- **The mesh-direct SL1 mask is only used for a consistently wound mesh** (`core/mesh_winding.js`, checked per export:
  720k facets in ~0.7s). It counts the surfaces above a pixel by each facet's own facing; the kernel reverses a loop
  assembled mostly backwards. They agree for consistent and fully inverted meshes and coincident copies, and not
  when only some facets are flipped (measured: 6400 px lit under a table top whose top faces were flipped, where the
  slice holds the 256 px leg). Any other mesh gets the contour raster of the kernel's own contours.
- **A `.3mf` is a project, not a mesh format.** Anything off MakerWorld, and every OrcaSlicer/BambuStudio "save
  project", is a zip whose `3D/3dmodel.model` is only one member; `Metadata/project_settings.config` holds the
  flattened preset the author sliced with, `Metadata/model_settings.config` the per-object state and plate layout.
  `parse3MFProject` reads all of it (`parse3MF` stays the geometry-only shape). Two traps that do not look like
  traps: **(1)** every value in `project_settings.config` is a STRING — a bool is `"0"`/`"1"` — and `deriveKernelParams`
  reads bools with `!!v`, so importing raw turns every disabled option ON (`!!"0" === true`). Everything must go
  through `normalizeProjectSettings`, which coerces by config-schema type and drops non-schema keys. **(2)** The
  same trap again in a shape that does not look like one: a POINT is the string `"XxY"`, while every consumer
  indexes it as an `[x, y]` pair — so a raw `printable_area[1][0]` is the CHARACTER `'2'` of `"256x0"` and the bed
  comes out **2mm x NaN** (measured on a real MakerWorld project). `coPointsGroups` is a comma-separated LIST of
  such points in one string, and a few options (`best_object_pos`) use `,` where the rest use `x`. A `test_3mf_project.mjs`
  guard asserts every schema option type has a decided coercion, because points were missed exactly by nothing
  forcing that decision. **(3)** Painting is NOT in `model_settings.config` with the rest of the per-object state —
  it rides on the `<triangle>` tag itself as `paint_color` / `paint_supports` / `paint_seam` / `paint_fuzzy_skin`.
  Upstream's `inherits` / `different_settings_to_system` reconciliation (`Preset.cpp:2577`) is deliberately NOT
  reproduced: it exists to rebase a stored preset onto a LOCAL vendor preset database of a possibly different
  version, and this package has no such database — the flattened values are taken as written.
- A painted facet's 3mf value is its split TREE, not a state: upstream writes the same bitstream
  `TriangleSelector::serialize` produces, as hex, most-significant nibble first (so Extruder3 reads `"0C"`). The
  selector already had both halves of that codec; the only piece that had to be ported is the hex↔bitstream
  conversion, `FacetsAnnotation::get_triangle_as_string`/`set_triangle_from_string` (`Model.cpp:3542`), now
  `selector_bridge::apply_paint_hex`. Three things it forces on callers: `triangles_to_split` must be strictly
  ascending (the bridge sorts and de-duplicates, since a 3mf lists facets in its own order); the import REPLACES
  every mark because upstream's `deserialize` resets first, so it may only run on a freshly prepared selector; and
  a malformed hex string drops its whole facet rather than leaving a truncated bitstream, which the tree walker
  would read straight into the next facet's share. The reverse, `selector_bridge::export_paint_hex`, is the port of
  `get_triangle_as_string`, batched over one `serialize()` instead of upstream's per-facet binary search. It is what
  a "save project" needs and JS cannot substitute for: a brush stroke lives ONLY in the selector, and it is a split
  tree, not a facet list — one measured stroke on a 12-facet cube exports 2 source facets carrying 1168 painted
  sub-facets in a 1673-nibble string.
- **Writing a project is not the mirror image of reading one.** `write_3mf.js` re-encodes what the parser decodes,
  so each of the import traps has a matching one here: every value goes back out as a STRING through
  `serializeProjectSettings` (the inverse of `normalizeProjectSettings`, `settings.js`) — a raw JS `false` would be
  read back by anyone's parser as the string `"false"`, which is truthy; a point goes back to `"XxY"`; and the plate
  positions are re-encoded under UPSTREAM's grid (the constant is `UPSTREAM_PLATE_GAP_RATIO` in `plate_layout.js`,
  shared with the importer so the two cannot drift). Two asymmetries that are NOT bugs: the kernel's facet numbering
  is per merged mesh and a 3mf's is per object, so `write3MFProject` rebases with the same running offset
  `buildMergedSTL` used — which is why `exportObjects` must return objects in that same extruder-sorted order.
  Painting is written from the per-object store after a `flushPaint`, so every plate's brush strokes are saved in
  each object's own numbering; the writer still accepts a merge-numbered `paintExport` for a caller that has one.
  `write3MFProject` is **async** because the deflate runs off-thread (fflate's worker pool) — a save is dominated by
  compression, and on the main thread that is a frozen tab. Measured on a 980k-facet model: 2.6s all-on-thread when
  this landed, 1.5s wall / 0.45s longest frame gap now. Two of that came from choices worth not undoing: the weld keys
  vertices by their float32 BIT PATTERN rather than a decimal string (708ms -> 89ms), and the zip is level **3**,
  which on this XML is both faster than level 6 and slightly smaller. The `[vp-prof] export` line reports
  gather/paint/write separately, because the three scale with different things.
- **Selection is a set, and the kernel's facet numbering does not follow it.** `exportObjects({selectedOnly})` is
  upstream's `export_stl(..., selection_only, ...)`; upstream additionally rejects anything that is not a whole
  object (`Plater.cpp:16244`), which this viewer cannot hit because it has no parts. The trap is the painting: the
  kernel numbers facets across the merge of every VISIBLE object, so handing that numbering to a file holding only
  SOME of them paints the wrong triangles. The save therefore takes each object's paint from the per-object store,
  which is numbered per object to begin with — a subset needs no rebasing.
- Upstream's selection rules, ported as-is (`GLCanvas3D.cpp:4412` and `:4404`): a plain click replaces the
  selection, **Ctrl+click** adds or removes, a plain click on something already selected KEEPS the set (that is what
  makes dragging several objects work), empty space clears, **Shift+drag** is the box select, and Ctrl+A selects
  all. Alt is not a de-select there (`//BBS: don't use alt as de-select`) and is not one here.
  Two deliberate differences. **(1)** `TransformControls` attaches to one Object3D, so a multi-selection is driven
  through a pivot Group the meshes are re-parented onto (`Object3D.attach` preserves world transforms both ways);
  the commit releases it, seats each mesh individually — a rotation lands them at different heights — and rebuilds
  the pivot, because the selection has to survive its own drag. The pivot lives inside `objectsGroup` so hiding that
  group still hides its children. **(2)** Upstream's box select is a GPU picking pass over a framebuffer the size of
  the rectangle; here each object's world bbox is projected to screen and intersected with it, the same approach
  upstream uses for its point-based gizmos. The only visible difference is that a fully occluded object inside the
  rectangle IS selected here — the harmless direction to err in when picking whole objects.
- **An imported project's object positions are absolute, under UPSTREAM's plate grid — not this one's.** A
  slicer-written 3mf lays its plates out in world space, so an object's coordinates already say which plate it is
  on and where: upstream's origin is `(col*W*1.2, -row*D*1.2)` at the plate's **corner** with rows growing along
  **-y** (`PartPlate.cpp` `compute_shape_position` / `plate_stride_x`, `LOGICAL_PART_PLATE_GAP = 1/5`), while this
  viewer uses a constant 40mm gap and a plate origin at the **centre** (`plate_layout.js`). The two coincide at a
  200mm bed (`200*1.2 == 200+40`) and diverge everywhere else — 307.2 vs 296 on the 256mm bed a Bambu project
  uses. `platePlacements` (`model_load.js`) therefore decodes with upstream's rule and re-emits offsets for ours,
  falling back to per-plate group re-centring if any object fails to decode onto the plate it claims.
  Two things make this easy to get wrong and hard to see: `bakeLocal` centres every object's geometry and the
  placement cursor then puts it wherever it likes, so the file's position survives ONLY in the bbox the parser
  records; and the bed used to lay the plates out at import time must come from the project's own settings, not
  from the component's `kp` — `setSettings` has not landed yet, so `kp` still holds the 200mm default and the
  effect that re-lays the plates afterwards then slides the grid out from under everything just placed (measured:
  56mm per column, so plate 2 ended up 112mm off).
- 3mf facet indices are per OBJECT, the selector's are per MERGED MESH. The rebasing happens in `buildMergedSTL`
  (`viewer-package/src/core/model_geometry.js`) and nowhere else — that function is what decides which objects are merged and in what
  order (visibility, plate, the extruder sort), so any other place would be guessing. It survives `bakeLocal` and
  the STL weld because both preserve triangle ORDER.
- One facet holds one integer (see the EnforcerBlockerType note above), but a 3mf keeps material and support paint
  in two independent annotations that can both mark the same facet. On import **material paint wins** and the
  support paint is reported as dropped — half-applying it would be worse than not applying it.
- **The G-code text names the roles the stream records** (`Params::gcode_role_tags`, which the viewer turns on).
  A finished FFF slice is previewed from its own exported G-code read back (next rule), and an exported `.gcode` /
  `.gcode.3mf` opened again is read the same way, so the roles have to be in the TEXT; the multi-material path wrote
  no role marks, and an opened painted model drew its object as prime tower. `GcodeWriter::role_tag`
  writes upstream's `;TYPE:<name>` from the same kernel type `push_toolpath_segment` records — one call per run in
  every `emit_*` path, re-stated after every layer marker (`GcodeWriter::layer_begin`) and after the real WipeTower's own tagged block
  (`role_tag_unknown`). Upstream names where one exists; raft and thin wall, which upstream folds into Support and
  walls, keep `Raft` / `Thin wall` so a read-back here keeps their colours (OrcaSlicer reads them as Undefined). The
  flag is opt-in because the default G-code is golden-pinned; the tags change neither the time estimate nor the
  filament total, and st/mt stay byte-identical with them on. `[role tags]` in `test.mjs` pins it by reading the
  text back through `gcode_parse.js` and comparing per-role extrusion length with the stream in nine cases. The
  parser resets its role at a layer MARKER, never where a layer lazily opens: that reset threw away a `;TYPE:`
  written between the marker and the first move (every raft layer here, and Cura's `;LAYER:` files).
- The toolpath stream's role field (`paths[k+3]`, stride 8) encodes `role + tool * 16`. Roles only reach 11, so the tool rides in the spare high bits rather than a 9th float — the segment stream is the largest array the viewer holds and a 9th float costs +12.5% of it for one small integer. **Anything reading that field must mask** (`& 15` for the role, `>>> 4` for the tool); pre-encoding output is entirely below 16 and decodes to its own role with tool 0. The viewer's readers and writers take the layout from `viewer-package/src/core/toolpath_encoding.js` (`STRIDE`, `ROLE`, `encodeRole`/`roleOf`/`toolOf`); the engine's standalone SLA worker keeps named copies.
- `web/extract_all.py` takes the kernel key list (which preset columns to keep) from the GENERATED
  `viewer-package/src/settings/kernel_setting_keys.js`, the list `gen_kernel_params.mjs` probes out of
  `deriveKernelParams`. It used to regex-scan `packages/engine/src/settings.js` for quoted schema keys, which had two
  failure modes: a comment quoting a key added a column, and when the mapping moved into `viewer-package` the scan fell
  to 3 keys without an error (the committed presets predate the move, so it only showed on the next extraction).
  A missing or empty list now stops the extraction. Regenerate the list first when the mapping changes.
- **The object tools have one kernel entry for all geometry edits.** Boolean, Cut, engraved Text and negative parts all go
  through `mesh_boolean` (`mesh_boolean.cpp`, CGAL corefinement with exact constructions; the worker's `meshBoolean`
  command), and a non-solid input is refused with a typed `MESH_BOOLEAN_…` code. Corners weld on a 0.1 micron grid, not by float
  bits: three.js' cylinder seam and sphere poles differ by 1e-16 near 0, which refused them on plate 0 only. A negative part stays a live object:
  `prepareGeometry` (`actions/object_tools.js`) cuts each object it overlaps and caches that on the object as `cutPos`
  against the transforms involved, before a slice or export reads the geometry, because `buildMergedSTL` is synchronous
  and the boolean is not. `geometryInput` is the one place negative parts leave the merge and `cutPos` enters it. A
  multi-selection holds its meshes on a pivot, so their `position` is pivot-relative until it is released: a tool clears
  the selection before `recordHistory` (measured: an undo put the object 10 mm under the bed).
- **Seam paint reaches the kernel as triangles, not through the selector.** The selector holds one annotation, and a slice
  needs material and support paint from it, so the brush uses it only to edit (`kind: 'seam'`, modes `seam-enforcer` and
  `seam-blocker`). A slice swaps seam marks out of it, because they share state numbers with support marks, and
  `buildMergedSTL` sends `object.paint.seam` as `seam_enforcers` / `seam_blockers`. `seam_paint.cpp` cuts those with each
  layer plane, and `rotate_seam` inserts a vertex at the mark nearest the loop. Arachne walls take the same point through
  `seamed_walls` (`emit_layer.cpp`), with an interpolated width, and the multi-material path sets the marks around its walls
  only, because its prime tower shares the seam context.
- **The Text tool's fonts are the host's.** `viewer-package` ships only the three.js Latin font (tarball 315 kB; the four
  Noto Sans CJK files are 23 MB) and takes the others through the `textFonts` prop; the demo binds them once in
  `web/viewer/src/kernel_viewport.jsx`, so the extension gets them too. Han never falls back by script
  (`core/text_runs.js`): one code point has a different form per language, so only the picked font may draw it. Outlines go through `core/glyph_shapes.js`, not `Font.generateShapes`: three.js'
  `toShapes` reads holes from TrueType's contour order and winding, which turned ㅁ of a CFF `.otf` inside out.
- **Variable layer height is `plan_layers`' `bands` argument** (`variable_layer_heights`, flat `[fromZ, height, ...]`, in
  the settings map). With no bands the arithmetic is the fixed-height loop, so golden is untouched. Support, raft,
  multi-material and spiral all assume one height, so together with bands they are refused with
  `UNSUPPORTED_VARIABLE_LAYERS`. A band under 0.01 mm is `INVALID_VARIABLE_LAYERS`: 0 never reached the top of the object.
- **Arrange and Orient are this package's own algorithms.** `viewer-package` is MIT, so upstream's AGPL `Arrange.cpp` and
  `Orient.cpp` must not be read while changing them (`packages/PROVENANCE.md`).
- **The transform gizmo is deliberately not the stock one.** Three edits to `TransformControls`, each measured, each
  easy to mistake for superstition and delete: (1) `showY` is false in **translate** mode only — a part prints off
  the bed, so up/down is not a move (it also takes the XY/YZ plane handles, leaving X/Z; `gizmo_fit.js` removes the XZ plane). Set per mode, and
  `seatMesh` still has to run on commit because rotate and scale move the lowest point. (2) The scale gizmo's `XYZ`
  handle is **removed from the object graph**, not hidden — the per-frame update rewrites `visible` and `scale` on
  every handle it owns, so flags do not stick; the bounding-box corners (`scale_box.js`) are the usable version of
  that grip. (3) A 16px dead zone around the gizmo origin in scale mode: a scale drag's ratio is
  distance-now/distance-at-press, and every axis picker reaches the origin, so a press there divides by ~0 — measured
  4e7 on a 20mm cube, and negative past the centre, which mirrors the mesh and inverts the winding the kernel slices.
  `clampMeshScale` bounds the result (0.2mm..5000mm, positive) for the drags that stay legal.
- **The gizmo stands outside the selection** (`core/gizmo_layout.js`, applied by `scene/gizmo_fit.js`). Handles sit past
  the selection's box, sized by it with a pixel floor (the gap has one too, so it grows with the camera's distance), and rotate rings clear its corners. TransformControls resets each
  handle every frame, so its `updateMatrixWorld` is wrapped; arm stems and plane handles are removed and pickers shrink
  to the arm's end, because they reached the centre and took clicks meant for the model.
- **Dragging the selection or the box around it moves it on the bed** (`scene/body_drag.js`), in move mode only. It runs on
  TransformControls' XZ drag and starts past the click distance, because a drag records an undo step. A left drag on a
  model therefore no longer orbits; empty space and the right button still do.
- **Fine adjust lasts while Alt (Option) is held** (`hooks/use_fine_adjust.js`). Option changes what digits type, so a
  field that takes focus keeps the panel open past the key, as the panel's Hold button does until it is released. Typed values go through the gizmo's `dragging-changed` pair
  (`scene/fine_transform.js`), so they commit as a drag does. Scale box corners do not snap.
- **A rotate ring turns by the angle the pointer sweeps around it** (`scene/ring_drag.js`), not by TransformControls' travel
  across the axis: one 30 degree sweep measured 56 to 146 degrees by where it began. With Alt held it runs at a quarter
  speed, because 1:1 was over a degree per pixel and the 1 degree snap skipped values. The panel's angles are kept per axis
  beside the rotation they led to, since Euler angles read 100 degrees about Y as `[-180, 80, -180]`.
- **Corner handles must win the pointer where they overlap a gizmo axis** — they are drawn over everything, so they
  have to act there too. TransformControls picks its axis on HOVER and its listener is registered first, so it cannot
  be outrun in `onDown`; it is switched off while the pointer is on a handle instead (`updateHandleHover`).
- **Letter shortcuts match `e.code`, never `e.key`** (`shortcut_keymap.js`). Under a Korean layout `e.key` for the M
  key is `'ㅁ'`, so every letter shortcut died while the IME was on while the arrows and Delete kept working — which
  is what made it look intermittent rather than broken. `e.key` stays as a fallback for remapped Latin layouts.
- **Undo/redo covers the viewport's own state and stops there** (`history.js`). `settings`/`setSettings` are the
  HOST's props, so the boundary is drawn by the component's interface — painting, the prime tower and the plate
  count sit outside it too (paint restore needs a kernel `prepare` per step; the other two write host settings).
  Three things the design depends on: entries are **snapshots, not inverse operations** (geometry rides along by
  reference — `localPos` is immutable — so undo and redo become one function with the stacks swapped, and a new
  scene feature becomes undoable by calling `record()` and nothing else); `record()` runs **before** the mutation,
  and a drag records at its START (`onTransformStarted`) because the commit only fires once the mesh already holds
  the new pose; and restoring must redo a move's commit work (`registerSelector` + `checkBed`) or the paint overlay
  is left where the model used to be. `restoreScene` re-creates a deleted object **under its original id** — the id
  is half the paint topology key (`${id}:${ext}:${faces}`), so a fresh one silently drops that object's painting.
  Record at the ACTION layer, never on the buttons: delete alone is reachable from four entry points.
- **Per-plate settings are a sparse override, and absence means "follow the global map".** `plateSettings`
  (`{[plateIndex]: sparse map}`, a host prop beside `settings`) merges over the global map for that plate's
  slice only (`viewer-package/src/core/plate_settings.js` -> `viewer-package/src/hooks/use_slicer.js buildParams`) — upstream's
  PartPlate::m_config applied over full_config, in this package's omission discipline. With no override the
  merge returns the global map BY IDENTITY, which is what keeps the no-override path byte-identical to the
  pre-feature output. `PLATE_SETTING_BLOCKED_KEYS` is EMPTY since the heterogeneous-bed stage (the exported
  array stays the source of truth for any future scene-global key, and `test_plate_settings.mjs` gates this
  paragraph): `printer_technology` routes per plate (`plateTechnology` -> `use_slicer.js`, so an SLA-override
  plate goes to `slice_sla` beside FFF neighbours, its grid cell sized to its resin display), and a
  bed override (`printable_area`/`printable_height`) resizes that plate's own grid CELL — `plateLayoutHetero`
  (plate_layout.js) swaps the closed-form uniform grid for a cumulative one whose uniform case is pinned
  byte-equal by `test_plate_layout.mjs`, and membership/origins follow through `plateGrid()`/`buildMergedSTL`'s
  `plateDims`. What the 3mf CANNOT represent is refused typed at export, never approximated:
  `UNSUPPORTED_MIXED_TECH_3MF` for mixed technologies, `UNSUPPORTED_MIXED_BED_3MF` for mixed beds (same
  instanceof+`.code` shape as the engine's SlaRequestError). Staleness has two scopes:
  a global settings change still invalidates every plate's cached result, a plate-override change invalidates
  that plate alone, and a model load drops only the plate it lands on (`slice_staleness.js`, `model_load.js`).
  Plate identity is the plate INDEX, and only the last plate is deletable, so a delete truncates overrides
  exactly as it truncates `wipe_tower_x/y`.
  Two rules came out of the bug class this feature kept producing, and `test_plate_settings.mjs` /
  `test_layers.mjs` gate both. **(1) One derivation of what a plate prints with: `plateContext(settings,
  plateSettings, plate, dims)`** — effective map, technology, derived params and the frame the kernel enforces
  (bed, or the resin display with no ceiling). Viewport holds `globalFrame` (`plateSettings` null: the uniform
  grid cell, a project import's fallback bed, the 3mf stride, the global bed inputs) and `ctx` for the selected
  plate; the grid cells, the bed check, the tower boxes, the nozzle and bed rows, the injected-G-code frame and
  the support-progress shape all read a plate's context. Before this each of them read a `kp` derived from the
  global map and each was wrong for the one plate whose override differed — the last one measured was a resin
  project's single FFF plate keeping a 120x68 cell under a card that said 256x256. `test_layers.mjs` fails the
  build on `deriveKernelParams(settings)` / `kp.` in Viewport, ui/ and actions/. **(2) A plate-scope profile
  pick is written WHOLE and describes its own machine.** An override is additive — it cannot unset a global key
  — so a pick recorded as a diff left every key shared with the global machine off the override, and the next
  global printer change moved them: a plate ended up on a mixture of two machines. A printer pick in plate scope
  therefore writes the machine row, `printer_technology` (vendor rows carry it only for resin — an FFF row omits
  it, and a diff read that as "follow the global technology"), the vendor's recommended print preset and both
  ids in one `writePlateOverride(..., forceKeys)` call; material picks do the same for their column set. Single
  value edits stay diffs. A global technology switch then has one rule: an override without its own
  `printer_technology` is hand-edited values authored against the technology that just left (the Resin card's
  `layer_height` is an FFF key too) and is dropped, saying so in the status line; one with it stays. The scope
  toggle's ↺ drops a plate's whole override — the one-click complement of a pick writing a whole machine. The
  `printerKeys` union must not be used as "what the printer owns" against a preset: it holds `layer_height`
  because two resin rows set it, and guarding it blanketly meant no FFF quality preset could change the layer
  height (measured); `applyProcessPreset` guards only the picked row's own keys.
- **The classic wall generator is upstream's `process_classic`, not a kernel approximation** (`classic_bridge.cpp`,
  the only TU where the classic path meets Slic3r types; `MedialAxis.cpp` verbatim beside it). It replaced an
  "Arachne-lite" that filled any region narrower than 2w with one straight line along the bbox's x or y axis, so a
  thin wall turned on the bed printed as a stub: a 20mm x 0.8mm plate got 20mm of wall at 0deg and 1.6mm at 30deg
  (measured with the Bambu Lab A1 mini defaults, whose process preset sets `wall_generator: classic`; the schema
  default is arachne). `[thin wall orientation]` in `test.mjs` pins it. What comes from upstream as written: the
  Flow spacing offsets, BBS's narrow external loop, `detect_thin_wall` medial-axis thin walls, loop nesting and the
  `traverse_loops` order, `wall_sequence` / `wall_direction`, medial-axis gap fill with `filter_out_gap_fill`, and
  the infill area with `infill_wall_overlap` (25% `top_bottom_infill_wall_overlap` on the first and topmost layer).
  Left out, each for want of the subsystem it feeds (listed in the file header): overhang wall splitting and
  everything keyed on it, fuzzy skin, `only_one_wall_top`'s top-surface split (needs the upper layer inside the
  parallel PASS1), `counterbore_hole_bridging`, the first-layer outer-brim reverse (no `brim_type`). Two consequences
  that look like regressions and are not: golden moved (the inner wall now prints before the outer one, upstream's
  default order, and the infill reaches into the walls by the overlap: cube E +0.75%, table +1.4%, wall positions
  unchanged), and arachne mode is untouched, including its own fill and gap-fill approximation. The multi-material
  path (`slice_mm.cpp`) still offsets its walls by w itself.
- **A printer's custom G-code is expanded by upstream's PlaceholderParser, and only when the host sends the
  settings** (issue 63: vendor start G-code reached a Bambu Lab printer as `M140 S[bed_temperature_initial_layer_single]`).
  `deriveKernelParams` emits `placeholder_config` only when one of `CUSTOM_GCODE_KEYS` (`settings_core.js`) holds
  text, so every caller without a template stays on the raw path and golden is unchanged. It is the effective map in
  project_settings.config form (`serializeProjectSettings`) as a single escaped JSON string: the kernel's flat key search
  (`json_find_value`) never looks inside a string, so a key the map omits cannot be read out of it. The parser is
  upstream verbatim (`treesupport_port/libslic3r/PlaceholderParser.cpp`, in the tree-support group for the real `Flow`); the
  bridge (`custom_gcode_bridge_impl.cpp`) loads the settings with `load_string_map` (unknown keys skipped — the port's
  config is older than the profiles) and sets the variables in `GCode::_do_export`'s order from plain `Facts` the kernel
  computes: the first layer's outline (skirt, brim, raft), layer count, tools used, tool changes, the tower's extent.
  The multi-material path computes them after emission and splices the start block in (it is batch-only). Around the
  start block the kernel follows upstream's temperature rule (M190/M104 before it only when the template does not set
  them, none for Klipper, M109 after it for Bambu Lab — decided by `printer_model` starting with "Bambu Lab", which
  matches the BBL vendor exactly over the bundled profiles: 56 of 56, 0 of 873) and writes its own `G21/G90/M83` after
  it. `print_time_sec` / `used_filament_length` expand to upstream's reserved tags (`@PRINT_TIME_SEC@`, …) and the M73
  progress lines to `;_GP_…` placeholders, which the host fills from the estimate (`core/finalize_gcode.js`), as
  GCodeProcessor's post-process does upstream; the printer's thumbnails go where the kernel leaves
  `;_GP_THUMBNAILS_PLACEHOLDER` (`core/thumbnails.js`, PNG and QOI). The layer templates (`before_layer_change_gcode`,
  `layer_change_gcode`, `time_lapse_gcode`) and every tool change (`custom_gcode_toolchanges`: `filament_end_gcode`,
  `change_filament_gcode` with `GCode::set_extruder`'s variables, the T command the template does not write itself,
  `filament_start_gcode`) are left as slot lines by the parallel writers and expanded in print order, before upstream's
  ported cooling filter (`GCode/CoolingBuffer.cpp`) runs over each layer. A template variable this port does not set
  still fails typed instead of expanding to a guess. `random()` uses a fixed seed (upstream seeds from the clock), so the
  same input gives the same bytes. A template error is `CUSTOM_GCODE_ERROR: <key>: <parser message>`; reporting it at
  all needs the kernel's `-fwasm-exceptions` (`build.sh`: without it a throw aborted the module), and
  `core/slice_errors.js` keeps the slice ladder from retrying any typed refusal. The presets carry what the templates
  read (`web/extract_all.py _custom_gcode_keys`, derived from the templates themselves and the bridge's option names,
  multi-line values stored once in the artifact's `text` table), and the model's `default_bed_type` rides on the
  printer entry: the pick writes it to `curr_bed_type`, as upstream's Plater does, and the first-layer bed temperature
  follows it. `test_custom_gcode.mjs` (kernel, st == mt, streamed == batch) and `test_preset_file.mjs` pin it.
- **Extrusion follows upstream's multipliers and volumetric cap, and only for keys the host sends.** Upstream's E per
  mm is the section times `print_flow_ratio`, the filament's ratio and the path role's ratio (`GCode.cpp:7343-7390`),
  and its speed is capped at `filament_max_volumetric_speed / mm3_per_mm` (`:7492`). The kernel had the filament ratio
  only. Now `GcodeWriter` carries `print_flow` and `role_flow` into every `set_e_per_mm*` (a product with 1.0 is exact, so a
  map without the keys stays byte-identical — golden and the multi-material/arachne/raft/tree/ironing dumps were
  compared), `role_flow_ratio` (`emit.cpp`) is the one copy of upstream's role rules for the st, raft and
  multi-material paths, and `GcodeWriter::capped_feed` caps every extrusion entry point, the dry run included so the chained
  `current_feed` matches a real emit. A feature that keeps its width changes ratio through `GcodeWriter::set_role_flow`, which rescales
  the current flow: recomputing it from the float ribbon width moved E with every ratio at 1. Two shapes follow
  upstream rather than the kernel's surface model: the top and bottom ratios apply to the current layer's exposed top and
  bottom (`pass2.cpp` splits them out of the shell region only when the ratio is not 1), and a thick bridge is a round
  thread of nozzle * sqrt(`bridge_flow`) (`LayerRegion::bridging_flow`). Not read, for want of the feature they scale:
  `internal_bridge_flow`, `overhang_flow_ratio`, `bridge_line_width`; spiral mode keeps role ratio 1.
  `test_flow.mjs` pins each multiplier against the slice without it.
- **Arc fitting is upstream's `ArcFitter`** (`arcfit_bridge.cpp`, called from `GcodeWriter::extrude_run` at upstream's per-role
  tolerance: 0.04mm sparse infill, 0.0375mm support and raft, `resolution` otherwise). The kernel's own fitter accepted
  a run when its VERTICES lay on one circle, so a zigzag whose turning points sit on a round boundary became one arc:
  the preview (drawn from the stream) looked right while the exported G-code, and the print, did not (measured on a
  Benchy with the Bambu Lab A1 mini defaults, which turn arc fitting on: 19871 G-code segments off the real path by
  more than 0.05mm before, 30 after, worst 0.072mm). `[arc fidelity]` in `test.mjs` pins it. One difference is left:
  upstream simplifies slice contours by 0.0025mm (`PrintObjectSlice.cpp:172`, "has influence on arc fitting") and
  PASS1 by `resolution`, so a coarsely faceted round wall here can sit just past the arc tolerance and stay straight
  moves where upstream would fit it.
- **Tree support (slim, strong, hybrid) runs its loops threaded on mt, and each must give the serial result.**
  `tbb_stub::ParallelSection` (`treesupport_port/tbb/stub_parallel.h`) turns the tbb stub's threads on around one loop:
  `detect_overhangs`' per-layer loops, `draw_circles`, `generate_toolpaths`, the avoidance precompute, and the
  per-part spanning trees and the move pass of `drop_nodes` (upstream runs most of them in parallel); the preview
  cache (`TreeSupportData`, the layer outlines) is built on a thread taken from the stub's budget while
  `detect_overhangs` runs. The move pass creates its nodes with `link_to_parent` false and writes the child links in
  node order afterwards, which also keeps the node constructor out of the lock. The rest of the tree path stays serial because the `concurrent_*` stubs are std aliases. The move
  pass is not upstream's loop: a node's own exit is decided first, the moves read a neighbour's validity as the serial
  loop would at that node, and the results are applied in node order, including the `child` links the `SupportNode`
  constructor writes on every node merged into its parent (one node can be merged into several parents, so the last
  write followed the thread order). `MinimumSpanningTree::prim` scans its candidates in vertex order: upstream keys
  them by address and picks with `min_element`, so equal distances were broken by heap layout and the st kernel gave
  different G-code for one slim input from different script paths. Measured on a 1.13M-facet hybrid plate (mt):
  91.1 -> 20.7 s, G-code unchanged. `test_tree_support_mt.mjs` pins st == mt over three mt runs for all three styles.
  `draw_circles` unions a layer's node circles per cluster of overlapping bboxes (`union_ex_by_clusters`) before the
  roof diff; one union of all of them was 39 of its 47 s (st). Same region, other vertex order, so the support
  G-code bytes moved once (measured on the same plate: 21.2 -> 18.9 s mt, support extrusion +0.01 mm). Each cluster is
  then unioned as a tree split by position (`union_ex_by_halves`, 32 per leaf), which moved them again (draw_circles
  4.6 -> 2.3 s mt, support extrusion +0.06 mm, worst layer 0.27 %); Clipper2's union measured slower.
  `detect_overhangs` is two passes instead of upstream's one loop: upstream's loop stops sharp-tail detection at the
  first layer with more than 100 overhangs, which under threads depends on the order the layers are reached; the first
  pass finds that layer, the second checks the layers as the serial loop would (same plate: 18.6-18.9 -> 17.6-17.7 s
  mt, G-code unchanged).
- **Organic tree support runs threaded on mt too, from the main thread only.** A tree(auto) type left on the 'default'
  style is organic (`TreeSupport3D.cpp`), and it ran entirely serial: 73% of a 28-plate shield project's kernel time
  (Bambu Lab P1S), support 10.6 s st and 10.3 s mt on its longest plate. `generate_tree_support_3D` now opens one
  `ParallelSection` over the whole path, since upstream wrote its loops for real TBB (per-index writes, locked caches).
  Two things that made it neither faster nor safe until they were changed. **(1)** `organic_draw_branches` threads the
  trees, and that plate has one tree of 6987 branches: every branch of every tree is computed threaded (tube, slices,
  bottom contacts) and committed in tree and branch order, because the commit appends roofs to the interface layers
  under a lock, in thread order otherwise. A branch's `slice_mesh` runs under a per-thread `SerialSection`: its loops
  cost a thread each on a small tube, and `slice_make_lines` appends under a lock in thread order. **(2)**
  `threaded_here` starts threads from the runtime's main thread only. A nested start from a pthread goes through the
  main thread, and a pthread joined by a pthread returns to the pool by a message the main thread only reads after the
  slice: four kernels slicing at once in one browser tab hung or aborted one slice in two of three runs (baseline: none
  in three), node never did, and the main-thread rule ran 24 of 24. Measured (8 cores): that plate 11.2 -> 4.1 s,
  support 9.7 -> 2.6 s; slice-all of the project 32.4 -> 25.2 s (Auto, 4 workers), G-code byte-identical to st on
  three plates, slim and hybrid speed and bytes unchanged. Both worker counts then use about 190 core-seconds, so the
  machine is saturated and more workers do not help. `test_tree_support_mt.mjs` pins organic st == mt and the
  main-thread rule in the source. **(3)** `generate_initial_areas`' layer loop runs serial (`SerialSection`): a layer
  adds its tips and roofs to the layers below it under a lock, so threaded, a layer's vector came out in thread order
  and the tip de-duplication kept whichever of two near-equal tips arrived first. Measured on one plate of that
  project: 9 of 54 mt runs gave another support polygon on one layer than st, 0 of 40 serial (the loop is ~0.3 s of
  a 19 s support pass); all 28 plates then equalled st in four mt rounds. The test model does not reach it, so the
  test checks the source. **(4)** A branch slice inside a rectangular bed skips its intersection with the bed
  (`organic_draw_branches`): it comes out of the collision difference already as Clipper writes it (support
  -4% on a support-heavy plate, G-code byte-identical on all 28 plates). Skipping the second union of an already
  unioned layer, and unioning per bounding-box cluster, each moved support bytes for 1-3% and were not kept.
- **PASS1's contour union can run on the GPU, between two calls of `slice()`.** The kernel is synchronous and WebGPU
  is not, so `contour_phase.h` splits the slice: CAPTURE stops after chaining every layer's raw loops, the worker
  runs `engine/src/contour_gpu.js` on them, INJECT reads the contours back (`engine/src/contour_slice.js` drives the
  three). OFF is the kernel as it was and the golden output is unchanged. Four things it depends on. **(1)** Segments
  coinciding in opposite directions are cancelled on the CPU first (`cancel_coincident`): the pipeline cannot order
  the crossings of two segments on one line (measured on a 3M-facet scan: 164,337 such pairs; 0 layers fall back
  with the cancel, 5 to 100 without). **(2)** Two crossings at one place on a segment are ordered in the sort shader
  by the perturbation the crossing test uses; without it the loops do not close. **(3)** A layer whose loops stay
  open gets the kernel's own union (`assemble`), and a device that refuses the input leaves the kernel's own slice:
  the slice never depends on the GPU. **(4)** The GPU's contours have the CPU union's area and other vertices, so a
  GPU slice is not byte-identical to the CPU slice; `test_contour_gpu.mjs` compares by filament within a tolerance
  and pins that the same input gives the same G-code twice. `gpu_acceleration` is a worker option (`gpu: true`),
  never a kernel parameter, and `auto` asks for the GPU on the st kernel only: on mt the union is already spread
  over the threads and the measured difference is inside the run-to-run spread. The selector worker and every pool
  worker decide it by that one rule (`resolveGpuAcceleration`). A browser hands a page one adapter per
  `powerPreference`, never a list, so every worker of a tab shares one GPU and a second discrete GPU is out of
  reach; `acquireContourDevice` asks for `high-performance` and refuses a software adapter (measured, Chrome 157
  Linux: no adapter by default, SwiftShader with `#enable-unsafe-webgpu` alone, the RTX 3090 with `#enable-vulkan`
  too), naming each case in `contour_engine_reason`. The shader text
  (`contour_gpu_shaders.js`) is the measured experiment's and is edited only with a measurement beside it.
  **The mesh route moves the cut and chain onto the GPU too.** MESH stops pass1 before the segment sweep and keeps the
  seated triangles and the layer planes; `contour_front_gpu.js` (shaders `contour_front_shaders.js`, same editing
  rule) cuts in double-float, cancels coincident pairs, chains and lays the loops out as `chain_polygons` and
  `write_polygon` would, straight into the union's input buffers. Three things it depends on. **(a)** Metal compiles
  WGSL with fast math, which folds a two_sum's error term away; every intermediate the double-float depends on goes
  through `opaque()` (an XOR with a uniform zero), or the points are off by thousands of units. **(b)** A layer with a
  chain the GPU did not close is marked (`open_layers`) and `assemble` cuts, chains and unions that layer itself from
  the kept mesh, with pass1's own inclusion rule and triangle order, so it is the capture route's layer exactly
  (`[open layer]` pins a holed box to the CPU slice's G-code). **(c)** Only cycle members are laid out (the image of
  succ^(2^R)): a tail leading into a cycle once misplaced every slot after it. The worker takes this route on the st
  kernel only: st's own cut and chain measured 419-442 ms against 34-154 ms of mesh hand-over plus 64-153 ms on the
  GPU, while mt's threads do it in 64-77 ms and the mesh route was 20 ms slower there.
- **With the GPU on, an organic tree support's branches are made outside the kernel, and they are not upstream's.**
  `support_phase.h` splits the slice as the contour phase does: CAPTURE stops after upstream's own overhang detection
  and tip placement (`generate_initial_areas`) and keeps the layers, `engine/src/support_gpu.js` makes every layer's
  support body, INJECT takes the kept layers (no PASS1) and commits those polygons where upstream would propagate
  influence areas and draw branches (`organic_commit_layer`, the lines of `organic_draw_branches`' last loop moved
  into a function both call). Interfaces, toolpaths and G-code stay upstream's. What replaces the three stages
  (`TreeModelVolumes::precalculate`, `create_layer_pathing`, `organic_draw_branches`: 18 + 12 + 35 % of one 1173-layer
  plate's st slice): **(1)** one scalar field per layer, by jump flooding, holding the largest radius that clears the
  model by the xy distance and can still get down to the bed, in place of the collision and avoidance polygons of
  every radius; **(2)** `support_route.js` walks each tip down that field by lookups, heading for its nearest
  neighbour and merging on contact, between the field's own pixels (sampling a circle missed the neighbour pixel and
  25 branches ended in mid air); **(3)** the cross-sections drawn as ellipses and capsules over the layer's
  clearance, read back and traced into rings (`support_trace.js`). Five things it depends on. **(a)** OFF is the
  kernel as it was (golden unchanged), and RESUME finishes a captured slice with upstream's support byte for byte
  (`test_support_phase.mjs`), which is what a slice gets when the GPU fails after the capture. **(b)** CAPTURE
  precalculates only the volumes placing the tips reads (`precalculate(..., tips_only)`): left to be computed on demand
  they took 22 s on that plate. Nothing reads a captured tip's `LineStatus`, which says which avoidance a point lies
  outside of, so a capture gives each point the weakest status that still places it from one volume
  (`s_tips_unlabelled` in `TreeSupport3D.cpp`): the collision at the tip radius when the support may rest on the
  model, the Fast avoidance to the bed when it may not. That leaves out every avoidance chain (a serial pass over all
  layers per type), the hole-free collision, the placeable areas and the extra radii: the captures of the 28-plate
  project 34.3 -> 10.9 s (st, classic walls), every one of its 19796 tips the same. The test compares the tips with a
  capture that precalculates everything. INJECT finishes the tree support the capture kept (the facade
  print in `treesupport_bridge_impl.cpp`, `SupportGroupLayers` in `TreeSupport3D.cpp`); run from the start again it
  detected the overhangs and placed the tips twice (1130 of INJECT's 1600 ms of support on that plate, st). An INJECT
  that does not follow its own capture drops what was kept and is the plain slice. **(c)** Layers are worked in batches as tiles of one atlas, nothing is
  cleared but the stencil, each layer's draw is packed by its own rectangle, and several batches are in flight
  before a readback is awaited: one pass per layer and step was 25,000 passes and 130 round trips for that plate, and
  whole-target clears were 60 GB. A batch's drawn masks are packed to one bit per pixel on the GPU and read back in
  one copy (`PACK_SHADER`, `tracePackedRings`), and a field page is its buffer's mapped range rather than a copy of
  it: as a byte per pixel the masks were 2.45 GB over the 28-plate project (one plate 411 -> 62 MB), the G-code is
  unchanged, and Chrome's thread pool went from 5.7 to 3.8-4.0 core-seconds in a slice-all, where it is without the
  GPU; the run's time did not move. The field then comes back as 8x8 blocks (`makeFieldBlocks`, `fieldBlockCode`):
  a block of one value is its value in a table, any other block a slot of a compacted list the GPU appends to, so the
  slot order varies and the decoded field does not (445 -> 110 MB on the largest plate, 3.3 GB over the project
  before). Read back twice, the field of a large plate was 0.7 s slower beside seven workers, so the readback was what
  they queued for. The tracer works on the packed bits and visits boundary pixels only (`tracePackedRings`; it unpacked
  every rectangle to a byte per pixel first). Measured in Chrome (8 workers, GPU on, classic walls), three runs each:
  slice-all 7.8-8.3 -> 7.1-7.5 s, Chrome memory peak 9.3-9.6 -> 7.1-7.7 GB, a large plate's field 1.1-1.45 -> 0.5-0.9 s
  and its draw 0.9-1.1 -> 0.3-0.6 s. G-code byte-identical on all 28 plates (node, Dawn). `[field]` in
  `test_support_gpu.mjs` packs a code texture and reads every pixel back.
  **(d)** One field layer stands for two object layers
  (`FIELD_LAYERS_PER_STEP`); at 0.4 mm pixels 1574 of 3542 branches were routed onto the model, at three layers 27.
  **(e)** A plate whose field passes `FIELD_BYTE_BUDGET`, a raft, any other style and multi-material keep upstream's
  support. **(f)** The worker starts the device and the pipelines and awaits them after the capture
  (`supportGpuOf()` in `slicer.worker.js`): awaited first, eight workers asking at once each waited ~1.2 s before
  their kernel started. It is taken only when the mode asks for the GPU (`gpu: true`; Auto does on the st kernel
  only), and the stats card names it. Measured (8 cores, RTX 3090): that plate st 12.3 -> 4.9 s, mt 2.75 -> 1.86 s,
  support extrusion 0.92 of upstream's; slice-all of the 28-plate project in Chrome 19.3-19.9 -> 12.5-13.0 s with 23
  plates on the GPU, GPU memory +5 GB, Chrome memory 8.4 -> 9.3 GB. That run is bound by the CPU (workers 75.7
  core-seconds of the 101.6 the 8 cores have in it, the rest of Chrome 13): Arachne's walls are 30 % of two heavy
  plates' kernel time, and the read-back of the G-code is 0.7 s of the run. Not done: bottom contacts for a branch that ends on the
  model, the roofs upstream draws from a branch (`recover_pending_branch_roofs`), the flat foot; and no print has
  been made from it.
- **A finished slice is shown as the G-code it exports.** `asExported` (`core/exported_preview.js`) finalizes the
  G-code and parses it back (`previewFromGcode`, `core/gcode_parse.js`) into the plate's layers, taking the slice's bed centre off
  so they stay plate-local, and takes the layer, segment and filament figures from the same text; the time estimate
  and the bed verdicts stay the kernel's. The slicer worker runs it beside the kernel when the slice message carries
  `exportedPreview` (the viewer's hook always sends it) and marks its result so; its layers then post only their
  index. The hook still runs it for a worker that did not. On the main thread it was the largest part of a slice-all
  (28 plates: busy 33 s of a 25 s run, dev build), and every streamed layer's toolpath crossed to the page only to
  be replaced. `test_worker_replies.mjs` pins the worker's result to the hook's. A slice-all puts the read-back off
  until its last plate is cut (`deferPreview` on the slice message, `finalizedExport` / `readBack` in
  `core/exported_preview.js`): the pool keeps every core busy, so each plate's read-back delayed the plates behind it.
  The result comes back with the finalized G-code and the kernel's own layers, marked `previewPending`; the run then
  sends each plate's G-code to a worker that is still alive (`readback` command, the focused plate first) and
  announces the plate to the host after it, so `onSliced` still carries the read-back figures. The notice's time is
  the time to the last plate's G-code. Measured on the 28-plate project in Chrome (8 workers, GPU on): classic walls
  10.5 -> 9.1-9.4 s, Arachne 12.9 -> 12.0 s, the previews ready at 10.3-10.6 and 13.1 s as before. The same test
  pins a deferred slice plus its `readback` to the inline result. The kernel's toolpath stream left the printer's start and end G-code out,
  so a sliced plate and the same file opened again differed (benchy on an A1 mini: 240 vs 241 layers, 5255.5 vs
  5279.3 mm). Economy mode (no toolpath kept) and resin results stay on the stream. Measured on the benchmark model
  (3M facets, tree slim, A1 mini): 13 MB of G-code read back in 192 ms on the main thread, 0.57x the stream's
  segments; a multi-hundred-MB G-code has not been measured. `test_gcode_parse.mjs` pins the frame and the start
  line. The toolpath handle carries `data` and `setMoveRange` for the move scrub (`TOOLPATH_SPEC.md`): the renderer
  that replaced the ported one had left both out and the bar read 0 / 0.
  The parser writes a layer's segments into typed arrays that double and walks the text line by line
  (`parseGcode`): plain arrays and one array of every line put a 21.5 MB plate's read-back on the JS heap (265 MB),
  and every JS heap of a tab shares one 4 GB region (see the threaded-wasm rule). With the read-back in the workers,
  several large plates parsed at once and slice-all of a 28-plate project (224 MB of G-code) crashed the tab with
  `V8 javascript OOM` in 4 of 23 runs; 0 of 20 after, the layers byte-identical and the parse 30% faster.
  A plain motion line ("G1 " and words of one letter and a decimal) is read in place (`fastMove`): its digits as an
  exact integer over an exact power of ten round as `parseFloat` does, and any other line goes the general way
  (the 21.5 MB plate 410 -> 280 ms, 585 ms before either change). `test_gcode_open.mjs` fails on either array
  coming back and compares 3000 decimals with `parseFloat`.
- **The kernel reads its own G-code back per layer, and that read is kept cheap** (cooling filter, time estimate).
  Measured on a 28-plate project (st, all plates): emit 52.0 -> 28.4 core-seconds of 166, every G-code byte-identical.
  Two things hold it. **(1)** `fast_atof` (`fast_atof.h`) replaces `atof` in `CoolingBuffer::parse_layer_gcode` and
  `parse_filament_chunk`: musl's `strtod` works in long double, which wasm has only as soft-float calls (7% of an st
  slice). fast_float is correctly rounded as `strtod` is, and what it does not read (a leading blank or `+`, hex)
  goes to `atof`. **(2)** The estimator makes no "actual speed" moves (`PORT_ACTUAL_SPEED_MOVES`,
  `GCodeProcessor.cpp`): they carry no time, each was inserted into the middle of the move list, and they counted
  toward the bridge's resident move cap, so the five largest plates of that project hit it and came back without a
  time estimate (`stream-notime`); they are `full-stream` now, and the other 23 kept their estimate and layer times
  to the bit. `[stage10]` in `test.mjs` pins one move per motion line.
- **Arachne's Voronoi diagram is built with `FastInt` as the big integer of boost's exact predicates**
  (`voronoi_fast_int.h`; `construct_segment_voronoi` in both `Geometry/Voronoi.cpp` copies, a `[PORT]` edit). boost
  computes each circle event in double and recomputes it in big integers when its error bound is too wide, and on a
  finely tessellated outline that is almost every event, since three neighbouring segments of a smooth curve are close
  to collinear (measured natively on a 1469-segment outline: 7214 of 7214 point-segment-segment and 1827 of 1827
  segment-segment-segment events, 15.3 of the build's 18.6 ms). `FastInt` keeps `extended_int<64>`'s limbs, count and
  truncation and multiplies row by row, so the predicates return the same doubles: golden and all 28 plates of the
  shield project byte-identical, pass1 -4.5 % on four heavy plates (st). `test_voronoi_fast_int.mjs` holds the hash of
  twelve outlines' diagrams against the one boost's own builder gives (`voronoi_fast_int_hash.cpp`, compiled natively
  with `-DVORONOI_REFERENCE_BUILDER`). That recomputation is why Arachne is not a GPU candidate: it is exact integer
  arithmetic inside one sequential sweep per island, 82 % of the diagram's time, and the topology it decides is what
  the wall graph is built from. What does lower the cost is the generator itself: on the same project `wall_generator:
  classic` (upstream's `process_classic`) took pass1 from 7.6 to 1.55 s on four plates and slice-all in Chrome with the
  GPU on from 12.6-12.8 to 10.0-10.1 s, with other walls (filament +2.9 % on those four plates).
- **`Polygon` and `Polyline` move, in both port copies** (`MultiPoint.hpp`, a `[PORT]` edit). Upstream's move
  constructors are written `MultiPoint(std::move(other.points))` with no `MultiPoint(Points&&)` to take it, so they
  copied the points, and without `noexcept` a growing `Polygons` copied every polygon again. Measured on a
  support-heavy plate (st): support 10.03 -> 9.48 s, G-code byte-identical on all 28 plates. A `static_assert` in
  `Polygon.hpp` and `Polyline.hpp` fails the build if they stop being nothrow-movable. Code that read a polygon after
  moving it would now see it empty; none was found by the golden dump, `test.mjs` or the 28 plates.
- **A layer is cut at its middle** (`slice_planes.h plan_layers`, upstream's `generate_object_layers` for a fixed
  layer height): a layer exists while its middle is below the object's top, on every path (st, mt, multi-material,
  the GPU contour route). The kernel cut each layer at its top and kept only tops below the object height, so the
  top face's plane cut nothing and a 20 mm cube printed 19.8 mm. Golden moved with it (cube 99 -> 100 layers, both
  table fixtures 69 -> 70; every layer below the top shells byte-identical). `[layer count]` in `test.mjs` pins it.
- **Layer loops are oriented and filled NonZero, not even-odd.** The kernel slices the merge of every object as ONE
  mesh, so even-odd counted two coincident shells as outside and two objects on the same spot sliced to nothing.
  `intersect_triangle_with_plane` orients each segment by its facet normal (solid on the left, upstream's
  `IntersectionLine`), and `chain_polygons` keeps a loop in its first segment's direction, prefers a continuation
  that STARTS at the current point (four segments meet where shells coincide) and reverses a loop assembled mostly
  backwards (flipped facets).
  That is upstream's Regular mode; a fully inverted shell still prints, an inward-facing inner shell is still a void
  (`[overlapping shells]` in `test.mjs`). The golden fixtures stayed byte-identical; a clean mesh can still move
  by Clipper rounding (measured on the Benchy: under 0.0003 mm² per layer), which shifts point order in its G-code.
- **The prime tower is per plate, from two stores.** The position is `wipe_tower_x/y[plate]` in the GLOBAL map
  (upstream's coFloats layout, written by both the card and the scene drag); everything else about the tower —
  `enable_prime_tower`, `prime_tower_width`, `flush_into_infill`, `flush_volumes_matrix` and the viewer knob
  `wipe_tower_real` — follows the plate override through the card's Global | Plate switch. The stand-ins are decided
  per plate from `plateContext` (`towerOf` in `core/tower_layout.js`): the plate's own tool changes, on/off and
  footprint. The footprint comes from the DERIVED params, not the map — an unset `prime_tower_width` reaches the
  kernel as the schema's 60, which a raw read took as 30. In plate scope the card writes defaults explicitly instead
  of deleting the key, because an override cannot express absence (it merges over the global map).
- **A `.3mf` save carries what upstream has no place for in `Metadata/three_slicer_settings.json`**: the per-plate
  overrides and the global map's non-schema keys (`serializeProjectSettings` drops those). Upstream's `<plate>`
  metadata is a fixed key set (`bbs_3mf.cpp`) and it ignores unknown members, so an OrcaSlicer open sees the global
  preset on every plate. Only existing plates are written; the reader keeps only plain maps under integer plate keys.
  An array with a HOLE (`wipe_tower_x/y` of a plate on automatic placement) is never written as `null`: upstream's
  loader breaks out of its whole key loop on a non-string entry (`Config.cpp` `parse_str_arr` -> `break;`), which
  dropped every key sorting after it. The hole is written as the schema default and the original goes to the member.
  The member also records the plate count (`<plate>` records name only plates holding objects, so an empty plate
  with an override would not come back), is read even when no `project_settings.config` was written, and the
  import keeps only overrides for plates that exist once placement is done.
- **A `.gcode.3mf` is a print job, not a project** — upstream's "Export all plate sliced file" (`SaveStrategy
  SkipModel | WithGcode`): no meshes, each sliced plate's G-code as `Metadata/plate_N.gcode` named by a `gcode_file`
  entry on its `<plate>` record, an uppercase-hex MD5 beside it (a Bambu printer checks it; `core/md5.js`, because
  `crypto.subtle` has no MD5), and the estimate in `slice_info.config`. `writeGcode3MF` writes it; the reader tells
  it apart by CONTENT (a `gcode_file` whose member exists), never by the file name. Opening one does not create a
  second path: the plates become `useImportedGcode`'s `{plate: text}` map, and Viewport hands `gcode ?? that map`
  to `useInjection` and to every slice guard as their `gcode`, so nothing re-slices over it or invalidates it —
  the same rule as the host's `gcode` prop, which wins while set. While one is open the viewer is preview-only
  (Prepare and Slice refused), as upstream is; a model load or the top bar's close ends it and takes its plates'
  results with it. Injected G-code is placed by the bed CORNER (`origin - bed/2`), not the plate origin a kernel
  slice uses, which is why `followPlateLayout` moves display offsets by the origin DELTA — setting them to the new
  origin put every injected plate half a bed off (measured the first time a `.gcode.3mf` grew the grid).
- **An all-plates run is a queue drained by K workers, and the selector worker is one of them.** `slice_pool.js`
  sizes K (Auto: the cores on mt, each worker with a share of the threads, cores-1 on st, never more than plates); `use_slicer.js`'s
  `createPoolContext` is a worker whose whole state — pending slice, stream accumulator, SAB view, poll, watchdog,
  the classic/economy ladder — lives in one closure, because it exists for one run and paints nothing. The
  selected plate goes FIRST and to the selector worker: it is the mesh the brush painted. A pool worker starts with
  an empty selector, so a pool plate with stored paint loads it first (`ctx.loadPaint`) and `buildParams` takes that
  reply's counts; the selector worker's live counts (`painted`) belong to its own plate only. The selector worker's progress is re-routed through `progressSinkRef` for the
  run's duration so it reports per plate like the others; `reuse_stages` stays the selector worker's alone (a pool
  worker is terminated after the run — wasm heaps do not shrink, measured 8.8GB for five on a 3M-facet model).
  The STL is COPIED to a pool worker, not transferred, because the ladder re-sends it on a retry and a transferred
  buffer is detached. Policy is measured, not designed (see the README tables): in a node harness worker count
  never made a run slower up to the core count and memory was the only ceiling; divisor counts were measured to
  change nothing — do not add them. A per-worker thread budget changed nothing there either, when tree support ran on
  one thread; with it threaded it does, so every pool slice carries `threads` (`threadsPerWorker`: twice the cores
  over the workers, at least two) and the worker hands it to the kernel (`set_thread_limit`, `thread_limit.h`: every
  core-count read and the tbb stub's `take()` stay under it; 0 takes it off, and each slice sets it, so a single
  slice after the run has every core again). Measured in Chrome on 8 cores, the 28-plate project: 4 workers without
  a limit 20.2-20.8 s, 8 workers at 2 threads 19.4-19.5 s. The G-code is the st G-code at every limit
  (`test_tree_support_mt.mjs`). Longest-plate-first changed nothing there
  but does in the browser (8 cores, a 28-plate project whose largest plates come last by index: 26.2 -> 25.3-25.7 s
  at 4 workers), so the queue is `sliceOrder` (`core/slice_pool.js`): the selected plate, then the largest merged
  STL first, with every worker but the selector's opening on one of the smallest plates. Started together, the largest plates
  reach the GPU support pipeline together and wait for one another on the tab's one GPU with their threads idle
  (measured on that project, 8 workers, GPU on, classic walls: 9.1-9.2 s all largest first, 8.7-9.0 s with half the
  workers opening small; with the cheaper capture above, 8.0-8.4 s half and 7.7-7.9 s with seven of eight). More workers than cores did not fill that wait (10 and 12 workers: 8.9-9.1 s, the largest plates
  9.5 s each instead of 7.3), and neither did more threads per worker (3 and 4: 8.8-8.9 s, 8: 9.3 s, against 9.0 s
  at 2). The wait is the GPU's own work: one large plate's field is ~0.25 s of jump flooding with or without its
  read-back (node, Dawn), six of them arrive within a second, and a worker cannot start its next plate while its
  kernel holds a captured one. No preview is built while the pool drains: the run's end shows the focused plate and
  `ensurePlateToolpaths` builds the others one plate per task. Built as each result landed they were ~9.5 s of
  main-thread work in a run that keeps every core busy (slice-all 21.4 -> 20.4 s), and built in one go at the end
  they held the main thread ~7 s; now the run reports at 19.4-19.8 s and the last toolpath is in the scene ~6 s
  later, the page responsive between plates. The run's progress reaches React every `RUN_PROGRESS_INTERVAL_MS`
  rather than every frame (19.9-20.1 -> 19.4-19.5 s). In the
  BROWSER, on a 143MB-STL model over nine plates, 2 workers gained 13%, 3 crashed the tab once, and Auto-by-cores (8)
  crashed it every time. That was the shared V8 heap region described in the next rule, not the STL buffers the
  renderer holds: with the threaded wasm moved out of its glue, 5 and 8 workers ran that model without a crash
  (Chrome RSS peak 11.4GB on a 24GB machine). `resolveWorkerCount` still caps Auto and the select by the largest
  plate's STL size (`HEAP_PER_STL_BYTE` x bytes against `POOL_HEAP_BUDGET`); its constants were set from those
  crashes and have not been re-derived for physical memory. A pool worker that dies (memory, a script that failed to load, the watchdog)
  is the POOL's failure, not the plate's: the ladder does not retry it under the same pressure, the worker is
  dropped, and the plate is re-queued to run alone on the selector worker after the pool drains — so a too-high
  count degrades to serial instead of to a row of failed plates. Selection no longer follows the run; the tabs
  carry each plate's state (`plateRun`), with the failure reason in the tooltip.
- **The threaded kernel's wasm is a file, never inlined in its glue** (`build.sh`: no `SINGLE_FILE` on the mt link).
  Every pthread worker is started from the glue file itself and parses all of it, while it takes the compiled
  module from the main thread. Inlined, the wasm was a 6.3MB string literal in each of ~16 isolates per kernel,
  ~60MB of V8 heap each, and Chrome keeps every isolate of a renderer in one 4GB pointer-compression cage: three
  slicing workers filled it and the tab died with `V8 javascript OOM (CALL_AND_RETRY_LAST)` (haaland.3mf, 6 plates,
  4 of 6 runs) while the renderer's RSS read 4.5-5.2GB and the isolate that failed held 598MB. RSS does not show
  this; the sum of `--js-flags=--trace-gc` heap sizes over all isolates does. Split, the glue is 107KB, a pthread
  isolate ~1MB, and 3-8 workers peaked at 1.2-1.9GB. The glue reaches the file through the literal
  `new URL("slicer_core.mt.wasm", import.meta.url)`, the shape Vite and webpack emit as an asset; the bare name
  beside it is the `locateFile()` branch. `test_mt_glue.mjs` fails on an inlined wasm and `pack_check.sh` on a
  tarball, Vite dist or Next build without the file. The st kernel's wasm is a file too (`slicer_core.wasm`): inlined,
  its glue was a 7.2MB script, and Firefox's add-on validator refuses any JS file over 5MB (`FILE_TOO_LARGE`), so the
  extension could not be listed on AMO. `test_mt_glue.mjs` checks both glues.
- **The kernel is sized by measurement, and three build choices hold it** (`build.sh` "Size"). A link with
  `--profiling-funcs` gives every function its name, and summing the code section per namespace is how the big
  contributors were found (st, 6.0 MB of code: the config subsystem 925 KB, CGAL corefinement 668 KB, libc++ 518 KB,
  nlopt 443 KB, tree support 427 KB, SLA 392 KB, boost rtree 387 KB, three Clipper copies 355 KB). What that bought,
  each G-code byte-identical: **(1)** nlopt links only the algorithms the SLA port selects (ESCH, SBPLX, NELDERMEAD,
  COBYLA, MLSL); `nlopt_unused_algorithms.c` answers `NLOPT_INVALID_ARGS` for the rest, because `nlopt_optimize`'s
  switch names them all and wasm-ld could not drop them (-187 KB). **(2)** `PrintConfig.cpp` is compiled from a copy
  that `arachne_port/config/strip_ui_strings.pl` writes to `/tmp/ws_obj/gen/` without tooltip, label, sidetext,
  category and enum-label strings — the kernel reads names, types, defaults and enum values, and the labels reached
  only Config.cpp's error text (-236 KB; the upstream file stays verbatim). **(3)** The TUs that run once per slice
  (config, GCodeProcessor, WipeTower, PressureEqualizer, the PlaceholderParser group) are compiled at -Os through
  `compile_main` / `compile_ts`, the per-layer geometry at -O2 (-355 KB); no floating-point flag differs between the
  two. Together st went 6,506,892 -> 5,741,239 bytes (brotli q11 1,457,481 -> 1,305,653). Measured and rejected:
  `wasm-opt -Oz` over the -O2 binary (-1.5% raw, -0.1% brotli). Still open, each a separately loaded module rather
  than a build flag: `mesh_boolean.cpp` (CGAL corefinement, -707 KB raw / -140 KB brotli, self-contained behind the
  worker's `meshBoolean` command) and the SLA group (-1.1 MB raw with `slice_sla.cpp`). Shipping a q11-precompressed
  `.wasm.br` instead of the CDN's on-the-fly brotli is worth 23% of the wire size on its own. `test_kernel_size.mjs`
  holds each wasm under a byte budget and fails when a stripped string is back in the bytes.
- **Every resin plate keeps a preview in the scene, not just the focused one.** The focused resin plate is the
  clipped `setSlaPreview` slot the layer slider cuts; every other resin plate with a result gets a static,
  unclipped group through `setSlaStatic` (`scene/sla_preview_mesh.js` builds both), the resin counterpart of the
  toolpaths every FFF plate keeps after slice-all. Before this, two resin plates showed only the focused one and
  the other read as a missing result. `core/sla_preview.js` is the one place the payload (lift, offsets, meshes)
  is derived, so the two previews cannot disagree on where a support tree stands.
- **Shipped code never evaluates a string.** The browser extension's pages run under `script-src 'self'
  'wasm-unsafe-eval'`, and anything that builds code from text fails there, silently, and nowhere else: embind's
  invokers (`new Function`) kept either kernel from loading until both links got `-s DYNAMIC_EXECUTION=0`
  (`build.sh`; mt wasm and golden byte-identical), and the settings toggle evaluator's `Function` call left every option
  enabled (3 fields disabled on the site, 0 in the extension, 564 CSP violations) until `evaluateBooleanExpression`
  (`toggle_eval.js`) parsed the restricted grammar itself — `test_toggle_parity.mjs` pins it to what `Function` gave
  over every upstream rule. The extension e2e test records CSP violations on the viewer tab and fails on any.
- UI components (viewer, components) are Shadow DOM isolated — each package's `styles.css` is inlined into the bundle via `?inline` and injected into the shadow root, so class names cannot collide with the host app's CSS. Their colours are `var(--_…)` references to `UI_TOKENS` (`viewer-package/src/core/theme.js`), prepended to each root as `THEME_CSS`; each also reads a public `--vp-…` override, the one styling hook that crosses the boundary. `test_viewer_docs.mjs` fails on a literal colour in either stylesheet.
- **SLA is a second technology, not an FFF variant.** `printer_technology` routes it: `deriveSlaParams` ->
  `slice_sla`, with a JS contour fallback when the wasm is absent. The support chain under
  `packages/wasm-core/slasupport_port/` is PrusaSlicer 2.9.6 verbatim — its own guide is
  `slasupport_port/PORT_NOTES.md`, and `test_sla_source_manifest.mjs` fails the build when a ported file
  drifts from its recorded upstream hash. It builds against real vendored deps, not shims: NLopt 2.5.0
  (Prusa's exact pin) and SGI glu-libtess in `third_party/deps_src/`, plus brew CGAL headers with
  `-DCGAL_DISABLE_GMP=1` on every CGAL-compiling group (the GMP auto-detect otherwise links `__gmpn_*`
  symbols no wasm provides).
- **What the SLA kernel cannot do it refuses with a typed code — it never approximates.** Hollowing/drain
  holes are `SLA_UNSUPPORTED_HOLLOWING` (an entry gate in `slice_sla.cpp` AND the request layer, because a
  solid slice answered to a hollow request would be a mislabeled print); organic trees are typed too; and a
  pad that fails to GENERATE fails the slice (upstream SlicingError semantics) rather than emitting a scene
  lifted onto a pad that is not there. `pad_around_object` (embed) is SUPPORTED: it forces zero elevation
  (upstream `is_zero_elevation`), and an EMPTY embed pad is legal (the ring survives only where supports
  stand) — the layer frame is fixed only after pad generation so an empty pad lifts nothing.
- **`slice_sla` reports progress from inside its contour phase, and only the calling thread may do it.** The
  phase used to be silent until it finished: on a 3M-facet model that is 6.4s of a 14s slice (mt, node), and
  beside two FFF workers it stretched to 16.9s of contention — which read as "the SLA plate does not slice until
  the FFF plates finish". Two things now carry it. The facet -> segment sweep is parallel in mt the way PASS1 is
  (contiguous facet ranges, per-range buckets, concatenated in range order, so segment order is the serial
  loop's and `test_sla_mt.mjs` keeps st and mt byte-identical) and reports 0 -> 3% as it goes; it measured
  ~30ms of the phase. The per-layer chain/simplify (`sla_for_each_layer`) is where the time is, and its `tick`
  argument is called on the caller's thread with the shared finished-layer count, 3 -> 18%. Parity for the
  parallel sweep is only exercised above 65536 facets — the box in `test_sla_mt.mjs` does not reach it — so a
  change there needs a large-model st/mt byte comparison (scratch `sla_parity.mjs` did 1816 layers).
- **The SLA layer frame lifts by `stats.lift_layers`, not elevation.** A pad occupies `[0, pad]` and the
  scene above rises by pad + elevation; the viewer overlay must use `lift_layers` — lifting by elevation
  alone is exactly the bug that floated supports in mid-air on pad-enabled previews.
- **SL1 masks are gray8, rasterized in-house, and NOT golden.** The mask encoder is `png_gray.js`
  (color type 0, bit depth 8 — the one layout upstream's SL1 reader accepts; the old canvas
  `convertToBlob` emitted RGBA, which `PNGReadWrite.cpp` rejects). The fill is `raster_mask.js`
  (CPU AET even-odd, the REFERENCE implementation and the always-available fallback — it is what
  finally lets an SL1 export run under plain node), with `sl1_raster_gpu.js` as the MSAA path for
  anti-aliasing: opt-in via the host settings key `sla_antialias` (1|2|4, a viewer knob, not a
  schema key), measured 11.8x at 1440x2560 aa=4 and 13.8x on a 12K display vs CPU supersampling.
  The GPU module takes an injected GPUDevice and never touches `navigator` (layer guard); only
  `scene/gpu_device.js` does. When the SLA result still holds its merged STL (`modelSTL`), the GPU
  path upgrades to `sl1_parity_gpu.js` — slice-by-rendering: the MESH itself is drawn per layer
  plane with a stencil count signed by facing (NonZero, the kernel's own fill rule — it was an invert parity,
  which left coincident objects empty in the mask), so the mask never depends on contour stitching (measured
  0.007% avg / 0.047% worst pixel diff vs the contour reference over a 775k-facet scan model, all
  658 layers rendered in 0.6s). Its `prepare()` reproduces the kernel's frame exactly: XY kept as
  the mesh's own, z seated to 0 — both measured, and the wrong half of that guess read as a 41%
  mask diff before it was pinned. Masks are outside the golden discipline on purpose: same device +
  same input -> same bytes (pinned in `test_sl1_gpu.mjs`), but cross-vendor f32 rasterization may
  move boundary pixels within the tolerance that test asserts — a byte-diff between two machines'
  archives is expected, not a bug. GPU checks skip (not fail) without a device; run them under
  node via `SL1_GPU_WEBGPU_PATH=<dawn index.js> node viewer-package/tests/test_sl1_gpu.mjs`.
- **The SL1 export is PORTRAIT by default**, like every Prusa SL1-family profile: the mask canvas is
  `pixels_y` wide by `pixels_x` tall, columns run along the display's y axis and rows along the X-mirrored
  x axis (`slaRasterTransform`, validated against masks a real 2.9.6 archive holds). `config.ini` is
  upstream `fill_iniconf`'s field set in `std::map` (alphabetical) order with 6-decimal floats.
  `test_sla_mt.mjs` pins the mt (pthread) kernel byte-identical to the st one over the same SLA slice.
- Licensed AGPL-3.0-or-later (`LICENSE.txt`) — except `viewer-package/`, which is MIT and must never import the
  AGPL package (`packages/engine/tests/test_license_boundary.mjs` enforces it). Which code may carry which licence, and
  why, is `packages/PROVENANCE.md`.

## Code review checklist

What a review of a diff in this repo checks, in order. Each item points at the rule it enforces; the rule itself
lives in Core rules above and is not restated here.

### Scope and process

- Review the diff, not the neighbourhood. A finding outside the changed lines is reported separately, never fixed
  as a side effect.
- Reproduce before judging a bug: run the case, read the output. Hold at least three competing explanations for a
  defect, trace the causal chain past the first plausible cause, and report the explanations that were rejected and
  why.
- A completion or "fixed" claim cites a command and its output from this session. For UI, SVG or chart changes,
  the evidence is the rendered result, not a static check.
- Narrowing the requested scope is reported as a choice with the cost of doing it fully, never done silently or
  filed as a "known limitation".

### Repo rules (Core rules above)

- No ternary operator anywhere, JSX and tests included. Suggest an early `return`, `if`/`else`, a lookup table with
  `??`, or `cond && <Element/>`. Ternaries in touched code are converted.
- One owner per fact. A second place that computes the same conversion, merge order, plate context or colour list,
  or that types out a list, label or limit a constant already holds, is a defect even if it agrees today (`paint_clip.js`, `buildMergedSTL`, `plateContext`, `filament_colors.js`, `paint_tools.js`). Tests included.
- Omission, not defaults: a param is emitted only when the settings map holds its key.
- Generated files (`PARAMS.md`, `settings-keys.d.ts`, `kernel_setting_keys.js`) change only through their generator.
- Layer boundary: nothing under `core/` imports React, the DOM or a renderer; `ui/` does not reach into the scene or
  the kernel. Arithmetic found in `scene/` is a candidate to move into `core/` where it can be tested.
- Undo `record()` is called at the action layer, before the mutation, not in a button handler.
- Unsupported input is refused with a typed code, never approximated.
- `viewer-package/` never imports the AGPL package.
- Kernel changes come with a golden `cmp` against a baseline regenerated from the pre-change source, plus `test.mjs`.
- A new rule or invariant lands with the test that fails when it is broken.

### Clean code

- Does the change need to exist? Code for a speculative future need is removed.
- Reuse before writing: a helper that already exists a few files away is imported, not copied.
- Dependency ladder: standard library, then platform feature, then an installed dependency, then hand-written code.
  A new dependency for a few lines is rejected.
- No speculative abstraction: an interface with one implementation, a factory with one product, a config value that
  never changes.
- Boring over clever. Code that has to be decoded is rewritten, not commented.
- Fix the shared root cause, not each symptom at its call site.
- A deliberate simplification carries a comment naming its ceiling and what would justify replacing it.
- Names are written out (`visibleCount`, not `vis`), scratch scripts included.
- Comments and docs state facts and measurements ("measured: 208 -> 0"), without emphasis or dramatic wording.
  Technical terms stay in their original language.

### Never minimized away

Validation at a trust boundary, error handling that prevents data loss, security controls, accessibility basics,
and anything the request explicitly asked for.

### Tools

`/code-review` for correctness, `/ponytail-review` for over-engineering, `/simplify` to apply cleanups.

## Commands

**Running the project goes through `web/Makefile`, not through raw npm/vite/docker invocations.** It exists
because the two things that make a run correct are not in any `package.json`: the demos under `examples/` are
standalone projects that install `three-slicer` from npm, so the repo's `npm ci`/workspaces never reach them
(`demos-install` does the explicit install, `demos` builds them into `viewer/public/demos`), and the dev and
compose targets free the port first (`kill PORT=n`) instead of failing on a stale process. `dev` depends on
`pkg demos`, so a viewer source change is rebuilt into the dist the app actually loads — running `vite`
directly is what silently serves the previous build. The port comes from `web/.env` (copy `.env.example`),
defaulting to 5173 / 8080.

A release goes through the ROOT `Makefile`, for the same reason: `three-slicer` pins `three-slicer-viewer`
exactly, so the viewer must be published first or `three-slicer@x.y.z` cannot be installed, and the MIT mirror
repo (`github.com/kimgh06/three-slicer-viewer`, a `git subtree split` of `viewer-package/`) must be pushed after
so it shows what was published. `make bump V=x.y.z` sets both versions and the pin; `make publish` gates on a
clean, pushed `main`, a `## x.y.z` entry in `packages/CHANGELOG.md`, `npm test`, the build and `pack_check.sh`,
then publishes in order, syncs the mirror and tags. `DRY=1` rehearses it with `npm publish --dry-run`.

```bash
cd web
make dev            # pkg + demos, then vite on DEV_PORT with /demos ready
make up / down      # docker compose on UP_PORT (demos built first, then copied by the image)
make logs
make pkg            # rebuild the three-slicer dist alone
make demos          # rebuild examples/* into viewer/public/demos (FORCE=1 for all)
make demos-clean
make kill PORT=n
make sync-viewer    # push viewer-package/ history to the MIT mirror repo (make publish does this)
```

```bash
# Release (root): bump both packages + the pin, then publish viewer -> three-slicer -> mirror -> tag
make bump V=0.3.0
make publish        # DRY=1 to rehearse
```

```bash
# Install (once, at the root) + build the packages (the viewer dist, the generated types)
npm i && npm run build

# The viewer demo app on its own — prefer `make dev`, which also builds the package and the demos
cd web/viewer && npm run dev

# Everything `npm test` runs, in two halves:
npm run test:kernel    # wasm-core invariants (120+), the kernel-param table, the worker-protocol wrapper
npm run test:core      # every viewer-package/tests/test_*.mjs — the viewer's layer guard, wiring and doc gates, the pure modules, the toolpath contract, the version lockstep
npm run test:viewer    # what stayed with the kernel: the G-code round trip through the kernel, the license boundary, the preset-file test that reads the vendor catalog

# The viewer half, individually (each is `node viewer-package/tests/test_<name>.mjs`):
#   layers          the src/ layer boundary is real, not decorative (see Structure below)
#   viewer_docs     README shortcuts + features + panels match the code
#   preset_file     OrcaSlicer preset .json / .orca_printer codecs (fixture is committed)
#   plate_layout    the plate grid the scene, the 3mf writer and the G-code injection all share
#   merge_stl       buildMergedSTL/exportObjects — the kernel's facet numbering
#   box_select      the Shift+drag rectangle's screen projection
#   bed_grid        upstream Bed_2D's cell ladder
#   tower_layout    prime-tower placement, auto and chosen
#   paint            per-extruder facet counts, the overlay/cursor colours, the brush's keyboard layer
#   bed_bounds gcode_parse history loaders overhang scale_box 3mf_export 3mf_project

# Regenerate the kernel parameter reference (params.cpp/params.h -> engine/PARAMS.md). build runs this automatically
node packages/types/gen_kernel_params.mjs

# The brush's kernel side: the swept (capsule) stroke, the section plane, the overhang limit, the fill preview.
# Runs inside test:kernel — it guards entry points the viewer feature-detects, so a silent regression is invisible.
node packages/wasm-core/tests/test_paint_brush.mjs

# 3mf project import — the painting codec/rebasing (kernel) and the parser/settings coercion (JS)
node packages/wasm-core/tests/test_paint_import.mjs
node viewer-package/tests/test_3mf_project.mjs

# 3mf project export — the reverse codec (kernel) and the writer, read back through the importer (JS)
node packages/wasm-core/tests/test_paint_export.mjs
node viewer-package/tests/test_3mf_export.mjs

# Uniform-scale drag ratio, the scale clamp, and layout-independent shortcut matching
node viewer-package/tests/test_scale_box.mjs

# Undo/redo stack semantics (branch discard, coalescing, limit) + the Ctrl+Z/Y binding
node viewer-package/tests/test_history.mjs

# Per-plate settings: the override merge, the blocked-key gate, isolation, and the two-scope staleness
node viewer-package/tests/test_plate_settings.mjs
node viewer-package/tests/test_stale_slice.mjs

# SLA: the kernel invariants + pad + mt parity + the hollowing gate run inside test:kernel; the rest standalone
node packages/wasm-core/tests/test_sla_kernel.mjs        # slice_sla end to end: contours, supports, lift frame
node packages/wasm-core/tests/test_sla_support_points.mjs # the ported SupportPointGenerator against its recorded run
node packages/wasm-core/tests/test_sla_source_manifest.mjs # slasupport_port files match their upstream hashes
node packages/engine/tests/test_sla_request.mjs          # the typed SLA job protocol (capability codes)
node viewer-package/tests/test_sl1.mjs                  # SL1 raster transform (portrait), config.ini, archive
node viewer-package/tests/test_sla_3mf.mjs              # SLA 3mf records (points/drain holes) round-trip

# Rebuild the kernel (needs emscripten + brew boost/eigen + brew cgal for the SLA group)
bash packages/wasm-core/build.sh
# Elsewhere than macOS Homebrew: an activated emsdk on PATH, and a directory holding only boost/ eigen3/ CGAL/ (6.x) and
#  the png headers (never /usr/include itself, whose libc headers would shadow emscripten's). Built this way with
#  emsdk 6.0.13, boost 1.89 and CGAL 6.0.1, the G-code matched the Homebrew build's (emsdk 7.0.0's libc++ drops
#  transitive includes the ports rely on).
WASM_DEPS_INCLUDE=$HOME/.local/wasm-deps/include bash packages/wasm-core/build.sh

# Regenerate the extracted JSON (slicers/slicer sources -> packages/data/)
python3 web/extract_all.py

# Regenerate the settings key types (config-schema.json -> types/settings-keys.d.ts, 976 keys). build runs this automatically
node packages/types/gen_settings_types.mjs

# Standalone tarball verification (4 consumers: Node/types/Vite/Next) — must live inside packages/
bash packages/pack_check.sh
```

## Structure

All of `packages/` is **one npm package, `three-slicer`** (consumed piecewise via subpath exports):
- `packages/engine/` — the entry point `three-slicer` (+`/settings` `/toggle` `/worker` `/wasm`): the WASM kernel SDK
- `packages/data/` — the extracted artifacts: config-schema, ui-tree, toggle-rules, invalidation-map, printers
  (vendor machine profiles: motion limits + bed/nozzle), processes (print presets — speeds/accelerations) and
  filaments (material presets — temperatures, flow, cooling, retraction overrides; joined to printers by
  `compatible_printers`, with each machine model's `default_materials` as the recommended list).
  `processes`/`filaments` are emitted as **`.js` modules, not JSON**, because they are loaded dynamically: a dynamic JSON import
  needs `with { type: 'json' }` in Node, and that same attribute makes browsers reject a dev server's
  `text/javascript` response. The large artifacts are column-oriented and deduplicated — read them through
  `printerSettings()` / `processPresets()` / `filamentPresets()` in `three-slicer/settings`, not by hand.
  Both preset artifacts carry only the keys some preset actually sets, so their key sets stay disjoint and
  applying one never clears another's values.
  New artifacts must also be added to `packages/package.json` `files`, or they are missing from the tarball.
  **A `!` entry in `files` only subtracts from the entries BEFORE it** — `!**/tests/**` and `!**/.omc` sit after the
  folders they prune for that reason, and a folder added below them is not covered. Measured: with `!engine/**/.omc`
  listed before `data`, `three-slicer@0.3.0` still shipped `types/.omc/`. `pack_check.sh` fails on any dot-path now.
  Prefer consuming `three-slicer/data` (named exports, import attribute included) — the raw `three-slicer/data/*.json` is available too.
  **When importing a new JSON file, always add it to `engine/src/data.js`**: Vite/esbuild strip
  `with { type: 'json' }` from bundle output, so with more than one import site the consumer's bundler warns about mismatched attributes.
- The React half is not in this package. A host binds it: `three-slicer-viewer`'s `useSlicer` with the WASM worker factory
  (`makeSlicerWorker`, `three-slicer/client`) and the bundled vendor presets (`bundledCatalog`, `three-slicer/settings`)
  go to `<Viewport/>` through the `slicer` and `catalog` props; the full schema, the real tab tree and `three-slicer/toggle`
  go to `<SettingsPanel/>` (`three-slicer-viewer/components`) as `schema`, `uiTree` and `toggle`. The slicing hook itself
  (the worker protocol, progress, the pool, the economy/classic ladder) is the permissive package's: its only tie to a
  kernel is `deps.makeWorker`. `three-slicer/viewer` and `three-slicer/components` were that binding as wrappers until
  0.4.0. `packages/engine/tests/` holds the tests that cross the boundary (the G-code round trip through the kernel, the
  license boundary, the preset file against the vendor catalog, the bed-frame round trip).
- `viewer-package/src/` — the viewer itself (`three-slicer-viewer`). Everything the AGPL package used to hold under
  `viewer/src/` lives here now, with the same layout; the guards (`test_layers.mjs`, `test_wiring.mjs`) moved with it.
  `src/` is laid out by ONE question — **can this run under node?** — because that is the only boundary that was
  already real here: every viewer test covers something on the pure side of it, and nothing covers the other side.
  `test_layers.mjs` enforces it, so the folders are a check rather than a convention.
  - `src/core/` — no React, no DOM, no renderer. three.js **math** is fine (`Matrix4`/`Vector3` run under node,
    which is what makes `model_geometry`/`scale_box` testable at all); `WebGLRenderer` and the jsm controls/loaders
    are not. This is where anything worth an assertion belongs.
  - `src/scene/` — the three.js/DOM shell (`use_three_scene`, the gizmo helpers, the loaders, the toolpath GPU
    path). Untestable here by nature, so it should stay thin: peel the arithmetic out into `core/` instead.
  - `src/actions/` — use cases. They take the shared refs plus the scene's `apiRef` and decide what happens.
  - `src/ui/` — presentational React. Props in, markup out; it must not reach into the scene or the kernel.
  - `src/hooks/` — Viewport's own React hooks (`use_slicer`, the slice request/run/staleness hooks, history, host
    events). They import React, `core/` and the package's `/settings` and `/gcode` subpaths only — not the package
    root, which re-exports `scene/toolpath_gpu.js`; `test_layers.mjs` enforces that.
  - `src/` itself — the entry (`Viewport.jsx`) and `make_worker.js`/`parse_3mf.worker.js`, which
    the **build resolves by path** (the vite lib entry and the `cp` in the package build script). Moving those two
    breaks the published tarball rather than a test, which is why `test_layers.mjs` pins them where they are.
- `packages/types/` — all the `.d.ts` files. Hand-written, except `settings-keys.d.ts` (976 keys) which `gen_settings_types.mjs` generates
- `packages/wasm-core/` — the kernel C++ sources + `third_party/` (a copy of the deps, for standalone builds) — not published to npm; its output lands in `packages/engine/src/`
- `web/viewer/` — the demo app (Vite + React) — a workspace member that references the package by name
