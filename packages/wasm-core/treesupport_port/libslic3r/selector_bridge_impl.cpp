// Stage-20 selector bridge impl (port world): owns a TriangleSelector over the current mesh, paints
// enforcer/blocker patches, and projects the painted facets to per-layer polygons via slice_mesh_slabs.
// Lives inside treesupport_port/libslic3r/ so every Slic3r include is file-relative (port-local).
#include "../../selector_bridge.h"
#include "selector_state.hpp"
#include "TriangleSelector.hpp"
#include "TriangleMesh.hpp"
#include "custom_facet_project.hpp"   // (stage 20) footprint projection
#include "MultiMaterialSegmentation.hpp"   // the exact per-layer segmentation (upstream)
#include <algorithm>
#include <array>
#include <memory>
#include <string>

using namespace Slic3r;

namespace {
    // Upstream reaches the seed-fill selection the same way: TriangleSelectorGUI is a SUBCLASS, because the split
    // triangles it has to walk are protected (TriangleSelector.hpp:475). The selection lives on the split tree and
    // not on the source facets, so there is no facet-index answer to hand back — it has to come out as geometry.
    class PreviewSelector : public TriangleSelector {
    public:
        using TriangleSelector::TriangleSelector;
        std::vector<float> seed_fill_overlay() const {
            std::vector<float> out;
            for (const Triangle& triangle : m_triangles) {
                if (!triangle.valid() || triangle.is_split() || !triangle.is_selected_by_seed_fill()) continue;
                for (int k = 0; k < 3; ++k) {
                    const stl_vertex& vertex = m_vertices[triangle.verts_idxs[k]].v;
                    out.push_back(vertex.x());
                    out.push_back(vertex.y());
                    out.push_back(vertex.z());
                }
            }
            return out;
        }
    };

    // One cache slot per EnforcerBlockerType value (index == the state number; 0 = NONE stays permanently empty).
    // get_facets() walks the whole split tree, so the states are filled lazily: the support path only ever asks for
    // ENFORCER/BLOCKER and must not pay for 14 extruder states it never paints.
    constexpr int STATE_COUNT = selector_bridge::STATE_EXTRUDER_MAX + 1;
    std::unique_ptr<TriangleMesh>      g_mesh;
    std::unique_ptr<PreviewSelector>   g_sel;
    std::array<indexed_triangle_set, STATE_COUNT> g_facets;   // cached painted facets per state (kernel coords)
    std::array<bool, STATE_COUNT>      g_cached{};
    const indexed_triangle_set         g_empty{};

    bool valid_state(int state) { return state >= selector_bridge::STATE_ENFORCER && state <= selector_bridge::STATE_EXTRUDER_MAX; }

    // Painting takes one more value than querying does: NONE. Writing NONE is exactly how upstream erases —
    // slicer/src/slic3r/GUI/Gizmos/GLGizmoPainterBase.cpp starts new_state at EnforcerBlockerType::NONE and only
    // overwrites it when shift is NOT held, so a shift+drag hands NONE straight to select_patch and the brushed
    // facets fall back to the default extruder. The query predicate must keep rejecting it: g_facets[0] is the
    // permanently empty slot described above, and get_facets(NONE) would walk the entire split tree to materialize
    // the one state nothing ever reads. Two predicates, because the two directions genuinely disagree about NONE.
    bool paintable_state(int state) { return state == selector_bridge::STATE_NONE || valid_state(state); }

    // The cached exact segmentation: [layer][state-1], the indexing merge_segmented_layers returns. It lives here
    // rather than next to the functions that use it so invalidate() can drop it — it is derived from the same marks,
    // so a stroke that changes the paint must not leave last run's regions readable.
    std::vector<std::vector<ExPolygons>> g_segmented;

    // "Has anything ever been marked on this selector?", maintained by the paint entry points instead of asked of
    // the mesh. Asking is not cheap: TriangleSelector::has_facets(state) SCANS every triangle (TriangleSelector.cpp
    // :1461) and returns false only after visiting all of them, so the has_paint() loop over 16 states costs 16 full
    // passes exactly when the answer is "nothing is painted" — 400ms of a 980k-facet export, measured in the app.
    // Conservative on purpose: erasing every mark leaves this true, which costs one wasted serialize() and never a
    // wrong answer. Cleared only where the marks genuinely cease to exist (a fresh selector).
    bool g_maybe_painted = false;
    void invalidate() {
        g_cached.fill(false);
        g_segmented.clear();
    }

    // The section plane every cursor is built with. Upstream keeps it on the gizmo's ObjectClipper and passes it
    // into each call; here it is one bridge-wide value because the viewer has exactly one section plane. Default
    // constructed == inactive (offset FLT_MAX), which is what the old hardcoded ClippingPlane() was.
    TriangleSelector::ClippingPlane g_clip;
    // Upstream's m_highlight_by_angle_threshold_deg, gated by m_paint_on_overhangs_only. 0 == off.
    float g_overhang_deg = 0.f;


    const indexed_triangle_set& facets_of(int state) {
        if (!valid_state(state)) return g_empty;
        if (!g_cached[state]) {
            g_facets[state] = [&]() -> indexed_triangle_set {
                if (g_sel) return g_sel->get_facets((EnforcerBlockerType)state);
                return indexed_triangle_set{};
            }();
            g_cached[state] = true;
        }
        return g_facets[state];
    }
}

// ---- port-world accessors (selector_state.hpp) ----
namespace Slic3r {
const indexed_triangle_set& selector_enforcer_its() { return facets_of(selector_bridge::STATE_ENFORCER); }
const indexed_triangle_set& selector_blocker_its()  { return facets_of(selector_bridge::STATE_BLOCKER); }
// Cheaper than materializing 16 triangle sets, but NOT cheap: the member has_facets(state) scans m_triangles and
// only returns early on a hit, so "nothing painted" costs 16 full passes over the mesh. That is affordable here
// because this is asked once per slice, next to work that is orders of magnitude larger. Do not reuse it on a hot
// path — the export takes g_maybe_painted instead. (It cannot: this must stay exact, and the flag is conservative,
// so an erased-clean selector would route a slice down the painted path it no longer belongs on.)
bool selector_has_paint() {
    if (!g_sel) return false;
    for (int state = selector_bridge::STATE_ENFORCER; state <= selector_bridge::STATE_EXTRUDER_MAX; ++state)
        if (g_sel->has_facets((EnforcerBlockerType)state)) return true;
    return false;
}
}

namespace selector_bridge {

void construct(const std::vector<float>& vertex_coords, const std::vector<int>& triangle_indices) {
    indexed_triangle_set triangle_set;
    triangle_set.vertices.reserve(vertex_coords.size() / 3);
    for (size_t i = 0; i + 2 < vertex_coords.size(); i += 3)
        triangle_set.vertices.emplace_back(vertex_coords[i], vertex_coords[i+1], vertex_coords[i+2]);
    triangle_set.indices.reserve(triangle_indices.size() / 3);
    for (size_t i = 0; i + 2 < triangle_indices.size(); i += 3)
        triangle_set.indices.emplace_back(triangle_indices[i], triangle_indices[i+1], triangle_indices[i+2]);
    g_mesh = std::make_unique<TriangleMesh>(triangle_set);
    g_sel  = std::make_unique<PreviewSelector>(*g_mesh);
    g_maybe_painted = false;
    invalidate();
}

bool reconstruct_keeping_paint(const std::vector<float>& vertex_coords, const std::vector<int>& triangle_indices) {
    const bool same_topology = g_sel && g_mesh && g_mesh->its.indices.size() == triangle_indices.size() / 3;
    if (!same_topology) {
        construct(vertex_coords, triangle_indices);
        return false;
    }
    TriangleSelector::TriangleSplittingData marks = g_sel->serialize();
    // `used_states` is the exact answer to "does this bitstream carry any mark", and serialize() just filled it in
    // — so a move restores the flag rather than guessing, at no extra cost. construct() below clears it first.
    bool marked = false;
    for (size_t state = 1; state < marks.used_states.size(); ++state)
        if (marks.used_states[state]) {
            marked = true;
            break;
        }
    construct(vertex_coords, triangle_indices);
    g_sel->deserialize(marks);
    g_maybe_painted = marked;
    invalidate();
    return true;
}

void clear() {
    if (g_mesh) g_sel = std::make_unique<PreviewSelector>(*g_mesh);
    g_maybe_painted = false;
    invalidate();
}

int  facet_count() {
    if (!g_mesh) return 0;
    return int(g_mesh->its.indices.size());
}
bool has_paint()   { return Slic3r::selector_has_paint(); }

namespace {
    // cursor_factory asserts on anything but these two, and an assert in a wasm build is a raw trap with no message,
    //  so an unknown value is read as the default brush instead of being passed through.
    TriangleSelector::CursorType shape_of(int cursor) {
        if (cursor == selector_bridge::CURSOR_CIRCLE) return TriangleSelector::CursorType::CIRCLE;
        return TriangleSelector::CursorType::SPHERE;
    }
    // Everything a stroke does after its cursor is built is identical whether that cursor is a ball or a capsule.
    void apply_patch(int facet, std::unique_ptr<TriangleSelector::Cursor>&& cursor_shape, int state) {
        Transform3d transform = Transform3d::Identity();
        g_sel->select_patch(facet, std::move(cursor_shape), (EnforcerBlockerType)state, transform,
                            /*triangle_splitting*/true, g_overhang_deg);
        if (state != selector_bridge::STATE_NONE) g_maybe_painted = true;   // NONE is the eraser — it never creates a mark
        invalidate();
    }
    bool paintable_hit(int facet, int state) {
        return g_sel && facet >= 0 && facet < int(g_mesh->its.indices.size()) && paintable_state(state);
    }
}

void set_overhang_limit(float degrees) {
    if (degrees > 0.f)
        g_overhang_deg = degrees;
    else
        g_overhang_deg = 0.f;
}

void set_clip_plane(float normal_x, float normal_y, float normal_z, float offset, bool enabled) {
    if (!enabled) {
        g_clip = TriangleSelector::ClippingPlane();
        return;
    }
    g_clip = TriangleSelector::ClippingPlane(std::array<float, 4>{normal_x, normal_y, normal_z, offset});
}

void paint(int facet, float hit_x, float hit_y, float hit_z, float camera_x, float camera_y, float camera_z, float radius, int state, int cursor) {
    if (!paintable_hit(facet, state)) return;
    Transform3d transform = Transform3d::Identity();
    apply_patch(facet, TriangleSelector::SinglePointCursor::cursor_factory(
        Vec3f(hit_x, hit_y, hit_z), Vec3f(camera_x, camera_y, camera_z), radius, shape_of(cursor), transform, g_clip), state);
}

void paint_stroke(int facet, float previous_x, float previous_y, float previous_z, float hit_x, float hit_y, float hit_z,
                  float camera_x, float camera_y, float camera_z, float radius, int state, int cursor) {
    if (!paintable_hit(facet, state)) return;
    Transform3d transform = Transform3d::Identity();
    // Capsule3D for the sphere brush, Capsule2D for the circle one — DoublePointCursor::cursor_factory picks by the
    //  same CursorType the single-point factory takes, so the two entry points cannot disagree about the shape.
    apply_patch(facet, TriangleSelector::DoublePointCursor::cursor_factory(
        Vec3f(previous_x, previous_y, previous_z), Vec3f(hit_x, hit_y, hit_z), Vec3f(camera_x, camera_y, camera_z), radius,
        shape_of(cursor), transform, g_clip), state);
}

// Both fills follow upstream's own order (GLGizmoPainterBase.cpp ~845-865): select, then apply the selection as a
// state. The trailing unselect is ours — upstream keeps the selection alive to highlight it under a moving cursor,
// while a headless one-shot call must leave the selector holding nothing, or the NEXT fill's `force_reselection`
// would be the only thing standing between the two clicks.
void seed_fill(int facet, float hit_x, float hit_y, float hit_z, float angle_deg, int state) {
    if (!paintable_hit(facet, state)) return;
    Transform3d transform = Transform3d::Identity();
    g_sel->seed_fill_select_triangles(Vec3f(hit_x, hit_y, hit_z), facet, transform, g_clip,
                                      angle_deg, g_overhang_deg, /*force_reselection*/true);
    g_sel->seed_fill_apply_on_triangles((EnforcerBlockerType)state);
    g_sel->seed_fill_unselect_all_triangles();
    if (state != selector_bridge::STATE_NONE) g_maybe_painted = true;
    invalidate();
}

void bucket_fill(int facet, float hit_x, float hit_y, float hit_z, float angle_deg, bool propagate, int state) {
    if (!paintable_hit(facet, state)) return;
    g_sel->bucket_fill_select_triangles(Vec3f(hit_x, hit_y, hit_z), facet, g_clip,
                                        angle_deg, propagate, /*force_reselection*/true);
    g_sel->seed_fill_apply_on_triangles((EnforcerBlockerType)state);
    g_sel->seed_fill_unselect_all_triangles();
    if (state != selector_bridge::STATE_NONE) g_maybe_painted = true;
    invalidate();
}

// Select without applying, and hand back what WOULD be filled. Upstream runs exactly this on every mouse move while
// a fill tool is active (GLGizmoPainterBase.cpp:929-965) and draws the result in a lighter shade, so a click is
// aimed rather than tried. The selection is left standing on the selector: the click that follows re-selects with
// force_reselection anyway, so nothing depends on clearing it, and leaving it costs one flag per split triangle
// instead of a second full walk on every pointer move.
std::vector<float> fill_preview(int facet, float hit_x, float hit_y, float hit_z, float angle_deg, int mode) {
    if (!g_sel || facet < 0 || facet >= int(g_mesh->its.indices.size())) return {};
    Transform3d transform = Transform3d::Identity();
    if (mode == selector_bridge::FILL_SMART)
        g_sel->seed_fill_select_triangles(Vec3f(hit_x, hit_y, hit_z), facet, transform, g_clip,
                                          angle_deg, g_overhang_deg, /*force_reselection*/true);
    else
        g_sel->bucket_fill_select_triangles(Vec3f(hit_x, hit_y, hit_z), facet, g_clip, angle_deg,
                                            /*propagate*/mode == selector_bridge::FILL_BUCKET, /*force_reselection*/true);
    return g_sel->seed_fill_overlay();
}
void fill_preview_clear() {
    if (g_sel) g_sel->seed_fill_unselect_all_triangles();
}

int painted_count(int state) { return int(facets_of(state).indices.size()); }

// ---- 3mf import ----------------------------------------------------------------------------------------------
// Port of upstream FacetsAnnotation::set_triangle_from_string (slicer/src/libslic3r/Model.cpp:3567), which is the
// only piece of the 3mf painting path that lives outside TriangleSelector: the selector already knows how to
// serialize/deserialize its split trees, but the 3mf spells that bitstream as hex text on the <triangle> tag.
// The whole batch is assembled into ONE TriangleSplittingData and deserialized in one call because deserialize()
// resets the selector — feeding it per facet would leave only the last one.
int apply_paint_hex(const std::vector<int>& facets, const std::vector<std::string>& hex) {
    if (!g_sel || facets.empty() || facets.size() != hex.size()) return 0;
    const int facet_total = facet_count();

    // triangles_to_split has to be strictly ascending by triangle_idx (upstream asserts it, and get_triangle_as_string
    // binary-searches it). The caller's order is whatever the 3mf listed, so sort here instead of trusting it —
    // and drop duplicates, which would otherwise put the same facet in the list twice with two bitstream offsets.
    std::vector<size_t> order;
    order.reserve(facets.size());
    for (size_t i = 0; i < facets.size(); ++i)
        if (facets[i] >= 0 && facets[i] < facet_total && !hex[i].empty()) order.push_back(i);
    std::sort(order.begin(), order.end(), [&facets](size_t left, size_t right) { return facets[left] < facets[right]; });
    order.erase(std::unique(order.begin(), order.end(),
                            [&facets](size_t left, size_t right) { return facets[left] == facets[right]; }), order.end());

    TriangleSelector::TriangleSplittingData data;
    int applied = 0;
    for (size_t i : order) {
        const std::string& text = hex[i];
        const size_t bitstream_start_idx = data.bitstream.size();
        data.triangles_to_split.emplace_back(facets[i], int(bitstream_start_idx));
        // The string is written most-significant nibble FIRST (get_triangle_as_string inserts each digit at the
        // front), so it reads back in reverse — four bits per digit, least significant bit first.
        bool malformed = false;
        for (auto it = text.crbegin(); it != text.crend(); ++it) {
            const char digit = *it;
            int nibble;
            if (digit >= '0' && digit <= '9')      nibble = digit - '0';
            else if (digit >= 'A' && digit <= 'F') nibble = 10 + (digit - 'A');
            else if (digit >= 'a' && digit <= 'f') nibble = 10 + (digit - 'a');   // upstream only writes uppercase; be liberal reading
            else {
                malformed = true;
                break;
            }
            for (int bit = 0; bit < 4; ++bit) data.bitstream.push_back(bool(nibble & (1 << bit)));
        }
        if (malformed) {
            // A truncated bitstream is worse than a missing facet: deserialize() walks it as a tree and would read
            // past this triangle's share into the next one's. Roll the facet back out entirely.
            data.bitstream.resize(bitstream_start_idx);
            data.triangles_to_split.pop_back();
            continue;
        }
        data.update_used_states(bitstream_start_idx);
        ++applied;
    }
    if (applied == 0) return 0;
    g_sel->deserialize(data);
    g_maybe_painted = true;
    invalidate();
    return applied;
}

// ---- 3mf export ----------------------------------------------------------------------------------------------
// Port of upstream FacetsAnnotation::get_triangle_as_string (slicer/src/libslic3r/Model.cpp:3542): each facet's
// share of the serialized bitstream, four bits per hex digit, most-significant nibble written FIRST (each digit is
// inserted at the front — the same order apply_paint_hex reads back in reverse). One serialize() up front and a
// linear walk, because upstream's per-facet variant binary-searches the same data once per triangle.
std::vector<std::pair<int, std::string>> export_paint_hex() {
    std::vector<std::pair<int, std::string>> out;
    // The flag, NOT has_paint(): serialize() walks every original triangle's split tree whether or not anything
    // was painted, and has_paint() is no cheaper — it scans the whole mesh once per state. Both cost ~400ms on a
    // 980k-facet model that carries no marks at all. g_maybe_painted answers the same question in one load.
    if (!g_sel || !g_maybe_painted) return out;
    const TriangleSelector::TriangleSplittingData data = g_sel->serialize();
    out.reserve(data.triangles_to_split.size());
    for (size_t entry = 0; entry < data.triangles_to_split.size(); ++entry) {
        const TriangleSelector::TriangleBitStreamMapping& mapping = data.triangles_to_split[entry];
        size_t offset = size_t(mapping.bitstream_start_idx);
        size_t end;
        if (entry + 1 < data.triangles_to_split.size())
            end = size_t(data.triangles_to_split[entry + 1].bitstream_start_idx);
        else
            end = data.bitstream.size();
        std::string hex;
        while (offset + 4 <= end) {
            int nibble = 0;
            for (int bit = 3; bit >= 0; --bit) nibble = (nibble << 1) | int(data.bitstream[offset + bit]);
            offset += 4;
            int digit;
            if (nibble < 10)
                digit = '0' + nibble;
            else
                digit = 'A' + (nibble - 10);
            hex.insert(hex.begin(), char(digit));
        }
        if (!hex.empty()) out.emplace_back(mapping.triangle_idx, std::move(hex));
    }
    return out;
}

std::vector<float> overlay(int state) {
    const indexed_triangle_set& painted = facets_of(state);
    std::vector<float> out;
    out.reserve(painted.indices.size() * 9);
    for (const auto& face : painted.indices)
        for (int k = 0; k < 3; ++k) {
            const Vec3f& vertex = painted.vertices[face[k]];
            out.push_back(vertex.x());
            out.push_back(vertex.y());
            out.push_back(vertex.z());
        }
    return out;
}

namespace {
    // Scaled per-layer Polygons -> the bridge's plain mm rings. Shared by both projectors so the two entry points
    // can only ever differ in the projection itself.
    std::vector<std::vector<std::vector<std::pair<double,double>>>>
    to_mm_rings(const std::vector<Polygons>& projected, size_t layer_count) {
        std::vector<std::vector<std::vector<std::pair<double,double>>>> out(layer_count);
        for (size_t i = 0; i < layer_count && i < projected.size(); ++i)
            for (const Polygon& polygon : projected[i]) {
                std::vector<std::pair<double,double>> ring;
                ring.reserve(polygon.points.size());
                for (const Point& point : polygon.points) ring.emplace_back(unscale<double>(point.x()), unscale<double>(point.y()));
                if (ring.size() >= 3) out[i].push_back(std::move(ring));
            }
        return out;
    }
    std::vector<float> to_float_heights(const std::vector<double>& slice_zs_mm) {
        std::vector<float> zs;
        zs.reserve(slice_zs_mm.size());
        for (double z : slice_zs_mm) zs.push_back(float(z));
        return zs;
    }
}

std::vector<std::vector<std::vector<std::pair<double,double>>>>
project_layers(const std::vector<double>& slice_zs_mm, int state) {
    const indexed_triangle_set& painted = facets_of(state);
    if (painted.indices.empty() || slice_zs_mm.empty())
        return std::vector<std::vector<std::vector<std::pair<double,double>>>>(slice_zs_mm.size());
    const std::vector<float> zs = to_float_heights(slice_zs_mm);
    return to_mm_rings(project_custom_facets_footprint(painted, zs), slice_zs_mm.size());   // XY footprint per layer
}


// ---- exact per-layer segmentation (upstream MultiMaterialSegmentation) ---------------------------------------------
namespace {
    ExPolygons rings_to_expolygons(const std::vector<std::vector<std::pair<double,double>>>& rings) {
        Polygons polygons;
        polygons.reserve(rings.size());
        for (const auto& ring : rings) {
            if (ring.size() < 3) continue;
            Polygon polygon;
            polygon.points.reserve(ring.size());
            for (const auto& point_mm : ring) polygon.points.emplace_back(scale_(point_mm.first), scale_(point_mm.second));
            polygons.push_back(std::move(polygon));
        }
        // The caller hands over its slicer's own output, where nesting is expressed by winding. union_ex is what
        // turns that back into contour+holes, and it is the same call upstream makes on its own layer input.
        return union_ex(polygons);
    }

    std::vector<std::pair<double,double>> polygon_to_ring(const Polygon& polygon) {
        std::vector<std::pair<double,double>> ring;
        ring.reserve(polygon.points.size());
        for (const Point& point : polygon.points) ring.emplace_back(unscale<double>(point.x()), unscale<double>(point.y()));
        return ring;
    }
}

bool segment_prepare(const std::vector<double>& slice_zs_mm, const selector_bridge::LayerRings& layer_rings,
                     int extruder_count, int top_shell_layers, int bottom_shell_layers,
                     double layer_height, double outer_wall_line_width, double segmented_region_max_width) {
    g_segmented.clear();
    if (!g_sel || slice_zs_mm.empty() || layer_rings.empty() || extruder_count < 2) return false;

    // State s addresses Extruder s, so the state count upstream wants is extruder_count + 1 — index 0 is the
    // default extruder, the one every unpainted facet prints with.
    const size_t num_facets_states = size_t(extruder_count) + 1;
    bool any_painted = false;
    for (int state = STATE_ENFORCER; state <= extruder_count && state <= STATE_EXTRUDER_MAX; ++state)
        if (painted_count(state) > 0) {
            any_painted = true;
            break;
        }
    if (!any_painted) return false;

    const size_t layer_count = std::min(slice_zs_mm.size(), layer_rings.size());
    std::vector<ExPolygons> layer_slices(layer_count);
    for (size_t i = 0; i < layer_count; ++i) layer_slices[i] = rings_to_expolygons(layer_rings[i]);

    std::vector<float> zs = to_float_heights(slice_zs_mm);
    zs.resize(layer_count);

    SegmentationShellParams shell;
    shell.top_shell_layers      = top_shell_layers;
    shell.bottom_shell_layers   = bottom_shell_layers;
    shell.layer_height          = float(layer_height);
    shell.outer_wall_line_width = outer_wall_line_width;

    // get_facets vs get_facets_strict is upstream's own split: the contour projection wants every facet carrying the
    // state, the shell projection only the ones entirely of it. Neither is cached — each is read once per run.
    auto facets_of_state = [](size_t state, bool strict) -> indexed_triangle_set {
        if (!g_sel || !valid_state(int(state))) return indexed_triangle_set{};
        if (strict) return g_sel->get_facets_strict((EnforcerBlockerType)state);
        return g_sel->get_facets((EnforcerBlockerType)state);
    };

    g_segmented = mm_segmentation_by_painting(layer_slices, zs, facets_of_state, num_facets_states, shell,
                                              float(segmented_region_max_width),
                                              IncludeTopAndBottomLayers::Yes, [](){});
    return !g_segmented.empty();
}

selector_bridge::LayerRings segment_regions(int state) {
    selector_bridge::LayerRings out(g_segmented.size());
    if (!valid_state(state)) return out;
    const size_t column = size_t(state) - 1;
    for (size_t layer_idx = 0; layer_idx < g_segmented.size(); ++layer_idx) {
        const std::vector<ExPolygons>& by_extruder = g_segmented[layer_idx];
        if (column >= by_extruder.size()) continue;
        for (const ExPolygon& expolygon : by_extruder[column]) {
            out[layer_idx].push_back(polygon_to_ring(expolygon.contour));
            for (const Polygon& hole : expolygon.holes) out[layer_idx].push_back(polygon_to_ring(hole));
        }
    }
    return out;
}

void segment_clear() { g_segmented.clear(); }

} // namespace selector_bridge
