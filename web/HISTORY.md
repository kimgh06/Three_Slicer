# Development history — the stage-by-stage log

How the kernel and the viewer were built, one stage at a time. This is a record, not current documentation —
what each stage says was true when it landed; the present state is `web/README.md`, `AGENTS.md` and the
package READMEs.

> **A note on screenshots and test wasm**: the stage-by-stage records below cite verification screenshot paths such as
> `wasm-core/sNN_*.png` and `stageNN_*.png`, but those files are excluded from the repository (6.6MB). The emscripten test
> outputs (`wasm-core/**/test_*.wasm`, 6.5MB) are build artifacts regenerable with `build.sh`, so they are excluded too.
> Both are in `.gitignore` and remain in the initial commit history. Read the citations as a record that the verification
> really was performed at the time.

## The WASM core (track C — the browser-only slicing mini kernel)

- Location: `../packages/wasm-core/`.
- Build: `bash packages/wasm-core/build.sh` (requires emscripten, including the `EMSDK_PYTHON` export).
  **From stage 7 it also needs brew `boost` + `eigen`** (the header-only voronoi/Eigen). The output `slicer_core.js`
  (SINGLE_FILE=1 -> the wasm inlined as base64) is committed in `packages/engine/src/`, so **using just the viewer works
  without emscripten/boost/eigen**.
- Self-tests: `node packages/wasm-core/test.mjs` (cube + ASCII + overhang table + cylinder + thin
  cross + thin ring + L shape + two boxes side by side -> **120 invariants**: layer count, solid shell, skirt, z_hop, support, raft, bed +
  slicing per infill pattern, reduced zigzag travel, the fan ramp (0 on the first layer / M107), small-layer slowdown, G2/G3 arcs present with extrusion within ±1%,
  the distribution of the 4 seam modes, spiral + **stage 5: gap fill (the 2.5w ring), thin-wall center lines, the scarf marker + a mid-value seam z, M900, tree_lite
  taper + touchdown, bridges** + **stage 6: ironing type10 + 10% flow, reduced wall-crossing travel (the L shape), the PE-lite flow change-rate
  limit (verified through F), multi-material T0/T1 + the prime tower** + **stage 7: the real Arachne variable-width walls (the thin cross varying 0.42 -> 0.60mm,
  a uniform cube, width-based E), classic remaining the backwards-compatible default** + **stage 8: the real Fill patterns (gyroid TPMS/honeycomb/
  3dhoneycomb/crosshatch/concentric), upstream gyroid ≠ the approximation, gyroid z phase, the real PE port running with E preserved** + **stage 9:
  the real PE fully integrated (emitting the OrcaSlicer tags -> per-segment F ramps, more G1 lines, E preserved, tags stripped), the TreeSupport MST core ported** +
  **stage 10: the ported GCodeProcessor time estimate (the upstream trapezoidal planner verbatim; parse-based total/per-layer/per-role times, faster -> less,
  filament matching to 0%), the estimate shown in the viewer, and the WipeTower/full GCodeProcessor gate on the config subsystem recorded**).
- Composition: `slicer_core.cpp` (multi-pass: STL -> intersect, chain, union, walls -> surface detection -> **support** -> solid/sparse
  (patterns) -> **raft** -> cooling/slowdown/seam/arc -> G-code, with the flow math in SPECS §6.2), `clipper.{cpp,hpp}`
  (OrcaSlicer's dependency Clipper 6.4.2 patched for WASM: Eigen/oneTBB removed) and `Int128.hpp` (a local copy).
- Interface: embind `slice(Uint8Array stl, string paramsJson, function onProgress)` -> `{ gcode,
  stats:{layers,model_layers,raft_layers,path_segments,filament_mm,over_bed,wall_crossings}, layers:[{z, paths:Float32Array, widths:Float32Array}] }`.
  (`widths` = a parallel array of per-segment widths, for the stage-7 Arachne variable width. classic keeps line_width uniform.)
  Toolpaths are flat `[x,y,z,type]` (0=travel/1=wall/2=sparse/3=solid/4=skirt·brim/5=support/6=raft/7=gap-fill/8=thin-wall/9=bridge/**10=ironing/11=prime-tower**). `stats.wall_crossings` (the number of wall-crossing travels) was added. `onProgress(done,total)` fires per layer.

**Stage 1** (the skeleton): binary STL -> N walls + sparse parallel-line infill -> G-code. (Open top and bottom.)

**Stage 2** (actually printable):
- Solid top/bottom shells — surface detection (a Clipper difference with the neighboring layer) -> propagation through `top_shell_layers`/`bottom_shell_layers`,
  with the first and last layers fully solid. Solid = line_width spacing, sparse = line_width/density.
- Skirt (`skirt_loops` at `skirt_distance`) + brim (`brim_width` -> rings at w spacing), on the first layer. **Concentric rings are emitted individually**.
- ASCII STL parsing (collecting `vertex`). Binary/ASCII is auto-detected (`84+50n==size`).
- Parameterized retraction (`retract_length`/`retract_speed`) + `z_hop` (raise Z on retraction, move, then lower Z).
- Seam alignment (rear seam): each layer's wall loop start is rotated to the vertex with maximum Y -> the seam lines up along the back.
- Non-blocking slicing in a Web Worker with per-layer progress.

**Stage 3** (geometry complete):
- **Normal (grid) support** — overhang detection `contour_i − offset(contour_{i-1}, +tan(threshold)·lh)` -> vertical projection
  downward (union, delayed by `support_top_z_distance` for the contact z gap) -> model avoidance (`support_xy_distance`) ->
  interface `support_interface_top_layers` (solid) / body (sparse, `support_density`). No walls. Toolpath type=5.
- **Raft** (`raft_layers`) — a base expanded 3mm beyond the first-layer area of the model plus support is inserted below in z (the first layer 0.3 solid,
  the rest sparse), shifting the whole model in z. Marked `; raft`, toolpath type=6.
- **Bed parameterization** (`bed_width`/`bed_depth`) — the G-code offset = bed/2, and the viewport grid uses the same values. Exceeding it sets `over_bed`.
- **Multiple objects** — several STLs accumulate in the viewer, and the TransformControls transforms are applied to the triangles in JS before merging and
  handing them to the kernel. Non-overlapping objects are handled naturally by the kernel's union.
- **Monotonic top solid** — solid infill lines are sorted by their projection onto the fill normal axis before emission.

**Stage 4** (path and G-code level):
- **Infill patterns** (`sparse_infill_pattern`) — rectilinear · grid (0/90°) · triangles (0/60/120°) · zigzag (a continuous path connected at the
  boundary -> fewer travels) · gyroid (a sine approximation with a z phase rotation). Pattern names the kernel does not support fall back to rectilinear.
- **Cooling** (`fan_speed`/`close_fan_the_first_x_layers`/`full_fan_speed_layer`) — a linear M106 ramp at layer boundaries
  (0 on the first layer -> 255·fan/100 at the full layer), M107 at the end. Plus, when the estimated layer time < `slow_down_layer_time`, the feedrate is
  scaled down (floor 20mm/s), computed from the path length before emission.
- **Arc fitting** (`enable_arc_fitting`) — arc approximation of consecutive segments (>=5 points, deviation <=0.05mm, r 0.1~200, <=155°) -> G2/G3.
- **Seam position** (`seam_position`) — back (max Y) / nearest (closest to the nozzle) / aligned (the previous layer's seam) / random (an LCG seeded by the layer
  index, deterministic).
- **Spiral** (`spiral_mode`) — a single outer wall, no infill or solid, with z rising continuously around the perimeter (vase mode).

**Stage 5** (quality/approximation features — each a minimal implementation plus an approximation, with a "not full libslic3r" comment):
- **Gap fill** (type7) — detects the morphological-open leftover of the fill inside the innermost wall (`offset -w/2 then +w/2`, gaps narrower than w)
  -> a single-width center line approximation (one rectilinear line). Excluded from fillCore to prevent double extrusion. ⚠ Not a medial axis or variable width.
- **Thin wall (Arachne-lite)** (type8) — detects regions narrower than 2w where the wall offset vanishes (`contour − open(contour,w)`).
  Walls are generated only from the thick core, while thin parts get **one center line** along each component's major axis with the flow corrected by the local width (area/length).
  ⚠ Not a full Arachne variable-width skeleton — a single center line approximation.
- **Scarf seam** (`seam_slope_type` none|external|all) — with external/all, the outer wall loop ramps z (`z-h -> z`) and
  flow (0 -> 1) up at the start (10mm by default, subdivided on long straight walls so z rises continuously) and ramps down over the same length at the end with an overlap (flow 1 -> 0).
  Marked `; scarf`. A gentle sloped joint instead of a z-seam blob.
- **Pressure advance** (`enable_pressure_advance` + `pressure_advance`, default 0.02) — `M900 K<v>` in the preamble
  (Marlin/RRF). For Klipper only a `SET_PRESSURE_ADVANCE` comment is written.
- **Tree-lite support** (`support_style` grid|tree_lite) — tree_lite sweeps top to bottom shrinking each layer by `-0.5mm`
  (keeping a minimum pillar radius of 1.5mm) and unioning -> a tree shape, wide on top and narrow at the bottom. Model avoidance is reused.
  ⚠ Not organic tree support (no branch splitting or angle optimization) — just a descending taper. Frame-shaped overhangs do not merge into a trunk; they
  narrow to the minimum width and freeze there (only solid overhangs converge into a trunk). The viewer maps the schema's `support_style` enum (tree_*,
  organic) to tree_lite and everything else to grid.
- **Bridges** (type9) — unsupported bottom solid (an overhang underside not touching support) -> fan 100% + a `bridge_speed` slowdown (default 25).

**Stage 6** (closing the parity gap — each a minimal implementation plus an approximation, with a "not full libslic3r" comment):
- **Ironing** (`ironing_type` no ironing|top|topmost|solid, type10) — for the top family, a low-flow second pass at the same z over exposed top solid:
  spacing `ironing_spacing` (0.1), flow `ironing_flow` (10% -> e_per_mm x 0.1), speed `ironing_speed`.
  Marked `; ironing`. ⚠ top/topmost/solid are all treated identically as ironing over the exposed top surface (no layer distinction).
- **Wall-avoiding travel** (`reduce_crossing_wall`) — when a travel starts and ends inside the island (inside the walls = `offset(contour,-w/2)`)
  but the straight line crosses the boundary -> a detour walking the boundary polygon from the vertex nearest A to the vertex nearest B (the shorter way), skipping
  the retraction. Crossings are always detected (`stats.wall_crossings`); the detour only happens with avoid on. ⚠ Not complete avoidance (failed detours remain).
- **PressureEqualizer-lite** (`max_volumetric_extrusion_rate_slope`, mm³/s², 0=off) — limits the volumetric flow change rate between
  adjacent extrusion segments: with Δt=d/v_n and v_n=Fn/A -> slope=|Fn−Fl|·Fn/(d·A) <= the limit. Acceleration caps Fn (a quadratic),
  deceleration clamps a steep drop to hi. **It adjusts only per-segment speed without splitting segments** (E unchanged, speed only). Low-flow
  features (thin walls, ironing) are excluded from PE to avoid abrupt cross-section changes. ⚠ The desktop app splits segments and predicts over the whole range; this is an approximation.
- **Multi-material basics** (`extruder_count`=2 + `mm_group_split`) — the viewer assigns an extruder (T1/T2) per object ->
  the merged STL is sorted by extruder and the group boundary index is passed -> within a layer each group is sliced separately, and a switch emits `T0/T1` +
  a simple prime tower (3 concentric 15x15 square rings in the bed corner, type11, only on switching layers). Walls + sparse infill only.
  ⚠ **Not a proper wipe tower** — no purge/ramming/wipe volume or tower density optimization. Support, solid shells and so on are not applied.

**Stage 7** (a change in character — not an approximation but **a port of the real OrcaSlicer Arachne sources**, the start of real parity):
- All of `src/libslic3r/Arachne/` (WallToolPaths, the SkeletalTrapezoidation Voronoi skeleton, the 5 BeadingStrategies,
  ExtrusionLine/Junction, the SparseGrid/PolylineStitcher utilities) was ported into `wasm-core/arachne_port/` **with the upstream algorithms unmodified**
  -> it **compiles, links and runs** under WASM. With `wall_generator=arachne`, wall generation runs through
  real Arachne (classic remains the kernel default -> backwards compatible).
- Results (verified): uniform 0.42mm walls on a cube, **the thin cross's arms varying 0.42 -> 0.60mm** (real variable-width beads), E based on the segment
  width (`set_e_per_mm_width` — wider segments raise E per unit length, verified as 0.031 -> 0.046 in the G-code), and a parallel
  `widths[]` array in the toolpath so the ribbon renders each segment's true width. Viewer screenshots: `screenshots/stage7-arachne-*`.
- Integration structure: `arachne_bridge.{h,cpp}` is the only boundary — the kernel (the global `ClipperLib`) and the port
  (`Slic3r::ClipperLib` + `ClipperLib_Z`) are isolated in different namespaces so they coexist in one module. The kernel includes only the
  plain-type `arachne_bridge.h` (no Slic3r/clipper types leak). Fill, infill, support and the rest stay classic;
  **only wall generation** is replaced by real Arachne.
- Dependencies: brew **boost** (the header-only `polygon/voronoi` + `container_hash`) + brew **eigen** + `deps_src`
  (`clipper/clipper_z`, `ankerl/unordered_dense`). **No boost link libraries are needed** (voronoi is header-only) —
  that was the key to the port being feasible.
- Stubs and minimal edits (the upstream algorithms are untouched, only the surroundings — each file records the reason in a comment at the top):
  `oneapi/tbb` -> std::allocator, `boost/log` -> no-op, `cereal/access` -> a forward declaration + construct, `SVG` -> no-op
  (all SVG use is under `#ifdef ARACHNE_DEBUG`), `Flow` -> one static function only, `VariableWidth/PrintConfig/Utils/Config` ->
  unused parts stubbed, `Geometry` -> the real thing (only cereal stubbed). **2 source edits**: `WallToolPaths.cpp`
  (removing the `make_paths_params` definition — a convenience function that reads PrintConfig; the port builds params directly) +
  `WallToolPaths.hpp` (adding the `boost/container_hash/hash.hpp` include — replacing a transitive include lost to a stub) +
  `ExtrusionLine.cpp` (removing 2 libslic3r ExtrusionPaths conversion helpers — they couple to Flow and the port does not use them).

**Stage 8** (the upstream port continues — the real Fill patterns + the real PressureEqualizer):
- **Porting the real Fill patterns** (`src/libslic3r/Fill/`) — the FillBase framework + `FillGyroid` (the real TPMS),
  `FillHoneycomb`, `Fill3DHoneycomb`, `FillCrossHatch` and `FillConcentric` were all ported into `arachne_port/` and
  they **compile, link and run** under WASM. In `sparse_infill_pattern`, gyroid is **replaced by the real TPMS** (the old sine
  approximation is kept as `gyroid_approx`). `fill_bridge` is the only boundary (per-component ExPolygon -> FillBase.fill_surface ->
  Polylines). Verification: the real gyroid produces 50968 segments ≠ the approximation's 101828, the **gyroid z phase** changes the surface per layer, and all 5 patterns
  slice with segments > 0. Viewer screenshot: `screenshots/stage8-real-gyroid-tpms.png` (the TPMS surface inside a cut-open cube).
  - Dependencies added: **Clipper2** (deps_src/clipper2, headers + 3 .cpp files, for `FillBase::multiline_fill`), `ShortestPath`
    (path ordering), `ExtrusionEntityCollection`, `Circle` (ArcSegment) and `MarchingSquares` (the gyroid contours).
  - Stubs and edits: `Execution/ExecutionTBB` -> a sequential policy (no TBB), `PrintConfig` -> infill enums added + a PrintRegionConfig
    forward declaration, `Utils` -> IsTriviallyCopyable/modulo helpers, `Flow` -> the real width/spacing/mm3_per_mm formulas, `cereal/types`
    -> stubbed, `GCodeWriter` -> only GCodeFormatter extracted. **Source edits**: `FillBase.cpp` (narrowing new_from_type to the 5 ported patterns,
    a null guard on use_bridge_flow, and stubbing the string factory / fill_surface_extrusion / _create_gap_fill — all of them coupling points to
    PrintObjectConfig or unported patterns), `FillConcentric.cpp` (the nozzle value made a constant) and `ShortestPath.cpp`
    (removing Print.hpp + stubbing chain_print_object_instances).
- **Porting the real PressureEqualizer** (`src/libslic3r/GCode/PressureEqualizer.cpp`) — compiles, links and runs under WASM.
  The `GCodeConfig` constructor was replaced by **direct parameter injection**, the `LayerResult` overload removed, `process_to_string()`
  added (string in -> smoothed g-code out) and `GCodeFormatter::emit_axis` extracted (wasm uses std::to_chars). Verified: it runs,
  **preserves total E exactly** and keeps the g-code structure (`; LAYER`/M104). ⚠ **Limitation (recorded honestly)**: the real PE only adjusts extrusions inside OrcaSlicer's
  `;_EXTRUDE_SET_SPEED`/`;_EXTRUDE_END`/`;_EXTRUSION_ROLE:` tag blocks (PE.cpp:317
  `adjustable_flow = opened_extrude_set_speed_block`). This mini kernel emits **plain g-code** (no tags), so
  the real PE passes through as a no-op — even a minimal synthetic input with tags injected showed no segment splitting (presumably it needs the full role-slope +
  multi-line look-back pipeline context). Hence **pe_lite=true by default** (keeping the effective stage-6 approximation),
  with the real PE opt-in through `pe_lite=false` and this limitation documented. **Full integration = modifying the kernel to emit SET_SPEED/EXTRUSION_ROLE tagged
  g-code** (the next stage, which changes the g-code format).
- **WipeTower reconnaissance only** (`src/libslic3r/GCode/WipeTower.cpp`) — its include graph: the geometry core (Point/Polygon/
  Polyline/BoundingBox/ClipperUtils, already ported) + **GCodeProcessor.hpp** (the g-code parser, the biggest blocker — see the
  stage 9 roadmap below) + **TriangleMesh + Triangulation** (the tower mesh, moderate difficulty) + LocalesUtils (header inline).

**Stage 9** (the real PE fully integrated + the TreeSupport core ported + the GCodeProcessor roadmap):
- **The real PE fully integrated** — the kernel's G-code emission was extended to attach the OrcaSlicer tags (`emit_pe_tags`, false by default;
  enabled automatically when the real PE is used): extrusion runs get `;_EXTRUSION_ROLE:<n>` (the upstream ExtrusionRole integer — wall=2/infill=4/
  solid=5/skirt=12/support=14/…) + `G1 F<v> ;_EXTRUDE_SET_SPEED` (opening the block; the format was reverse-engineered from GCode.cpp:7643/7753 and
  PE.cpp:289/317) + `;_EXTRUDE_END` (closing it). Running the real PE on top of that **really does insert per-segment F ramps**.
  Verified (node): on an arachne cube (variable flow), **G1 lines go 4574 -> 4754 (+180 F ramps)**, **total E is preserved exactly**
  (570.76), the final output strips the tags (`pe_strip_tags` defaults to true -> clean g-code), and all 3 tag kinds are present in tag mode and
  absent by default. -> **The real PE now works effectively on the mini kernel's g-code** (resolving the stage-8 no-op limitation).
- **Attempting the (organic) TreeSupport port** — the full pipeline (`Support/TreeSupport.cpp`, 195KB + `TreeSupport3D.cpp`,
  248KB) is **unportable because of deep PrintObject coupling**: `Print.hpp`/`Layer.hpp`/`SupportCommon`/`TreeModelVolumes`
  (21 and 16 PrintObject references respectively) + tbb concurrent containers + libnest2d + nlohmann. **The core geometry routine did port
  successfully**: `MinimumSpanningTree` (branch placement and merging — Prim's MST over the support points, depending only on `Point.hpp` + `libslic3r.h`,
  fully self-contained) was driven from a kernel-shaped point set through `tree_bridge` -> **9 points -> 8 edges, a valid tree (N−1, acyclic)** with a branch length of
  74.06mm. Reproduce with `arachne_port/tree_link_test.sh`. Actual support generation **stays on tree_lite** (the organic tree is not integrated).
  - Gates by layer: MinimumSpanningTree ✅ ported and running / TreeModelVolumes (avoidance) ⛔ TreeSupportCommon ->
    SupportCommon -> Print / TreeSupport.cpp (branch placement, radii, touchdown) ⛔ PrintObject, Layer, tbb-concurrent.
- **GCodeProcessor porting roadmap** (`GCode/GCodeProcessor.{hpp,cpp}`, ~9091 lines, the gate for WipeTower, time estimation and preview)
  — **good news: no PrintObject coupling** (it includes Print.hpp but only references `PrintConfig`, 12 times, with 0 PrintObject references).
  Being a parser, it is structurally portable. Draft dependency/stub plan:
    · To port: `GCodeReader` (PrintConfig + libslic3r only — lightweight), `Geometry/ArcWelder` (Eigen + libslic3r),
      `CustomGCode` and `MultiNozzleUtils` (moderate), and GCodeProcessor.cpp itself.
    · To stub/replace: **`boost::filesystem` + `boost::nowide`** (9 file I/O sites — WASM takes string input, so the file load/
      save paths are stubbed; the only link-blocker-ish item, but avoidable with stubs), **GCodeConfig -> direct parameter injection** (the same
      pattern as PE), `boost/log` -> no-op (as before), and `format.hpp`/LocalesUtils (header inline).
    · Expected size: medium (the parser itself is large) — bigger than Arachne (which succeeded) and comparable to Fill. The gates are config injection and file I/O stubs,
      not PrintObject, so **the port looks feasible**. Once done, WipeTower, time estimation and preview data all become upstream.

**Stage 10** (porting the GCodeProcessor time estimate + the WipeTower gate + scouting the next big milestone):
- **The upstream time estimate ported successfully** — while executing the stage-9 roadmap it was measured (via a compile probe) that **the whole GCodeProcessor.cpp is blocked by the config
  subsystem**: GCodeProcessor.hpp -> `calib.hpp` demands the entire real PrintConfig.hpp (~3000 lines) — ExtruderType/NozzleVolumeType/BedType/FullPrintConfig/
  GCodeWriter/DynamicPrintConfig/BrimType and more -> hundreds of errors. (Stage 9's "no PrintObject coupling" observation was right, but **the PrintConfig
  subsystem itself was the gate** — corrected.) Response: **transcribe the time estimation algorithm verbatim**
  (`gcode_time.{h,cpp}` — citing the upstream GCodeProcessor.cpp lines: helpers L146-175, Trapezoid/TimeBlock
  L261-290, the forward/reverse planner L332-413, calculate_time L435-487, the process_G1 block creation L5007-5231) + machine limit
  parameter injection (the PE pattern, using representative machine_max_*/machine_min_* profile values) + a lightweight parser that reads the emitted g-code directly.
  - **Kernel integration**: `stats.time_estimate` (total seconds), `layer_times[]` (per layer, summing to the total), `role_times{}` (per role in PE tag mode),
    `time_extrude/time_travel` (a move-type breakdown) and `time_filament_mm` (filament from parsing, to compare against gw.filament). The viewer's stats show
    "estimated print time h:mm:ss".
  - **Verification (7 new node tests)**: the cube parses with a total time > 0, layer_times sums to the total, **faster print_speed -> less time** (30mm/s 878s > 120mm/s 698s,
    the right physical direction), **parsed filament == gw.filament to 0.00%** (passing the ±2% bar), the role breakdown (tag mode {2,4,5,12}) and determinism. The browser
    smoke test had 0 console errors (excluding a favicon 404); screenshot `screenshots/stage10_time_estimate.png`.
  - **Gaps/approximations**: only the Normal time mode (Stealth not modeled), unlimited look-ahead (firmware uses a 64-block window — somewhat optimistic),
    G2/G3 approximated as a single move by arc length (arc_fitting is off by default), and M204/custom g-code accelerations ignored. The direction and magnitude are accurate.
- **Attempting the WipeTower port -> recorded as a config subsystem gate** (compile probe): `GCode/WipeTower.{cpp,hpp}` (4834+650 lines)
  (1) includes `GCodeProcessor.hpp` (the config flood above) (2) has a constructor `WipeTower(const PrintConfig&)` that directly references **78 config options**
  (single_extruder_multi_material, wipe_tower_x/y, prime_tower_width, gcode_flavor, travel_speed, filament_change_length, …)
  (3) pulls in `TriangleMesh.hpp -> Format/STL.hpp` (tower mesh I/O, unported) (4) needs GCode.cpp's `WipeTowerIntegration` (the multi-material tool-change
  orchestration, coupled to the Print pipeline). -> **Not portable; the stage-6 prime tower (the square ring) stays**. `wipe_tower_real` was not introduced
  (nothing to gate).
- **The next big milestone = porting the config subsystem** (scouting): the **shared keystone gate** for full GCodeProcessor, WipeTower and full TreeSupport
  alike is the real `PrintConfig.hpp` (~3000 lines of StaticPrintConfig macros + hundreds of options + cereal + the enums
  ExtruderType/NozzleVolumeType/BedType/BrimType…). What full TreeSupport additionally requires from the Print/Layer subset (scouted):
  Layer(`print_z`·`get_layer`·`height`·`lslices(_extrudable/_bboxes)`·`lower_layer`·`bounding_box`·sharp_tails/
  the cantilevers overhang field), PrintObject (`layers()`, `layer_count()`, `config()`, `support_layers()`, `id`), SupportLayer
  (`support_fills`, `base/roof/floor_areas`, `area_groups`), plus TreeSupportCommon's **84 config references**. Header size:
  Print.hpp 1376 + PrintBase.hpp 686 + Layer.hpp 354 = 2416 lines, on top of the config subsystem. **Porting config has the highest leverage**
  (breaking through once unlocks all three components at the same time).

**Stage 11** (porting the config subsystem — breaking the keystone gate stage 10 identified + a real WipeTower port):
- **The Config core + PrintConfig ported successfully** — `src/libslic3r/Config.cpp` (2122 lines), `PrintConfig.cpp` (12688 lines),
  `PrintConfig.hpp` (2429 lines) and `MaterialType.cpp` were ported **unmodified** into `arachne_port/config/libslic3r/`, and they
  **compile, link and run** under emscripten. Inside WASM the global `print_config_def` is constructed and `FullPrintConfig`
  instantiates correctly. Isolation: the config sources take the override headers in their own directory (the real PrintConfig.hpp + stubs) through `""`
  relative includes, falling back to `arachne_port/libslic3r` (the real thing) for geometry -> **the main slicer_core.js build keeps the stub
  PrintConfig.hpp** (no regression across the 120 invariants). Reproduce with `arachne_port/config_link_test.sh`.
  - **Verification (embind, node)**: `print_config_def` holds **817 options** (the measured value — for the difference from the regex's 907, see the config-schema section),
    and `FullPrintConfig` has **667 keys**. All spot checks pass: `layer_height`=0.2, `seam_position`=aligned,
    `sparse_infill_pattern` with 26 enum values, `wall_loops`=2. Reproduce with `arachne_port/config_probe_build.sh` +
    `node arachne_port/config_probe_test.mjs`(→ CONFIG PROBE OK).
  - **Stubs/replacements (upstream algorithms and definitions untouched, only the surroundings — each file records the reason at the top)**: `Preset.hpp` -> an empty stub
    with only the BBL_JSON_KEY_* and ORCA_JSON_KEY_* macros (Config.cpp uses no Preset symbols), `GCode/Thumbnails.hpp` ->
    ThumbnailData/boost::beast removed, keeping only `make_and_check_thumbnail_list`/`get_error_string`/ThumbnailError
    verbatim, `Utils.hpp` -> a config-specific override (is_gcode_file/is_json_file verbatim + a header_slic3r_generated
    stub), `boost/thread.hpp` -> an empty stub (PrintConfig.cpp includes it but uses no symbols, and emscripten cannot compile the real header without -pthread),
    and the cereal stubs extended (`specialize`/`specialization` added to `access.hpp` plus a new
    `types/polymorphic.hpp` making CEREAL_REGISTER_TYPE/RELATION no-ops — serialize is never called in WASM). **No source
    edits** (0 — everything was solved at the include/stub boundary). nlohmann/json exists in `deps_src`, and boost nowide/property_tree
    are header-only (the file I/O paths are never reached in WASM).
- **The schema cross-check = the build-based dump realized** (guide §11.1) — a function that dumps WASM's `print_config_def` to JSON
  (embind `dump_schema_json`) -> node generates `packages/data/config-schema-builddump.json` (817 entries) ->
  `web/compare_schema.mjs` compares the fields against the existing regex-based `config-schema.json` (907). **Result**:
  800 in common, **0 type mismatches** (the regex extracts types accurately), and all 54 default mismatches are representational/extraction artifacts
  (bool `false` vs `"0"`, C escaping in strings, empty-vector defaults for per-extruder `coEnums`, nullable `nil`; the one
  real extraction bug, `has_scarf_joint_seam`, is corrected to `0` by the build), plus 2 enum mismatches (`filament_type`, where the build enumerates all 75 values
  through the ported `MaterialType::all()` while the static regex found 0, and `support_interface_bottom_layers`).
  The 107 regex-only entries are the separate `CLIActionsConfigDef`/`CLITransformConfigDef`/`CLIMiscConfigDef` (the cli_*_config_def
  globals) and placeholder-parser runtime variables (which the regex misclassified as print_config_def); the 17 build-only entries are the loop-generated `filament_*`
  retraction overrides (which the regex missed). The arithmetic checks out: 800+107=907 (regex), 800+17=817 (build).
- **The real WipeTower port succeeded** (clearing the stage-10 gate) — `GCode/WipeTower.{cpp,hpp}` (4834+650 lines) **compiles, links and runs
  on top of the real PrintConfig**. WipeTower accesses `config.<option>.value/.get_at()` members directly -> it needs the real StaticPrintConfig
  (which the config keystone unlocked). GCodeProcessor.hpp was reduced to a **lightweight stub** (only ETags, the Reserved_Tags/
  _compatible tables, reserved_tag(), Nozzle_Change_*_Tag and s_IsBBLPrinter, verbatim — everything WipeTower uses),
  and TriangleMesh/Triangulation became **mesh-path-only stubs** (the rib tower/brim mesh generators its_make_rib_* and Triangulation::
  triangulate are called only from Print.cpp and are separate from the wipe tower G-code path -> a minimal indexed_triangle_set definition compiles,
  with no real rib mesh generated). `ExtrusionEntity::role_to_string` and LocalesUtils's `float_to_string_decimal_point` are
  provided verbatim through single-function extraction / a unity include wrapper (avoiding the whole TU's Flow::bridging_flow/PCH dependency).
  - **Verification (node)**: build a 2-extruder MM PrintConfig -> create a `WipeTower` (width=60, pos=15,15) -> `set_extruder` x2
    + `plan_toolchange(0->1)` + `generate()` -> **the upstream tool change markers are emitted**: `; CP TOOLCHANGE START`,
    `; toolchange #1`·`; material : PLA -> PLA`·`; WIPE_TOWER_START`·`; FEATURE: Prime tower`·
    `; LAYER_HEIGHT: 0.200000` plus real G1 extrusions (with E values). Reproduce with `arachne_port/wipetower_probe.sh` (STEP1 compile ->
    STEP2 link + run under node).
  - **Remaining gate (recorded honestly)**: the above is an **isolated verification** (proof that the real WipeTower produces real tool change G-code with the real
    PrintConfig). Kernel integration (replacing the stage-6 square-ring prime tower behind a `wipe_tower_real` flag) is not done — the kernel's
    slicer_core.cpp uses a plain parameter struct, so enabling WipeTower requires **merging the real PrintConfig subsystem into
    the main build** (today the stub and real PrintConfig.hpp cannot coexist), which is a separate milestone with a high regression risk against the 120
    invariants. The rib tower/brim 3D meshes (TriangleMesh) are also not generated (stubbed).
- **Simultaneous unlock confirmed**: stage 10 predicted that "porting config has the highest leverage (breaking through once unlocks full GCodeProcessor, WipeTower and
  full TreeSupport at the same time)" -> **WipeTower was demonstrably unlocked**. Full GCodeProcessor and
  full TreeSupport can now also be attempted on the same config (the next stage).

**Stage 12** (merging the real config into the main build + wiring WipeTower into the kernel + measuring the GCodeProcessor gate):
- **The real config subsystem merged into the main slicer_core.js** — going beyond stage 11's isolated verification, **the main module now builds and runs
  on the real config**. `config_bridge.{h,cpp}` (isolated exactly like arachne_bridge — the kernel includes only plain-type headers,
  and the real PrintConfig/Slic3r types stay inside the .cpp) links `Config.cpp` + `PrintConfig.cpp` + `MaterialType.cpp` into the main
  build. **Conflict resolution: coexistence** (isolation instead of removing the stub) — Arachne/Fill/PE keep using `../PrintConfig.hpp` (the stub, whose InfillPattern
  and other enums are verbatim identical -> ODR-safe), while only the config TUs pick up the real PrintConfig.hpp through `""` relative includes.
  No compiled TU in the main build includes boost/thread (measured) -> the empty boost/thread stub in config/stubs is harmless.
  Exposed through embind as `config_option_count()`/`config_option_default(key)` (preventing dead-stripping and enabling verification).
  - **Verification (node)**: `config_option_count()` = **817** (the real print_config_def is live in the main module), `layer_height`=0.2,
    `seam_position`=aligned. **All 120 invariants pass under `node test.mjs`** (the existing slicing path and defaults are unchanged). Module size
    grew 1.03MB -> 2.19MB (the real config + WipeTower link).
- **Wiring `wipe_tower_real`** (false by default) — on an in-layer tool change in the MM path, the output of the **real ported
  WipeTower.generate()** is used instead of the stage-6 square ring. `config_bridge::wipe_tower_block()` builds the real PrintConfig -> drives WipeTower
  (set_extruder x2 -> plan_toolchange -> generate) -> converts the tool change block into bed coordinates (tower local -> + the tower position,
  keeping relative E -> compatible with the kernel's M83) -> the kernel splices it in, adds type=11 toolpaths and accumulates filament. The PlaceholderParser tokens
  (`[filament_*_gcode]`) are commented out because the mini kernel has no parser (documented).
  - **Verification (node)**: false (default) -> the old square ring exactly as before (`; prime tower (basic`, no WipeTower markers, 696 type11 segments).
    true -> **the upstream markers `; CP TOOLCHANGE START` and `; WIPE_TOWER_START` plus the tool change E/F sequence are present**, with 6206 type11 segments for the real
    prime tower and the tower at X10..40 Y10..29.5 (on the bed, over_bed=false). No regression across the 120 invariants (default false).
  - **Viewer**: a `real wipe tower (wipe_tower_real)` toggle was added to the Slice panel (injected in MM mode). Browser smoke test (cube T1 +
    cylinder T2, toggle ON) -> sliced 99 layers / 9699 segments successfully with the prime tower rendered and **0 console errors** (excluding a favicon 404).
    Screenshot: `wasm-core/screenshots/stage12_wipe_tower_real.png`.
- **Retrying the full GCodeProcessor -> the config gate is confirmed cleared and the remaining gates measured** (the body is unfinished; per file and symbol):
  The gate stage 10 identified (`calib.hpp` -> the real PrintConfig) was **cleared by the stage-12 config merge**. What remains to port (measured with a compile
  probe): (1) 3 unported .cpp files — `GCodeReader.cpp` (358L), `CustomGCode.cpp` (76L) and `MultiNozzleUtils.cpp` (970L),
  (2) `Geometry/ArcWelder.{cpp,hpp}`, (3) stubs — `boost::nowide` (7 file I/O sites) and `boost::filesystem/path`,
  `Print.hpp` (just 2 symbols: `m_print->print_statistics().total_wipe_tower_filament` @1050 and `active_step_add_warning`
  @1371 — the full pipeline is unnecessary and a minimal Print stub suffices), (4) the ExtrusionEntity.hpp transitive tree (needing deps_src/semver).
  At 7561 lines in a single TU with multiple compile waves, finishing it cleanly within the remaining budget was judged impossible, so **it is recorded as a gate instead**
  (on success the time estimate would be promoted from the `gcode_time` transcription to the upstream body — the transcription is preserved as `time_engine=transcribed`).
- **(Stretch) The kernel accepting real DynamicPrintConfig keys directly** — an explicitly "if there is time" item; the stage-12 budget went to items 1-3, so it
  **was not started**. The current settings.js schema key -> kernel parameter mapping stays (backwards compatible).

**Stage 13** (the final porting round — finishing the full GCodeProcessor + the last TreeSupport gate):
- **The full GCodeProcessor body ported successfully** — `GCode/GCodeProcessor.cpp` (7561 lines) + `GCodeReader.cpp` (358),
  `MultiNozzleUtils.cpp`(970)·`Geometry/ArcWelder.{cpp,hpp}`·`ElegooGCodeProcessorHelper.cpp`(190, process_elegoo_M6211)
  were ported unmodified and **compile, link and run** under WASM. It became possible because the stage-12 config merge cleared the gate (calib.hpp -> the real PrintConfig).
  `gcodeproc_bridge.{h,cpp}` is the kernel <-> GCodeProcessor boundary (apply_config -> process_buffer -> finalize -> extracting the
  GCodeProcessorResult). **The time estimation engine was promoted**: the `time_engine` parameter — `full` (the new default) = the real GCodeProcessor
  body, `transcribed` = the stage-10 `gcode_time` transcription, kept around.
  - **Stubs/replacements (upstream unmodified; reasons at the top of each file)**: `Print.hpp` -> a 2-symbol stub (print_statistics().total_wipe_tower_filament +
    active_step_add_warning; GCodeProcessor has no PrintObject coupling) plus transitive includes (unordered_set/map, BoundingBox,
    the EnforcerBlockerType enum verbatim, get_hrc_by_nozzle_type), `boost::nowide` -> std aliases, `boost::filesystem/path` ->
    an empty stub (file I/O is never reached), `Utils.hpp` -> unified into a single canonical version (FilePtr/get_time_dhms/short_time/format_diameter_to_str/
    rename_file/is_gcode_file verbatim; the config override becomes a forwarder), `GCodeWriter` -> the 2 static functions set_temperature and
    supports_separate_travel_acceleration added verbatim, the 6 `PrintStatistics` masks verbatim, `ExtrusionEntity::
    string_to_role` extracted as a single function, `ProjectTask.hpp` -> only FilamentInfo (avoiding boost::filesystem). **PrintConfig unified**:
    the stub PrintConfig.hpp became a forwarder to the real header (calib/MultiNozzle hit a same-directory stub vs real conflict -> the coordinator approved
    "unify the include path"; the main rebuild was confirmed green across 120).
  - **Verification (node, all 120 invariants pass — on the new engine)**: (1) parsing with a total time > 0 (cube 808.2s) (2) faster -> less (30mm/s
    946s > 120mm/s 766s) (3) **an 8.5% deviation from the transcription** (full 1406.6s vs transcribed 1296.6s — full is the upstream ground truth;
    the difference comes from the trapezoidal planner's accel/jerk/look-ahead) (4) **filament within ±2% of the kernel** (570.8 vs 570.8, 0.00% — the bridge parses relative
    E directly; GCodeProcessor's move sum is inflated by the actual-speed render sub-moves it inserts, and its volume sum is based on geometric width/height
    so it disagrees with the real E -> direct parsing verifies E integrity) (5) per-layer times (grouped by position.z, 51/101 layers). Even with the default
    changed (full), all 7 existing stage-10 invariants pass on the new engine -> no re-baselining needed.
  - **Gaps (honest)**: per-role times are only broken down with pe_lite=false (tag mode) — by default everything is aggregated under role 0 = erNone; layer detection
    groups by position.z (in the bridge) because the kernel emits "; LAYER" instead of the reserved CHANGE_LAYER tag; and because of the actual-speed render sub-moves,
    summing filament/time per move directly is inaccurate (the totals use the authoritative modes[Normal].time).
- **The final full TreeSupport attempt -> the structural gate recorded for good** (the config gate was cleared in stage 12, but the structural gate remains):
  - **Partial success (retained)**: the MST branch placement core (`MinimumSpanningTree`) was ported and driven in stage 9 (tree_bridge: 9 points -> 8 edges,
    acyclic, 74.06mm). That is the branch placement path the coordinator "partially allowed".
  - **The final gate (per file and symbol)**: `Support/TreeSupport.cpp` (3786) + `TreeSupport3D.cpp` (4198) + `TreeModelVolumes.cpp`
    (886) + `SupportCommon.cpp` (2033) are fundamentally coupled to the **PrintObject/Layer/SupportLayer object graph** — not to config:
    TreeSupport.cpp measures at **121 `m_object->` uses, 52 `lower_layer`, 39 `lslices` and 36 `SupportLayer`** (a PrintObject-driven
    algorithm operating on the real per-layer slice geometry). Even `TreeModelVolumes` (avoidance) has a constructor requiring
    `(const PrintObject&, const BuildVolume&)` plus 44 tbb:: uses. Additional non-config dependencies: **tbb concurrent containers**
    (concurrent_vector/unordered_set, absent from brew -> sequential stubs needed) and **libnest2d** (arrangement, deps_src). -> Porting it would require
    **rebuilding the slicing pipeline's object model (PrintObject/Layer/SupportLayer plus the real per-layer lslices/lower_layer slice
    state and BuildVolume)** and injecting the kernel's slice geometry = a pipeline reimplementation beyond a stub layer. Real support stays on
    tree_lite (the stage-5 morphological taper). **This is the final chapter of the full porting roadmap.**
- **(Stretch) The kernel accepting real DynamicPrintConfig keys directly** — carried over from stage 12; the stage-13 budget went to items 1-2, so it was not started.

**Stage 14** (minimizing the permanent exceptions — the 2 untried lines of attack):
- **The real CGAL planarity check ported successfully** (an exception removed) — exploiting the fact that CGAL 6.2 is header-only and works without GMP/MPFR through the
  Boost.Multiprecision backend. `brew install cgal` (headers only) -> the `VoronoiUtilsCgal.cpp` that was stubbed in stage 7 was restored (upstream) and
  linked into the main build. `is_voronoi_diagram_planar_angle` (the actual recovery path in Voronoi.cpp) really runs. **Verification**: no regression across the 120
  (arachne walls uniformly 0.42, variable width unchanged), and `cgal_planar_check_count` exposed through embind shows 99 calls after slicing an arachne cube
  (once per layer), proving real invocation. **Stubs/replacements (recorded)**: (1) `arachne_port/cgal_stubs/boost/config/platform/wasm.hpp`
  = boost's original with only `#define BOOST_NO_FENV_H` removed (emscripten provides fenv.h -> the Boost.Interval c99 rounding path is
  enabled) (2) `-DCGAL_DISABLE_ROUNDING_MATH_CHECK` (wasm cannot control the FP rounding mode -> avoiding CGAL's interval startup self-check
  abort). ⚠ **An honest limitation**: with no rounding control in wasm the interval filter is double precision (non-conservative) -> near-zero cases fall back to exact
  MP_Float (accurate) and only extremely rare near-degenerate cases could be misjudged. It is not the desktop's exact guarantee, but it is a real check compared with
  the "always planar" stub. Reproduce with `arachne_port/cgal_probe.sh`.
- **The full TreeSupport adapter — the foundation compiles, with the final gate documented in more depth**: stage 13's "PrintObject object graph
  coupling" was approached again through an adapter. **Result**: the adapter foundation (`Layer.hpp`/`SupportLayer`/`LayerRegion`) **compiles** on the ported
  deps plus `FlowRole` (an enum added to the Flow stub) (reproduce with `arachne_port/layer_probe.sh`) — two layers deeper than stage 13.
  `SupportCommon.hpp` is lightweight (libslic3r + Polygon). **Remaining gates (concrete and final)**: (1) the `Print.hpp`
  PrintObject facade — of its 19 methods, the **mesh operations** (`slice_support_enforcers/blockers`, `project_and_append_custom_facets`,
  `remove_bridges_from_contacts`) need the model's 3D mesh plus support painting (the kernel only has 2D lslices -> they can be stubbed, but
  manual support painting would be lost) (2) `TreeSupport3D.cpp` (4198L, the actual organic generation — TreeSupport.cpp delegates to `generate_tree_support_3D`)
  + `TreeModelVolumes.cpp` (886L, avoidance — the constructor requires `PrintObject&` + `BuildVolume&`) + `SupportCommon.cpp`
  (2033L) (3) tbb concurrent containers -> sequential replacements (4) libnest2d -> a stub. **Conclusion**: the gate is not a single hard blocker but the sheer **volume**
  of ~7000 lines of support body plus the facade plus tbb/libnest2d — the adapter is possible in principle (the foundation proves it) but cannot be finished cleanly
  within the remaining budget. Real support stays on tree_lite. "Why even an adapter does not fit the remaining budget" is the final document on this gate.

**Stage 15** (the last exception = attempting the full TreeSupport adapter port -> recording the final chapter's gate):
- **Infrastructure built**: (1) the `Print.hpp` **facade** (19 PrintObject methods + Print + ModelObject + PrintRegion +
  PrintInstances; the 3 mesh operations are documented empty stubs — the kernel has no 3D model mesh or support painting data) ->
  preserved at `arachne_port/treesupport_inc/libslic3r/Print.hpp` (2) a complete set of **tbb concurrent -> sequential stubs** (blocked_range,
  parallel_for/_each·concurrent_vector/_unordered_set·spin_mutex·task_group·task_arena·enumerable_thread_specific
  plus an oneapi/tbb forwarder) -> `arachne_port/treesupport_stubs/` (3) a copy of `Format/STL.hpp` (resolving the real TriangleMesh.hpp)
  (4) the real `Flow.hpp` (kept in treesupport_inc) (5) the 4 body .cpp files + 7 tree headers -> `arachne_port/libslic3r/Support/`
  (6) the probes `treesupport_probe.sh`, `layer_probe.sh` and `print_probe.sh`.
- **OpenVDB avoidance confirmed**: `TREE_SUPPORT_ORGANIC_NUDGE_NEW 1` is defined in TreeSupport3D.cpp:44 itself -> the OpenVDB
  `organic_smooth_branches` variant is dead code and the new AABB-tree nudge (real, no OpenVDB linkage) is used. **The OpenVDB exception is gone.**
- **Compilation progress (SupportCommon.cpp — the base file, wave by wave)**: missing `Format/STL` -> copied; `oneapi/tbb/*` -> forwarders;
  `SupportParameters.hpp` needs the real Flow (the free functions bridging_flow/with_flow_ratio/scaled_spacing/nozzle_diameter/support_material_flow)
  + a **PrintRegion facade** (config() -> PrintRegionConfig and flow(PrintObject, FlowRole, height) -> Flow) +
  PrintObject::num_printing_regions/printing_region/object_extruders.
- **The final gate (concrete, by symbol)**: `SupportParameters.hpp` (config-derived per-region flow parameters) — reached after the real Flow and the facade,
  it requires wiring the **PrintRegion facade's per-region flow calculation** into the PrintObject facade. That is the point inside the first header of the first
  body file (the base).
- **Remaining size**: SupportCommon (2033) + TreeModelVolumes (886) + TreeSupport3D (4198) + TreeSupport (3786) = **10903 lines** across many
  compile waves, plus finishing the PrintRegion facade, a libnest2d EdgeCache stub, kernel integration (the adapter filling the Layer/
  SupportLayer graph from the kernel's lslices -> overhangs/organic -> type5 toolpaths) and verification.
- **Key structural insight (the isolation conflict)**: the tree .cpp files use `"../Flow.hpp"`/`"../Print.hpp"` (parent-relative) includes -> they resolve against the **shared
  arachne_port/libslic3r headers**. So treesupport's real-Flow + facade-Print overrides cannot be isolated in the main build with `-I` alone (relative includes ignore -I).
  Finishing would need either (a) an in-place swap of the shared headers (breaking the main build's expectation of the stub Flow -> risking the 120
  invariants) or (b) duplicating the whole header tree (an isolated dir). We reached the foundation (Layer.hpp compiling, the facade built), but this
  isolation conflict plus 10903 lines of volume prevented finishing within budget while keeping the main build regression-free. **To keep the main build clean, the shared Flow.hpp/Print.hpp were
  restored to their stage-14 state (120 re-confirmed green).** Real support stays on tree_lite. **The single exception (full TreeSupport) is documented at maximum depth.**

**Stage 16** (executing the root fix stage 15 recorded -> full organic TreeSupport **compiles, links, runs and produces real toolpaths**, standalone):
- **The isolation conflict resolved (executing stage 15's option (b))**: the whole libslic3r header tree was duplicated into `treesupport_port/` (cp -R) so the tree .cpp files'
  `"../Flow.hpp"`/`"../Print.hpp"` (parent-relative) includes resolve to the **port-local real Flow + facade Print**. The relative-include problem that ignores `-I`
  (stage 15's gate) disappears entirely. **The main build's arachne_port shared headers and build.sh are untouched**; all the work stays in the isolated dir.
- **The compile waves completed**: all 4 bodies — SupportCommon (2033) + TreeModelVolumes (886) + TreeSupport3D (4198) + TreeSupport (3786) = **10903 lines** —
  compile. The PrintObject/Print/PrintRegion/ModelObject **facade is complete** (per-region flow transcribed from the real PrintRegion.cpp:25,
  `shared_regions() -> all_regions` (FillLightning), and the `support_fills` metric).
- **Linking completed (with real deps)**: TriangleMesh (+ an **inline header-only stub for `libqhullcpp`** — its_convex_hull_3d is never reached on the tree path),
  TriangleMeshSlicer, Geometry (ConvexHull/Circle/Voronoi/VoronoiUtils + the **real CGAL `VoronoiUtilsCgal`** = reusing the stage-14 cgal_stubs
  with `-DCGAL_DISABLE_ROUNDING_MATH_CHECK`), Fill/Lightning/*, **full Arachne** (WallToolPaths + SkeletalTrapezoidation +
  BeadingStrategy) and the Fill patterns (+ restoring the `FillSupportBase`/`FillRectilinear` cases in new_from_type).
- **Stubs/adapters (all inside `treesupport_port/`, documented)**: `GCode/GCodeProcessor.hpp` (only BuildVolume::all_paths_inside is referenced and the tree does not use it
  -> a minimal GCodeProcessorResult), `CutUtils.hpp` (a dead include in TriangleMesh.cpp -> an empty stub, cutting off the Model.hpp graph),
  `Semver.hpp` (boost-free — removing a boost/optional filesystem flake in em++'s large TUs; unused by the tree link set), `boost/thread/
  {mutex,lock_guard}` (-> std, single threaded), `tbb/blocked_range2d`, the `boost/format` umbrella in `libslic3r.h`, an inline `scalable_allocator` alias in
  `Point/SupportLayer.hpp` (removing a deep-path filesystem flake) and restoring the clipper include in `SVG.hpp` (for TreeNode.cpp's ClipperLib path).
- **The adapter driver** (`test_treesupport.cpp`): an overhang model (a 10x10 leg over 20 layers + a 30x30 top plate over 10 layers) -> `TreeSupport::generate()`
  (`smsTreeOrganic` + `stTreeAuto`) -> `generate_tree_support_3D` -> **20 support layers and 123 real extrusion toolpaths (type5)**
  (`SupportLayer::support_fills`). Runtime wiring: registering `print.m_objects`, `stTreeAuto` (support_auto), a no-op `throw_on_cancel`,
  `FillSupportBase/Rectilinear` and `-DNDEBUG` (release parity — the strict geometry asserts are compiled out in production).
- **Verification**: **PASS** (20 layers / 123 toolpaths) + **determinism** (two runs identical) + **no regression across the 120** (`node test.mjs` ALL PASSED — the main
  build.sh does not reference treesupport_port and the shared sources are unmodified). Reproduce with `arachne_port/treesupport_link_test.sh`.
- **Remaining (a separate wave)**: kernel integration = `treesupport_bridge.cpp` (the kernel lslices <-> TreeSupport boundary, following the arachne_bridge pattern) +
  merging it into build.sh + wiring slicer_core (`support_style=tree` -> real organic -> slicer_core.js). The isolation success **unlocked** it, but
  the ODR boundary (treesupport_port's own PrintConfig/Flow versions vs the main arachne_port ones) needs design — that is exactly the contamination risk stage 15 warned about,
  so it must be isolated behind the bridge before integration. The browser smoke test and screenshots come after that integration.

**Stage 17** (attempting main-build integration -> hitting the ODR boundary wall; measuring the conflict, recording the fix, and closing with stage 16's standalone as the final state):
- **What was completed**: (1) `treesupport_bridge.{h,cpp}` (the arachne_bridge pattern — only plain types are exposed to the kernel, and the port types are isolated in
  `treesupport_port/libslic3r/treesupport_bridge_impl.cpp`, with the facade resolved through file-relative includes). Kernel
  lslices (mm) -> the facade PrintObject graph -> `TreeSupport::generate()` -> `SupportLayer::support_fills` -> plain polylines.
  (2) slicer_core wiring (a `support_style=tree` branch emitting `L[].supTree` as type5; tree_lite/grid preserved). (3) a 2-phase build in build.sh
  (compiling the tree-specific sources into isolated relocatable objects -> joining the main link).
- **ODR measured under the shared-symbol approach**: only the tree-specific sources are compiled separately while shared symbols come from the main build. The header ABI was measured identical
  (PrintConfig.hpp/Polygon.hpp identical; Point.hpp differs only in a scalable_allocator alias and both resolve to std::allocator).
  **2 conflicting symbols** = `ExtrusionEntity::role_to_string`/`string_to_role` (the main build already provides them through single-function extraction in role_to_string.cpp + extrusion_role_helper.cpp)
  -> guarded in the port copy with `-DTS_BRIDGE_EXCLUDE_ROLE_FNS`. **Result: an ODR-clean link plus
  `node test.mjs` green across 120** (slicer_core.js 2.49MB -> 3.27MB).
- **The runtime wall (root cause)**: slicing with `support_style=tree` crashed. The cause is that the ported sources in the main build are **trimmed for the kernel**
  (e.g. `Fill::new_from_type` in `arachne_port/.../Fill/FillBase.cpp` returns **nullptr** for `ipSupportBase`/
  `ipRectilinear` because of the STAGE-8 trim; `fill_surface` and gap fill are stubbed too). With shared linking the tree pipeline inherits that trimmed behavior
  and dereferences a null filler -> "null function/signature mismatch". In other words **sharing = trim contamination**.
- **Attempting full isolation -> a toolchain wall**: compiling the tree group standalone from its own complete sources (`-fvisibility=hidden`) and then demoting every symbol
  except the bridge entry points to LOCAL. But **the emscripten wasm toolchain does not support symbol localization**: `llvm-objcopy` on
  wasm offers "only flags for section dumping, removal, and addition" (no symbol operations), `wasm-ld` has no `--version-script` or
  `--localize`, and `-fvisibility=hidden` only changes visibility while keeping STB_GLOBAL binding -> duplicate definition link errors. A fully isolated
  co-link is impossible.
- **Remaining (a follow-up wave, pick one)**: (a) **additively untrim** the main build's `FillBase.cpp` new_from_type (adding the ipSupportBase/Rectilinear
  cases — the kernel does not use this factory so the 120 are unaffected, though it changes a main-build source) and link FillRectilinear/FillSupportBase,
  or (b) **redirect the Fill factory locally in the tree group** (defining `ts_new_from_type` and editing ~10 call sites in SupportCommon.cpp/TreeSupport.cpp
  — modifying the port sources, requiring both to be compiled to keep standalone working), or (c) **SIDE_MODULE** dynamic linking
  (redesigning the SINGLE_FILE loading model). Each has trade-offs -> the coordinator must decide.
- **Closing state**: to avoid breaking the main build's green 120, the integration wiring was **rolled back** (slicer_core.js restored to 2.49MB, `node test.mjs` ALL
  PASSED re-confirmed). The bridge artifacts (`treesupport_bridge.{h,cpp}`, `ts_verify.mjs`) are kept for the follow-up wave. **The verified final state of the real organic
  TreeSupport = stage 16's standalone** (`arachne_port/treesupport_link_test.sh`: 20 layers / 123 type5 toolpaths,
  deterministic). The viewer's default support stays tree_lite.

**Stage 18** (option (a) approved — additively untrimming the FillBase factory -> real organic TreeSupport **integrated into the main build**, closing out at 0 exceptions):
- **Additive untrim (golden guarded)**: the `ipSupportBase -> FillSupportBase` / `ipRectilinear -> FillRectilinear` cases dropped by the STAGE-8 trim were
  **restored to their upstream state** in `arachne_port/.../Fill/FillBase.cpp::new_from_type` (marked with a STAGE-18 UNTRIM comment), and
  `FillRectilinear.cpp` was added to the main FILL_SRC. **A golden byte diff of 0 proves it**: the G-code for the cube and the overhang table (default + grid support)
  is **completely identical** before and after the untrim (523951B) -> hard evidence that the kernel's default path never calls these factory cases (`golden.mjs`).
- **Integration re-applied (shared-symbol)**: only the tree-specific sources are compiled into isolated relocatable objects (with the role_fns guard, and FillRectilinear
  excluded from the tree group since the main build provides it) -> joined into the main link. slicer_core.cpp is wired (`support_style=tree` -> the bridge -> `L[].supTree`
  emitted as type5; grid/tree_lite preserved). **An ODR-clean link plus the tree path receiving real fillers resolves stage 17's null deref** (no trim cascade —
  fill_surface resolves through the real FillRectilinear/SupportBase overrides).
- **Full verification set passed**: (1) `support_style=tree` on the overhang table -> **8662 type5 segments** (vs 511 for tree_lite) (2) tree vs tree_lite have
  **different per-layer distributions** (organic branches) (3) **determinism** (two runs produce identical G-code) (4) **no regression across the 120 + a golden byte diff of 0** (5) **the browser**
  (vite preview): slicing the overhang table **renders organic tree support** (69 layers / 11208 segments, with the support branches visible —
  `wasm-core/stage18_tree_support.png`) and **0 functional console errors** (only a favicon.ico 404, unrelated to slicing/WASM). Reproduce with
  `wasm-core/ts_verify.mjs` (standalone style), `golden.mjs` and the viewer's `npm run build && npm run preview`.
- **Viewer mapping**: `viewer/src/settings.js` — the organic/tree family maps to the kernel's `'tree'` (real organic) and everything else to grid.
- **Bottom line: the real organic TreeSupport exception is gone.** With `support_style=tree` (organic/tree_slim/strong/hybrid) the kernel emits real
  `generate_tree_support_3D` branch toolpaths (type5) into slicer_core.js. The default (grid) and tree_lite are preserved.

**Stage 19** (picking off the remaining precision caveats — a priority ladder of 4):
- **(1) Per-path support extrusion width**: the bridge passes `ExtrusionPath::width` along with the polyline, and the kernel applies `set_e_per_mm_width` (for E) and
  `g_seg_w_cur` (the ribbon width) per path through `emit_lines_variable_width`. Check: changing the `support_line_width` config from
  0.4 (default) to 0.6 makes the emitted support width follow exactly (0.4 -> 0.6), proving the per-path width reaches E and widths[].
  (Note: in this port `support_material_flow`/`interface_flow` share the width key -> the interface and body having the same width is a fact of the port model,
  not a wiring defect.)
- **(2) Support z alignment**: the cause was that the bridge left `slicing_params.first_object_layer_height` unset (-> 0), so `layer_z()` computed the
  support z as `idx*lh` (while objects use `(idx+1)*lh`), off by one layer (0.2mm). Setting `first_object_layer_height=lh` synchronizes
  the support z with the object z grid (equivalent to the desktop's independent_support_layer_height=off). Check: the G-code diagnostic
  `; tree_support ... z_resid_max` is now **0mm** (previously 0.2mm).
- **(3) Promoting the CGAL planarity check to exact predicates**: because wasm has no directed rounding, the interval filter (FK=`Interval_nt_advanced`) risked being
  inaccurate -> the `Filtered_predicate` filter stage in `VoronoiUtilsCgal.cpp` (the main `arachne_port` plus the port copy) was replaced by exact
  predicates (EK=`Simple_cartesian<MP_Float>`, C2E), skipping the interval stage and always evaluating exactly. Checks: no regression across the 120 (Arachne included) +
  a golden byte diff of 0 (for simple shapes exact == interval) + the check counter unchanged (`cgal_planar_check_count`=792) + perf on a
  cube slice 18.6ms -> 17.5ms (no regression, well under 2x). Running once per layer keeps the cost acceptable.
- **(4) Manual support painting — TriangleSelector ported and linked (this round's goal)**: the real `TriangleSelector.{cpp,hpp}`
  (2527L) was ported. `Model.hpp` was a dead include (EnforcerBlockerType is defined in the .hpp itself and no Model symbols are used) -> removed,
  leaving only a direct `Geometry.hpp` include. Standalone link + run (`arachne_port/selector_link_test.sh`): painting an ENFORCER patch on a cube's top face with a Sphere
  cursor -> `get_facets(ENFORCER)` = 4016 facets (triangle splitting), blocker = 0, **PASS**. **Remaining size measured
  (follow-up)**: (viewer) selecting a triangle/hit point with the three.js Raycaster -> a brush radius and enforcer/blocker toggle UI +
  selector_bridge (paint/get_facets em::bindings); (facade) replacing the `slice_support_enforcers/blockers` stubs with a real implementation that projects the enforcer/blocker
  its onto each layer's z with `slice_mesh` (the largest piece) -> TreeSupport3D's `generate_overhangs` already consumes it. Size: viewer brush medium + bridge small + facade projection medium. Kernel wiring is a call for the next wave.
  already consumes it. Size: viewer brush medium + bridge small + facade projection medium. Kernel wiring is a call for the next wave.
- **Verification**: no regression across the 120 + a **golden byte diff of 0** + the tree width/z checks passing + organic tree rendering in the browser
  (`wasm-core/stage19_tree_support.png`, 69 layers / 11127 segments, 0 functional console errors). Reproduce with `wasm-core/ts_verify.mjs` and
  `golden.mjs`·`perf.mjs`·`arachne_port/selector_link_test.sh`.

**Stage 20** (the last caveat — assembling manual support painting -> all 4 caveats closed, "parity + 0 documented remainder"):
- **① selector_bridge** (`selector_bridge.{h,cpp}` + `treesupport_port/libslic3r/selector_bridge_impl.cpp`):
  embind `selector_prepare/paint/clear/facet_count/painted_count/overlay`. The state (painted facets) persists in the worker Module
  (slicing uses the same Module). The kernel's `selector_prepare` builds the mesh with the same transform as slice (XY centered, minZ=0) plus **welding** (using an exact tuple
  key — an XOR hash destroyed the topology through collisions, fixed after measuring) -> the viewer's raycast faceIndex == the selector facet.
- **(2) Viewer brush UI** (`Viewport.jsx` + `slicer.worker.js`): a "manual support painting" toggle (enforcer/blocker + a brush
  radius slider + clear), painting with a SPHERE cursor by dragging over the model (raycast faceIndex + hit point -> viewer (Y-up) -> STL -> kernel
  transform -> the worker), with a translucent overlay in blue for enforcer and red for blocker.
- **(3) Facade wiring**: the `slice_support_enforcers/blockers` stubs became a projection of the painted enforcer/blocker its onto each layer's z
  (`custom_facet_project.hpp`: the triangle XY footprint, with orientation decided by a double cross product — avoiding coord_t area overflow on large facets).
  `slice_mesh_slabs` returns nothing for isolated patches, so it was replaced. -> `generate_overhangs` consumes it (tree) and the grid path honors it too
  (enforcer = overhangs added, blocker = overhangs subtracted).
- **(4) Grid support**: the grid/tree_lite paths apply enforcer/blocker through the same footprint.
- **Physical verification (PASS)**: `wasm-core/test_paint.mjs` — **tree**: enforcer (manual mode) 0 -> 10496, blocker 8581 -> 44 (suppressed,
  the rest kept); **grid**: enforcer 0 -> 612, blocker 558 -> 508; both deterministic (identical g-code twice). A `support_auto`
  flag was added to the kernel (false = manual, painted enforcers only) — for physically verifying enforcers (upstream tree enforcers only force real overhang areas).
- **Browser (vite preview)**: load the overhang table -> paint a blocker (the cap underside, 5783 facets, red overlay —
  `wasm-core/stage20_paint_blocker.png`) -> slicing suppresses support on the painted half while keeping the rest (9880 -> 7615 segments,
  `wasm-core/stage20_blocker_result.png`), with 0 functional console errors (only a favicon 404). This demonstrates the interactive brush, overlay and worker
  pipeline (the effect screenshot drives the selector_paint API with controlled coordinates — the same path the brush uses).
- **Bottom line**: **all 4 caveats (width / z / CGAL / painting) are closed.** The default path keeps a golden byte diff of 0 and no regression across the 120 (completely unchanged when painting
  is unused). Reproduce with `wasm-core/test_paint.mjs` and `arachne_port/selector_link_test.sh`.

**Stage 21** (a user bug report, "the rendering does not reflect width information" -> fixing the per-feature width mapping gap):
- **Root cause (coordinator diagnosis)**: settings.js mapped only the single `line_width` key -> the panel's per-feature widths (outer_wall/
  inner_wall/top_surface/sparse_infill/internal_solid_infill/initial_layer) never reached the kernel -> a uniform ribbon. On top of that, widths[] was missing from the
  MM path and raft export -> those paths fell back to uniform.
- **(1) Per-feature width parameters**: 6 widths added to the kernel Params + mapped in settings.js (the original string "120%" is passed through verbatim).
- **(2) 0 = derive automatically**: quoting the upstream `Flow::auto_extrusion_width` formula (src/libslic3r/Flow.cpp:21) — top-surface/support
  = nozzle, everything else = 1.125*nozzle. Resolution order: value>0 -> as-is · 0 -> line_width (>0) · line_width also 0 -> auto.
  coFloatOrPercent "120%" -> nozzle*1.2 (the ratio_over semantics). **Default behavior unchanged**: the viewer sends line_width=0.42 ->
  features at 0 -> 0.42 (the auto formula never fires) -> a golden byte diff of 0 (no re-baselining needed).
- **(3) Emission wiring**: each feature sets `set_e_per_mm_width` (E) and `g_seg_w_cur` (the ribbon) together at emission (the same pattern as the stage-19 support
  width). Outer wall = outer_wall, inner walls = inner_wall, solid = internal_solid, and the top surface is split out of solid only when the widths differ
  (-> no regression), sparse = sparse_infill, with initial_layer taking precedence on the first layer. Arachne walls keep their own variable width.
- **(4) Filling the widths export gap**: widths[] was added to the multi-material path (slice_multimaterial) and the raft rows.
- **Verification (PASS)**: `wasm-core/test_width.mjs` — outer wall 0.6 / inner wall 0.42 -> both 0.6 and 0.42 appear in widths[], plus filament
  1169.7 -> 1284.6mm (E reflects it); top_surface 0.6 applied; line_width:0 -> auto 0.45 (1.125*0.4); "150%" -> 0.6; MM widths[]
  present. **No regression across the 120 + a golden byte diff of 0**. Browser: slicing with the outer wall at 0.6 shows a visibly thicker outer wall when zoomed into the ribbon
  (`wasm-core/stage21_width_ribbon.png`), with 0 functional console errors. Stages 19/20 (tree/paint) re-confirmed regression-free.

**Stage 22** (user bug reports: "true-width rendering fails on large models -> it falls back to lines" and "make the width **an actual solid**" ->
promoting the toolpath to volumetric and recomputing the cap. **Rendering only — the kernel is unchanged**):
- **Root cause**: the ribbon up to stage 21 was (a) an **open** half ribbon with only a top and two sides, so it had no solidity, and (b)
  the automatic `MAX_RIBBON_SEG=100k` fallback was too conservative, so a realistic 177k-class model (199 layers / 177k segments) lost true-width rendering
  and raised a "falling back to line mode" warning.
- **(1) Volumetric beads** (`Viewport.jsx buildLayerRibbon`): each extrusion segment becomes a **closed box** of width w x height h
  (top, bottom and two sides, 4 faces x 2 triangles = 24 vertices). Extending the ends by w/2 makes adjacent beads overlap and hide the gaps at direction changes (end caps are omitted —
  keeping the vertex budget, avoiding over-engineering). Per-segment widths from `widths[]` are used as-is (honoring the stage-21 per-feature widths).
- **(2) Per-face normals + shading**: non-indexed geometry -> `computeVertexNormals` gives every triangle a face normal ->
  `MeshStandardMaterial{flatShading}` produces solid shading with bright tops and darker sides. The per-type colors are kept.
- **(3) The cap is a vertex memory budget** (not a segment count): 24 vertices per segment x 36B (position+color+normal, non-indexed
  Float32) = 864B. With a 900MB budget -> `MAX_RIBBON_SEG ≈ 1,092,266` (≈1.09M, about 11x the old 100k). Measured basis: a 329k-segment
  cylinder ≈ 284MB and a 489k-segment browser case ≈ 423MB — comfortable. The reported 177k model renders volumetrically with no fallback.
- **(4) Layer-chunked building** (non-blocking UI): models above 20k segments build 6 layers per chunk across `requestAnimationFrame`
  (a token cancels a previous build, output appears progressively, with a "building solid render X%" indicator). Small models still build synchronously in one frame (preserving the old behavior).
- **(5) The fallback stays, plus a manual override**: above the cap it uses line mode + a warning (showing the real segment count and the cap) plus a **"render solid anyway"**
  button that forces volumetric (respecting the user's choice). The cap is re-evaluated to a safe default on every new slice or file.
- **Verification (browser, PASS)**: (1) big_cyl.stl (`gen_big.mjs`, a 256-gon cylinder) sliced in the browser at **489,123 segments**
  -> fully volumetric with no fallback (`stage22_big_full.png`) plus rim shading when zoomed in (`stage22_big_zoom.png`).
  (2) A cube with a 0.6 outer wall vs a 0.42 inner wall -> the bead width difference is visible when zoomed (`stage22_cube_wall_width.png`, `stage22_cube_volumetric.png`
  — the outer wall is a thick 3D bead with a top and sides). (3) Progress measured: slicing 0 -> 100% (~1.45s) then the chunked build 3% -> 99% (~0.5s),
  with the main thread still answering a 16ms poll during the build (no freeze); after the build, orbit dragging holds a **median of 120fps and an average of 109fps** (489k segments).
  Override measured: layer_height 0.08 -> **1.24M segments > the cap** -> fallback + button (`stage22_fallback_override.png`) ->
  clicking the button -> a chunked volumetric build from 0 -> 100% in ~1.58s with no crash (`stage22_forced_volumetric.png`). (4) **0 functional console
  errors** (only a favicon 404). (5) **The kernel is unchanged** (slicer_core.cpp/.js untouched) -> no regression across the 120 + golden byte-identical
  (determinism confirmed, no re-baselining needed) + the WIDTH TEST re-confirmed PASS.

**Stage 22-fix** (user bug report: "the volumetric render has giant plane polygons (sparse/gap fill/solid colored) cutting diagonally across the model" ->
root cause found and fixed. **Rendering only — the kernel is unchanged**). Three competing hypotheses judged on evidence:
- **H1 (degenerate segments -> NaN/giant quads) rejected**: `wasm-core/scan_ribbon.mjs` replicated the buildLayerRibbon vertex formulas and scanned 6 models
  (cube, thin cross (gap fill/thin wall), cylinder, scarf, spiral, arachne) -> **0 NaN or huge coordinates**, maxWidth <= 0.45
  (no huge widths). Measured in the browser (walking the scene via `window.__vpThree`): both the synchronous path (plate 4781) and the chunked path (big_cyl 489k = 11.7M vertices) show
  **0 badVerts and 0 giant meshes**, with an accurate worldBBox. The `len<1e-6` guard already skips zero-length XY.
- **H2 (a chunked-build buffer bug) rejected**: the chunked path's big_cyl geometry (199 meshes / 11.7M vertices) has the same quality as the synchronous path (badVerts
  0). Both sync and chunk call the same `buildOne` — no shared buffer offsets or counts.
- **H3 (coplanar z-fighting) confirmed = the real cause**: measured — an adjacent layer's top face is **exactly coplanar with the layer below's bottom face in 198/198 cases**
  (z difference <1e-4), and with the camera near/far at 0.1/6000 (a ratio of 60000) the 24-bit depth resolution exceeds the 0.2mm layer height at distance (0.25mm@d646,
  0.57mm@d974) -> sub-surface infill (sparse/gap fill/solid) pokes through the surface and reads as a diagonal plane. (The coordinator thought H3
  "could not explain giant polygons", but the evidence shows the giant polygons are **clean geometry looking wrong because of depth imprecision**, not garbage
  geometry -> H3 is correct and H1 was a misdiagnosis.)
- **Fix**: (1) **shrink the depth range** near/far 0.1/6000 -> **1/3000** (a 20x smaller far/near ratio -> depth resolution 0.566 -> 0.055mm@d964,
  within the layer height). (2) **remove the coplanarity between layers**: the bead bottom becomes `zb = z0-h-ε` (ε=h·0.05), overlapping slightly so exact top ≡ bottom matches disappear
  (198/198 -> **0/198**). (3) **defense against H1 (in depth)**: `!(len>1e-6)` (blocking NaN), a width NaN guard, a 2.5mm half-width cap and a dev-mode NaN
  assert. (logarithmicDepthBuffer was rejected: gl_FragDepth disables early-Z -> **fps 120 -> 42 (a 3x drop)** at 489k overdraw;
  shrinking near/far alone is sufficient.)
- **Verification (PASS)**: before/after at the same angle (big_cyl 489k, distant top-down) `wasm-core/stage22b_before.png` -> `stage22b_after.png`
  (plus a zoom, `stage22b_after_zoom.png` = clean volumetric beads). The NaN/abnormal coordinate scan is **0** (scan_ribbon.mjs, with the fixed formulas).
  Coplanar matches went **198/198 -> 0/198**. 489k fps holds at a **median of 120 and an average of 106** (unchanged from before, no regression). **0 functional console errors** (the dev
  NaN assert never fired). **The kernel is unchanged** -> golden byte-identical, plus the 120 and WIDTH suites regression-free. ⚠ Note: the artifact's severity depends on GPU depth
  precision (severe on the user's GPU, mild on the test Chrome), but the root cause (198 coplanar cases + an extreme near/far) is confirmed removed in the data.

**Stage 24** (the giant plane artifact reappeared in a user screenshot -> a root-cause response: dropping the hand-rolled CPU geometry builder and
**reimplementing the upstream libvgcode algorithm verbatim**, structurally eliminating the whole artifact class [CPU geometry bugs, z-fighting, memory]).
Measured upstream: `src/libvgcode/{SegmentTemplate.cpp, ShadersES.hpp(Segments_Vertex_Shader_ES), ViewerImpl.cpp(extract_pos_and_or_hwa)}` (SPECS §7).
- **Structure (`viewer/src/toolpath_gpu.js`)**: the CPU builds no geometry. (1) an 8-vertex diamond template (the upstream
  VERTEX_DATA, 24 indices) x `InstancedBufferGeometry` (a vertex_id_float attribute) (2) the PathVertex stream in 4 `DataTexture`s
  — position (RGBA32F, z -= 0.5·height), height_width_angle (RGBA32F), color (RGBA32F, r<<16|g<<8|b) and segment_index
  (RGBA32UI, usampler2D) (3) a `RawShaderMaterial` (GLSL3) with **the upstream Segments_Vertex_Shader_ES ported verbatim** — the vertical-line guard,
  the view-dependent half box (a 16-entry corner sign table), miter joins (sin/cos angles), POINTY_CAPS, FIX_TWISTING and 2-light shading. The algorithm is
  unchanged (only port-mandated edits: #version comes from three (GLSL3), `255.0f` -> `255.0`, vertex_id as a float attribute, samplerBuffer
  -> sampler2D + tex_coord(id -> uv), which the upstream ES variant already does).
- **CPU data (`buildSegmentData`, pure and node-testable)**: kernel segments -> PathVertex (reconstructing connected runs by sharing endpoints)
  + the join angle `atan2(prev x this, prev · this)` (upstream extract_pos_and_or_hwa) + position.z -= 0.5·height. Segment indices are in
  layer order -> the visible range is `instanceCount`, O(1) (no texture re-upload). Travels are separate lines (drawRange in layer order).
- **View transform**: `view_matrix = camera.matrixWorldInverse · mesh.matrixWorld`, with `camera_position` converted into mesh-local (kernel z-up)
  coordinates — the shader's UP=(0,0,1) matches kernel z-up (preserving upstream semantics). Updated every frame in onBeforeRender.
- **Dropped**: the CPU ribbon builder (buildLayerRibbon), the line fallback, the cap/override, chunked building, zEps and the near/far tuning are all gone
  (less code). Because the diamond cross-section removes inter-layer coplanarity at the source, no z-fighting mitigation is needed.
- **Verification (PASS)**: CPU — `wasm-core/test_gpu_toolpath.mjs` (0 NaN, 0 huge coordinates, miter angles present [cube max 1.571rad = 90°], widths 0.6/0.42
  preserved, prefix == total, id_a+1 safe, z centering). Browser (489k segments = 489,521 instances, with **0** shader compile / glError / console
  errors): (1) no artifacts from any angle — `s24_big_{topfar (the distant top-down view where 22-fix showed artifacts),side,bottom,near,default}.png`
  (2) the width difference is solid, `s24_cube_width.png` (a thick 0.6 outer wall diamond vs the infill) (3) miter joins make the concentric top-surface beads smooth (`s24_big_near.png`)
  (4) the layer slider (489521 -> 121946 @50/199), the travel toggle (on 7886 vertices / off 0) and type colors all work (5) orbit fps **120** (489k, higher than the box version)
  (6) 0 console/shader errors (7) the kernel is unchanged -> golden byte-identical, plus the 120 and WIDTH suites regression-free.

**Stage 25** (the first tranche of desktop UI reproduction — S6, S2 and part of S5 from the SPECS §8 roadmap. **Viewer only, kernel unchanged**):
- **S6 Preview view** (`toolpath_gpu.js` + `Viewport.jsx`):
  - **6 view types** (Feature type/Speed/Layer Height/Line Width/Fan Speed/Temperature) — only the GPU renderer's color texture is
    recomputed (the §7 structure). Value -> color ports the **upstream libvgcode `DEFAULT_RANGES_COLORS`** (ColorRange.hpp, an 11-color blue-to-red ramp) and `ColorRange::
    get_color_at` (Linear) verbatim. Feature uses fixed colors. **Speed/Fan/Temp are absent from the kernel toolpath and derived from settings**
    (type -> feature speed, etc., leaving the kernel unchanged = the cheap option. Rationale: the stride-8 paths carry only type + widths, with no feedrate/fan/temp).
    A view type select plus a gradient legend (min/max).
  - **A dual slider** (lower/higher) — because segment indices are in layer order, the upper bound is an `instanceCount` cut and the lower bound is a shader `layer_lo`
    clip (both O(1), with the layer stored in segIndex.g). Plus a **single layer mode** button. Travels show the range through a `drawRange` offset.
  - **Role legend**: the **length share %** per type (descending). ⚠ Per-role **time** is not exposed by the kernel (only the time_extrude/travel totals) ->
    approximated by length share (documented as deferred; a time share would need a per-role kernel export).
- **S2 Prepare|Preview switching** (a toggle at the top left): Prepare = models + gizmos + painting (toolpaths hidden), Preview = toolpaths + slider + view types
  (models hidden). **Automatic Preview when slicing finishes.** In Preview the gizmo/painting are force-released and pointer input is gated.
- **Part of S5, settings consistency** (`toggle_eval.js` + `App.jsx`):
  - **Partial toggle-rules application**: the conditions (enable_if) from `toggle-rules.json` are translated to JS (with locals inlined: have_support_material =
    enable_support||raft, have_perimeters, have_infill, has_solid_infill, spiral, prime_tower, …). A false condition greys the widget out
    and shows the condition in a tooltip. **Untranslatable conditions (enum comparisons, unknown locals) fail open** (staying enabled, avoiding false positives). Translating all 907 keys / 231 rules
    is out of scope.
  - **dirty + reset**: options changed from the schema default get an orange dot plus a ↺ reset (the baseline is the default because there is no preset system yet).
- **Verification (playwright, PASS)**: (1) the Speed view's gradient shows the feature speed difference (first layer 30 blue -> infill 100 red) `wasm-core/s25_speed_view.png`
  and the 489k model in Speed `s25_big_speed.png` (fps 120, 0 glError) (2) the dual slider's range band `s25_dual_range.png` + single layer
  `s25_single_layer.png` (the instanceCount cut measured) (3) Prepare <-> Preview (automatic switch after slicing; the demo + gizmo vs the toolpaths) (4)
  enable_support=false disables support_style and friends (with the condition in a tooltip), `s25_toggle_rules.png` (23 greyed rows) (5) changing a value -> the orange dot -> reset
  restores it, `s25_dirty_reset.png` (6) 0 console/shader errors (7) the kernel is unchanged -> golden byte-identical plus the 120, WIDTH, GPU and VIEW tests PASS.
  CPU regression: `wasm-core/test_viewtypes.mjs` (integrity of the 6 views, wall ≠ infill on the heatmap, widths 0.42/0.6 preserved, the 11-color palette).
- **Deferred**: the per-role time share (needs a kernel export); the vertical slider has the functionality only (dual thumbs + single) — its orientation is a CSS follow-up; translating all
  toggle-rules; the Global|Objects switch (needs per-object kernel config first); and S1/S3/S4/S7 (top bar, toolbars, sidebar, plates).

**Stage 26** (user request: remove the demo mesh + strengthen multi-format import. **Viewer only, kernel unchanged**):
- **R1 demo removal**: the hardcoded cube/cylinder/torus and all related code are deleted (grep 0). An empty scene shows a drop hint overlay (📦 + the format list + a file picker).
- **R2/R3 multi-format loaders** (`model_loaders.js`): **STL, OBJ, 3MF, AMF and PLY** — reusing `three/examples/jsm/loaders/{OBJ,PLY,3MF,AMF}Loader`
  (**0 new npm dependencies**; 3MFLoader unzips with the fflate bundled in three). A unified pipeline: extension -> loader -> (BufferGeometry|Group)
  -> `collectMeshes` (baking the world matrix) -> non-indexed triangles -> a **model z-up flat array (N*9)**. Coordinate systems (measured): printing formats are z-up mm and three's loaders
  load raw coordinates without axis conversion -> used as z-up directly (a comment notes OBJ may be graphics y-up, but the printing convention z-up is the default). Slicing reuses the existing path
  (matrixWorld -> merged binary STL -> the kernel). **STEP is out of scope** (it needs OCCT — no browser WASM OCCT is bundled). For 3MF only the geometry is read (restoring project
  settings comes later, SPECS §1).
- **R4 multi-file + DnD**: multiple file selection + **drag and drop over the whole viewport** (with a highlight overlay), bbox-based side-by-side placement (the placeX cursor, avoiding
  overlap), and individual registration of multiple objects inside a 3MF/AMF. The list, selection, gizmo, T1/T2, delete and painting all work for every format.
- **Verification (PASS)**: (1) a grep for demo leftovers returns **0** (2) `wasm-core/test_loaders.mjs` (node: load STL/OBJ/PLY -> STL -> kernel slice, 12 triangles, 20mm,
  z-up, 99 layers, identical G-code) plus **all 5 formats in the browser** (STL/OBJ/PLY/AMF/3MF) loading and slicing to **the same 99 layers / 8147 segments / 1194.1mm**
  (3MF/AMF need DOMParser -> browser only). Fixtures: `wasm-core/gen_fixtures.mjs` (assembling the 3MF zip with fflate) -> `testing_files/cube.{obj,ply,amf,3mf}`.
  (3) Loading two different formats at once (an OBJ cube + an STL cylinder) -> side by side (x=10/38, no overlap) -> a merged slice, `wasm-core/s26_merge.png` (2 objects / 15246
  segments) (4) drag and drop under playwright (injecting a DataTransfer: dragover -> the overlay appears `s26_dragover.png`, drop -> objects load 0 -> 1) (5) 0 console
  errors (6) the kernel is unchanged -> golden byte-identical plus the 120, WIDTH, GPU, VIEW and LOADERS suites PASS (7) the empty scene overlay `s26_empty.png`.
- **Deferred**: STEP (OCCT), restoring 3MF project settings/painting data (geometry only), and automatic OBJ y-up detection (currently fixed to z-up).
  *(Since landed: STEP via a pluggable `registerLoader` + `occt-import-js` in the demo, and 3MF **project** import — plate layout, project settings and painting. OBJ stays fixed z-up.)*

**Stage 27** (user feedback "where is the UI improvement? it looks the same" -> rebuilding the layout and visuals to match desktop OrcaSlicer. S1/S3/S4 from SPECS §8.
**Viewer only, kernel unchanged, 0 functional regressions**):
- **Shell restructure**: `Viewport.jsx` owns the desktop-style shell (App's `Prepare` embeds it as `processPanel={<SettingsPanel/>}`). Layout =
  a top bar / [left gizmo rail · center viewport · right sidebar] / (buttons fixed at the bottom of the sidebar).
- **S1 top bar** (~44px): the logo "OrcaSlicer RE" + an Open button · the centered Prepare|Preview tabs (moved from vp-modebar) · undo/redo placeholders on the right (disabled + tooltips).
- **S3 left rail**: vertical gizmo icons (move/rotate/scale/**support painting**) — **reusing the upstream desktop SVGs** (resources/images/toolbar_{move,
  rotate,scale,support,open,arrange,orient}_dark.svg + add/delete -> viewport/src/assets). Painting is a rail mode (selecting it opens the brush in a
  floating panel). The viewport's top toolbar: add, delete and arrange/orient (disabled with a "backend port pending" tooltip).
- **S4 right sidebar** (light): (1) printer (bed size, nozzle Ø) (2) filament (color swatches + a T row list, +/− edits the color array; **changing a color updates the object
  mesh color**) (3) process (the settings panel embedded) (4) the object list (a print toggle eye, name, T selector, delete) (5) [Slice ▾] + [Export G-code] fixed at the bottom.
  The slice stats appear in a card at the bottom left of the viewport in Preview. The view type / dual slider / legend live in the sidebar's "preview" card.
- **Skin**: dark chrome (top bar, rail, viewport) with a light sidebar, an Orca green (#00AE42) accent, section cards, dividers and desktop icon sizes. styles.css was tidied and extended (no new framework).
- **Verification (PASS)**: (1) full layout screenshots for Prepare (`wasm-core/s27_prepare_v1.png` empty scene, `s27_prepare_model.png` model + paint) and Preview
  (`s27_preview_v1.png`) (2) painting as a rail mode -> 4066 blocker facets -> slicing works (3) filament T1 color #6aa0dc -> #22cc55 turns the object
  mesh green (4) slicing from the bottom -> the stats card at the bottom left of the viewport (99 layers / 8147 segments / 1194mm / 15m33s) (5) no regressions in existing features (view types, the dual slider,
  DnD, toggle-rules disabling support, dirty/reset all work) (6) 0 console errors (7) the kernel is unchanged -> the 120, golden byte-identical, WIDTH, GPU, VIEW and LOADERS suites PASS.
- **Deferred**: undo/redo (placeholders only), arrange/orient (needs the backend port), the prime tower / toolpath Tool-view colors (needs a per-segment tool export from the kernel —
  today the filament color only affects the Prepare object meshes), the S4 printer/filament preset combos (needs the preset system) and the S1 File menu / window controls.

**Stage 28** (a real-world STL (Benchy class) bug round — P1~P5. **Kernel change (the coordinate contract) + a golden review**):
- **P1 seating on the bed**: on load, `bakeLocal` seats each object's local geometry at minZ -> 0 (upstream `ModelObject::ensure_on_bed`'s
  `z_offset=-min_z`). Sinking (allow_negative_z) is out of scope. A "place on bed (⬇0)" button was added to re-seat after a gizmo Z move.
- **P2 flipping the coordinate contract (the core)**: the stage-3 design where the kernel realigned the combined bbox to the origin was dropped -> **`auto_center` (false by default) =
  trust the viewer's coordinates**. With false, slicing happens without XY realignment (only Z is seated) and the G-code only gets the plate origin offset (+bed/2) (matching upstream
  `GCode.cpp:932 m_plate_origin`). Result: **the toolpath overlaps the on-screen model's position and orientation exactly** (measured: an offset error of ~1-2mm =
  the skirt/bead width, and with a +40/-20 gizmo move the toolpath follows within 1.2mm). The selector (painting) weld and the viewer's paintXform were also
  aligned to an XY identity. `auto_center=true` keeps the legacy realignment for backwards compatibility.
- **P3 orientation**: the -90°X bake <-> the slice inverse matrix round trip preserves orientation (staying z-up) — measurements show no lying-down bug (the pseudo-benchy stands upright both on screen and in the
  slice, with height = three-Y). The lying-down symptom was a side effect of P2's coordinate mismatch. OBJ keeps the z-up assumption (rotate with the gizmo if it lies down).
- **P4 the support ∩ solid = 0 invariant**: (incorporating the coordinator's correction) the closed-cavity exclusion logic differs from upstream and is **not implemented** — support inside a cavity
  is normal. The only criterion is **support region ∩ model solid (inside the walls) = 0**. After the P2 fix, re-slicing **passes** the invariant (510 support segments,
  0 piercing the solid) -> the "support inside the model" symptom was coordinate-derived and resolved by P2 (not an avoidance logic bug).
- **Fixing the off-origin tree support crash**: once P2 placed the model away from the origin, `treesupport_bridge` (the generate_tree_support_3D port) hit
  a memory access violation. The rings are moved to the origin by the model's XY center before being passed to the bridge and the branch output is moved back before emission -> the crash is gone and the P2 overlap
  is preserved (a latent bug the legacy realignment had been hiding).
- **golden (no re-baselining needed)**: the harness was changed to send "bed-centered placement coordinates" (`golden.mjs centerTris` — the same as the viewer's bakeLocal).
  Centered placement + auto_center=false produces **the same G-code** as the legacy realignment -> **golden byte-identical (523965B, 0 line differences)**, so no re-baselining
  was needed (reason recorded). After rebuilding the kernel, the 120, WIDTH, GPU, VIEW, LOADERS, TREE and PAINT suites are all green.
- **P5 regression gate**: `wasm-core/gen_benchy.mjs` -> `testing_files/pseudo_benchy.stl` (off-center, minz=5, upright, an arm overhang, a sealed cavity;
  3DBenchy is CC-BY-ND and the repo only has a .drc, so it is generated programmatically). The `wasm-core/test_coords.mjs` invariants: (1) seated at minZ=0 (2) the toolpath XY
  bbox ≈ the model XY (<1mm) (3) off-center placement is followed (4) over_bed (5) auto_center=true legacy behavior (6) support ∩ solid = 0.
- **Verification (browser)**: the Prepare model and the Preview toolpath overlap from the same camera (`wasm-core/s28_prepare.png` / `s28_preview.png`), support
  is generated under the overhang without piercing (`s28_support.png`), the toolpath follows a gizmo move (`s28_moved_overlap.png`), and the console is clean.

**Stage 29** (2 user requests — **kernel unchanged, viewer orchestration only**):
- **(1) Automatic re-seating after a gizmo transform**: on the TransformControls `dragging-changed` commit (drag end) the object's world bbox
  minY (three) = the bottom is re-seated to 0 (for move, rotate and scale, on commit rather than live). Upstream, `GLCanvas3D::do_move/do_rotate/do_scale`
  calls `ensure_on_bed` (Model.cpp:1720, z_offset=-min_z) on every commit, snapping a flying object (minZ>0) to the bed while keeping sinking (minZ<0)
  down to SINKING_Z_THRESHOLD. **The one-line difference is no sinking support** (our kernel cannot slice negative z -> any minZ≠0 snaps to 0, up or
  down). Verification: `wasm-core/s29_reseat.png`.
- **(2) Multiple plates, first pass (the minimal S7)**: N plates (a single-row grid, 1 by default, add/remove in the top toolbar, labels 1·2·3…), each
  plate being a printable_area rectangle + grid + label. **Membership by position** (the plate rectangle the object's world X sits on). Clicking a plate
  selects it (a green highlighted border). **[Slice ▾]** drops down to current/all. **Current** sends only that plate's objects to the kernel (in plate-local coordinates),
  **all** slices plate by plate and downloads an individual `plate_N.gcode` for each (no zip; a body anchor plus a 350ms gap avoids the browser's multi-download
  block). The preview shows the selected plate's cached result (`plateResultsRef`/`plateOffsetsRef`, swapped on switch). **The stage-28 coordinate contract holds**:
  the G-code offset = the plate origin + bed/2. **Deferred** (no over-engineering): per-plate setting overrides, lock/icons and auto arrange.
- **Crash fix (viewer only)**: after stage 28 P2 (removing the kernel realignment), some asymmetric/negative coordinates (e.g. a cube model at x[0,20], y[-10,10])
  caused "memory access out of bounds" in the kernel's skirt/infill paths (a fragile case avoided by skirt_loops:0, rectilinear, seam nearest or symmetric
  coordinates — any one of them). It is avoided by "slice centered, display offset" (the desktop `m_plate_origin` approach):
  `buildMergedSTL` sends the slice input centered on the XY origin (symmetric coordinates) to dodge the crash and returns `offX/offZ` -> `setToolpathOffset`
  pushes the toolpath back so it still overlaps the on-screen model. The paint xform reflects the same centering. **The kernel is unchanged, so golden stays byte-identical.**
- **Verification**: the single-cube slice crash is gone with the toolpath overlapping perfectly (error 0,0); slicing all of 2 plates (benchy@0, cube@1)
  produced 2 files, `plate_1.gcode` + `plate_2.gcode`, with preview switching (plate0 = 169 layers @ offset 26, plate1 = 99 layers @ offset 250) and accurate membership/positions,
  0 glError and 0 console errors. `wasm-core/s29_multiplate.png`. **Regression gate**: the 120, WIDTH, GPU, VIEW, LOADERS, TREE, PAINT and COORDS suites
  are all green plus golden byte-identical (523965B, 0 line differences, kernel unchanged).

**Stage 30** (the OOM tolerance round — "the G-code finishes even under memory pressure". The §6.8 output streaming round):
- **(1) G-code layer streaming (the root fix)**: a module-level layer sink (`set_layer_sink(cb)`/`clear_layer_sink`) was added
  to the kernel. When registered, `slice()` emits `cb(z, idx, gcodeChunk, pathsF32, widthsF32)` per layer instead of keeping the batch resident (the whole `gw.s` +
  the whole `layersArr`) and **frees that layer's buffers from the heap** (emptying after `gw.s.swap`). The preamble goes into the first chunk and
  the footer into the last -> concatenating the chunks is **byte-identical** to the batch `gw.s`. With no sink registered the old batch path runs unchanged
  (every node test and golden unaffected). The real PE (whole-string cross-layer smoothing, opt-in and outside golden) falls back to batch.
- **Streaming the post-processor**: GCodeProcessor is a streaming parser upstream (`process_buffer` is stateful — with chunks on '\n'
  boundaries, many calls equal one call) -> `estimate_begin/feed/end` were added to `gcodeproc_bridge` so the kernel feeds chunks as it produces them
  instead of keeping the whole string resident. PE tag stripping is a stateless line filter, so it applies per chunk (identical results).
- **(2) Transfer and rendering**: the worker emits each layer to main as a **transferable** (moving the Float32Array buffers) as soon as it is produced ->
  the worker copy is freed immediately. Main accumulates and builds the texture once (`buildSegmentData` needs cross-layer miter joins and the prefix sum,
  so a per-layer GPU-append growing texture is deferred with the rationale recorded; the worker/WASM was the OOM bottleneck and is already fixed). The g-code chunks are
  kept in an array (for download).
- **(3) OOM detection + an automatic retry ladder**: 3 detectors — worker error/messageerror, a WASM abort, and a **hang watchdog** (no progress callback
  for 60 seconds -> declared dead, the worker is terminated). On trigger: **recreate the worker -> automatically re-slice in economy mode** (skipping the preview
  toolpaths and time estimate, G-code only) -> on success a "no preview" notice plus the G-code. If that also fails, a dialog offers a **simplified retry**
  (rectilinear infill, lower density, economy). **E1**: if one plate fails while slicing all plates in sequence, the G-code of the already finished
  plates is preserved and downloadable. Partial G-code is never returned as a result.
- **Bug fix (kernel)**: during the `gcodeproc_bridge` refactor, `make_cfg` **returned `PrintConfig` by value** -> StaticPrintConfig's
  option map (pointers to member addresses) pointed from the copy at the original's destroyed members, causing a wasm OOB when parsing gap-fill/thin-wall g-code. Fixed by filling
  **in place** with `fill_limits` (no copying). Isolated by bisecting at the node level (full crashed / transcribed was fine).
- **Verification**: (1) the heap benchmark (`wasm-core/bench_heap.mjs`, big_cyl at 318,687 segments) — batch **126.9MB** -> stream **107.1MB** (15.6% lower,
  freeing per layer) -> **economy 16.4MB (87% lower** = the base, with no resident moves vector, toolpaths or gcode) = the OOM survival mode finishes large models on
  the baseline heap. (2) The streamed assembly is **byte-identical** to batch (the new `golden_stream.mjs`, 4 cases including economy,
  15/15). (3) Browser (0 console errors): normal streaming (a benchy preview at 169 layers / 13886 segments, `wasm-core/s30_streaming.png`), a **forced failure
  -> economy completion** (notice + download), the **hang watchdog** (firing at 1.5s -> economy completion at 2.0s) and **plate E1** (plate1's g-code still
  downloads when plate2 fails). (4) The whole suite (test/width/gpu/viewtypes/loaders/ts_verify/paint/coords) plus the batch golden at **523965B byte-identical**
  shows no regression. The test hooks (`window.__vpFail/__vpStallNext/__vpWatchdogOnce`, the worker's `d.stall`) are not set in production.

**Stage 31** (user bug: organic tree support on a symmetric vase-like model was generated/rendered on **one side (the right) only**):
- **Verdict (splitting generation vs rendering)**: a symmetric fixture (a central pillar + two identical ±X ears, with an overhanging underside) was created ->
  sliced with `support_style=tree` -> the **X distribution of the kernel's type5 (support) segments** was measured: left (X<0) = **0**, right (X>0) = **4080** -> the G-code (toolpath)
  itself is one-sided = a **generation bug (H1)**. `tree_lite` is symmetric (123/123) -> overhang detection is fine and **only the organic path** is defective.
- **Rejected**: **H2 (a rendering omission)** — the kernel's own output is already one-sided, so it is upstream of rendering (unrelated to the stage-30 streaming assembly).
  **H1's re-centering sign hypothesis** — an off-center (+40) fixture is also right-only relative to the model center (because the bridge always re-centers on the bbox
  center, independent of stage 28's tcx sign) -> not a re-centering sign issue. **H3 (upstream is legitimately asymmetric)** — upstream
  OrcaSlicer keeps objects inside the printable area (positive [0,bed]) so symmetry is the norm; our integration mismatched an origin-centered model against the
  [0,bed] border, which is the cause (not a defect in the port itself).
- **Root cause**: TreeSupport clips the support region against `m_machine_border` (= `printable_area`)
  (`TreeSupport.cpp:2188/2193/2197`, `intersection_ex(roof/base_areas, m_machine_border)`). The bridge set
  `printable_area` to the **positive quadrant [0,bed]** (`treesupport_bridge_impl.cpp:88`) while the kernel handed over an **origin-centered** model
  (bbox center = 0, stage 28 P2) -> the model's **negative X/Y half (one ear of the symmetric model)** fell outside the border and its support was
  clipped away entirely. (The table in ts_verify has a single central pillar so it stayed latent — it only checked type5 > 0, never symmetry.)
- **Fix (one change in the bridge)**: `treesupport_bridge_impl.cpp:88-93` — `printable_area` (= machine_border) becomes **origin-centered**
  `[-bed/2, bed/2]` -> an origin-centered model sits fully inside the border -> symmetric support. The model coordinates stay near the origin (small)
  (`slicer_core.cpp:1244` tcx restored = exactly as in stage 28) -> **avoiding the cross-slice OOB**. (A first attempt: moving tcx to the bed
  center so the model sat in positive coordinates (v1) fixed the symmetry but reproduced "memory access out of bounds" at large coordinates (~100mm) when slicing tree -> tree_lite
  back to back -> discarded. Moving the border keeps the coordinates small and is safer.)
- **Verification**: a new invariant in `wasm-core/test_tree_symmetry.mjs` — the left/right type5 ratio of the symmetric fixture must be in **[0.7,1.3]** with both sides > 0:
  centered L/R = **0.92** (left 7365, right 7969), off-center (+40) L/R = **0.92**, and tree_lite as a control at 1.00. **tree -> tree_lite runs without crashing**
  (the v1 regression is resolved). In the browser, a vase-like model (`testing_files/sym_ears.stl`, `window.__vpForceTree`) -> **support renders on both ears**
  (`wasm-core/s31_tree_symmetric.png`, 149 layers, support 19%, 0 console errors). **Regression gate**: 10 suites
  (test/width/gpu/viewtypes/loaders/ts_verify/paint/coords/golden_stream/test_tree_symmetry) + batch golden
  and golden **523965B byte-identical**, all green (the kernel's slicing logic and golden are unchanged).

**Stage 32** (the support structure defect round — a reproduce-first investigation plus the fixes it actually found):
- **Hypotheses measured -> two assumptions rejected**: roof (a table + a cantilever arm) and cup (thick walls + an internal overhang) fixtures were sliced with grid/tree_lite/tree
  and the type5 (support) distribution was measured per x region and z band (`wasm-core/repro_support.mjs`). Conclusions:

  | Hypothesis | Measurement | Verdict |
  |------|------|------|
  | A hole/`offset_paths` defect (support inside wall solid) | cup: type5 in the wall solid = **0**, with support in the cavity | **Rejected** — `SimplifyPolygons(pftEvenOdd)` orientation normalization + ClipperOffset shrink holes correctly |
  | A protrusion above the roof piercing below it | with vs without the arm, the type5 under the roof shows **Δ=0** (the support under the roof is legitimate support for the roof's overhanging underside) | **Rejected** — our kernel does not bridge, so a roof underside is always an overhang -> support, and the upper column is absorbed into it |

  The underlying reason: the per-layer clip `col = column[j] − offset(contour[j],+xy)` already achieves "support never enters the solid and rests on the model's
  top surface". There is no upstream bottom-contact concept, but the clip is structurally equivalent.
- **Real finding, fix A — no support under a floating overhang**: `slicer_core.cpp:1303` skipped overhang detection when the lower layer was empty (a floating part above a full z gap),
  so a part in mid-air got **0 support**. The skip condition was narrowed to `L[i].contour.empty()` alone -> with an empty lower layer,
  `offset(empty)=empty` makes the clip result the whole contour = a full overhang -> support is generated. (It only fires for floating parts -> normal models are
  unaffected and golden is unchanged.) Verified: the floating arm fixture goes from type5 **0 -> 150**.
- **Real finding, fix B — the `support_bottom_z_distance` parameter**: the z gap under support resting on a model's top surface. `botGap=round(dist/lh)`, and the
  default 0.2/lh = **1 -> the extra clip loop never runs -> completely identical to today (golden byte-identical)**. Above 1, support on the (botGap−1)
  layers directly above the top surface is removed to create the gap. Mapped in `settings.js` (`support_bottom_z_distance`, default 0.2). Verified: on the tower + arm
  fixture the support bottom z goes 5.00 (0.2) -> 5.40 (0.6) -> 5.80 (1.0) — exactly (botGap−1)·lh above the top surface (z=5).
- **A new regression guard** (`wasm-core/test_support_structure.mjs`, grid and tree_lite): cup wall solid = 0 with cavity > 0, roof arm Δ=0 with
  resting-on-roof > 0, cantilever over-pillar = 0, **fix A** (floating support > 0) and **fix B** (the z gap rising). A safety net for future support work.
- **The full GCodeProcessor non-manifold crash (investigated only; the fix is a separate round)**: processing the g-code of a non-manifold fixture built from overlapping boxes (roof + arm)
  with `time_engine=full` (the default) raises "memory access out of bounds" (`function[2807]`, the gcodeproc move/time path).
  It is **heap-layout dependent** (the same family as the stage 30/31 heisenbugs) — a single slice does not reproduce it; it takes back-to-back slices of
  `roof-noarm -> roof-arm`. It is presumed to be a latent buffer/index bug in the port, sensitive to the pathological move sequences self-intersecting geometry produces (likely degenerate/zero-length
  moves). **The stage-30 OOM ladder currently defends against it** (the economy retry skips the time estimate). Fixing it needs ASan -> a separate round.
- **`SupportMaterial.cpp` port reconnaissance: deferral confirmed (reason: the stage-32 evidence).** The current sweep was measured to be structurally sound (holes, resting on top surfaces and
  solid avoidance all behave), so porting the contact-layer pipeline has little expected benefit. Bottom contact is parameterized through fix B (approximated on top of the sweep).
  It will be re-evaluated when a real vase STL arrives (option 1).
- **Regression gate**: 11 suites (the 10 above + test_support_structure) plus the batch golden at **523965B byte-identical**, all green
  (proving fixes A/B leave the default behavior unchanged). After rebuilding the kernel.

**Still unimplemented / approximation limits** (approximations are the ceiling without a full libslic3r port):
- **Organic TreeSupport** — **integrated into the main build in stage 18 and refined in stage 19**: with `support_style=tree` the real
  `generate_tree_support_3D` branch toolpaths (type5) are emitted (verified rendering in the browser). Stage 19 completed **per-path support extrusion width
  delivery** (reflected in E and the ribbon, proven to follow config) and **support z alignment to the object grid (z_resid 0mm)**. Remaining: in this port the
  support flow gives the interface the same width as the body (a port model trait). The defaults grid and tree_lite are preserved.
- **Manual support enforcer/blocker painting** — **completed for real in stage 20**: the real TriangleSelector ported + selector_bridge
  (embind) + a three.js brush UI in the viewer (a SPHERE cursor with an overlay) + the facade's `slice_support_enforcers/blockers` wired to a real projection
  (footprint). Physically verified: enforcer -> support generated, blocker -> support suppressed (tree + grid, `test_paint.mjs`), rendered in the browser.
  Remaining approximations: upstream tree enforcers only force real overhang areas (verified in manual mode), and the footprint projection replaces slice_mesh_slabs
  (to handle isolated patches).
- **Time estimation** — computed by the real GCodeProcessor body since stage 13 (a 7561-line port, `time_engine=full` by default). The stage-10
  transcription is preserved as `time_engine=transcribed` (they differ by 8.5%, with full being the upstream truth). Gaps: role breakdowns only in tag mode, and
  layers grouped by position.z (the kernel does not emit the CHANGE_LAYER tag).
- **The config subsystem** — **ported in stage 11 and merged into the main build in stage 12** (the real Config.cpp + PrintConfig.cpp link into the main
  slicer_core.js, with `config_option_count()` = 817 live). The keystone gate stage 10 identified is fully cleared.
- **WipeTower** — **really ported in stage 11 and wired into the kernel in stage 12** (`wipe_tower_real`, false by default). When true, an MM tool change splices in
  the real WipeTower.generate() output (`; CP TOOLCHANGE` / `; WIPE_TOWER_START` + E/F); when false it uses the stage-6 square ring.
  The viewer has a toggle. **Remaining**: the rib 3D mesh (TriangleMesh) is stubbed (not generated), each layer is generated independently rather than optimized across layers,
  the PlaceholderParser tokens are not expanded (commented out), and filament purge/ramming scheduling is not modeled.
- **full GCodeProcessor** — **ported in stage 13** (the 7561-line body compiles, links and runs, with `time_engine=full` as the new default and the
  120 green). Time estimation now uses the upstream body (the real trapezoidal planner). The transcription is preserved as `time_engine=transcribed`.
  Gaps: role breakdowns only in tag mode, layer detection by position.z grouping, and inaccurate per-move direct sums because of the actual-speed sub-moves.
- **full TreeSupport** — **integrated into the main build in stage 18**. Stage 16 standalone (10903 lines / 4 bodies, with real CGAL + Arachne + Fill,
  20 layers / 123 type5) -> stage 17's ODR measurements (shared linking was green across 120 but crashed from the main build's trimmed Fill contamination; full isolation is impossible because wasm does not support symbol
  localization) -> **stage 18 option (a): additively untrimming the main build's FillBase factory (golden byte diff 0) + shared-symbol integration**.
  Result: `support_style=tree` on the overhang table -> **8662 type5 segments**, different distributions for tree vs tree_lite, determinism, no regression across the 120 with golden at 0,
  and organic tree support rendering in the browser (`wasm-core/stage18_tree_support.png`) with 0 functional console errors. Reproduce with `wasm-core/ts_verify.mjs` and
  `golden.mjs`. **The real organic TreeSupport exception is gone.**
- **Unported Fill patterns** — rectilinear/grid/triangles/zigzag remain the kernel's own approximations (only the 5 ported patterns are real). FillAdaptive,
  Lightning, Tpms, Line and others are unported (new_from_type returns nullptr -> the kernel falls back).
- **Arachne's CGAL planarity recovery** — **really ported in stage 14** (no longer a stub). `VoronoiUtilsCgal.cpp` (the real
  CGAL 6.2, header-only + Boost.Multiprecision, with no GMP/MPFR linkage) links into the main build so `is_voronoi_diagram_planar_angle`
  actually runs (verified: after slicing an arachne cube, `cgal_planar_check_count` = 99 = once per layer). ⚠ **A wasm rounding limitation**:
  wasm has no FP rounding mode register (fesetround is a no-op), so CGAL's interval arithmetic is not conservative ->
  `CGAL_DISABLE_ROUNDING_MATH_CHECK` bypasses the startup self-check, the filter runs in double precision, and near-zero cases fall back to exact
  MP_Float (accurate). So it is not the desktop's exact guarantee, but it is a real check rather than an "always planar" stub. The boost wasm.hpp
  override (removing BOOST_NO_FENV_H — emscripten has fenv.h) enables the Boost.Interval c99 rounding path.
- **Unwired Arachne parameters** — `wall_transition_*`, `min_bead_width` and similar are filled with defaults by the bridge
  (since make_paths_params was removed). Exposing them through config would make it fully equivalent.
- **classic thin walls / gap fill** (stage 5) — automatically disabled in arachne mode (Arachne replaces them with variable width). In classic mode they remain
  center line approximations.
- **Organic tree support** — the upstream TreeSupport pipeline was integrated into the main build in stages 16-18 (`support_style=tree`,
  with per-path width, z alignment and manual painting added in stages 19-20). tree_lite is preserved as a lightweight alternative (a morphological descending taper —
  no branch splitting or merge optimization). The outdated wording on this line dates from before stage 15.
- **A proper wipe tower** — the real WipeTower was ported in stage 11 and wired into the kernel in stage 12 (with `wipe_tower_real=true` using the real upstream
  purge/ramming/wipe logic). Remaining: each layer is generated independently (not multi-layer tower scheduling), the rib 3D mesh is not generated, and
  the PlaceholderParser tokens are not expanded. The default (false) keeps the stage-6 square ring.
- **PressureEqualizer** — the upstream PE was ported in stage 8 and tag-integrated in stage 9 (per-segment F ramp splitting observed for real). The default is
  the PE-lite approximation (per-segment speed adjustment, no splitting) — opt into the upstream PE with `pe_lite=false`.
- **Complete wall avoidance** — cases where the boundary detour fails remain (crossing inner walls, hopping between multiple islands).
- **non-planar** — unimplemented. The support body is grid (with the zigzag not connected).
- Gap fill, thin walls, bridges and ironing are all morphological (Clipper offset) approximations, so thin curved regions can produce short stubs.
