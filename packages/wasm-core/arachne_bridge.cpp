// Stage-7 bridge implementation: converts kernel contours (mm) to Slic3r::Polygons, runs the
// real ported Arachne WallToolPaths, and flattens the variable-width ExtrusionLines back to
// plain WallLine/WallJunction (mm). This is the ONLY translation unit where slicer_core meets Slic3r types.
#include "arachne_bridge.h"
#include "arachne_port/libslic3r/Arachne/WallToolPaths.hpp"

using namespace Slic3r;
using namespace Slic3r::Arachne;

#include <atomic>
namespace Slic3r::Geometry { extern std::atomic<int> g_cgal_planar_angle_calls; }  // stage-14 debug counter (mt-safe)

namespace arachne_bridge {

int cgal_planar_check_count() { return Slic3r::Geometry::g_cgal_planar_angle_calls; }

static inline coord_t to_scaled(double millimetres) { return (coord_t) std::llround(millimetres / SCALING_FACTOR); }
static inline double  to_mm(coord_t scaled) { return double(scaled) * SCALING_FACTOR; }

std::vector<WallLine> generate_walls(const std::vector<std::vector<std::pair<double,double>>>& polygons_mm,
                                  double line_width_mm, int wall_count, double layer_height_mm)
{
    std::vector<WallLine> out;
    if (polygons_mm.empty() || wall_count <= 0) return out;

    Polygons outline;
    for (const auto& polygon_mm : polygons_mm) {
        if (polygon_mm.size() < 3) continue;
        Polygon polygon;
        polygon.points.reserve(polygon_mm.size());
        for (const auto& point : polygon_mm) polygon.points.emplace_back(to_scaled(point.first), to_scaled(point.second));
        outline.emplace_back(std::move(polygon));
    }
    if (outline.empty()) return out;

    // Params: default Arachne tuning (mirrors OrcaSlicer make_paths_params for a 0.4mm nozzle).
    WallToolPathsParams params;
    const double nozzle = 0.4;
    params.min_bead_width                   = 0.85f * float(nozzle);
    params.min_feature_size                 = 0.10f * float(nozzle);
    params.min_length_factor                = 0.5f;
    params.wall_transition_length           = 1.0f * float(line_width_mm);
    params.wall_transition_angle            = 10.f;
    params.wall_transition_filter_deviation = 0.25f * float(nozzle);
    params.wall_distribution_count          = 1;
    params.is_top_or_bottom_layer           = false;

    const coord_t bead_width = to_scaled(line_width_mm);
    WallToolPaths wall_tool_paths(outline, bead_width, bead_width, (size_t) wall_count, /*wall_0_inset*/0,
                                  (coordf_t) layer_height_mm, params);
    const std::vector<VariableWidthLines>& toolpaths = wall_tool_paths.generate();

    for (const VariableWidthLines& inset_lines : toolpaths)
        for (const ExtrusionLine& line : inset_lines) {
            if (line.junctions.size() < 2) continue;
            WallLine wall_line;
            wall_line.closed = line.is_closed;
            wall_line.inset_index = (int) line.inset_idx;
            wall_line.junctions.reserve(line.junctions.size());
            for (const ExtrusionJunction& junction : line.junctions)
                wall_line.junctions.push_back({ to_mm(junction.p.x()), to_mm(junction.p.y()), to_mm(junction.w) });
            out.push_back(std::move(wall_line));
        }
    return out;
}

} // namespace arachne_bridge
