// Stage-7 link/functional test: call the real ported Arachne WallToolPaths on a square,
// print the resulting variable-width beads. Proves the port links & runs.
#include <cstdio>
#include "libslic3r/Arachne/WallToolPaths.hpp"

using namespace Slic3r;
using namespace Slic3r::Arachne;

int main() {
    // 20x20 mm square outline (coords scaled: 1mm = 1e6)
    const coord_t scaled_mm = 1000000; // scaled(1mm)
    Polygon square;
    square.points = { Point(0,0), Point(20*scaled_mm,0), Point(20*scaled_mm,20*scaled_mm), Point(0,20*scaled_mm) };
    Polygons outline;
    outline.push_back(square);

    WallToolPathsParams params;
    params.min_bead_width = 0.85f * 0.4f;   // ~min_bead_width_pct * nozzle
    params.min_feature_size = 0.1f * 0.4f;
    params.min_length_factor = 0.5f;
    params.wall_transition_length = 0.4f;
    params.wall_transition_angle = 10.f;
    params.wall_transition_filter_deviation = 0.25f * 0.4f;
    params.wall_distribution_count = 1;
    params.is_top_or_bottom_layer = false;

    coord_t bead_width = coord_t(0.42 * scaled_mm);   // 0.42mm line width
    WallToolPaths wall_paths(outline, bead_width, bead_width, /*inset_count*/3, /*wall_0_inset*/0, /*layer_height*/0.2, params);
    const std::vector<VariableWidthLines>& toolpaths = wall_paths.generate();

    printf("ARACHNE OK (square 20mm): %zu inset groups\n", toolpaths.size());
    auto report = [scaled_mm](const char* name, const std::vector<VariableWidthLines>& toolpath_groups){
        int lines = 0;
        double min_width = 1e18;
        double max_width = -1e18;
        long junctions = 0;
        for (const VariableWidthLines& group : toolpath_groups)
            for (const ExtrusionLine& line : group) {
                ++lines;
                for (const ExtrusionJunction& junction : line.junctions) {
                    ++junctions;
                    double width = junction.w / double(scaled_mm);
                    if (width < min_width) min_width = width;
                    if (width > max_width) max_width = width;
                }
            }
        printf("  %s: groups~ lines=%d junctions=%ld  width_mm min=%.4f max=%.4f\n", name, lines, junctions, min_width, max_width);
    };
    report("square20", toolpaths);

    // Tapering wedge: forces Arachne variable-width beads (wide end -> narrow tip).
    Polygon wedge;
    wedge.points = { Point(0,0), Point(30*scaled_mm,0), Point(30*scaled_mm, coord_t(0.55*scaled_mm)), Point(0, coord_t(2.2*scaled_mm)) };
    Polygons wedge_outline;
    wedge_outline.push_back(wedge);
    WallToolPaths wedge_paths(wedge_outline, bead_width, bead_width, 3, 0, 0.2, params);
    const auto& wedge_toolpaths = wedge_paths.generate();
    printf("ARACHNE OK (tapering wedge): %zu inset groups\n", wedge_toolpaths.size());
    report("wedge", wedge_toolpaths);
    return 0;
}
