# Detailed specs — 3MF XML · painting codec · expression language · shortcuts · 3D rendering

A companion to `REVERSE_ENGINEERING_GUIDE.md`. Everything here was measured against the sources (main 607648c).

---

## 1. 3MF project file XML spec

Source: [src/libslic3r/Format/bbs_3mf.cpp](../slicers/slicer/src/libslic3r/Format/bbs_3mf.cpp), the constant declarations (lines 232-439).
The ZIP entry list is in guide §7.2. This section covers the XML structure of each entry.

### 1.1 `3D/3dmodel.model` — scene/mesh (3MF core + extensions)

```
<model unit="millimeter" ...>
 <resources>
  <object id="" p:UUID="" type="model">
   <mesh>
    <vertices>  <vertex x y z/>* </vertices>
    <triangles> <triangle v1 v2 v3
                  paint_supports=""    <- support painting (§2 codec)
                  paint_seam=""        <- seam painting
                  paint_color=""       <- MMU color painting
                  paint_fuzzy_skin=""  <- fuzzy skin painting
                  face_property=""/>* </triangles>
   </mesh>
   <components> <component objectid="" p:path="" transform=""/>* </components>
   <!-- text/SVG volume metadata -->
   <slic3rpe:text text="" font_name="" font_size="" bold="" italic="" ... />
   <slic3rpe:shape scale="" depth="" use_surface="" filepath3mf="" ... />
  </object>
  <m:colorgroup> <m:color color=""/>* </m:colorgroup>
 </resources>
 <build> <item objectid="" transform="" printable=""/>* </build>
</model>
```

- Each object's real mesh is split into `3D/Objects/<name>_<n>.model` and referenced from 3dmodel.model as a component.
- `transform` = a 3x4 matrix, 12 space-separated reals (3 column-major columns + translation).

### 1.2 `Metadata/model_settings.config` — hierarchical setting overrides (XML)

```
<config>
 <object id="">
  <metadata key="name|extruder|...(option key)" value=""/>*
  <part id="" subtype="normal_part|negative_part|modifier_part|support_blocker|support_enforcer">
   <metadata key="name|matrix|source_file|source_object_id|source_volume_id|
                  source_offset_{x,y,z}|mesh_shared|volume_type|part_type" value=""/>*
   <mesh_stat ... />
  </part>
  <model_instance> <metadata key="object_id|instance_id|identify_id" value=""/>* </model_instance>
 </object>
 <plate>
  <metadata key="plater_id|plater_name|locked|bed_type|print_sequence|
                 first_layer_print_sequence|other_layers_print_sequence|
                 filament_map_mode|filament_maps|limit_filament_maps|
                 gcode_file|thumbnail_file|thumbnail_no_light_file|top_file|pick_file|
                 pattern_bbox_file|index" value=""/>*
  <model_instance .../>*                 <- the instances belonging to this plate
 </plate>*
 <assemble> <assemble_item object_id="" instance_id="" transform="" offset=""/>* </assemble>
</config>
```

- **Every setting override is a `<metadata key value>` pair**, where the key is exactly an option key from config-schema.json.
- A `<part>`'s `matrix` is the volume-local transform.

### 1.3 `Metadata/project_settings.config` — flat JSON

A snapshot of the fully merged settings. `{ "option key": "value" | ["per-filament value", ...] }`.
Vector options are always arrays of strings. This file alone is enough to reproduce the slicing settings.

### 1.4 `Metadata/slice_info.config` — slice result metadata (XML)

A `<header>` (version, …) plus per-`<plate>` `<metadata key=prediction|weight|outside|support_used|
label_object_enabled|timelapse_type .../>` + `<filament id type color used_m used_g/>` +
`<warning msg/>` + `<object identify_id name skipped/>`.

### 1.5 Round-trip compatibility rules

- When reading, **preserve the original bytes of unknown tags/attributes/entries instead of dropping them** and write them back out.
- Legacy `Metadata/Slic3r_PE*.config` (the PrusaSlicer family) is read-only compatibility.

---

## 2. Painting data codec (TriangleSelector)

Source: [TriangleSelector.cpp:1692](../slicers/slicer/src/libslic3r/TriangleSelector.cpp#L1692) `serialize`,
stringification: [Model.cpp `FacetsAnnotation::get_triangle_as_string`](../slicers/slicer/src/libslic3r/Model.cpp).

### 2.1 Concept

Painting is stored as a tree of recursively split source triangles. A bitstream is built per triangle,
then converted to a hexadecimal string and stored in the 3MF `paint_*` attribute.
**Unpainted triangles (state NONE, unsplit) have no attribute at all.**

### 2.2 The bitstream of a single triangle (recursive)

```
triangle := split_info state? children*
split_info := 2 bits yy = number of split edges (0=leaf, 1..3)
split (yy>0)  : 2 bits xx = special side (1 split: which edge, 2 splits: the retained edge, 3 splits: ignored)
              then the (yy+1) children are serialized recursively in reverse order   <- reversed for PrusaSlicer 2.3.1 compatibility
leaf (yy=0)   : state n = EnforcerBlockerType
              n<=2  -> 2 bits xx = n
              n>=3  -> 2 bits xx = 0b11, then 4 bits zzzz = n-3   (n up to 16, the extruder color)
```

State values: 0=NONE, 1=ENFORCER, 2=BLOCKER, 3+=extruder index (MMU painting).

### 2.3 String encoding

The bitstream is cut into 4-bit nibbles and each nibble becomes a hex character (`0-9A-F`), but
**each character is always inserted at the front of the string** — so the final string is in reverse nibble order.
Decoding reads from the end of the string backwards, restoring the bits.
Bit order within a nibble: `next_code = bit[3]<<3 | bit[2]<<2 | bit[1]<<1 | bit[0]` (the LSB comes first in the stream).

Verification vector for a JS implementation: an unsplit ENFORCER leaf = bits `00` (yy) + `01` (xx -> n=1) -> nibble `0100₂=4` -> string `"4"`.

---

## 3. The PlaceholderParser expression language (EBNF)

Source: [PlaceholderParser.cpp](../slicers/slicer/src/libslic3r/PlaceholderParser.cpp), the boost::spirit grammar (lines 1880-2400).
Used for (1) custom G-code slots and (2) the preset `compatible_printers_condition` / `compatible_prints_condition`.

```ebnf
template        = { text | macro } ;
macro           = "{" block "}" | legacy "[" variable "]" ;      (* [] is the legacy simple substitution *)
block           = if_block | switch_block | assignment | expr ;
if_block        = "if" expr "then"? body
                  { "elsif" expr body } [ "else" body ] "endif" ;
expr            = ternary ;
ternary         = or_expr [ "?" expr ":" expr ] ;
or_expr         = and_expr { ("or"  | "||") and_expr } ;
and_expr        = equality { ("and" | "&&") equality } ;
equality        = relational { ("==" | "!=" | "=~" | "!~") relational } ;
                                          (* =~ / !~ : regex match, the right-hand side is a /regex/ literal *)
relational      = additive { ("<" | ">" | "<=" | ">=") additive } ;
additive        = multiplicative { ("+" | "-") multiplicative } ;
multiplicative  = unary { ("*" | "/" | "%") unary } ;
unary           = [ "-" | "+" | "!" | "not" ] factor ;
factor          = "(" expr ")" | literal | function_call | variable_ref ;
variable_ref    = ident [ "[" expr "]" ] ;                        (* vector indexing *)
literal         = int | float | bool | string | "/" regex "/" ;
function_call   = "min(a,b)" | "max(a,b)" | "random(lo,hi)"
                | "int(x)" | "round(x)" | "floor(x)" | "ceil(x)"
                | "digits(x,n[,m])" | "zdigits(x,n[,m])"
                | "is_nil(var)" | "size(vec)" | "empty(vec)"
                | "one_of(x, list...)" | "interpolate_table(x, (k,v)...)"
                | "regex_replace(subject, pattern, repl)"
                | "repeat" | "filament_change" ;                  (* G-code only *)
assignment      = ["global"|"local"] ident "=" expr ;             (* script variables *)
```

- Value types: int, double, bool, string, vector (coming from a settings option). nil in a nullable vector is tested with `is_nil`.
- A settings option key is directly a variable name (`nozzle_diameter[0]`, `printer_notes=~/.*PRINTER_VENDOR_XX.*/`).
- A web implementation is a recursive-descent parser of roughly 800 lines. Precedence follows the EBNF order above exactly.

---

## 4. Keyboard shortcuts (measured from KBShortcutsDialog.cpp)

Per platform, ctrl = ⌘ on macOS. The full list is in [KBShortcutsDialog.cpp](../slicers/slicer/src/slic3r/GUI/KBShortcutsDialog.cpp).

| Key | Action | | Key | Action |
|---|---|---|---|---|
| Ctrl+N/O/S | New/open/save project | | M / R / S | Gizmo move/rotate/scale |
| Ctrl+Shift+S | Save as | | F | Place face on bed |
| Ctrl+I | Import geometry | | C / B | Cut / mesh boolean |
| Ctrl+R | Slice plate | | P / H | Seam painting / fuzzy skin |
| Ctrl+G | Export sliced file | | T / U / Y / E | Text/measure/assemble/brim ears |
| Ctrl+Z / Ctrl+Y | undo / redo | | A / Q | Arrange all / auto orient |
| Ctrl+X/C/V | Cut/copy/paste | | I / O | Zoom in/out |
| Ctrl+A / Ctrl+D | Select all / delete all | | V | Toggle printable |
| Ctrl+K | Duplicate selection | | 1-9 | Assign filament/extruder |
| Ctrl+0~6 | Camera preset views | | ? | Shortcut list |
| Ctrl+P | Preferences | | L / C (preview) | Single layer mode / G-code window |
| Del/fn+⌫ | Delete selection | | | |

---

## 5. 3D rendering · picking · painting interaction details

All measured from the sources. This is the contract document for a web (three.js/WebGL2) reimplementation.

### 5.1 Geometry pipeline (Model -> GPU)

```
ModelVolume.mesh (TriangleMesh)
  -> when a GLVolume is created, v.model.init_from(mesh)         (3DScene.cpp:836 -> GLModel.cpp:436)
  -> the GLModel::Geometry vertex buffer
```

- **Vertex layout**: `EVertexLayout::P3N3` — position 3f + normal 3f, interleaved
  ([GLModel.hpp:38-47](../slicers/slicer/src/slic3r/GUI/GLModel.hpp#L38)). Indices shrink automatically to UINT/USHORT/UBYTE.
- **One GLVolume = one ModelVolume x ModelInstance combination**. The transforms are kept
  **in two separate stages**: `m_instance_transformation` (the instance) and `m_volume_transformation` (part local)
  ([3DScene.hpp:117-119](../slicers/slicer/src/slic3r/GUI/3DScene.hpp#L117)) — the final world matrix = instance ∘ volume.
- Extra caches: the convex hull (for arrangement and interference tests), 3 kinds of transformed bbox, and `SinkingContours` (drawing the outline of
  the part sunk below the bed, rendered separately with a flat shader — 3DScene.cpp:1060).
- **State and color palettes are static GLVolume members**: `MODEL_COLOR[5]` (the filament fallback), `MODEL_NEGTIVE_COL`,
  `MODEL_MIDIFIER_COL`, `SUPPORT_ENFORCER/BLOCKER_COL`, `MODEL_HIDDEN_COL`, `DISABLED/UNPRINTABLE` +
  and the hover state `EHoverState {None, Hover, Select, Deselect}` (3DScene.hpp:85-110). Every frame
  `set_render_color()` combines (selection, hover, type, filament color) into the final color.
- Web mapping: one `BufferGeometry` (pos+normal) per volume, the two-stage transform composed into `Object3D.matrix`,
  and the color as a material uniform. InstancedMesh only when the same volume has many instances.

### 5.2 Shader contract (the main body = gouraud)

The shader `_render_objects` uses is `gouraud` (confirmed fallback: inside GLCanvas3D.cpp `_render_objects`,
`shader = get_shader("gouraud")`). The uniforms are effectively the feature list.
([resources/shaders/110/gouraud.vs/.fs](../slicers/slicer/resources/shaders/110/)):

| Uniform | Feature | Web equivalent |
|---|---|---|
| `view_model_matrix, projection_matrix, view_normal_matrix, volume_world_matrix` | transforms | three's defaults |
| `uniform_color` | volume color (the result of set_render_color in 5.1) | material.color |
| `print_volume` (PrintVolumeDetection: type 0=Rect/1=Circle + xy_data/z_data) | **decides off-bed status live in the fragment shader -> grey/warning tint** (`_render_objects` injects it via `set_print_volume`, GLCanvas3D.cpp:8199-8214) | shader injection with onBeforeCompile, or simplified: a CPU bbox test then a material swap |
| `extruder_printable_heights` | marks exceeding the per-extruder print height | same |
| `z_range`, `clipping_plane` | cross-section clipping (gizmo/assemble view) — fragment discard | material.clippingPlanes |
| `color_clip_plane` + 2 colors | two colors split by the clip plane (the cut gizmo) | custom |
| `slope` (SlopeDetection) | overhang slope visualization (a normal z threshold) | custom shader |
| `is_outline`, `depth_tex`, `screen_size` | selection outline (via depth comparison) | replaced by three's OutlinePass |

Transparent volumes (modifiers, …) go in a separate pass after the opaque one (guide §6.5 render order). Before rendering,
z_range and the clipping planes are set on all of `m_volumes` at once (GLCanvas3D.cpp:8226-8240).

### 5.3 Picking (not GPU color picking — a CPU raycast)

- Entry point: `SceneRaycaster` ([SceneRaycaster.hpp:40](../slicers/slicer/src/slic3r/GUI/SceneRaycaster.hpp#L40)) —
  a raycaster list per Bed/Volume/Gizmo group, with hits identified through `encode_id/decode_id/base_id` (:115-119).
- Per mesh: `MeshRaycaster` ([MeshUtils.hpp:159](../slicers/slicer/src/slic3r/GUI/MeshUtils.hpp#L159)) —
  **based on `AABBMesh` (the igl AABB tree)**, providing `unproject_on_mesh` (mouse -> unproject -> tree query -> hit point + normal)
  and `closest_hit`. So mouse pixel -> world ray -> BVH traversal runs even on every hover frame.
- Web mapping: `three.Raycaster` + **three-mesh-bvh** (the same acceleration structure). Id encoding is unnecessary
  (three returns the object reference). Hover highlighting uses the same caching strategy (the raycast cache in §5.4).

### 5.4 Painting brush interaction (GLGizmoPainterBase — shared by support/seam/MMU/fuzzy skin)

The full flow ([GLGizmoPainterBase.cpp](../slicers/slicer/src/slic3r/GUI/Gizmos/GLGizmoPainterBase.cpp)):

```
(1) mouse move -> update_raycast_cache(mouse, camera, trafo_matrices)   (:158, 495, 603)
     raycast every candidate volume -> cache the nearest (mesh_id, hit point, facet index)
(2) drag/click -> gizmo_event(action, mouse_pos, shift/alt/ctrl)        (:658)
(3) build the cursor (brush) — TriangleSelector::CursorType             (TriangleSelector.hpp:52)
     CIRCLE (a screen-axis cylinder) | SPHERE (a sphere, the default) | POINTER (per triangle)
     | HEIGHT_RANGE (a height band) | GAP_FILL   <- a BBS extension
     Movement between frames is bridged with Capsule2D/3D (DoublePointCursor, :209-223) to avoid gaps
(4) apply -> TriangleSelector::select_patch(facet_start, cursor, new_state,
        trafo_no_translate, triangle_splitting, highlight_by_angle_deg,
        select_partially)                                             (TriangleSelector.hpp:306)
     BFS expansion from the starting facet; triangles straddling the cursor boundary are split recursively (triangle_splitting)
     -> the brush boundary becomes finer than the triangle size. highlight_by_angle_deg = painting limited to overhangs
(5) smart/bucket fill: seed_fill_select_triangles (flood within smart_fill_angle of the normal, :693,857),
     bucket_fill_select_triangles (:861-864), the wheel adjusts the angle (:680), and on release
     seed_fill_apply_on_triangles(new_state) commits (:855)
(6) commit -> serialized into the ModelVolume's FacetsAnnotation (the §2 codec) + an undo snapshot
(7) render — TriangleSelectorGUI (GLGizmoPainterBase.hpp:33):
     a separate GLModel per state (m_iva_enforcers / m_iva_blockers / m_iva_seed_fills[3] /
     m_paint_contour, :71-79). On change, update_render_data() rebuilds only the painted triangles
     and draws them as an overlay on top of the main mesh. Multi-color MMU uses triangle_patches (:109-111)
(8) paint only inside the clipping plane (get_clipping_plane_in_volume_coordinates, around :805)
```

**Guidance for a web reimplementation**: keep the source mesh immutable and (1) reproduce the cache from step 1 with three-mesh-bvh
(2) port the TriangleSelector algorithm (BFS + splitting) to JS — its data structure is the same split tree as the §2 codec, so
serialization comes for free (3) rebuild the paint overlay as a BufferGeometry per state (the same strategy as step 7).
The brush radius must support both world units (SPHERE) and screen units (CIRCLE) to feel like the desktop app.

### 5.5 Render loop summary (one frame)

Combining the guide's §6.5 pass order with the contract above: background -> bed/plate (grid, logo, icons) ->
opaque volumes (gouraud, print_volume test) -> selection markers -> transparent volumes -> sequential interference regions ->
the active gizmo (+ paint overlay) -> (optional SSAO/FXAA) -> the ImGui overlay. The camera is a spherical orbit around
the target (guide §6.5.1). Hover is a CPU raycast every frame (§5.3).

---

## 6. G-code path calculation pipeline in detail

Every step from the slice result (ExPolygon) to actual G1/G2 lines. All measured from the sources.

### 6.1 Path data model — the ExtrusionEntity hierarchy

([ExtrusionEntity.hpp:165-179](../slicers/slicer/src/libslic3r/ExtrusionEntity.hpp#L165))

```
ExtrusionPath      = Polyline3 (point list) + mm3_per_mm + width + height + role
                     + overhang_degree + smooth_speed
ExtrusionLoop      = consecutive ExtrusionPaths (a closed loop, holding the seam split point)
ExtrusionEntityCollection = a tree of entities. With the no_sort flag (:33) true, the order is preserved
```

**This hierarchy is the slicer's "paths" themselves.** Speed and E values are not here — they are computed at emission time (§6.7).
The 20 roles are in guide §9. If a web app needs paths for preview, serializing this hierarchy with a custom export is
a shortcut compared with re-parsing the G-code text.

### 6.2 Width -> flow math (Flow -> E value)

- Cross-section formulas ([Flow.cpp:219-230](../slicers/slicer/src/libslic3r/Flow.cpp#L219)):
  - Normal extrusion: `mm3_per_mm = h × (w − h(1 − π/4))` — a stadium (rectangle + semicircular ends) cross-section
  - Bridges: `mm3_per_mm = π w²/4` — a circular cross-section
- E value conversion ([GCode.cpp:7382](../slicers/slicer/src/libslic3r/GCode.cpp#L7382), [Extruder.cpp:19](../slicers/slicer/src/libslic3r/Extruder.cpp#L19)):
  ```
  e_per_mm3 = filament_flow_ratio / filament cross-section (π d²/4)
  e_per_mm  = e_per_mm3 × path.mm3_per_mm        (divided by flow_ratio again at :7383)
  dE        = e_per_mm × segment length            (:7900)
  ```
  GCodeWriter handles relative E (`use_relative_e_distances`) versus absolute E mode.

### 6.3 Wall path generation (PerimeterGenerator)

- `process_classic()` ([PerimeterGenerator.cpp:1159](../slicers/slicer/src/libslic3r/PerimeterGenerator.cpp#L1159)) —
  **Repeatedly offsets the slice contour inward** by the line spacing (Clipper) -> wall_loops loops,
  with the remaining gaps becoming gap-fill paths. Overhanging stretches are tagged by splitting the polyline (role erOverhangPerimeter).
- `process_arachne()` (:2108) — the Arachne variable-width algorithm ([src/libslic3r/Arachne/](../slicers/slicer/src/libslic3r/Arachne/)):
  skeleton-based bead placement varies the width continuously on thin walls. An ExtrusionPath's width differs per segment.
- Infill paths: the per-pattern classes in [Fill/](../slicers/slicer/src/libslic3r/Fill/) turn a surface into polylines, then add
  anchors (short connections attaching to the wall) and convert them to ExtrusionPaths (the internal algorithms are per pattern; summarized here).

### 6.4 Ordering and seams

- Nearest-neighbor chaining: `chain_extrusion_entities(entities, start_near)`
  ([ShortestPath.hpp:21](../slicers/slicer/src/libslic3r/ShortestPath.hpp#L21)) — picks the entity closest to the previous end point
  and direction from the previous end point. `no_sort` collections (support, …) are skipped.
- Seams: `extrude_loop` -> `m_seam_placer.place_seam(layer, loop, last_pos, …)` ->
  `loop.split_at(seam point)` ([GCode.cpp:6626-6628](../slicers/slicer/src/libslic3r/GCode.cpp#L6626)) —
  the loop is cut at the seam into an open path before emission. The scarf joint also starts here.
  (SeamPlacer's internal scoring — visibility, angle, alignment — is in [SeamPlacer.cpp](../slicers/slicer/src/libslic3r/GCode/SeamPlacer.cpp); summarized here.)

### 6.5 Travel and retraction

([GCode.cpp:8254-8330](../slicers/slicer/src/libslic3r/GCode.cpp#L8254))

```
travel_to(point, role):
  needs_retraction(travel, role, lift_type) decides (:8263)
    — minimum travel distance, whether it stays inside the same island, …
  with reduce_crossing_wall, AvoidCrossingPerimeters.travel_to recomputes a wall-avoiding path (:8327)
    — when a detour exists the retraction can be skipped (could_be_wipe_disabled)
  retract (:8556): wipe (retracing the path) -> retraction -> z_hop (LiftType: normal/slope/spiral)
```

### 6.6 Speed decision (at emission time, `_extrude` :7215)

Priority (observed around GCode.cpp:7390-7465):
1. The config speed for the role (bridge_speed, ironing_speed, capped by scarf_joint_speed, …)
2. When no speed is set: derived from `filament_max_volumetric_speed / mm3_per_mm` (:7430)
3. The first `slow_down_layers` layers are slowed by linear interpolation (:7442+, accounting for the raft offset)
4. **The minimum layer time slowdown is not applied here but in the CoolingBuffer post-processing** (§6.8), which rewrites the G-code

### 6.7 Emission (GCodeWriter)

- `extrude_to_xy(point, dE)` ([GCodeWriter.cpp:1094](../slicers/slicer/src/libslic3r/GCodeWriter.cpp#L1094)) → `G1 X.. Y.. E..`
- `travel_to_xy` (:749), `retract` (:1165)
- With arc fitting on and an ArcSegment, G2/G3 is emitted ([GCode.cpp:7980](../slicers/slicer/src/libslic3r/GCode.cpp#L7980),
  [GCodeWriter.cpp:1116](../slicers/slicer/src/libslic3r/GCodeWriter.cpp#L1116)) — the path was arc-approximated beforehand by ArcFitter

### 6.8 Layer post-processing pipeline (the definitive order)

TBB parallel_pipeline ([GCode.cpp:4223-4231](../slicers/slicer/src/libslic3r/GCode.cpp#L4223)):

```
generator (produces the layer G-code)
  -> [spiral_mode]           when enabled: rewritten to a spiral Z with no layer boundaries
  -> [pressure_equalizer]    when enabled: smooths the extrusion rate changes
  -> cooling                 CoolingBuffer: computes layer time -> rewrites slowdowns/fan speeds (always)
  -> fan_mover               shifts fan commands along the time axis (always)
  -> [adaptive PA processor] injects adaptive pressure advance
  → output stream
```

So **the final speed and fan values are settled in text post-processing, not in path calculation**. That is exactly why
using GCodeProcessor (guide §9.1) is the accurate way to reproduce time estimates on the web.

**Stage 30 — the output streaming round (OOM tolerance).** Upstream, the pipeline above flows per layer and exits through the `output stream`
(nothing stays fully resident). Until then the mini kernel kept the whole `gw.s` (the g-code string) plus the whole `layersArr` (toolpaths) resident and then
had PE and GCodeProcessor re-parse the entire string (A3, triple residency) — the cause of OOM on large models. Stage 30 added a layer sink
(`set_layer_sink`) that emits a chunk per layer and frees the heap, feeds GCodeProcessor chunk by chunk via `process_buffer` (upstream is a streaming
parser), and lets the viewer take the data immediately as transferables. The streamed assembly is byte-identical to batch (an absolute requirement, `golden_stream.mjs`).
Heap peak: batch 126.9MB -> stream 107.1MB -> **economy 16.4MB (87% lower)** (318k segments, `bench_heap.mjs`).

**OOM scenario table (S-A~S-E)** — as addressed in stage 30:

| ID | Pressure point | Response (stage 30) |
|----|-----------|--------------|
| S-A1/A2/A3 | The kernel's whole g-code string · whole toolpath set · triple residency during post-processing | streamed per-layer emission and release, chunk feeding for PE/GCodeProcessor (A3 removed) |
| S-B1/B2 | Worker -> main transfer · a resident JS copy | transferables (the worker copy is freed at once), the main thread consumes chunks |
| S-B3 | The g-code text staying resident (for download) | kept as an array of chunks (OPFS append is optional and deferred) |
| S-C2 | Plate result textures staying resident | unselected plates keep only the cache (layer data); textures are rebuilt on switch |
| S-D2/A6 | OOM / hang | 3 detectors (worker error · WASM abort · 60s watchdog) -> recreate the worker -> economy re-slice (g-code only) -> offer a simplified retry |
| S-E1 | A failure partway through slicing all plates | the g-code of finished plates is preserved and offered; partial g-code is not |

### 6.9 Web mapping verdict

This pipeline (§6.3-6.8) tangles Clipper offsets, Arachne and seam scoring, so it belongs to the **WASM track**
(guide §10 track C) — a JS reimplementation is not recommended. The acceptance criterion is a golden G-code byte diff (guide §11.7).
What the web side actually needs is three things: (1) the E value / cross-section math (§6.2 — reproducing preview thickness) (2) ExtrusionEntity
serialization (§6.1 — preview data) (3) knowledge of the post-processing order (§6.8 — validating time estimates).

---

## 7. The upstream libvgcode toolpath rendering algorithm (broken down)

Source: [src/libvgcode/](../slicers/slicer/src/libvgcode/) — SegmentTemplate.cpp, Shaders.hpp `Segments_Vertex_Shader`. All measured.

### 7.1 Data model — the CPU builds no geometry
- `PathVertex` (PathVertex.hpp:17): one per G-code move endpoint — position, **height, width**, feedrate, role, type, …
- The GPU upload uses **texture buffers (TBO)**: `position_tex`, `height_width_angle_tex` (x=height, y=width, z=the join angle with the next segment, w=z-fighting bias), `color_tex`, and `segment_index_tex` (visible segment indices only).

### 7.2 Geometry — an 8-vertex template x GPU instancing
SegmentTemplate.cpp:17 (the upstream comment verbatim):
```
     /1-------6\
    / |       | \
   2--0-------5--7      <- the cross-section is a diamond (top/bottom/left/right); 2/7 are the front and back "spikes"
    \ |       | /
      3-------4
```
A single fixed 24-index (8 triangle) template per segment is repeated with `glDrawArraysInstanced(TRIANGLES, 24, segment count)` (:81) — **the CPU vertex buffer is independent of the segment count** (O(1) geometry in memory; only the TBOs are O(n)).

### 7.3 Vertex shader expansion (the core math, Shaders.hpp)
1. `gl_InstanceID` -> segment_index_tex -> fetch PathVertex a and b=a+1
2. compute `line_dir` — **vertical line guard**: when `|dot(dir,UP)|>0.9`, right=cross(X axis, dir) (the shader itself handles the degenerate case)
3. **View-dependent half box**: depending on whether the camera is to the side or above, 8 of the 16 corner sign table entries are chosen — only the half facing the camera is generated (halving overdraw)
4. corner = endpoint ± half_width·right ± half_height·up
5. **Miter join**: the spike vertices (2/7) are moved by `sin(|θ|/2)·dir + sign(θ)·cos(|θ|/2)·right` (θ = the precomputed neighbor segment angle) -> they interlock exactly with the neighboring bead at a corner. Unjoined ends get a pointed half_width cap via POINTY_CAPS
6. **Orca extension: `eye_position.z += bias`** — z-fighting is avoided with a **view-space z bias** (not world space). Upstream tackles this problem explicitly too
7. Lighting: two fixed lights (top/front) with diffuse + specular, the normal approximated as `normalize(pos−endpoint)`

### 7.4 Structural differences from our viewer (`toolpath_gpu.js`) — aligned to the upstream approach in stage 24
The original hand-rolled CPU ribbon builder (cuboids, a w/2 approximation, a world-space ε) kept producing giant plane artifacts -> stage 24 **ported the upstream algorithm
verbatim**, matching every item below with upstream. (Items that only differ in expression because of WebGL2 constraints are marked "upstream semantics preserved".)
| | Upstream libvgcode (desktop OpenGL) | Current viewer (stage 24, WebGL2) |
|---|---|---|
| Geometry | GPU instancing (an 8-vertex template, 24 indices) | Same — `InstancedBufferGeometry` (vertex_id_float) |
| Cross-section | Diamond + front/back spikes | Same (VERTEX_DATA verbatim) |
| Joins | Miter (angles precomputed with atan2) | Same (`buildSegmentData` uses the same formula) |
| Vertex shader | `Segments_Vertex_Shader_ES` (GLSL ES 3.0) | Ported as-is (`RawShaderMaterial`, GLSL3) |
| Data transfer | TBO (samplerBuffer) or a 2D texture fallback | 2D `DataTexture` + `texelFetch(tex_coord(id))` (the same as the upstream ES fallback path) |
| z-fighting | Diamond cross-section + position.z-=0.5h (the view-space bias is an optional extension) | Same — the diamond + z centering removes coplanarity at the source |
| Memory | O(n) textures + an O(1) template | Same (O(1) geometry + an O(n) DataTexture) |
| Visible range | Adjusts indices only | Segment indices in layer order -> `instanceCount`, O(1) |

---

## 8. Full survey of the desktop UI — the viewer reproduction roadmap

The result of surveying the upstream UI file by file and line by line, plus the section definitions the web viewer follows. (Measured 2026-07-24)

### S1. Custom top title bar — BBLTopbar.cpp:245-301  🟡 stage 27 (top bar + tabs + open; only placeholders for the File menu and undo/redo)
Logo · File menu · dropdown menu · save · **undo/redo buttons** · window controls.
-> Viewer: a file/save/undo/redo button bar. (The viewer's "header removal" only removed the builder listing — the desktop app does have a top bar.)
-> **Viewer (stage 27)**: a ~44px top bar = the logo "OrcaSlicer RE" + Open · the centered Prepare|Preview tabs · undo/redo. The File menu and window controls are deferred.
-> **Undo/redo (live)**: the viewport's own state only — object transforms, add/remove, per-object extruder and visibility, with Ctrl+Z / Ctrl+Shift+Z bound to the component's root rather than window so a host app keeps its own. Print settings are the host's props and painting needs a kernel `prepare` per step, so neither is on the stack (`packages-mit/src/core/history.js`).

### S2. View switching — the 3 ECanvasType modes (GLCanvas3D.hpp:510)  ✅ implemented in stage 25 (Prepare|Preview)
Prepare | Preview | Assemble, switched through assemble_view_toolbar (GLCanvas3D.cpp:1172). Assemble is lower priority.
-> **Viewer (stage 25, done)**: a Prepare|Preview toggle at the top left, automatic Preview after slicing, and gizmo/painting gating in Preview.
  Assemble remains lower priority.

### S3. The 3 toolbars  🟡 stage 27 (a 4-tool left gizmo rail + viewport add/delete + disabled arrange/orient)
The main top bar (add/addplate/arrange/orient/split/layersediting…) · 23 gizmos on the left · **collapse_toolbar** (collapses the sidebar, :1356).
arrange/orient need the backend (libslic3r Arrange/Orient) ported — a disabled button plus a tooltip is the honest first step.
-> **Viewer (stage 27)**: a vertical rail on the left = move/rotate/scale/support painting (the upstream toolbar_*_dark.svg). The viewport top = add and delete-selected + arrange/orient
  disabled ("backend port pending" tooltip). split/layersediting/collapse and the other 23 gizmos are deferred.

### S4. Sidebar (measured from the Plater.cpp:655-800 members, top to bottom)  🟡 stage 27 (printer/filament/process/objects + the bottom button bar)
-> **Viewer (stage 27)**: the right sidebar = (1) printer (bed and nozzle display) (2) filament (color swatches + T rows + and −, the color feeding through to objects) (3) process (the settings panel embedded)
  (4) the object list (print toggle eye, name, T selector, delete = 4 of the 6 columns) (5) the bottom [Slice ▾] + [Export G-code]. The preset combos, AMS, flushing,
  ObjectSettings/ObjectLayers, the plate/all split and send_gcode are deferred (they need the preset system and per-object kernel support first).
1. Printer section: title + icon, connect/sync/setting buttons, the printer combo, nozzle diameter/type, bed type, extruder group (single/dual)
2. Filament section: title + count, the 4 add/del/AMS/set buttons, the filament combo list (combos_filament[]), the purge_mode/flushing_volume buttons (the flush matrix)
3. Process section: combo_print (the preset combo) + the embedded ParamsPanel (sizer_params)
4. Search bar (m_search_bar) + SearchObjectDialog (Ctrl+F)
5. **The ObjectList tree — 6 columns** (GUI_ObjectList.cpp:406-413): name · print toggle (colPrint) · filament · support paint (colSupportPaint) · sinking (colSinking) · editing (colEditing)
6. **ObjectSettings** (per-object overrides) + **ObjectLayers** (settings per height band)
7. Bottom buttons: btn_reslice (**a plate/all split** — on_action_slice_all, Plater.cpp:5625) · btn_export_gcode · btn_send_gcode (sending to the printer, out of scope for the web)

### S5. Parameter panel — ParamsPanel.cpp  🟡 partially in stage 25 (some toggle-rules + dirty/reset)
- The **`Global | Objects` SwitchButton** (:265-267) — switching between global settings and the selected object's overrides (core UX) — **not implemented** (needs per-object kernel support first)
- Embeds m_tab_print/filament/printer, with a mode switch (Simple/Advanced/Expert)
- Shows values changed against the preset (dirty) + a reset arrow, and enables/disables based on toggle-rules
-> **Viewer (stage 25)**: `toggle_eval.js` translates the toggle-rules conditions into JS (with inlined locals) — applying only the fully translatable rules (grey + tooltip),
  while enum comparisons and unknown locals fail open. **An orange dirty dot + a ↺ reset** (baseline = the default). Translating all 231 rules and the Global|Objects switch are deferred.

### S6. Preview view  🟡 mostly done in stage 25 (6 of 11 view types + the dual slider + the role legend)
- The vertical slider carries **two values, lower/higher** (IMSlider.hpp:68-73, showing the range + a one-layer mode) plus a separate horizontal move slider
- 11 view type colorings (guide §9) — because the GPU renderer (the §7 port) is structured around a color texture, switching is just a recomputation
- A legend per role (time and share — already present in the GCodeProcessor result)
-> **Viewer (stage 25)**: the dual slider (lower/higher + single layer; an instanceCount cut plus the shader's layer_lo clip, O(1)) ✅. View types:
  **6** (Feature/Speed/Height/Width/Fan/Temp) — ports upstream's `DEFAULT_RANGES_COLORS` + `get_color_at`, recomputing only the color
  texture ✅. Speed/Fan/Temp are derived from settings because the kernel does not carry them (rationale recorded). The role legend shows the **length share** (a time share would need the kernel to
  export roles -> deferred). The remaining 5 views (ActualSpeed/PA/Accel/Jerk/VolFlow, …), the vertical CSS orientation and the horizontal move slider are deferred.

### S7~S9. The plate system (PartPlate — multiple plates + labels + icons) · shortcuts (the §4 table) + undo/redo · notification toasts
🟡 **S7 first pass — stage 29** (viewer orchestration, kernel unchanged): N plates (a single-row grid, add/remove in the top toolbar, labels 1·2·3…) · membership by position (the plate rectangle the object's origin sits on) · click a plate to select it (highlighted border) · [Slice ▾] -> current/all · all = slicing plate by plate in sequence with an individual `plate_N.gcode` download (no zip) · preview = the selected plate's cached result (swapped on switch). Each plate passes coordinates in local space and the G-code offset = plate origin + bed/2 (keeping the stage-28 coordinate contract). **Deferred**: per-plate setting overrides · lock/icons · auto arrange.

### Recommended implementation order  (progress: ✅ most of S6 · ✅ S2 · 🟡 part of S5 · 🟡 S7 first pass — stage 29)
S6 (dual slider + view types: the data is ready) -> S5 (switch + toggle-rules + dirty) -> S2 (view separation) -> S4-5/6 (ObjectList columns + ObjectLayers — including the per-object kernel extension) -> S4-1~3 (**the preset system = the watershed**: loading 66 vendors + inherits + an expression evaluator) -> S1 (top bar + undo/redo) -> S3 -> S7 (plates).

---

## 9. Full list of unimplemented features (as of 2026-07-25)

The gap inventory at stage 28. Basis: every deferral recorded per stage in the README plus measurements of settings.js and the kernel (42 mapped keys, 57 kernel parameters).

### A. Slicing kernel
1. **All custom G-code slots plus PlaceholderParser are unported** — no custom start/end/layer-change/filament-change (the EBNF spec is in §3; the kernel has a fixed preamble)
2. Infill patterns: about 10 of the desktop's 26 (5 upstream ports + 4 own approximations + gyroid_approx). Not ported: adaptive cubic, lightning (sparse paths), monotonic surfaces, the hilbert family, …
3. No **variable layer height** (adaptive layer height)
4. No **per-object/per-region settings or layer_config_ranges** (one global set — the prerequisite for the Global|Objects switch)
5. WipeTower: multi-layer scheduling, the rib mesh and PlaceholderParser tokens (each layer is generated independently)
6. PE defaults to lite (the upstream PE is opt-in), wall avoidance still fails in some cases, spiral mode leaves the bottom open, and zigzag crosses concave gaps
7. Advanced multi-material: shells/support/ironing are not separated per group, and there is no flush volume matrix or ramming
8. Brim variants (ears/outer-inner), the draft shield, and some prime tower position/size parameters are hardcoded (see the audit)
9. non-planar — absent from the desktop app too (confirmed out of scope)

### B. Settings surface (the largest gap)
- 42 keys mapped out of 907 options (**4.6%**) — the 57 kernel parameters are the ceiling. Large unmapped groups: temperature details (chamber, idle), retraction details (wipe, lift direction), individual accel/jerk, minimum layer time details, top/bottom surface pattern selection, sequence and time-lapse, precision (slice gap closing, resolution) and most of the rest
- The ratio_over reference chain of coFloatOrPercent is not generalized (only nozzle-based %), only the first element of vector options is editable, and "0=auto" is only partly handled

### C. Preset/profile system — entirely unimplemented ⭐the watershed
Loading 66 vendors, resolving inherits, compatibility conditions (an expression evaluator), the 3 preset combos, saving user presets, and making dirty relative to a preset (currently it is relative to the schema default)

### D. Project/formats
3MF **project** save/restore (round-tripping settings, arrangement and painting — the §1 spec exists), STEP (OCCT) and DRC (Draco) import, G-code import (a viewer-only mode), and the project save feature itself

### E. UI (the rest of SPECS §8)
~~undo/redo (placeholder only)~~ **✅ scene actions live** (transforms/add/remove/extruder/visibility; painting, the prime tower and the plate count are still outside it, and settings belong to the host) · ~~automatic re-seating after a gizmo transform~~ **✅ stage 29** (re-seats minZ -> 0 on drag commit for move/rotate/scale; the one difference from upstream is no sinking support — upstream keeps sinking (minZ<0), while we snap any minZ≠0 to 0 because the slicer cannot handle negative z) · arrange/orient (needs the backend) · ObjectSettings/ObjectLayers (needs A-4 first) · the Global|Objects switch · **the plate system (S7 🟡 first pass done — stage 29; per-plate settings, lock and auto arrange remain)** · the File menu · most shortcuts (the §4 table) · camera presets (Ctrl+0~6) / the view cube · notification toasts · the AMS/flushing dialogs · **the horizontal move slider** · option markers (seam/retraction/tool change indicators)

### F. Painting
Seam, MMU color and fuzzy skin painting are unimplemented (support enforcer/blocker only — the TriangleSelector base is already ported, so they are extensible) · only the SPHERE cursor (CIRCLE/POINTER/HEIGHT_RANGE/GAP_FILL are missing) · rough edges when aiming the brush from below

### G. Preview
The remaining 5 view types (ActualSpeed/PA/Accel/Jerk/VolFlow) · **Speed/Fan/Temp are derived from settings rather than measured** (needs the kernel to export per-segment feedrate/tool — including the Tool view colors) · a per-role time breakdown display · a G-code text view with line <-> toolpath linking

### H. Calibration
All 12 (PA/Flow/Temp/VFA/Retraction/Input Shaping/Cornering, …) are unimplemented — calib.cpp is UI-independent, so it is a porting candidate

### I. Declared out of scope (not to be implemented)
Device/network/multi-device, sending to a printer, the cloud — the desktop app's printer integration layer
