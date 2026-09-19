// params.cpp — extracted verbatim from slicer_core.cpp (pure code move; no behavior change).
#include "params.h"

#include <cstdlib>
#include <string>

static size_t jfind_val(const std::string& s, const char* key) {
  std::string k = std::string("\"") + key + "\"";
  size_t p = s.find(k);
  if (p == std::string::npos) return std::string::npos;
  p = s.find(':', p + k.size());
  if (p == std::string::npos) return std::string::npos;
  ++p;
  while (p < s.size() && (s[p]==' '||s[p]=='\t'||s[p]=='\n')) ++p;
  return p;
}
static double jget(const std::string& s, const char* key, double d) {
  size_t p = jfind_val(s, key);
  return (p == std::string::npos) ? d : std::strtod(s.c_str() + p, nullptr);
}
// `"key": [270, 220]` -> {270, 220}. Absent or non-array yields an empty vector, which every reader treats as
//  "no per-extruder values, use the scalar" — so an older host that sends nothing keeps the previous behaviour.
static std::vector<double> jarr(const std::string& s, const char* key) {
  std::vector<double> out;
  size_t p = jfind_val(s, key);
  if (p == std::string::npos || p >= s.size() || s[p] != '[') return out;
  for (++p; p < s.size() && s[p] != ']'; ) {
    while (p < s.size() && (s[p]==' '||s[p]=='\t'||s[p]=='\n'||s[p]==',')) ++p;
    if (p >= s.size() || s[p] == ']') break;
    char* end = nullptr;
    double v = std::strtod(s.c_str() + p, &end);
    if (end == s.c_str() + p) break;            // not a number — stop instead of spinning on the same character
    out.push_back(v);
    p = (size_t)(end - s.c_str());
  }
  return out;
}
// `"key": ["PLA", "ABS"]` -> {"PLA","ABS"}. Same contract as jarr: absent or non-array yields empty, which every
//  reader treats as "the host sent no per-filament strings". No escape handling — these are option values
//  (material names, preset ids), not the custom G-code jstr below has to unescape.
static std::vector<std::string> jstrarr(const std::string& s, const char* key) {
  std::vector<std::string> out;
  size_t p = jfind_val(s, key);
  if (p == std::string::npos || p >= s.size() || s[p] != '[') return out;
  for (++p; p < s.size() && s[p] != ']'; ) {
    while (p < s.size() && (s[p]==' '||s[p]=='\t'||s[p]=='\n'||s[p]==',')) ++p;
    if (p >= s.size() || s[p] == ']') break;
    if (s[p] == 'n') { out.push_back(std::string()); p += 4; continue; }   // JSON null -> "no value for this slot"
    if (s[p] != '"') break;
    size_t end = s.find('"', p + 1);
    if (end == std::string::npos) break;
    out.push_back(s.substr(p + 1, end - p - 1));
    p = end + 1;
  }
  return out;
}
static bool jbool(const std::string& s, const char* key, bool d) {
  size_t p = jfind_val(s, key);
  if (p == std::string::npos) return d;
  if (s.compare(p, 4, "true") == 0)  return true;
  if (s.compare(p, 5, "false") == 0) return false;
  return std::strtod(s.c_str() + p, nullptr) != 0.0;   // 1/0 accepted too
}
static std::string jstr(const std::string& s, const char* key, const std::string& d) {
  size_t p = jfind_val(s, key);
  if (p == std::string::npos || p >= s.size() || s[p] != '"') return d;
  ++p; std::string out;
  // Escapes matter for the printer profile's custom G-code, which arrives as one "G28\nM104 ..." string.
  //  Plain option strings contain none, so unescaping is a no-op for them.
  while (p < s.size() && s[p] != '"') {
    if (s[p] == '\\' && p + 1 < s.size()) {
      char c = s[p + 1]; p += 2;
      switch (c) {
        case 'n': out += '\n'; break;   case 't': out += '\t'; break;
        case 'r': break;                                        // CR is dropped: the writer emits its own line ends
        case 'u': p += 4; break;                                // \uXXXX: skipped, not expected in G-code
        default:  out += c;                                     // \" \\ \/ and anything else -> literal
      }
      continue;
    }
    out += s[p]; ++p;
  }
  return out.empty() ? d : out;
}
// Stage 21: reading a coFloatOrPercent width — "120%" -> nozzle*1.2; a number -> as-is; absent -> 0 (the auto-derive marker).
static double jwidth_raw(const std::string& s, const char* key, double nozzle) {
  size_t p = jfind_val(s, key);
  if (p == std::string::npos) return 0.0;
  if (s[p] == '"') { std::string v; size_t q = p + 1; while (q < s.size() && s[q] != '"') { v += s[q]; ++q; }
    if (!v.empty() && v.back() == '%') return std::strtod(v.c_str(), nullptr) * 0.01 * nozzle;
    return std::strtod(v.c_str(), nullptr); }
  return std::strtod(s.c_str() + p, nullptr);
}
// Upstream Flow::auto_extrusion_width (src/libslic3r/Flow.cpp:21): top-surface/support = nozzle_diameter,
//  everything else (outer/inner wall, sparse, solid) = 1.125 * nozzle_diameter.
static double auto_lw(double nozzle, bool top_or_support) { return top_or_support ? nozzle : 1.125 * nozzle; }
// Feature width resolution: value>0 -> as-is · 0 -> line_width (>0) · line_width also 0 -> the upstream auto. (default line_width=0.42 -> default behavior unchanged)
static double resolve_lw(double raw, double nozzle, double base_lw, bool top_or_support) {
  if (raw > 0) return raw;
  if (base_lw > 0) return base_lw;
  return auto_lw(nozzle, top_or_support);
}

Params parse_params(const std::string& j) {
  Params p;
  p.layer_height       = jget(j,"layer_height",p.layer_height);
  p.first_layer_height = jget(j,"first_layer_height",p.first_layer_height);
  p.line_width         = jget(j,"line_width",p.line_width);
  p.wall_loops         = (int)jget(j,"wall_loops",p.wall_loops);
  p.infill_density     = jget(j,"infill_density",p.infill_density);
  p.nozzle_diameter    = jget(j,"nozzle_diameter",p.nozzle_diameter);
  p.filament_diameter  = jget(j,"filament_diameter",p.filament_diameter);
  p.flow_ratio         = jget(j,"flow_ratio",p.flow_ratio);
  p.print_speed        = jget(j,"print_speed",p.print_speed);
  p.first_layer_speed  = jget(j,"first_layer_speed",p.first_layer_speed);
  p.travel_speed       = jget(j,"travel_speed",p.travel_speed);
  p.nozzle_temp        = jget(j,"nozzle_temp",p.nozzle_temp);
  p.bed_temp           = jget(j,"bed_temp",p.bed_temp);
  p.top_shell_layers   = (int)jget(j,"top_shell_layers",p.top_shell_layers);
  p.bottom_shell_layers= (int)jget(j,"bottom_shell_layers",p.bottom_shell_layers);
  p.skirt_loops        = (int)jget(j,"skirt_loops",p.skirt_loops);
  p.skirt_distance     = jget(j,"skirt_distance",p.skirt_distance);
  p.brim_width         = jget(j,"brim_width",p.brim_width);
  p.retract_length     = jget(j,"retract_length",p.retract_length);
  p.retract_speed      = jget(j,"retract_speed",p.retract_speed);
  p.z_hop              = jget(j,"z_hop",p.z_hop);
  p.infill_angle       = jget(j,"infill_angle",p.infill_angle);
  p.enable_support     = jbool(j,"enable_support",p.enable_support);
  p.support_threshold_angle       = jget(j,"support_threshold_angle",p.support_threshold_angle);
  p.support_density               = jget(j,"support_density",p.support_density);
  p.support_top_z_distance        = jget(j,"support_top_z_distance",p.support_top_z_distance);
  p.support_bottom_z_distance     = jget(j,"support_bottom_z_distance",p.support_bottom_z_distance);
  p.support_xy_distance           = jget(j,"support_xy_distance",p.support_xy_distance);
  p.support_interface_top_layers  = (int)jget(j,"support_interface_top_layers",p.support_interface_top_layers);
  p.support_line_width            = jget(j,"support_line_width",p.support_line_width);
  p.support_auto                  = jbool(j,"support_auto",p.support_auto);
  // Keys added in stage 33 when the hardcoding was removed
  p.support_angle                 = jget(j,"support_angle",p.support_angle);
  p.support_base_pattern          = jstr(j,"support_base_pattern",p.support_base_pattern);
  p.support_interface_pattern     = jstr(j,"support_interface_pattern",p.support_interface_pattern);
  p.support_interface_spacing     = jget(j,"support_interface_spacing",p.support_interface_spacing);
  p.support_base_pattern_spacing  = jget(j,"support_base_pattern_spacing",p.support_base_pattern_spacing);
  p.support_overhang_min_area     = jget(j,"support_overhang_min_area",p.support_overhang_min_area);
  p.support_remove_small_overhang = jbool(j,"support_remove_small_overhang",p.support_remove_small_overhang);
  p.bridge_no_support             = jbool(j,"bridge_no_support",p.bridge_no_support);
  p.support_expansion             = jget(j,"support_expansion",p.support_expansion);
  p.support_threshold_overlap     = jget(j,"support_threshold_overlap",p.support_threshold_overlap);
  p.support_on_build_plate_only   = jbool(j,"support_on_build_plate_only",p.support_on_build_plate_only);
  p.support_interface_bottom_layers = (int)jget(j,"support_interface_bottom_layers",p.support_interface_bottom_layers);
  p.support_grid_snap             = jbool(j,"support_grid_snap",p.support_grid_snap);
  p.support_filament              = (int)jget(j,"support_filament",p.support_filament);
  p.support_interface_filament    = (int)jget(j,"support_interface_filament",p.support_interface_filament);
  p.tree_lite_shrink              = jget(j,"tree_lite_shrink",p.tree_lite_shrink);
  p.tree_lite_min_radius          = jget(j,"tree_lite_min_radius",p.tree_lite_min_radius);
  // WP1: parsing the real tree support shape keys — the upstream UI keys (with the organic suffix) win, falling back to the suffix-less keys
  p.tree_style                    = jstr(j,"tree_style",p.tree_style);
  p.tree_support_branch_angle     = jget(j,"tree_support_branch_angle_organic",jget(j,"tree_support_branch_angle",p.tree_support_branch_angle));
  p.tree_support_angle_slow       = jget(j,"tree_support_angle_slow",p.tree_support_angle_slow);
  p.tree_support_branch_diameter  = jget(j,"tree_support_branch_diameter_organic",jget(j,"tree_support_branch_diameter",p.tree_support_branch_diameter));
  p.tree_support_branch_distance  = jget(j,"tree_support_branch_distance_organic",jget(j,"tree_support_branch_distance",p.tree_support_branch_distance));
  p.tree_support_branch_diameter_angle = jget(j,"tree_support_branch_diameter_angle",p.tree_support_branch_diameter_angle);
  p.tree_support_tip_diameter     = jget(j,"tree_support_tip_diameter",p.tree_support_tip_diameter);
  p.tree_support_top_rate         = jget(j,"tree_support_top_rate",p.tree_support_top_rate);
  p.tree_support_wall_count       = (int)jget(j,"tree_support_wall_count",p.tree_support_wall_count);
  p.printable_height              = jget(j,"printable_height",p.printable_height);
  p.independent_support_layer_height = jbool(j,"independent_support_layer_height",p.independent_support_layer_height);
  p.support_object_first_layer_gap= jget(j,"support_object_first_layer_gap",p.support_object_first_layer_gap);
  p.raft_expansion                = jget(j,"raft_expansion",p.raft_expansion);
  p.raft_contact_distance         = jget(j,"raft_contact_distance",p.raft_contact_distance);
  p.raft_first_layer_height       = jget(j,"raft_first_layer_height",p.raft_first_layer_height);
  p.skirt_height        = (int)jget(j,"skirt_height",p.skirt_height);
  p.brim_object_gap               = jget(j,"brim_object_gap",p.brim_object_gap);
  p.retraction_minimum_travel     = jget(j,"retraction_minimum_travel",p.retraction_minimum_travel);
  p.gcode_resolution              = jget(j,"gcode_resolution",p.gcode_resolution);
  p.prime_tower_x                 = jget(j,"prime_tower_x",p.prime_tower_x);
  p.prime_tower_y                 = jget(j,"prime_tower_y",p.prime_tower_y);
  p.prime_tower_ring_size         = jget(j,"prime_tower_ring_size",p.prime_tower_ring_size);
  p.raft_layers        = (int)jget(j,"raft_layers",p.raft_layers);
  p.bed_width          = jget(j,"bed_width",p.bed_width);
  p.bed_depth          = jget(j,"bed_depth",p.bed_depth);
  p.bed_height         = jget(j,"bed_height",p.bed_height);
  p.machine_start_gcode = jstr(j,"machine_start_gcode",p.machine_start_gcode);
  p.machine_end_gcode   = jstr(j,"machine_end_gcode",p.machine_end_gcode);
  p.sparse_infill_pattern         = jstr(j,"sparse_infill_pattern",p.sparse_infill_pattern);
  p.fan_speed                     = jget(j,"fan_speed",p.fan_speed);
  p.close_fan_the_first_x_layers  = (int)jget(j,"close_fan_the_first_x_layers",p.close_fan_the_first_x_layers);
  p.full_fan_speed_layer          = (int)jget(j,"full_fan_speed_layer",p.full_fan_speed_layer);
  p.slow_down_layer_time          = jget(j,"slow_down_layer_time",p.slow_down_layer_time);
  p.enable_arc_fitting            = jbool(j,"enable_arc_fitting",p.enable_arc_fitting);
  p.seam_position                 = jstr(j,"seam_position",p.seam_position);
  p.spiral_mode                   = jbool(j,"spiral_mode",p.spiral_mode);
  p.seam_slope_type               = jstr(j,"seam_slope_type",p.seam_slope_type);
  p.scarf_length                  = jget(j,"scarf_length",p.scarf_length);
  p.enable_pressure_advance       = jbool(j,"enable_pressure_advance",p.enable_pressure_advance);
  p.pressure_advance              = jget(j,"pressure_advance",p.pressure_advance);
  p.support_style                 = jstr(j,"support_style",p.support_style);
  p.bridge_speed                  = jget(j,"bridge_speed",p.bridge_speed);
  p.ironing_type                  = jstr(j,"ironing_type",p.ironing_type);
  p.ironing_spacing               = jget(j,"ironing_spacing",p.ironing_spacing);
  p.ironing_flow                  = jget(j,"ironing_flow",p.ironing_flow);
  p.ironing_speed                 = jget(j,"ironing_speed",p.ironing_speed);
  p.reduce_crossing_wall          = jbool(j,"reduce_crossing_wall",p.reduce_crossing_wall);
  p.max_volumetric_extrusion_rate_slope = jget(j,"max_volumetric_extrusion_rate_slope",p.max_volumetric_extrusion_rate_slope);
  p.extruder_count                = (int)jget(j,"extruder_count",p.extruder_count);
  p.extruder_nozzle_temp          = jarr(j,"extruder_nozzle_temp");
  p.extruder_filament_diameter    = jarr(j,"extruder_filament_diameter");
  p.extruder_flow_ratio           = jarr(j,"extruder_flow_ratio");
  p.extruder_retract_length       = jarr(j,"extruder_retract_length");
  p.extruder_retract_speed        = jarr(j,"extruder_retract_speed");
  p.extruder_z_hop                = jarr(j,"extruder_z_hop");
  p.mm_group_split                = (int)jget(j,"mm_group_split",p.mm_group_split);
  p.mm_group_splits               = jarr(j,"mm_group_splits");
  p.mm_group_tools                = jarr(j,"mm_group_tools");
  p.outer_wall_filament_id        = (int)jget(j,"outer_wall_filament_id",p.outer_wall_filament_id);
  p.inner_wall_filament_id        = (int)jget(j,"inner_wall_filament_id",p.inner_wall_filament_id);
  p.sparse_infill_filament_id     = (int)jget(j,"sparse_infill_filament_id",p.sparse_infill_filament_id);
  p.top_surface_filament_id       = (int)jget(j,"top_surface_filament_id",p.top_surface_filament_id);
  p.bottom_surface_filament_id    = (int)jget(j,"bottom_surface_filament_id",p.bottom_surface_filament_id);
  p.internal_solid_filament_id    = (int)jget(j,"internal_solid_filament_id",p.internal_solid_filament_id);
  p.filament_map                  = jarr(j,"filament_map");
  p.enable_prime_tower            = jbool(j,"enable_prime_tower",p.enable_prime_tower);
  p.flush_into_infill              = jbool(j,"flush_into_infill",p.flush_into_infill);
  p.flush_volumes_matrix          = jarr(j,"flush_volumes_matrix");
  p.flush_multiplier              = jget(j,"flush_multiplier",p.flush_multiplier);
  p.prime_volume                  = jget(j,"prime_volume",p.prime_volume);
  p.filament_type                 = jstrarr(j,"filament_type");
  p.filament_settings_id          = jstrarr(j,"filament_settings_id");
  p.filament_density              = jarr(j,"filament_density");
  p.filament_cost                 = jarr(j,"filament_cost");
  p.gcode_stats_block             = jbool(j,"gcode_stats_block",p.gcode_stats_block);
  p.gcode_config_block            = jbool(j,"gcode_config_block",p.gcode_config_block);
  p.params_json                   = j;
  p.auto_center                   = jbool(j,"auto_center",p.auto_center);   // stage 28
  p.wipe_tower_real               = jbool(j,"wipe_tower_real",p.wipe_tower_real);
  p.prime_tower_width             = jget(j,"prime_tower_width",p.prime_tower_width);
  p.wall_generator                = jstr(j,"wall_generator",p.wall_generator);
  p.pe_lite                       = jbool(j,"pe_lite",p.pe_lite);
  p.extrusion_rate_slope_segment_length = jget(j,"extrusion_rate_slope_segment_length",p.extrusion_rate_slope_segment_length);
  p.pe_external_perimeter_only    = jbool(j,"pe_external_perimeter_only",p.pe_external_perimeter_only);
  p.emit_pe_tags                  = jbool(j,"emit_pe_tags",p.emit_pe_tags);
  p.gcode_role_tags               = jbool(j,"gcode_role_tags",p.gcode_role_tags);
  p.pe_strip_tags                 = jbool(j,"pe_strip_tags",p.pe_strip_tags);
  p.machine_accel_print           = jget(j,"machine_accel_print",p.machine_accel_print);
  p.machine_accel_travel          = jget(j,"machine_accel_travel",p.machine_accel_travel);
  p.machine_accel_retract         = jget(j,"machine_accel_retract",p.machine_accel_retract);
  p.machine_jerk_xy               = jget(j,"machine_jerk_xy",p.machine_jerk_xy);
  p.machine_jerk_z                = jget(j,"machine_jerk_z",p.machine_jerk_z);
  p.machine_jerk_e                = jget(j,"machine_jerk_e",p.machine_jerk_e);
  p.machine_max_accel_xy          = jget(j,"machine_max_accel_xy",p.machine_max_accel_xy);
  p.machine_max_accel_z           = jget(j,"machine_max_accel_z",p.machine_max_accel_z);
  p.machine_max_accel_e           = jget(j,"machine_max_accel_e",p.machine_max_accel_e);
  p.machine_max_speed_xy          = jget(j,"machine_max_speed_xy",p.machine_max_speed_xy);
  p.machine_max_speed_z           = jget(j,"machine_max_speed_z",p.machine_max_speed_z);
  p.machine_max_speed_e           = jget(j,"machine_max_speed_e",p.machine_max_speed_e);
  p.time_engine                   = jstr(j,"time_engine",p.time_engine);
  p.economy                       = jbool(j,"economy",p.economy);
  p.reuse_stages                  = (int)jget(j,"reuse_stages",p.reuse_stages);
  p.keep_stages                   = jbool(j,"keep_stages",p.keep_stages);
  p.arachne_dump                  = jbool(j,"arachne_dump",p.arachne_dump);
  // Stage 21: resolve per-feature widths (after nozzle parsing). When line_width is 0 it is promoted to the upstream auto (the viewer sends 0.42 by default -> unchanged).
  {
    const double noz = p.nozzle_diameter;
    if (p.line_width <= 0) p.line_width = auto_lw(noz, false);
    p.outer_wall_line_width            = resolve_lw(jwidth_raw(j,"outer_wall_line_width",noz),            noz, p.line_width, false);
    p.inner_wall_line_width            = resolve_lw(jwidth_raw(j,"inner_wall_line_width",noz),            noz, p.line_width, false);
    p.top_surface_line_width           = resolve_lw(jwidth_raw(j,"top_surface_line_width",noz),           noz, p.line_width, true);   // top surface → nozzle auto
    p.sparse_infill_line_width         = resolve_lw(jwidth_raw(j,"sparse_infill_line_width",noz),         noz, p.line_width, false);
    p.internal_solid_infill_line_width = resolve_lw(jwidth_raw(j,"internal_solid_infill_line_width",noz), noz, p.line_width, false);
    p.initial_layer_line_width         = resolve_lw(jwidth_raw(j,"initial_layer_line_width",noz),         noz, p.line_width, false);
  }
  return p;
}
