#include <chrono>
// Stage-17 bridge impl: build a facade PrintObject from kernel slice rings (mm), run the REAL organic
// TreeSupport (stage-16 port), and flatten SupportLayer::support_fills back to plain polylines (mm).
// This is the ONLY TU where the kernel meets the treesupport_port Slic3r/facade world. Compiled with
// the treesupport_port isolation -I set (so "Print.hpp" == the facade, "../*" == port-local copies);
// its objects are linked into the main slicer_core build, resolving shared symbols (Point/Polygon/
// PrintConfig/Arachne/Fill/Geometry/Voronoi/clipper) against the main build's already-compiled copies
// (headers verified ABI-identical: PrintConfig.hpp/Polygon.hpp identical, Point.hpp only differs by an
// include-mechanism change that resolves to the same std::allocator).
// This TU lives INSIDE treesupport_port/libslic3r/ so every Slic3r include below is file-relative
// (resolves to the port-local facade / real headers) exactly like the Support/*.cpp — the em++ FS
// sandbox does not reliably honor -I into the port tree, but file-relative includes always resolve.
// WP2: generate_normal() added — it drives the upstream PrintObjectSupportMaterial (a port of SupportMaterial.cpp)
//  on the same facade. Facade construction is shared via build_facade() (tree/normal differ only in the config type/style).
#include "../../treesupport_bridge.h"   // file-relative -> wasm-core/treesupport_bridge.h (plain types)
#include <tbb/stub_parallel.h>          // (WP-tbb) parallel-capable scope limited to generate_normal + the real progress counter
#include <tbb/parallel_for.h>
#include <tbb/blocked_range.h>
#include <cstdint>

namespace treesupport_bridge {
unsigned long progress_addr() { return (unsigned long)(uintptr_t)&tbb_stub::prog(); }
unsigned long cancel_addr() { return (unsigned long)(uintptr_t)&tbb_stub::cancel(); }
}

#include "Print.hpp"
#include "Layer.hpp"
#include "I18N.hpp"
#include "ClipperUtils.hpp"
#include "ExtrusionEntity.hpp"
#include "ExtrusionEntityCollection.hpp"
#include "Surface.hpp"
#include "selector_state.hpp"   // (stage 20) painted enforcer/blocker its from the selector (port world)
#include "Support/TreeSupport.hpp"
#include "Support/SupportMaterial.hpp"  // WP2: upstream normal (grid/snug) support

using namespace Slic3r;

// The treesupport group references Slic3r::I18N::translate_fn (support status strings). The main build
// does not define it, so the bridge (the group's root TU) provides the single definition (no-op).
namespace Slic3r { namespace I18N { translate_fn_type translate_fn = nullptr; } }

namespace {

// Recursively flatten one ExtrusionEntity into plain polylines (mm) with width.
void flatten_entity(const ExtrusionEntity *entity, std::vector<treesupport_bridge::Line> &out)
{
    if (entity == nullptr) return;
    if (const auto *collection = dynamic_cast<const ExtrusionEntityCollection*>(entity)) {
        for (const ExtrusionEntity *child : collection->entities) flatten_entity(child, out);
        return;
    }
    if (const auto *loop = dynamic_cast<const ExtrusionLoop*>(entity)) {
        for (const ExtrusionPath &loop_path : loop->paths) flatten_entity(&loop_path, out);
        return;
    }
    if (const auto *multi_path = dynamic_cast<const ExtrusionMultiPath*>(entity)) {
        for (const ExtrusionPath &sub_path : multi_path->paths) flatten_entity(&sub_path, out);
        return;
    }
    if (const auto *path = dynamic_cast<const ExtrusionPath*>(entity)) {
        treesupport_bridge::Line line;
        line.width      = double(path->width);
        line.role       = int(path->role());        // WP3: preserves the base(14)/interface(15)/ironing(8) distinction
        line.height     = double(path->height);     // WP3: upstream extrusion height (differs from the layer height on bridging contact layers, etc.)
        line.mm3_per_mm = path->mm3_per_mm;         // WP3: upstream volumetric flow -> lets the kernel reproduce E exactly as upstream
        line.pts.reserve(path->polyline.points.size());
        // ExtrusionPath::polyline is a Polyline3 (points carry Z); take X/Y only.
        for (const auto &point : path->polyline.points) {
            const coord_t point_x = point.x();
            const coord_t point_y = point.y();
            line.pts.emplace_back(unscale<double>(point_x), unscale<double>(point_y));
        }
        if (line.pts.size() >= 2) out.push_back(std::move(line));
        return;
    }
}

// List of mm rings -> scaled Polygons (rings with fewer than 3 points are ignored)
Polygons rings_to_polys(const std::vector<treesupport_bridge::Ring> &rings)
{
    Polygons polygons;
    for (const treesupport_bridge::Ring &ring : rings) {
        if (ring.size() < 3) continue;
        Polygon polygon;
        polygon.points.reserve(ring.size());
        for (const auto &point_mm : ring)
            polygon.points.emplace_back(coord_t(scale_(point_mm.first)), coord_t(scale_(point_mm.second)));
        polygons.emplace_back(std::move(polygon));
    }
    return polygons;
}

// WP2: shared facade builder — config (common part), slicing_params, the Layer graph and the painted facets.
//  support_type/support_style and the style-specific config are set by each entry point.
void build_facade(Print &facade_print, PrintRegion &facade_region, PrintObject &print_object,
                  const std::vector<std::vector<treesupport_bridge::Ring>> &object_slices_mm,
                  const std::vector<double> &layer_print_z_mm,
                  const treesupport_bridge::Params &params)
{
    const size_t layer_count = object_slices_mm.size();
    print_object.m_print = &facade_print;
    print_object.m_shared_regions.all_regions = { &facade_region };
    facade_print.m_objects = { &print_object };
    print_object.m_model_object = new ModelObject();

    print_object.m_config.enable_support.value = true;
    print_object.m_config.layer_height.value   = params.layer_height_mm;
    print_object.m_config.support_threshold_angle.value = int(params.support_threshold_angle);
    if (params.support_line_width_mm > 0) {   // (stage 19) explicit support extrusion width -> support flow -> per-path width
        print_object.m_config.support_line_width.value = params.support_line_width_mm;
        print_object.m_config.support_line_width.percent = false;
    }
    if (params.line_width_mm > 0) {           // WP1: enables the lslices_extrudable thin-region filter and the auto-threshold flow fallback
        print_object.m_config.line_width.value = params.line_width_mm;
        print_object.m_config.line_width.percent = false;
    }
    // WP1: wires up the 4 parameters that used to be parsed and discarded, plus the z/xy gap family (upstream config key names kept)
    print_object.m_config.support_top_z_distance.value        = params.support_top_z_distance;
    print_object.m_config.support_bottom_z_distance.value     = params.support_bottom_z_distance;
    print_object.m_config.support_object_xy_distance.value    = params.support_xy_distance;
    print_object.m_config.support_object_first_layer_gap.value= params.first_layer_gap_mm;
    print_object.m_config.support_interface_top_layers.value  = params.interface_top_layers;
    print_object.m_config.support_interface_bottom_layers.value = params.interface_bottom_layers; // -1 => same as top (upstream convention)
    print_object.m_config.support_on_build_plate_only.value   = params.on_build_plate_only;
    print_object.m_config.support_angle.value                 = params.support_angle_deg;
    print_object.m_config.support_interface_spacing.value     = params.interface_spacing_mm;
    print_object.m_config.support_base_pattern_spacing.value  = params.base_pattern_spacing_mm;
    SupportMaterialInterfacePattern interface_pattern = smipAuto;
    if (params.interface_pattern == "rectilinear")                 interface_pattern = smipRectilinear;
    else if (params.interface_pattern == "concentric")             interface_pattern = smipConcentric;
    else if (params.interface_pattern == "rectilinear_interlaced") interface_pattern = smipRectilinearInterlaced;
    else if (params.interface_pattern == "grid")                   interface_pattern = smipGrid;
    print_object.m_config.support_interface_pattern.value = interface_pattern;
    SupportMaterialPattern base_pattern = smpDefault;
    if (params.base_pattern == "rectilinear")           base_pattern = smpRectilinear;
    else if (params.base_pattern == "rectilinear-grid") base_pattern = smpRectilinearGrid;
    else if (params.base_pattern == "honeycomb")        base_pattern = smpHoneycomb;
    else if (params.base_pattern == "lightning")        base_pattern = smpLightning;
    else if (params.base_pattern == "none")             base_pattern = smpNone;
    print_object.m_config.support_base_pattern.value = base_pattern;
    // WP1: tree shape keys (consumed by TreeSupportSettings, TreeSupportCommon.hpp:79~95 — harmless on the normal path)
    print_object.m_config.tree_support_branch_angle_organic.value    = params.branch_angle_deg;
    print_object.m_config.tree_support_angle_slow.value              = params.angle_slow_deg;
    print_object.m_config.tree_support_branch_diameter_organic.value = params.branch_diameter_mm;
    print_object.m_config.tree_support_branch_distance_organic.value = params.branch_distance_mm;
    print_object.m_config.tree_support_branch_diameter_angle.value   = params.branch_diameter_angle_deg;
    print_object.m_config.tree_support_tip_diameter.value            = params.tip_diameter_mm;
    print_object.m_config.tree_support_top_rate.value                = params.top_rate_pct;
    print_object.m_config.tree_support_wall_count.value              = params.wall_count;
    // The twin keys read by the non-organic (slim/strong/hybrid) path (TreeSupport.cpp:651/2657/3405) get the same values
    print_object.m_config.tree_support_branch_angle.value    = params.branch_angle_deg;
    print_object.m_config.tree_support_branch_diameter.value = params.branch_diameter_mm;
    print_object.m_config.tree_support_branch_distance.value = params.branch_distance_mm;
    // WP2: keys used only by the normal path (harmless for tree — organic never reads them)
    print_object.m_config.support_expansion.value             = params.support_expansion_mm;
    print_object.m_config.bridge_no_support.value             = params.bridge_no_support;
    print_object.m_config.support_remove_small_overhang.value = params.remove_small_overhang;
    print_object.m_config.support_threshold_overlap.value     = params.threshold_overlap_pct;
    print_object.m_config.support_threshold_overlap.percent   = true;

    // Stage 31: the kernel hands over a model centered on the origin (bbox center = 0; small coordinates = the safe zone). Leaving printable_area in the
    //  positive quadrant [0,bed] makes TreeSupport's m_machine_border clip (intersection_ex, TreeSupport.cpp:2188/2193/2197)
    //  cut away all support on the model's negative X/Y half — the "support on one side only" bug. So the bed is placed **centered on the origin**
    //  ([-bed/2,bed/2]) and an origin-centered model fits entirely inside (a symmetric model -> symmetric support).
    //  Stage 35: ...and the border has to follow the SHIFT, not just the centring. The caller moves the model to the
    //  origin by its own bbox centre (support.cpp tcx/tcy) and moves the branches back afterwards, so a border left
    //  at [-bed/2,bed/2] describes a bed centred on the MODEL — it travels with it, and a model near the bed edge
    //  gets branches clipped against a bed that is not there (measured: support 2.6mm past a 200mm bed's edge while
    //  the model itself fit exactly). Subtracting the shift pins the border to the real bed, which is what upstream
    //  does with m_machine_border.translate(plate_offset - instance.shift) (TreeSupport.cpp:657).
    const double half_bed_width = params.bed_width_mm * 0.5;
    const double half_bed_depth = params.bed_depth_mm * 0.5;
    const double shift_x = params.model_shift_x_mm;
    const double shift_y = params.model_shift_y_mm;
    facade_print.m_config.printable_area.values  = { Vec2d(-half_bed_width-shift_x,-half_bed_depth-shift_y), Vec2d(half_bed_width-shift_x,-half_bed_depth-shift_y),
                                                     Vec2d(half_bed_width-shift_x,half_bed_depth-shift_y), Vec2d(-half_bed_width-shift_x,half_bed_depth-shift_y) };
    facade_print.m_config.nozzle_diameter.values = { params.nozzle_mm };
    facade_print.m_config.printable_height.value = params.printable_height_mm;   // WP1: BuildVolume height (previously hardcoded to 100mm)
    facade_print.m_config.independent_support_layer_height.value = params.independent_support_layer_height; // WP1: gap quantization switch
    // Stage 33: wires up the path simplification tolerance. TreeSupportCommon.hpp:56 takes this as TreeSupportSettings::resolution
    //  and uses it in TreeSupport3D's polygons_simplify. When unset, the PrintConfig default of 0.01 applies.
    if (params.resolution_mm > 0.0) facade_print.m_config.resolution.value = params.resolution_mm;

    PrintInstance instance;
    instance.print_object = &print_object;
    instance.shift = Point(0,0);
    print_object.m_instances.push_back(instance);

    const double layer_height = params.layer_height_mm;
    double first_layer_height;
    if (params.first_layer_height_mm > 0.0)
        first_layer_height = params.first_layer_height_mm;
    else
        first_layer_height = layer_height;
    print_object.m_slicing_params.layer_height             = layer_height;
    print_object.m_slicing_params.min_layer_height         = layer_height;
    print_object.m_slicing_params.max_layer_height         = layer_height;
    print_object.m_slicing_params.max_suport_layer_height  = layer_height;   // upstream create_from_config: max_layer_height when support is enabled
    // (stage-19 z alignment -> extended in WP1) The kernel z grid is first_layer_height + idx*layer_height, so the first layer height is
    // carried over verbatim (matching upstream initial_layer_print_height). With first_layer_height unset (0) it stays layer_height as before.
    print_object.m_slicing_params.first_print_layer_height  = first_layer_height;
    print_object.m_slicing_params.first_object_layer_height = first_layer_height;
    print_object.m_slicing_params.object_print_z_min       = 0.0;
    // ---- WP1: port of the gap formulas from upstream SlicingParameters::create_from_config (Slicing.cpp:80~190) ----
    // Previously gap_support_object / gap_object_support stayed 0, giving z_distance_top_layers=0
    // (support glued to the model). Zero-gap interface detection and the layer quantization based on independent mode are ported identically.
    {
        const double top_gap    = params.support_top_z_distance;
        const double bottom_gap = params.support_bottom_z_distance;
        const bool zero_top_gap = (top_gap == 0.0);
        int bottom_interface_layers;
        if (params.interface_bottom_layers < 0)
            bottom_interface_layers = params.interface_top_layers;
        else
            bottom_interface_layers = params.interface_bottom_layers;
        print_object.m_slicing_params.zero_gap_interface_top    = (params.interface_top_layers > 0) && zero_top_gap;
        print_object.m_slicing_params.zero_gap_interface_bottom = (bottom_interface_layers > 0) && (bottom_gap == 0.0 || zero_top_gap);
        auto quantize = [&](double gap) {
            if (params.independent_support_layer_height) return gap;
            return std::round(gap / layer_height + EPSILON) * layer_height;   // upstream: round(gap/layer_height + EPSILON)*layer_height
        };
        if (print_object.m_slicing_params.zero_gap_interface_top)
            print_object.m_slicing_params.gap_support_object = 0.0;
        else
            print_object.m_slicing_params.gap_support_object = quantize(top_gap);
        if (print_object.m_slicing_params.zero_gap_interface_bottom)
            print_object.m_slicing_params.gap_object_support = 0.0;
        else
            print_object.m_slicing_params.gap_object_support = quantize(bottom_gap);
    }

    coord_t min_x = 0;
    coord_t min_y = 0;
    coord_t max_x = 0;
    coord_t max_y = 0;
    bool bbox_init = false;
    Layer *previous_layer = nullptr;
    for (size_t i = 0; i < layer_count; ++i) {
        const double print_z = layer_print_z_mm[i];
        double layer_thickness;
        if (i == 0)
            layer_thickness = first_layer_height;
        else
            layer_thickness = layer_height;
        Layer *layer = print_object.add_layer(int(i), layer_thickness, print_z, print_z - layer_thickness * 0.5);
        layer->lower_layer = previous_layer;
        if (previous_layer) previous_layer->upper_layer = layer;   // WP1: link upward too, exactly like the upstream layer graph
        // WP1: attach one LayerRegion — when support_threshold_angle=0 ("auto"), TreeSupport3D.cpp:251~256 computes the
        //  threshold offset from the outer wall flow of lower_layer.regions(). Previously regions was empty, giving 0/0=NaN.
        //  This is a single-region kernel, so one shared PrintRegion is equivalent to upstream (the outer wall width comes from the line_width fallback).
        layer->add_region(&facade_region);
        Polygons polygons = rings_to_polys(object_slices_mm[i]);
        for (const Polygon &polygon : polygons)
            for (const Point &point : polygon.points) {
                if (!bbox_init) {
                    min_x = max_x = point.x();
                    min_y = max_y = point.y();
                    bbox_init = true;
                } else {
                    min_x = std::min(min_x, point.x());
                    max_x = std::max(max_x, point.x());
                    min_y = std::min(min_y, point.y());
                    max_y = std::max(max_y, point.y());
                }
            }
        ExPolygons layer_expolygons = union_ex(polygons);   // group rings into contour+holes ExPolygons
        layer->lslices = layer_expolygons;
        layer->lslices_extrudable = layer_expolygons;
        previous_layer = layer;
    }
    if (bbox_init) print_object.m_bbox = BoundingBox(Point(min_x, min_y), Point(max_x, max_y));
    if (layer_count > 0) {   // WP1: matches object_print_z_max (object height) in upstream create_from_config
        print_object.m_slicing_params.object_print_z_max = layer_print_z_mm[layer_count-1];
        print_object.m_slicing_params.valid = true;
    }

    // (stage 20) hand the painted enforcer/blocker facets to the facade so generate_overhangs projects
    // them (project_and_append_custom_facets -> slice_mesh_slabs). No paint => empty its => no-op.
    print_object.set_custom_facets(selector_enforcer_its(), selector_blocker_its());
}

// SupportLayer::support_fills -> list of LayerOut (shared by tree/normal)
std::vector<treesupport_bridge::LayerOut> collect_output(const PrintObject &print_object)
{
    std::vector<treesupport_bridge::LayerOut> result;
    for (const SupportLayer *support_layer : print_object.support_layers()) {
        if (support_layer == nullptr) continue;
        treesupport_bridge::LayerOut layer_out;
        layer_out.print_z_mm = support_layer->print_z;
        for (const ExtrusionEntity *entity : support_layer->support_fills.entities)
            flatten_entity(entity, layer_out.lines);
        if (!layer_out.lines.empty()) result.push_back(std::move(layer_out));
    }
    return result;
}

} // namespace

namespace treesupport_bridge {

std::vector<LayerOut> generate(const std::vector<std::vector<Ring>>& object_slices_mm,
                               const std::vector<double>&            layer_print_z_mm,
                               const Params&                         params)
{
    const size_t layer_count = object_slices_mm.size();
    if (layer_count == 0 || layer_print_z_mm.size() != layer_count) return {};

    // generate_normal resets this through ParallelScope; the tree path opens no such scope, so it has to reset the
    //  counter itself. Without it a tree slice inherits whatever the previous grid slice left behind and the UI
    //  shows a stale constant instead of starting from zero.
    tbb_stub::prog().store(0);

    Print facade_print;
    PrintRegion facade_region;
    PrintObject print_object;
    build_facade(facade_print, facade_region, print_object, object_slices_mm, layer_print_z_mm, params);
    if (params.support_auto)   // manual => only painted enforcers
        print_object.m_config.support_type.value = stTreeAuto;
    else
        print_object.m_config.support_type.value = stTree;
    // WP1: style is no longer hardcoded (slim/strong/hybrid go down the non-organic path)
    SupportMaterialStyle tree_style = smsTreeOrganic;
    if (params.tree_style == "slim")        tree_style = smsTreeSlim;
    else if (params.tree_style == "strong") tree_style = smsTreeStrong;
    else if (params.tree_style == "hybrid") tree_style = smsTreeHybrid;
    print_object.m_config.support_style.value = tree_style;

    TreeSupport tree_support(print_object, print_object.m_slicing_params);
    tree_support.throw_on_cancel = [](){};
    tree_support.generate();
    return collect_output(print_object);
}

std::vector<LayerOut> generate_normal(const std::vector<std::vector<Ring>>& object_slices_mm,
                                      const std::vector<double>&            layer_print_z_mm,
                                      const std::vector<LayerSurf>&         surfs,
                                      const Params&                         params)
{
    const size_t layer_count = object_slices_mm.size();
    if (layer_count == 0 || layer_print_z_mm.size() != layer_count) return {};

    Print facade_print;
    PrintRegion facade_region;
    PrintObject print_object;
    build_facade(facade_print, facade_region, print_object, object_slices_mm, layer_print_z_mm, params);
    if (params.support_auto)
        print_object.m_config.support_type.value = stNormalAuto;
    else
        print_object.m_config.support_type.value = stNormal;
    SupportMaterialStyle normal_style = smsGrid;
    if (params.normal_style == "snug") normal_style = smsSnug;
    print_object.m_config.support_style.value = normal_style;

    // WP2: inject LayerRegion surface data — the minimal surfaces SupportMaterial consumes:
    //  · raw_slices (sharp-tail detection), · the stTop (bottom contact detection) / stBottom / stInternal partitions of slices.
    //  perimeters/unsupported_bridge_edges are not supplied -> bridge_no_support's bridge detection is a no-op (a documented approximation;
    //  it can be promoted once an adapter reconstructs kernel perimeters as ExtrusionEntity).
    // (WP-tbb) Only the upstream grid/snug support may use the real-parallel tbb stubs (tree stays serial because the concurrent_* stubs are unsafe).
    //  The scope is extended to before the surface injection loop — facade construction benefits from the parallelism too.
    tbb_stub::ParallelScope parallel_scope;
    // [parallel] Surface partitioning is per-layer independent (it only writes its own Layer/LayerRegion) — the main component of the measured 0.43s facade time.
    tbb::parallel_for(tbb::blocked_range<size_t>(0, layer_count), [&](const tbb::blocked_range<size_t>& layer_range) {
    for (size_t i = layer_range.begin(); i < layer_range.end(); ++i) {
        Layer *layer = print_object.get_layer(int(i));
        LayerRegion *layer_region = layer->get_region(0);
        layer_region->raw_slices = layer->lslices;
        ExPolygons top;
        ExPolygons bottom;
        if (i < surfs.size()) {
            top = union_ex(rings_to_polys(surfs[i].top));
            bottom = union_ex(rings_to_polys(surfs[i].bottom));
        }
        Polygons top_and_bottom = to_polygons(top);
        polygons_append(top_and_bottom, to_polygons(bottom));
        ExPolygons rest = [&]() -> ExPolygons {
            if (top_and_bottom.empty()) return layer->lslices;
            return diff_ex(layer->lslices, top_and_bottom);
        }();
        Surfaces surfaces;
        for (ExPolygon &expolygon : top)    surfaces.emplace_back(stTop, std::move(expolygon));
        for (ExPolygon &expolygon : bottom) surfaces.emplace_back(stBottom, std::move(expolygon));
        for (ExPolygon &expolygon : rest)   surfaces.emplace_back(stInternal, std::move(expolygon));
        layer_region->slices.set(std::move(surfaces));
    }
    });

    PrintObjectSupportMaterial support_material(&print_object, print_object.m_slicing_params);
    support_material.generate(print_object);
    return collect_output(print_object);
}

} // namespace treesupport_bridge
