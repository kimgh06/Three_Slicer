// Classic wall generator: a port of upstream PerimeterGenerator::process_classic (OrcaSlicer
// src/libslic3r/PerimeterGenerator.cpp:1159), traverse_loops (:100) and variable_width (VariableWidth.cpp).
// This is the only translation unit where the classic path meets Slic3r types (see classic_bridge.h).
//
// Kept as upstream wrote it: the Flow spacing arithmetic, the onion-shell offsets (offset2 with min_spacing), BBS's
// smaller external loop for narrow islands, detect_thin_wall's medial-axis thin walls, loop nesting, the
// traverse_loops ordering (chain_extrusion_entities, holes/contours, wall_direction), wall_sequence (OuterInner
// reverse and the InnerOuterInner sandwich), gap fill (medial axis + variable_width + filter_out_gap_fill, subtracted
// from the infill), and the infill area (inset with infill_wall_overlap / top_bottom_infill_wall_overlap).
//
// Left out, each because the kernel has no counterpart for what it feeds:
//  - overhang wall detection (detect_overhang_wall): splits loops against the lower layer into erOverhangPerimeter
//    paths, which only matters with a per-role overhang speed the kernel does not emit; traverse_loops therefore
//    always takes upstream's "no overhang detection" branch (one path per loop).
//  - apply_extra_perimeters / extra_perimeters_on_overhangs, overhang_reverse / reorient_perimeters: same reason.
//  - fuzzy skin: the kernel has none. apply_fuzzy_skin returns the polygon unchanged when it is off.
//  - only_one_wall_top's split_top_surfaces: needs the upper layer's slices, which PASS1 computes concurrently.
//  - process_no_bridge (counterbore_hole_bridging): upstream default none.
//  - the first-layer outer-brim reverse: the kernel has no brim_type.
//  - Surface::extra_perimeters: always 0 here (nothing in the kernel sets it).
#include "classic_bridge.h"

#include "arachne_port/libslic3r/ClipperUtils.hpp"
#include "arachne_port/libslic3r/ExPolygon.hpp"
#include "arachne_port/libslic3r/ExtrusionEntity.hpp"
#include "arachne_port/libslic3r/ExtrusionEntityCollection.hpp"
#include "arachne_port/libslic3r/Flow.hpp"
#include "arachne_port/libslic3r/ShortestPath.hpp"

#include <algorithm>
#include <cmath>

using namespace Slic3r;

namespace classic_bridge {

namespace {

// PerimeterGenerator.cpp:23-27
const double narrow_loop_length_threshold = 10;
constexpr double SMALLER_EXT_INSET_OVERLAP_TOLERANCE = 0.22;

// Upstream's non-bridge Flow constructor: the spacing is rounded_rectangle_extrusion_spacing (Flow.cpp:200), computed in
//  float as upstream does. The port's Flow is a stub whose constructor computes it in double, so the spacing is set here.
Flow make_flow(float width, float height, float nozzle_diameter)
{
    Flow flow(width, height, nozzle_diameter);
    flow.m_spacing = width - height * float(1. - 0.25 * PI);
    return flow;
}
// Upstream Flow::with_width for a non-bridge flow (Flow.cpp:143). The stub has no with_width.
Flow flow_with_width(const Flow& flow, float width) { return make_flow(width, flow.height(), flow.m_nozzle_diameter); }
// Flow::scaled_width / scaled_spacing (Flow.hpp:62,69)
coord_t scaled_width(const Flow& flow)   { return coord_t(scale_(flow.width())); }
coord_t scaled_spacing(const Flow& flow) { return coord_t(scale_(flow.spacing())); }

// PerimeterGenerator.cpp:34
class PerimeterGeneratorLoop {
public:
    Polygon                             polygon;
    bool                                is_contour;
    bool                                is_smaller_width_perimeter;
    unsigned short                      depth;
    std::vector<PerimeterGeneratorLoop> children;

    PerimeterGeneratorLoop(const Polygon &polygon, unsigned short depth, bool is_contour, bool is_small_width_perimeter = false) :
        polygon(polygon), is_contour(is_contour), is_smaller_width_perimeter(is_small_width_perimeter), depth(depth) {}
    bool is_external() const { return this->depth == 0; }
    // PerimeterGenerator.cpp:2553
    bool is_internal_contour() const {
        if (! this->is_contour)
            return false;
        for (const PerimeterGeneratorLoop &loop : this->children)
            if (loop.is_contour)
                return false;
        return true;
    }
};
using PerimeterGeneratorLoops = std::vector<PerimeterGeneratorLoop>;

// VariableWidth.cpp: thick_polyline_to_extrusion_paths_2 (BBS), verbatim but for flow.with_width.
ExtrusionPaths thick_polyline_to_extrusion_paths_2(const ThickPolyline& thick_polyline, ExtrusionRole role, const Flow& flow, const float tolerance)
{
    ExtrusionPaths paths;
    ExtrusionPath path(role);
    ThickLines lines = thick_polyline.thicklines();

    size_t start_index = 0;
    double max_width = 0, min_width = 0;

    for (int i = 0; i < (int)lines.size(); ++i) {
        const ThickLine& line = lines[i];

        if (i == 0) {
            max_width = line.a_width;
            min_width = line.a_width;
        }

        const coordf_t line_len = line.length();
        if (line_len < SCALED_EPSILON) continue;

        double thickness_delta = std::max(fabs(max_width - line.b_width), fabs(min_width - line.b_width));
        if (thickness_delta > tolerance) {
            if (start_index != (size_t)i) {
                path = ExtrusionPath(role);
                double length = lines[start_index].length();
                double sum = lines[start_index].length() * 0.5 * (lines[start_index].a_width + lines[start_index].b_width);
                path.polyline.append(Point3(lines[start_index].a));
                for (int idx = start_index + 1; idx < i; idx++) {
                    length += lines[idx].length();
                    sum += lines[idx].length() * 0.5 * (lines[idx].a_width + lines[idx].b_width);
                    path.polyline.append(Point3(lines[idx].a));
                }
                path.polyline.append(Point3(lines[i].a));
                if (length > SCALED_EPSILON) {
                    double w = sum / length;
                    Flow new_flow = flow_with_width(flow, unscale<float>(w) + flow.height() * float(1. - 0.25 * PI));
                    path.mm3_per_mm = new_flow.mm3_per_mm();
                    path.width = new_flow.width();
                    path.height = new_flow.height();
                    paths.emplace_back(std::move(path));
                }
            }

            start_index = i;
            max_width = line.a_width;
            min_width = line.a_width;

            thickness_delta = fabs(line.a_width - line.b_width);
            if (thickness_delta > tolerance) {
                const unsigned int segments = (unsigned int)ceil(thickness_delta / tolerance);
                const coordf_t seg_len = line_len / segments;
                Points pp;
                std::vector<coordf_t> width;
                {
                    pp.push_back(line.a);
                    width.push_back(line.a_width);
                    for (size_t j = 1; j < segments; ++j) {
                        pp.push_back((line.a.cast<double>() + (line.b - line.a).cast<double>().normalized() * (j * seg_len)).cast<coord_t>());

                        coordf_t w = line.a_width + (j * seg_len) * (line.b_width - line.a_width) / line_len;
                        width.push_back(w);
                        width.push_back(w);
                    }
                    pp.push_back(line.b);
                    width.push_back(line.b_width);
                }

                lines.erase(lines.begin() + i);
                for (size_t j = 0; j < segments; ++j) {
                    ThickLine new_line(pp[j], pp[j + 1]);
                    new_line.a_width = width[2 * j];
                    new_line.b_width = width[2 * j + 1];
                    lines.insert(lines.begin() + i + j, new_line);
                }
                --i;
                continue;
            }
        }
        else {
            max_width = std::max(max_width, std::max(line.a_width, line.b_width));
            min_width = std::min(min_width, std::min(line.a_width, line.b_width));
        }
    }
    size_t final_size = lines.size();
    if (start_index < final_size) {
        path = ExtrusionPath(role);
        double length = lines[start_index].length();
        double sum = lines[start_index].length() * lines[start_index].a_width;
        path.polyline.append(Point3(lines[start_index].a));
        for (size_t idx = start_index + 1; idx < final_size; idx++) {
            length += lines[idx].length();
            sum += lines[idx].length() * lines[idx].a_width;
            path.polyline.append(Point3(lines[idx].a));
        }
        path.polyline.append(Point3(lines[final_size - 1].b));
        if (length > SCALED_EPSILON) {
            double w = sum / length;
            Flow new_flow = flow_with_width(flow, unscale<float>(w) + flow.height() * float(1. - 0.25 * PI));
            path.mm3_per_mm = new_flow.mm3_per_mm();
            path.width = new_flow.width();
            path.height = new_flow.height();
            paths.emplace_back(std::move(path));
        }
    }

    return paths;
}

// VariableWidth.cpp: variable_width
void variable_width(const ThickPolylines& polylines, ExtrusionRole role, const Flow& flow, std::vector<ExtrusionEntity*>& out)
{
    const float tolerance = float(scale_(0.05));
    for (const ThickPolyline& p : polylines) {
        ExtrusionPaths paths = thick_polyline_to_extrusion_paths_2(p, role, flow, tolerance);
        if (!paths.empty()) {
            if (paths.front().first_point() == paths.back().last_point())
                out.emplace_back(new ExtrusionLoop(std::move(paths)));
            else {
                for (ExtrusionPath& path : paths)
                    out.emplace_back(new ExtrusionPath(std::move(path)));
            }
        }
    }
}

struct Flows {
    Flow perimeter, ext_perimeter, smaller_ext_perimeter, solid_infill;
    float layer_height;
};

// PerimeterGenerator.cpp:100 traverse_loops, without the overhang-detection branch (see the file header).
ExtrusionEntityCollection traverse_loops(const Flows& flows, const Config& config, const PerimeterGeneratorLoops &loops,
                                         ThickPolylines &thin_walls, bool reverse_thin_wall_hole)
{
    ExtrusionEntityCollection coll;

    for (const PerimeterGeneratorLoop &loop : loops) {
        bool is_external = loop.is_external();
        bool is_small_width = loop.is_smaller_width_perimeter;

        ExtrusionRole role = erPerimeter;
        if (is_external)
            role = erExternalPerimeter;
        ExtrusionLoopRole loop_role = elrHole;
        if (loop.is_internal_contour())
            loop_role = elrInternal;
        else if (loop.is_contour)
            loop_role = elrDefault;

        double extrusion_mm3_per_mm = flows.perimeter.mm3_per_mm();
        double extrusion_width = flows.perimeter.width();
        if (is_external) {
            if (is_small_width) {
                extrusion_mm3_per_mm = flows.smaller_ext_perimeter.mm3_per_mm();
                extrusion_width = flows.smaller_ext_perimeter.width();
            } else {
                extrusion_mm3_per_mm = flows.ext_perimeter.mm3_per_mm();
                extrusion_width = flows.ext_perimeter.width();
            }
        }

        ExtrusionPaths paths;
        ExtrusionPath path(role);
        path.polyline = Polyline3(loop.polygon.split_at_first_point());
        path.mm3_per_mm = extrusion_mm3_per_mm;
        path.width = extrusion_width;
        path.height = flows.layer_height;
        paths.emplace_back(std::move(path));

        coll.append(ExtrusionLoop(std::move(paths), loop_role));
    }

    // Append thin walls to the nearest-neighbor search (only for first iteration)
    if (! thin_walls.empty()) {
        variable_width(thin_walls, erExternalPerimeter, flows.ext_perimeter, coll.entities);
        thin_walls.clear();
    }

    Point zero_point(0, 0);
    std::vector<std::pair<size_t, bool>> chain = chain_extrusion_entities(coll.entities, &zero_point);
    ExtrusionEntityCollection out;
    for (const std::pair<size_t, bool> &idx : chain) {
        if (idx.first >= loops.size()) {
            // This is a thin wall.
            out.entities.reserve(out.entities.size() + 1);
            out.entities.emplace_back(coll.entities[idx.first]);
            coll.entities[idx.first] = nullptr;
            if (idx.second)
                out.entities.back()->reverse();
        } else {
            const PerimeterGeneratorLoop &loop = loops[idx.first];
            const bool reverse_children_thin_wall_hole = loops.size() == 1 && loop.is_contour && loop.children.size() == 1 &&
                                                         (!loop.children.front().is_contour) && loop.children.front().children.empty();
            ExtrusionEntityCollection children = traverse_loops(flows, config, loop.children, thin_walls, reverse_children_thin_wall_hole);
            out.entities.reserve(out.entities.size() + children.entities.size() + 1);
            ExtrusionLoop *eloop = static_cast<ExtrusionLoop*>(coll.entities[idx.first]);
            coll.entities[idx.first] = nullptr;

            if (config.wall_counter_clockwise == (loop.is_contour || reverse_thin_wall_hole))
                eloop->make_counter_clockwise();
            else
                eloop->make_clockwise();

            // Orca: Reverse print order for thin wall holes.
            if (reverse_thin_wall_hole) {
                std::reverse(out.entities.begin(), out.entities.end());
            }

            eloop->inset_idx = loop.depth;
            if (loop.is_contour) {
                out.append(std::move(children.entities));
                out.entities.emplace_back(eloop);
            } else {
                out.entities.emplace_back(eloop);
                out.append(std::move(children.entities));
            }
        }
    }
    return out;
}

// PerimeterGenerator.cpp:1482 — Orca's sandwich mode (InnerOuterInner), verbatim.
void reorder_inner_outer_inner(ExtrusionEntityCollection& entities)
{
    entities.reverse(); // reverse all entities - order them from external to internal
    if(entities.entities.size()>2){ // 3 walls minimum needed to do inner outer inner ordering
        int position = 0; // index to run the re-ordering for multiple external perimeters in a single island.
        int arr_i, arr_j = 0;    // indexes to run through the walls in the for loops
        int outer, first_internal, second_internal, max_internal, current_perimeter; // allocate index values

        ExtrusionEntityCollection reordered_extrusions, skipped_extrusions;
        bool found_second_internal = false; // helper variable to indicate the start of a new island

        for(auto extrusion_to_reorder : entities.entities){ //scan the perimeters to reorder
            switch (extrusion_to_reorder->inset_idx) {
                case 0: // external perimeter
                    if(found_second_internal){ //new island - move skipped extrusions to reordered array
                        for(auto extrusion_skipped : skipped_extrusions)
                            reordered_extrusions.append(*extrusion_skipped);
                        skipped_extrusions.clear();
                    }
                    reordered_extrusions.append(*extrusion_to_reorder);
                    break;
                case 1: // first internal perimeter
                    reordered_extrusions.append(*extrusion_to_reorder);
                    break;
                default: // second internal+ perimeter -> put them in the skipped extrusions array
                    skipped_extrusions.append(*extrusion_to_reorder);
                    found_second_internal = true;
                    break;
            }
        }
        if(entities.entities.size()>reordered_extrusions.size()){
            for(auto extrusion_skipped : skipped_extrusions)
                reordered_extrusions.append(*extrusion_skipped);
            skipped_extrusions.clear();
        }

        while (position < (int)reordered_extrusions.size()) {
            outer = first_internal = second_internal = current_perimeter = -1; // initialise all index values to -1
            max_internal = reordered_extrusions.size()-1; // initialise the maximum internal perimeter to the last perimeter on the extrusion list
            for (arr_i = position; arr_i < (int)reordered_extrusions.size(); ++arr_i) {
                switch (reordered_extrusions.entities[arr_i]->inset_idx) {
                    case 0: // external perimeter
                        if (outer == -1)
                            outer = arr_i;
                        break;
                    case 1: // first internal wall
                        if (first_internal==-1 && arr_i>outer && outer!=-1){
                            first_internal = arr_i;
                        }
                        break;
                    case 2: // second internal wall
                        if (second_internal == -1 && arr_i > first_internal && outer!=-1){
                            second_internal = arr_i;
                        }
                        break;
                }
                if(outer >-1 && first_internal>-1 && second_internal>-1 && reordered_extrusions.entities[arr_i]->inset_idx == 0){
                    arr_i=arr_i-1; //step back one perimeter
                    max_internal = arr_i; // new maximum internal perimeter is now this as we have found a new external perimeter, hence a new island.
                    break; // exit the for loop
                }
            }

            if (outer > -1 && first_internal > -1 && second_internal > -1) { // found perimeters to re-order?
                ExtrusionEntityCollection inner_outer_extrusions; // temporary collection to hold extrusions for reordering

                for (arr_j = max_internal; arr_j >=position; --arr_j){
                    if(arr_j >= second_internal){
                        inner_outer_extrusions.append(*reordered_extrusions.entities[arr_j]);
                        current_perimeter++;
                    }
                }

                for (arr_j = position; arr_j < second_internal; ++arr_j){
                    inner_outer_extrusions.append(*reordered_extrusions.entities[arr_j]);
                }

                for(arr_j = position; arr_j <= max_internal; ++arr_j) // replace perimeter array with the new re-ordered array
                    entities.replace(arr_j, *inner_outer_extrusions.entities[arr_j-position]);
            } else
                break;
            position = arr_i + 1;
        }
    }
}

IPath to_ipath(const Points& points)
{
    IPath out;
    out.reserve(points.size());
    for (const Point& point : points) out.emplace_back(point.x(), point.y());
    return out;
}

IPath to_ipath(const Polyline3& polyline)
{
    IPath out;
    out.reserve(polyline.points.size());
    for (const Point3& point : polyline.points) out.emplace_back(point.x(), point.y());
    return out;
}

// Flattens one entity of the perimeter collection. A loop with inset_idx >= 0 is a perimeter; anything else there is
//  a thin wall from variable_width (a path, or a loop when the medial axis closed on itself), whose inset_idx stays -1.
void flatten_wall(const ExtrusionEntity* entity, std::vector<Extrusion>& out)
{
    if (entity->is_loop() && entity->inset_idx >= 0) {
        const ExtrusionLoop* loop = static_cast<const ExtrusionLoop*>(entity);
        int kind = InnerWall;
        if (loop->paths.front().role() == erExternalPerimeter) kind = OuterWall;
        out.push_back({ to_ipath(loop->polygon().points), true, kind, loop->inset_idx, double(loop->paths.front().width) });
        return;
    }
    if (entity->is_loop()) {
        for (const ExtrusionPath& path : static_cast<const ExtrusionLoop*>(entity)->paths)
            out.push_back({ to_ipath(path.polyline), false, ThinWall, -1, double(path.width) });
        return;
    }
    const ExtrusionPath* path = static_cast<const ExtrusionPath*>(entity);
    out.push_back({ to_ipath(path->polyline), false, ThinWall, -1, double(path->width) });
}

void flatten_gap_fill(const ExtrusionEntity* entity, std::vector<Extrusion>& out)
{
    if (entity->is_loop()) {
        for (const ExtrusionPath& path : static_cast<const ExtrusionLoop*>(entity)->paths)
            out.push_back({ to_ipath(path.polyline), false, GapFill, -1, double(path.width) });
        return;
    }
    const ExtrusionPath* path = static_cast<const ExtrusionPath*>(entity);
    out.push_back({ to_ipath(path->polyline), false, GapFill, -1, double(path->width) });
}

} // namespace

Result generate(const std::vector<IPath>& contour, const Config& config)
{
    Result result;

    Polygons slice_polygons;
    for (const IPath& path : contour) {
        if (path.size() < 3) continue;
        Polygon polygon;
        polygon.points.reserve(path.size());
        for (const IPoint& point : path) polygon.points.emplace_back(coord_t(point.first), coord_t(point.second));
        slice_polygons.emplace_back(std::move(polygon));
    }
    ExPolygons slices = union_ex(slice_polygons);
    if (slices.empty()) return result;

    const float layer_height = float(config.layer_height);
    Flows flows;
    const float nozzle_diameter = float(config.nozzle_diameter);
    flows.perimeter     = make_flow(float(config.perimeter_width), layer_height, nozzle_diameter);
    flows.ext_perimeter = make_flow(float(config.ext_perimeter_width), layer_height, nozzle_diameter);
    flows.solid_infill  = make_flow(float(config.solid_infill_width), layer_height, nozzle_diameter);
    flows.layer_height  = layer_height;

    // other perimeters
    coord_t perimeter_width         = scaled_width(flows.perimeter);
    coord_t perimeter_spacing       = scaled_spacing(flows.perimeter);

    // external perimeters
    coord_t ext_perimeter_width     = scaled_width(flows.ext_perimeter);
    coord_t ext_perimeter_spacing   = scaled_spacing(flows.ext_perimeter);
    coord_t ext_perimeter_spacing2  = scaled<coord_t>(0.5f * (flows.ext_perimeter.spacing() + flows.perimeter.spacing()));
    // Orca: ignore precise_outer_wall if wall_sequence is not InnerOuter
    if (config.precise_outer_wall && config.wall_sequence == InnerOuter)
        ext_perimeter_spacing2 = scaled<coord_t>(0.5f * (flows.ext_perimeter.width() + flows.perimeter.width()));

    // solid infill
    coord_t solid_infill_spacing    = scaled_spacing(flows.solid_infill);

    coord_t min_spacing         = coord_t(perimeter_spacing      * (1 - INSET_OVERLAP_TOLERANCE));
    coord_t ext_min_spacing     = coord_t(ext_perimeter_spacing  * (1 - INSET_OVERLAP_TOLERANCE));
    bool    has_gap_fill        = config.has_gap_fill;

    // BBS: this flow is for smaller external perimeter for small area
    coord_t ext_min_spacing_smaller = coord_t(ext_perimeter_spacing * (1 - SMALLER_EXT_INSET_OVERLAP_TOLERANCE));
    flows.smaller_ext_perimeter = flow_with_width(flows.ext_perimeter, float(SCALING_FACTOR *
        (ext_perimeter_width - 0.5 * SMALLER_EXT_INSET_OVERLAP_TOLERANCE * ext_perimeter_spacing)));

    double scaled_resolution = scaled<double>(std::max(config.resolution, EPSILON));
    // BBS: don't simplify too much which influence arc fitting when export gcode if arc_fitting is enabled
    double surface_simplify_resolution = scaled_resolution;
    if (config.arc_fitting)
        surface_simplify_resolution = 0.2 * scaled_resolution;

    //BBS: reorder the surface to reduce the travel time
    std::vector<size_t> surface_order = chain_expolygons(slices);
    for (size_t order_idx = 0; order_idx < surface_order.size(); order_idx++) {
        const ExPolygon &surface = slices[surface_order[order_idx]];
        // detect how many perimeters must be generated for this island
        int loop_number = config.wall_loops - 1;  // 0-indexed loops (Surface::extra_perimeters is 0 here)
        if (config.alternate_extra_wall && config.layer_id % 2 == 1 && !config.spiral_vase && config.sparse_infill_density > 0) // add alternating extra wall
            loop_number++;
        if (config.layer_id == config.raft_layers && config.only_one_wall_first_layer)
            loop_number = 0;

        ExPolygons last        = union_ex(surface.simplify_p(surface_simplify_resolution));
        ExPolygons gaps;
        if (loop_number >= 0) {
            std::vector<PerimeterGeneratorLoops> contours(loop_number+1);    // depth => loops
            std::vector<PerimeterGeneratorLoops> holes(loop_number+1);       // depth => loops
            ThickPolylines thin_walls;
            // we loop one time more than needed in order to find gaps after the last perimeter was applied
            for (int i = 0;; ++ i) {  // outer loop is 0
                ExPolygons offsets;
                ExPolygons offsets_with_smaller_width;
                if (i == 0) {
                    // look for thin walls
                    if (config.detect_thin_wall) {
                        // the minimum thickness of a single loop is:
                        // ext_width/2 + ext_spacing/2 + spacing/2 + width/2
                        offsets = offset2_ex(last,
                            -float(ext_perimeter_width / 2. + ext_min_spacing / 2. - 1),
                            +float(ext_min_spacing / 2. - 1));
                        // the following offset2 ensures almost nothing in @thin_walls is narrower than $min_width
                        // (actually, something larger than that still may exist due to mitering or other causes)
                        coord_t min_width = coord_t(scale_(flows.ext_perimeter.m_nozzle_diameter / 3));
                        ExPolygons expp = opening_ex(
                            // medial axis requires non-overlapping geometry
                            diff_ex(last, offset(offsets, float(ext_perimeter_width / 2.) + ClipperSafetyOffset)),
                            float(min_width / 2.));
                        // the maximum thickness of our thin wall area is equal to the minimum thickness of a single loop
                        for (ExPolygon &ex : expp)
                            ex.medial_axis(min_width, ext_perimeter_width + ext_perimeter_spacing2, &thin_walls);
                    } else {
                        coord_t ext_perimeter_smaller_width = scaled_width(flows.smaller_ext_perimeter);
                        for (const ExPolygon& expolygon : last) {
                            // BBS: judge whether it's narrow but not too long island which is hard to place two line
                            ExPolygons expolys;
                            expolys.push_back(expolygon);
                            ExPolygons offset_result = offset2_ex(expolys,
                                -float(ext_perimeter_width / 2. + ext_min_spacing_smaller / 2.),
                                +float(ext_min_spacing_smaller / 2.));
                            if (offset_result.empty() &&
                                expolygon.area() < (double)(ext_perimeter_width + ext_min_spacing_smaller) * scale_(narrow_loop_length_threshold)) {
                                // BBS: for narrow external loop, use smaller line width
                                ExPolygons temp_result = offset_ex(expolygon, -float(ext_perimeter_smaller_width / 2.));
                                offsets_with_smaller_width.insert(offsets_with_smaller_width.end(), temp_result.begin(), temp_result.end());
                            }
                            else {
                                //BBS: for not narrow loop, use normal external perimeter line width
                                ExPolygons temp_result = offset_ex(expolygon, -float(ext_perimeter_width / 2.));
                                offsets.insert(offsets.end(), temp_result.begin(), temp_result.end());
                            }
                        }
                    }
                    if (config.spiral_vase && (offsets.size() > 1 || offsets_with_smaller_width.size() > 1)) {
                        // Remove all but the largest area polygon.
                        keep_largest_contour_only(offsets);
                        //BBS
                        if (offsets.empty())
                            //BBS: only have small width loop, then keep the largest in spiral vase mode
                            keep_largest_contour_only(offsets_with_smaller_width);
                        else
                            //BBS: have large area, clean the small width loop
                            offsets_with_smaller_width.clear();
                    }
                } else {
                    coord_t distance = perimeter_spacing;
                    if (i == 1)
                        distance = ext_perimeter_spacing2;
                    //BBS: For internal perimeter, we should "enable" thin wall strategy in which offset2 is used to
                    // remove too closed line, so that gap fill can be used for such internal narrow area in following
                    // handling.
                    offsets = offset2_ex(last,
                        -float(distance + min_spacing / 2. - 1.),
                        float(min_spacing / 2. - 1.));
                    // look for gaps
                    if (has_gap_fill)
                        // not using safety offset here would "detect" very narrow gaps
                        // (but still long enough to escape the area threshold) that gap fill
                        // won't be able to fill but we'd still remove from infill area
                        append(gaps, diff_ex(
                            offset(last,    - float(0.5 * distance)),
                            offset(offsets,   float(0.5 * distance + 10))));  // safety offset
                }
                if (offsets.empty() && offsets_with_smaller_width.empty()) {
                    // Store the number of loops actually generated.
                    loop_number = i - 1;
                    // No region left to be filled in.
                    last.clear();
                    break;
                } else if (i > loop_number) {
                    // If i > loop_number, we were looking just for gaps.
                    break;
                }
                {
                    for (const ExPolygon& expolygon : offsets) {
                        contours[i].emplace_back(expolygon.contour, i, true);

                        if (!expolygon.holes.empty()) {
                            holes[i].reserve(holes[i].size() + expolygon.holes.size());
                            for (const Polygon& hole : expolygon.holes)
                                holes[i].emplace_back(hole, i, false);
                        }
                    }

                    //BBS: save perimeter loop which use smaller width
                    if (i == 0) {
                        for (const ExPolygon& expolygon : offsets_with_smaller_width) {
                            contours[i].emplace_back(PerimeterGeneratorLoop(expolygon.contour, i, true, true));
                            if (!expolygon.holes.empty()) {
                                holes[i].reserve(holes[i].size() + expolygon.holes.size());
                                for (const Polygon& hole : expolygon.holes)
                                    holes[i].emplace_back(PerimeterGeneratorLoop(hole, i, false, true));
                            }
                        }
                    }
                }

                last = std::move(offsets);

                if (i == loop_number && (! has_gap_fill || config.sparse_infill_density == 0)) {
                    // The last run of this loop is executed to collect gaps for gap fill.
                    // As the gap fill is either disabled or not
                    break;
                }
            }

            // nest loops: holes first
            for (int d = 0; d <= loop_number; ++ d) {
                PerimeterGeneratorLoops &holes_d = holes[d];
                // loop through all holes having depth == d
                for (int i = 0; i < (int)holes_d.size(); ++ i) {
                    const PerimeterGeneratorLoop &loop = holes_d[i];
                    // find the hole loop that contains this one, if any
                    for (int t = d + 1; t <= loop_number; ++ t) {
                        for (int j = 0; j < (int)holes[t].size(); ++ j) {
                            PerimeterGeneratorLoop &candidate_parent = holes[t][j];
                            if (candidate_parent.polygon.contains(loop.polygon.first_point())) {
                                candidate_parent.children.push_back(loop);
                                holes_d.erase(holes_d.begin() + i);
                                -- i;
                                goto NEXT_LOOP;
                            }
                        }
                    }
                    // if no hole contains this hole, find the contour loop that contains it
                    for (int t = loop_number; t >= 0; -- t) {
                        for (int j = 0; j < (int)contours[t].size(); ++ j) {
                            PerimeterGeneratorLoop &candidate_parent = contours[t][j];
                            if (candidate_parent.polygon.contains(loop.polygon.first_point())) {
                                candidate_parent.children.push_back(loop);
                                holes_d.erase(holes_d.begin() + i);
                                -- i;
                                goto NEXT_LOOP;
                            }
                        }
                    }
                    NEXT_LOOP: ;
                }
            }
            // nest contour loops
            for (int d = loop_number; d >= 1; -- d) {
                PerimeterGeneratorLoops &contours_d = contours[d];
                // loop through all contours having depth == d
                for (int i = 0; i < (int)contours_d.size(); ++ i) {
                    const PerimeterGeneratorLoop &loop = contours_d[i];
                    // find the contour loop that contains it
                    for (int t = d - 1; t >= 0; -- t) {
                        for (size_t j = 0; j < contours[t].size(); ++ j) {
                            PerimeterGeneratorLoop &candidate_parent = contours[t][j];
                            if (candidate_parent.polygon.contains(loop.polygon.first_point())) {
                                candidate_parent.children.push_back(loop);
                                contours_d.erase(contours_d.begin() + i);
                                -- i;
                                goto NEXT_CONTOUR;
                            }
                        }
                    }
                    NEXT_CONTOUR: ;
                }
            }
            // at this point, all loops should be in contours[0]
            ExtrusionEntityCollection entities = traverse_loops(flows, config, contours.front(), thin_walls, false);

            // if brim will be printed, reverse the order of perimeters so that
            // we continue inwards after having finished the brim
            if (config.wall_sequence == OuterInner)
                entities.reverse();
            // Orca: sandwich mode. Apply after 1st layer.
            else if (config.wall_sequence == InnerOuterInner && config.layer_id > 0)
                reorder_inner_outer_inner(entities);

            for (const ExtrusionEntity* entity : entities.entities)
                flatten_wall(entity, result.walls);
        }

        // fill gaps
        if (! gaps.empty()) { // collapse
            // ORCA: Use the smaller width as the lower bound to avoid overestimating safe overlap
            double min = 0.2 * std::min(perimeter_width, ext_perimeter_width) * (1 - INSET_OVERLAP_TOLERANCE);
            double max = 2. * perimeter_spacing;
            ExPolygons gaps_ex = diff_ex(
                //FIXME offset2 would be enough and cheaper.
                opening_ex(gaps, float(min / 2.)),
                offset2_ex(gaps, - float(max / 2.), float(max / 2. + ClipperSafetyOffset)));
            ThickPolylines polylines;
            for (ExPolygon& ex : gaps_ex) {
                //BBS: Use DP simplify to avoid duplicated points and accelerate medial-axis calculation as well.
                ex.douglas_peucker(surface_simplify_resolution);
                ex.medial_axis(min, max, &polylines);
            }

            // SoftFever: filter out tiny gap fills
            polylines.erase(std::remove_if(polylines.begin(), polylines.end(),
                [&](const ThickPolyline& p) {
                    return p.length() < scale_(config.filter_out_gap_fill);
                }), polylines.end());

            if (! polylines.empty()) {
                ExtrusionEntityCollection gap_fill;
                variable_width(polylines, erGapFill, flows.solid_infill, gap_fill.entities);
                /*  Make sure we don't infill narrow parts that are already gap-filled
                    (we only consider this surface's gaps to reduce the diff() complexity).
                    Growing actual extrusions ensures that gaps not filled by medial axis
                    are not subtracted from fill surfaces (they might be too short gaps
                    that medial axis skips but infill might join with other infill regions
                    and use zigzag).  */
                last = diff_ex(last, gap_fill.polygons_covered_by_width(10.f));
                for (const ExtrusionEntity* entity : gap_fill.entities)
                    flatten_gap_fill(entity, result.gap_fill);
            }
        }

        // create one more offset to be used as boundary for fill
        // we offset by half the perimeter spacing (to get to the actual infill boundary)
        // and then we offset back and forth by half the infill spacing to only consider the
        // non-collapsing regions
        coord_t inset = 0;
        if (loop_number == 0)
            inset = ext_perimeter_spacing / 2;   // one loop
        else if (loop_number > 0)
            inset = perimeter_spacing / 2;       // two or more loops

        // only apply infill overlap if we actually have one perimeter
        coord_t infill_peri_overlap = 0;
        if (inset > 0) {
            // coPercent's get_abs_value(ratio_over) is ratio_over * percent / 100
            double overlap_percent = config.infill_wall_overlap;
            if (config.layer_id == 0 || config.is_top_layer)
                overlap_percent = config.top_bottom_infill_wall_overlap;
            infill_peri_overlap = coord_t(scale_(unscale<double>(inset + solid_infill_spacing / 2) * overlap_percent / 100.));
            inset -= infill_peri_overlap;
        }
        // simplify infill contours according to resolution
        Polygons pp;
        for (ExPolygon &ex : last)
            ex.simplify_p(scaled_resolution, &pp);
        ExPolygons not_filled_exp = union_ex(pp);
        // collapse too narrow infill areas
        coord_t min_perimeter_infill_spacing = coord_t(solid_infill_spacing * (1. - INSET_OVERLAP_TOLERANCE));

        ExPolygons infill_exp = offset2_ex(
            not_filled_exp,
            float(-inset - min_perimeter_infill_spacing / 2.),
            float(min_perimeter_infill_spacing / 2.));
        for (const ExPolygon& expolygon : infill_exp) {
            result.fill.push_back(to_ipath(expolygon.contour.points));
            for (const Polygon& hole : expolygon.holes)
                result.fill.push_back(to_ipath(hole.points));
        }
    } // for each island
    return result;
}

} // namespace classic_bridge
