// stage_cache.cpp — extracted verbatim from slicer_core.cpp (pure code move; no behavior change).
//  `static` dropped: the struct/definition moved to stage_cache.h/.cpp so slice() and the phase files share one instance.
#include "stage_cache.h"

#include <cstdio>

StageCache g_scache;
std::string make_layer_key(const Params& p) {
  char k[1024];
  std::snprintf(k, sizeof k, "%.6f|%.6f|%.6f|%d|%d|%s|%d|%.3f|%.3f|%.3f|%.3f|%d|%d|%s|%s|%.3f|%d|%.4f|%d"
                            "|%.6f|%.6f|%.6f|%.6f|%.6f|%d|%s|%s|%.6f|%d|%.6f|%.6f|%d|%d|%d|%d",
    p.layer_height, p.first_layer_height, p.line_width, p.wall_loops, (int)p.enable_support,
    p.support_style.c_str(), (int)p.support_auto, p.support_threshold_angle, p.support_top_z_distance,
    p.support_xy_distance, p.support_density, p.support_interface_top_layers, p.raft_layers,
    p.wall_generator.c_str(), p.sparse_infill_pattern.c_str(), p.infill_density,
    (int)p.auto_center, p.gcode_resolution, (int)p.spiral_mode,
    // PASS1's classic walls read these (classic_bridge.cpp), so a change to any of them must not reuse cached layers
    p.outer_wall_line_width, p.inner_wall_line_width, p.internal_solid_infill_line_width, p.initial_layer_line_width,
    p.nozzle_diameter, (int)p.detect_thin_wall, p.wall_sequence.c_str(), p.wall_direction.c_str(),
    p.filter_out_gap_fill, (int)p.has_gap_fill(), p.infill_wall_overlap, p.top_bottom_infill_wall_overlap,
    (int)p.precise_outer_wall, (int)p.only_one_wall_first_layer, (int)p.alternate_extra_wall, (int)p.enable_arc_fitting);
  return std::string(k);
}
