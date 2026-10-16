// Stage-20 bridge: plain-type interface to the ported TriangleSelector (manual support painting).
// slicer_core.cpp includes ONLY this header and embind-exports the functions; the Slic3r/facade types
// live in the port-world impl (treesupport_port/libslic3r/selector_bridge_impl.cpp), which shares the
// painted enforcer/blocker its with treesupport_bridge (both port world). Mesh coords are the kernel's
// transformed coords (XY-centered, z-min=0) so facet indices + hit points line up with the kernel slice.
#pragma once
#include <string>
#include <vector>
#include <utility>

namespace selector_bridge {

// Painting state = the upstream EnforcerBlockerType (slicer/src/libslic3r/TriangleSelector.hpp), which is one enum
// serving both jobs: NONE=0, ENFORCER=1 (== Extruder1), BLOCKER=2 (== Extruder2), Extruder3..Extruder16 = 3..16.
// So a single int addresses the support enforcer/blocker pair AND every MMU extruder — hence the bridge takes the
// state number rather than a bool. Every QUERY (painted_count/overlay/project_layers) rejects anything outside
// [1,16] and answers "nothing painted"; paint() additionally accepts STATE_NONE, which is the erase — see below.
enum : int {
  STATE_NONE      = 0,
  STATE_ENFORCER  = 1,   // == Extruder1
  STATE_BLOCKER   = 2,   // == Extruder2
  STATE_EXTRUDER_MAX = 16,
};

// Build the selector from a WELDED mesh in kernel coords: vertex_coordinates = flat x,y,z; triangle_indices = flat 3 indices/face.
// Face order must match the kernel's triangle order so a viewer raycast face index == selector facet.
void construct(const std::vector<float>& vertex_coordinates, const std::vector<int>& triangle_indices);
// Rebuild the selector on a mesh with the SAME topology and keep every mark. Moving, rotating or scaling a model
// changes its coordinates and nothing else, so the selector has to be rebuilt (the brush and the layer projection
// both work on real positions) while the paint has no reason to go. Upstream's own persistence does exactly this:
// the marks live in a TriangleSplittingData keyed by facet index, which a transform does not touch — it is the same
// data 3MF stores and undo/redo replays. Returns false, and falls back to a plain construct, when the face count
// differs: a different model's facet 7 is not this one's, and pretending otherwise would move the paint elsewhere.
bool reconstruct_keeping_paint(const std::vector<float>& vertex_coordinates, const std::vector<int>& triangle_indices);
void clear();
int  facet_count();
bool has_paint();                    // true when ANY state (1..16) has painted facets

// Brush shape for paint(). Upstream's CursorType has five entries but its own cursor_factory asserts on all but
// these two — the other three are separate tools (seed/bucket fill below), not cursors. SPHERE is 0 so a caller
// that sends nothing keeps the brush the support painting has always used.
enum : int {
  CURSOR_SPHERE = 0,   // a ball around the hit: also catches the far wall of a thin part
  CURSOR_CIRCLE = 1,   // a disc facing the camera: only the surface being looked at
};

// Paint a brush patch anchored at facet `facet` around world hit point (hit_x,hit_y,hit_z), camera at
// (camera_x,camera_y,camera_z), radius mm, in the given state (STATE_ENFORCER / STATE_BLOCKER / an extruder 3..16).
// STATE_NONE is a legal state HERE and only here: it is the eraser, writing NONE over the brushed facets so they
// return to the default extruder — the same thing upstream's shift+drag does (GLGizmoPainterBase.cpp ~732-748).
// The embind layer does NOT let a state argument carry NONE (bindings.cpp): erasing has its own entry point there,
// because embind coerces a JS `false` to the int 0 == NONE and a boolean must never be able to erase.
// Upstream's `highlight_by_angle_deg` (select_patch's last-but-one argument), as a MODE rather than a per-stroke
// argument — it is gizmo state upstream too (m_paint_on_overhangs_only). Non-zero restricts every stroke and every
// fill to facets overhanging by more than that angle; 0, the default, paints everything.
void set_overhang_limit(float degrees);

void paint(int facet, float hit_x, float hit_y, float hit_z, float camera_x, float camera_y, float camera_z, float radius, int state, int cursor);

// The CAPSULE swept between two consecutive stroke samples — upstream's DoublePointCursor (GLGizmoPainterBase.cpp
// :878 builds one for every adjacent pair of projected mouse positions). A pointer stream is sampled, not
// continuous: paint() alone leaves a drag as a row of separate balls with gaps between them, and the faster the
// drag the wider the gaps. (previous_*) is the previous sample, (hit_*) this one; everything else matches paint().
void paint_stroke(int facet, float previous_x, float previous_y, float previous_z, float hit_x, float hit_y, float hit_z,
                  float camera_x, float camera_y, float camera_z, float radius, int state, int cursor);

// The section plane, upstream's object clipper (Alt+wheel over the canvas — GLGizmoPainterBase.cpp:709). Every
// cursor and both fills reject facets on the far side of it, which is the only way to reach an interior surface
// with a brush. `normal`+`offset` are in KERNEL coords (a point p is clipped when normal.p - offset > 0);
// `enabled` false restores upstream's inactive plane, which clips nothing.
void set_clip_plane(float normal_x, float normal_y, float normal_z, float offset, bool enabled);

int  painted_count(int state);       // number of painted facets of that state (UI feedback)

// The two fill tools, upstream's Smart fill and Bucket fill (GLGizmoPainterBase.cpp ~845-865). Both are one click
// rather than a drag, so neither takes a radius or a camera: what they select comes from the mesh's own topology.
//  · seed_fill  — flood outward from the hit facet while the angle between neighbouring facets stays under
//    `angle_deg`, i.e. paint the smooth feature the user clicked. This is the one a radius brush cannot do:
//    covering a whole curved face by dragging leaves gaps and spills over the edges.
//  · bucket_fill — flood across facets that share the hit facet's CURRENT state, stopping where the state changes
//    or the edge is sharper than `angle_deg`. With `propagate` false it marks only the facet under the cursor,
//    which is exactly upstream's "Triangles" (POINTER) cursor — the same call with propagation off.
// STATE_NONE is accepted by both, on the same reasoning as paint(): it is the eraser.
void seed_fill(int facet, float hit_x, float hit_y, float hit_z, float angle_deg, int state);
void bucket_fill(int facet, float hit_x, float hit_y, float hit_z, float angle_deg, bool propagate, int state);

// A fill SELECTED but not applied — upstream runs exactly this on every mouse move while a fill tool is active
// (GLGizmoPainterBase.cpp:929-965) and draws the result in a lighter shade, so a click is aimed rather than tried.
// Without it a fill is only discoverable by doing it and undoing it, which on a 40k-facet mesh is two full rebuilds.
// Returns the selected triangles as flat x,y,z (3 vertices per triangle), the same shape overlay() returns.
enum : int {
  FILL_SMART    = 0,   // flood the smooth feature under the cursor (seed fill)
  FILL_BUCKET   = 1,   // flood everything sharing the hit facet's current state
  FILL_TRIANGLE = 2,   // exactly one facet: bucket fill with the propagation off
};
std::vector<float> fill_preview(int facet, float hit_x, float hit_y, float hit_z, float angle_deg, int mode);
void fill_preview_clear();

// Overlay triangles for the painted state: flat x,y,z per vertex, 3 vertices per triangle (three.js render).
std::vector<float> overlay(int state);

// Load painting straight out of a 3mf. Upstream stores a painted facet as a hex string on the <triangle> tag
// (Format/bbs_3mf.cpp: paint_color / paint_supports), each being that facet's split tree written as a bitstream —
// the SAME encoding TriangleSelector::serialize() produces, so the marks arrive as a full sub-triangle tree rather
// than one state per source facet. `facets[i]` is the facet index `hex[i]` belongs to; the pair arrays must be the
// same length, and the facet numbering must be the one this selector was constructed with.
// REPLACES every existing mark (upstream's deserialize resets first) — this is an import, not a merge.
// Returns how many of the given facets were actually loaded; 0 means nothing was applied and the selector is untouched.
int apply_paint_hex(const std::vector<int>& facets, const std::vector<std::string>& hex);

// The reverse of apply_paint_hex: every marked facet's split tree as the hex text a 3mf stores on its
// <triangle> tag — a port of upstream FacetsAnnotation::get_triangle_as_string (slicer/src/libslic3r/Model.cpp:3542),
// batched over serialize() so the bitstream is walked once instead of binary-searched per facet. Facet indices are
// the selector's own (the merged mesh's); the caller owns rebasing them onto per-object numbering. Facets whose
// tree decodes entirely to NONE still appear (upstream exports them too); untouched facets do not.
std::vector<std::pair<int, std::string>> export_paint_hex();

// Project the painted facets of one state to per-layer polygons (mm rings) at the given slice-z's,
// via slice_mesh_slabs — the grid/tree_lite kernel path consumes these. one entry per z.
std::vector<std::vector<std::vector<std::pair<double,double>>>>
project_layers(const std::vector<double>& slice_zs_mm, int state);


// Rings in mm: [layer][ring][point] — the shape project_layers above already returns. A hole is a ring wound the
// other way, which is what clipper reads a hole as.
using LayerRings = std::vector<std::vector<std::vector<std::pair<double,double>>>>;

// Exact per-layer multi-material segmentation: upstream's MultiMaterialSegmentation.cpp, which partitions the LAYER
// CONTOUR against the painted facets rather than approximating the volume behind them. That is the whole difference
// in the result — a patch keeps its own outline instead of becoming the band of layers it spans.
//  `layer_rings` is the caller's own sliced contour, one entry per z in `slice_zs_mm`, handed over as it came out of
//  the slicer. The run is cached because it costs one Voronoi diagram per layer, which must not be paid again per
//  extruder; segment_regions() then reads one extruder's share out of it.
//  Returns false when there is nothing to segment (no paint, no layers, no selector) — the caller keeps its own path.
bool segment_prepare(const std::vector<double>& slice_zs_mm, const LayerRings& layer_rings,
                     int extruder_count, int top_shell_layers, int bottom_shell_layers,
                     double layer_height, double outer_wall_line_width, double segmented_region_max_width);
// The area extruder `state` owns on every layer (state s == Extruder s == tool s-1), from the cached run above.
LayerRings segment_regions(int state);
void segment_clear();

} // namespace selector_bridge
