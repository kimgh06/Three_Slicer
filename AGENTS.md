# AGENTS.md

Three_Slicer — a browser/WASM slicer reverse-engineered from OrcaSlicer. The root holds three folders:

- **`slicers/`** — the upstream reference checkouts, untracked: OrcaSlicer at `slicers/slicer` (the extraction/porting source — its own guide is `slicers/slicer/AGENTS.md`) and PrusaSlicer at `slicers/PrusaSlicer` (comparison only).
- **`packages/`** — the published npm package `three-slicer` (AGPL) plus the kernel sources. Zero build or runtime dependency on `slicers/`.
- **`viewer-package/`** — the published npm package `three-slicer-viewer` (MIT): the viewer without the slicer — model loading, G-code parsing, GPU toolpath rendering, the catalog-free settings transforms, the toggle evaluator (unbound), `<SettingsPanel/>` and `<Viewport/>` themselves. `three-slicer/viewer` is a thin wrapper that plugs the kernel and the vendor catalog into it. The two publish as a locked pair (same version, exact pin — `packages/RELICENSE.md`).
- **`web/`** — the demo app shell. It consumes the package as a workspace (no relative-path imports). Details: `web/README.md` (the stage log is split out as `web/HISTORY.md`), `web/GUIDE.md`, `web/SPECS.md`.

The root `package.json` is the npm workspaces root (`viewer-package`, `packages`, `web/viewer`) — a single `npm i` at the root installs everything. `viewer-package` comes first because `packages` depends on it.

## Core rules

- **Never modify `slicers/`.** All development happens in `packages/` and `web/`.
- **No ternary operator (`cond ? a : b`), in any language or test.** Not nested, not single, not in JSX. A ternary
  packs a branch into an expression, where the condition, the two values and their order all have to be read at
  once — and a single one invites the next one inside it. Write an early `return`, an `if`/`else` assignment, a
  lookup table with `??` when the choice maps names to values (`{ key: value }[name] ?? fallback`), and `cond &&
  <Element/>` for conditional JSX. `?.` and `??` are not ternaries and stay. Existing code is converted as it is
  touched.
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
  read by the kernel's plain number reader, not the percent-aware `jwidth_raw` the per-feature widths get, so a
  `"120%"` would reach `strtod` as a quoted string and resolve to 0 == auto — it is resolved against the nozzle on
  the JS side instead; and the tree-support shape options exist upstream under two spellings (`…_organic` and
  suffix-less), which the kernel accepts both of and prefers `_organic`, so both are passed as written.
- **The kernel parameter reference is generated, and must stay that way** (`types/gen_kernel_params.mjs` ->
  `engine/PARAMS.md`). Its key column comes from the `j*(j,"…")` reader call sites in `params.cpp`, which are the
  definition of the accepted set; its *From setting* column comes from PROBING `deriveKernelParams` with one schema
  key at a time rather than parsing it, because that mapping includes renames, rescales (`sparse_infill_density` 15
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
  `write3MFProject` is **async** because the deflate runs off-thread (fflate's worker pool, as the parser's `unzip`
  already does) — a save is dominated by compression, and on the main thread that is a frozen tab. Measured on a
  980k-facet model: 2.6s all-on-thread when this landed, 1.5s wall / 0.45s longest frame gap now. Two of that came
  from choices worth not undoing: the weld keys vertices by their float32 BIT PATTERN rather than a decimal string
  (708ms -> 89ms), and the zip is level **3**, which on this XML is both faster than level 6 and slightly smaller.
  The `[vp-prof] export` line reports gather/paint/write separately, because the three scale with different things.
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
- The toolpath stream's role field (`paths[k+3]`, stride 8) encodes `role + tool * 16`. Roles only reach 11, so the tool rides in the spare high bits rather than a 9th float — the segment stream is the largest array the viewer holds and a 9th float costs +12.5% of it for one small integer. **Anything reading that field must mask** (`& 15` for the role, `>>> 4` for the tool); pre-encoding output is entirely below 16 and decodes to its own role with tool 0. The viewer's readers and writers take the layout from `viewer-package/src/core/toolpath_encoding.js` (`STRIDE`, `ROLE`, `encodeRole`/`roleOf`/`toolOf`); the engine's standalone SLA worker keeps named copies.
- `web/extract_all.py` takes the kernel key list (which preset columns to keep) from the GENERATED
  `viewer-package/src/settings/kernel_setting_keys.js`, the list `gen_kernel_params.mjs` probes out of
  `deriveKernelParams`. It used to regex-scan `packages/engine/src/settings.js` for quoted schema keys, which had two
  failure modes: a comment quoting a key added a column, and when the mapping moved into `viewer-package` the scan fell
  to 3 keys without an error (the committed presets predate the move, so it only showed on the next extraction).
  A missing or empty list now stops the extraction. Regenerate the list first when the mapping changes.
- **The transform gizmo is deliberately not the stock one.** Three edits to `TransformControls`, each measured, each
  easy to mistake for superstition and delete: (1) `showY` is false in **translate** mode only — a part prints off
  the bed, so up/down is not a move (it also takes the XY/YZ plane handles, leaving X/Z/XZ). Set per mode, and
  `seatMesh` still has to run on commit because rotate and scale move the lowest point. (2) The scale gizmo's `XYZ`
  handle is **removed from the object graph**, not hidden — the per-frame update rewrites `visible` and `scale` on
  every handle it owns, so flags do not stick; the bounding-box corners (`scale_box.js`) are the usable version of
  that grip. (3) A 16px dead zone around the gizmo origin in scale mode: a scale drag's ratio is
  distance-now/distance-at-press, and every axis picker reaches the origin, so a press there divides by ~0 — measured
  4e7 on a 20mm cube, and negative past the centre, which mirrors the mesh and inverts the winding the kernel slices.
  `clampMeshScale` bounds the result (0.2mm..5000mm, positive) for the drags that stay legal.
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
- **Layer loops are oriented and filled NonZero, not even-odd.** The kernel slices the merge of every object as ONE
  mesh, so even-odd counted two coincident shells as outside and two objects on the same spot sliced to nothing.
  `tri_plane` orients each segment by its facet normal (solid on the left, upstream's `IntersectionLine`), and
  `chain_polys` keeps a loop in its first segment's direction, prefers a continuation that STARTS at the current
  point (four segments meet where shells coincide) and reverses a loop assembled mostly backwards (flipped facets).
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
- **An all-plates run is a queue drained by K workers, and the selector worker is one of them.** `slice_pool.js`
  sizes K (Auto: half the cores on mt, cores-1 on st, never more than plates); `use_slicer.js`'s
  `createPoolContext` is a worker whose whole state — pending slice, stream accumulator, SAB view, poll, watchdog,
  the classic/economy ladder — lives in one closure, because it exists for one run and paints nothing. The
  selected plate goes FIRST and to the selector worker: it is the mesh the brush painted. A pool worker starts with
  an empty selector, so a pool plate with stored paint loads it first (`ctx.loadPaint`) and `buildParams` takes that
  reply's counts; the selector worker's live counts (`painted`) belong to its own plate only. The selector worker's progress is re-routed through `progressSinkRef` for the
  run's duration so it reports per plate like the others; `reuse_stages` stays the selector worker's alone (a pool
  worker is terminated after the run — wasm heaps do not shrink, measured 8.8GB for five on a 3M-facet model).
  The STL is COPIED to a pool worker, not transferred, because the ladder re-sends it on a retry and a transferred
  buffer is detached. Policy is measured, not designed (see the README tables): in a node harness worker count
  never made a run slower up to the core count and memory was the only ceiling; a per-worker thread budget,
  longest-plate-first ordering and divisor counts were each measured to change nothing — do not add them. The
  BROWSER ceiling is far lower, because the renderer process already holds every plate's STL buffer and geometry:
  on a 143MB-STL model over nine plates, 2 workers gained 13%, 3 crashed the tab once, and Auto-by-cores (8)
  crashed it every time. So `resolveWorkerCount` also caps Auto by the largest plate's STL size
  (`HEAP_PER_STL_BYTE` x bytes against `POOL_HEAP_BUDGET`, both measured constants) — a manual count is not
  capped, because the user chose it. A pool worker that dies (memory, a script that failed to load, the watchdog)
  is the POOL's failure, not the plate's: the ladder does not retry it under the same pressure, the worker is
  dropped, and the plate is re-queued to run alone on the selector worker after the pool drains — so a too-high
  count degrades to serial instead of to a row of failed plates. Selection no longer follows the run; the tabs
  carry each plate's state (`plateRun`), with the failure reason in the tooltip.
- **Every resin plate keeps a preview in the scene, not just the focused one.** The focused resin plate is the
  clipped `setSlaPreview` slot the layer slider cuts; every other resin plate with a result gets a static,
  unclipped group through `setSlaStatic` (`scene/sla_preview_mesh.js` builds both), the resin counterpart of the
  toolpaths every FFF plate keeps after slice-all. Before this, two resin plates showed only the focused one and
  the other read as a missing result. `core/sla_preview.js` is the one place the payload (lift, offsets, meshes)
  is derived, so the two previews cannot disagree on where a support tree stands.
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
  AGPL package (`packages/viewer/tests/test_license_boundary.mjs` enforces it). Which code may carry which licence, and
  why, is `packages/PROVENANCE.md`.

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
# Install (once, at the root) + build the packages (components/viewer dist)
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
- `packages/components/` — `three-slicer/components`: a wrapper that hands upstream's data to the permissive panel — the full
  schema (labels and tooltips are OrcaSlicer's text), the real tab tree, and `three-slicer/toggle` bound to upstream's rules.
  The `<SettingsPanel/>` itself is `viewer-package/src/components/` (`three-slicer-viewer/components`), which takes those three
  as props and, without them, labels every field by its key and disables nothing.
- `packages/viewer/` — `three-slicer/viewer`: the kernel plugged into the permissive viewer. `Viewport.jsx` binds
  `three-slicer-viewer`'s own `useSlicer` to the WASM worker factory (`makeSlicerWorker`, `three-slicer/client`) and hands
  it plus the bundled vendor presets (`bundledCatalog`, `three-slicer/settings`) to the permissive `<Viewport/>` through
  the `slicer` and `catalog` props; three re-export shims keep the old subpaths. Nothing else is here — the two things
  that cannot be permissive live where they belong, beside the kernel and beside the catalog functions. The slicing hook itself
  (the worker protocol, progress, the pool, the economy/classic ladder) is the permissive package's: its only tie to a
  kernel is `deps.makeWorker`.
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
