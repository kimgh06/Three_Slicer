// stage_cache.cpp — extracted verbatim from slicer_core.cpp (pure code move; no behavior change).
//  `static` dropped: the struct/definition moved to stage_cache.h/.cpp so slice() and the phase files share one instance.
#include "stage_cache.h"

#include <cstdio>

StageCache g_scache;
std::string make_layer_key(const Params& params) {
  char key[1024];
  std::snprintf(key, sizeof key, "%.6f|%.6f|%.6f|%d|%d|%s|%d|%.3f|%.3f|%.3f|%.3f|%d|%d|%s|%s|%.3f|%d|%.4f|%d"
                            "|%.6f|%.6f|%.6f|%.6f|%.6f|%d|%s|%s|%.6f|%d|%.6f|%.6f|%d|%d|%d|%d",
    params.layer_height, params.first_layer_height, params.line_width, params.wall_loops, (int)params.enable_support,
    params.support_style.c_str(), (int)params.support_auto, params.support_threshold_angle, params.support_top_z_distance,
    params.support_xy_distance, params.support_density, params.support_interface_top_layers, params.raft_layers,
    params.wall_generator.c_str(), params.sparse_infill_pattern.c_str(), params.infill_density,
    (int)params.auto_center, params.gcode_resolution, (int)params.spiral_mode,
    // PASS1's classic walls read these (classic_bridge.cpp), so a change to any of them must not reuse cached layers
    params.outer_wall_line_width, params.inner_wall_line_width, params.internal_solid_infill_line_width, params.initial_layer_line_width,
    params.nozzle_diameter, (int)params.detect_thin_wall, params.wall_sequence.c_str(), params.wall_direction.c_str(),
    params.filter_out_gap_fill, (int)params.has_gap_fill(), params.infill_wall_overlap, params.top_bottom_infill_wall_overlap,
    (int)params.precise_outer_wall, (int)params.only_one_wall_first_layer, (int)params.alternate_extra_wall, (int)params.enable_arc_fitting);
  return std::string(key);
}
