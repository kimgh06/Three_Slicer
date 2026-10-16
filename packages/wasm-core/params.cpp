// params.cpp — extracted verbatim from slicer_core.cpp (pure code move; no behavior change).
#include "params.h"

#include <cstdlib>
#include <string>

static size_t json_find_value(const std::string& json, const char* key) {
  std::string quotedKey = std::string("\"") + key + "\"";
  size_t position = json.find(quotedKey);
  if (position == std::string::npos) return std::string::npos;
  position = json.find(':', position + quotedKey.size());
  if (position == std::string::npos) return std::string::npos;
  ++position;
  while (position < json.size() && (json[position]==' '||json[position]=='\t'||json[position]=='\n')) ++position;
  return position;
}
static double json_number(const std::string& json, const char* key, double fallback) {
  size_t position = json_find_value(json, key);
  if (position == std::string::npos) return fallback;
  return std::strtod(json.c_str() + position, nullptr);
}
// `"key": [270, 220]` -> {270, 220}. Absent or non-array yields an empty vector, which every reader treats as
//  "no per-extruder values, use the scalar" — so an older host that sends nothing keeps the previous behaviour.
static std::vector<double> json_number_array(const std::string& json, const char* key) {
  std::vector<double> out;
  size_t position = json_find_value(json, key);
  if (position == std::string::npos || position >= json.size() || json[position] != '[') return out;
  for (++position; position < json.size() && json[position] != ']'; ) {
    while (position < json.size() && (json[position]==' '||json[position]=='\t'||json[position]=='\n'||json[position]==',')) ++position;
    if (position >= json.size() || json[position] == ']') break;
    char* end = nullptr;
    double value = std::strtod(json.c_str() + position, &end);
    if (end == json.c_str() + position) break;            // not a number — stop instead of spinning on the same character
    out.push_back(value);
    position = (size_t)(end - json.c_str());
  }
  return out;
}
// `"key": ["PLA", "ABS"]` -> {"PLA","ABS"}. Same contract as json_number_array: absent or non-array yields empty, which every
//  reader treats as "the host sent no per-filament strings". No escape handling — these are option values
//  (material names, preset ids), not the custom G-code json_string below has to unescape.
static std::vector<std::string> json_string_array(const std::string& json, const char* key) {
  std::vector<std::string> out;
  size_t position = json_find_value(json, key);
  if (position == std::string::npos || position >= json.size() || json[position] != '[') return out;
  for (++position; position < json.size() && json[position] != ']'; ) {
    while (position < json.size() && (json[position]==' '||json[position]=='\t'||json[position]=='\n'||json[position]==',')) ++position;
    if (position >= json.size() || json[position] == ']') break;
    if (json[position] == 'n') {   // JSON null -> "no value for this slot"
      out.push_back(std::string());
      position += 4;
      continue;
    }
    if (json[position] != '"') break;
    size_t end = json.find('"', position + 1);
    if (end == std::string::npos) break;
    out.push_back(json.substr(position + 1, end - position - 1));
    position = end + 1;
  }
  return out;
}
static bool json_bool(const std::string& json, const char* key, bool fallback) {
  size_t position = json_find_value(json, key);
  if (position == std::string::npos) return fallback;
  if (json.compare(position, 4, "true") == 0)  return true;
  if (json.compare(position, 5, "false") == 0) return false;
  return std::strtod(json.c_str() + position, nullptr) != 0.0;   // 1/0 accepted too
}
static std::string json_string(const std::string& json, const char* key, const std::string& fallback) {
  size_t position = json_find_value(json, key);
  if (position == std::string::npos || position >= json.size() || json[position] != '"') return fallback;
  ++position;
  std::string out;
  // Escapes matter for the printer profile's custom G-code, which arrives as one "G28\nM104 ..." string.
  //  Plain option strings contain none, so unescaping is a no-op for them.
  while (position < json.size() && json[position] != '"') {
    if (json[position] == '\\' && position + 1 < json.size()) {
      char escaped = json[position + 1];
      position += 2;
      switch (escaped) {
        case 'n': out += '\n'; break;
        case 't': out += '\t'; break;
        case 'r': break;                                        // CR is dropped: the writer emits its own line ends
        case 'u': position += 4; break;                         // \uXXXX: skipped, not expected in G-code
        default:  out += escaped;                               // \" \\ \/ and anything else -> literal
      }
      continue;
    }
    out += json[position];
    ++position;
  }
  if (out.empty()) return fallback;
  return out;
}
// Stage 21: reading a coFloatOrPercent width — "120%" -> nozzle*1.2; a number -> as-is; absent -> 0 (the auto-derive marker).
static double json_width_raw(const std::string& json, const char* key, double nozzle) {
  size_t position = json_find_value(json, key);
  if (position == std::string::npos) return 0.0;
  if (json[position] == '"') {
    std::string text;
    size_t cursor = position + 1;
    while (cursor < json.size() && json[cursor] != '"') {
      text += json[cursor];
      ++cursor;
    }
    if (!text.empty() && text.back() == '%') return std::strtod(text.c_str(), nullptr) * 0.01 * nozzle;
    return std::strtod(text.c_str(), nullptr);
  }
  return std::strtod(json.c_str() + position, nullptr);
}
// Upstream Flow::auto_extrusion_width (src/libslic3r/Flow.cpp:21): top-surface/support = nozzle_diameter,
//  everything else (outer/inner wall, sparse, solid) = 1.125 * nozzle_diameter.
static double auto_line_width(double nozzle, bool top_or_support) {
  if (top_or_support) return nozzle;
  return 1.125 * nozzle;
}
// Feature width resolution: value>0 -> as-is · 0 -> line_width (>0) · line_width also 0 -> the upstream auto. (default line_width=0.42 -> default behavior unchanged)
static double resolve_line_width(double raw, double nozzle, double base_width, bool top_or_support) {
  if (raw > 0) return raw;
  if (base_width > 0) return base_width;
  return auto_line_width(nozzle, top_or_support);
}

Params parse_params(const std::string& params_json) {
  Params p;
  p.layer_height       = json_number(params_json,"layer_height",p.layer_height);
  p.first_layer_height = json_number(params_json,"first_layer_height",p.first_layer_height);
  p.line_width         = json_number(params_json,"line_width",p.line_width);
  p.wall_loops         = (int)json_number(params_json,"wall_loops",p.wall_loops);
  p.infill_density     = json_number(params_json,"infill_density",p.infill_density);
  p.nozzle_diameter    = json_number(params_json,"nozzle_diameter",p.nozzle_diameter);
  p.filament_diameter  = json_number(params_json,"filament_diameter",p.filament_diameter);
  p.flow_ratio         = json_number(params_json,"flow_ratio",p.flow_ratio);
  p.print_speed        = json_number(params_json,"print_speed",p.print_speed);
  p.first_layer_speed  = json_number(params_json,"first_layer_speed",p.first_layer_speed);
  p.travel_speed       = json_number(params_json,"travel_speed",p.travel_speed);
  p.nozzle_temp        = json_number(params_json,"nozzle_temp",p.nozzle_temp);
  p.bed_temp           = json_number(params_json,"bed_temp",p.bed_temp);
  p.first_layer_nozzle_temp = json_number(params_json,"first_layer_nozzle_temp",p.first_layer_nozzle_temp);   // nozzle_temperature_initial_layer
  p.first_layer_bed_temp    = json_number(params_json,"first_layer_bed_temp",p.first_layer_bed_temp);         // <plate>_temp_initial_layer
  p.single_extruder_multi_material = json_bool(params_json,"single_extruder_multi_material",p.single_extruder_multi_material);
  p.gcode_flavor            = json_string(params_json,"gcode_flavor",p.gcode_flavor);
  p.use_relative_e_distances = json_bool(params_json,"use_relative_e_distances",p.use_relative_e_distances);
  p.reduce_infill_retraction = json_bool(params_json,"reduce_infill_retraction",p.reduce_infill_retraction);
  p.disable_m73              = json_bool(params_json,"disable_m73",p.disable_m73);
  p.use_firmware_retraction  = json_bool(params_json,"use_firmware_retraction",p.use_firmware_retraction);
  p.z_offset                 = json_number(params_json,"z_offset",p.z_offset);
  p.machine_envelope         = json_number_array(params_json,"machine_envelope");
  // Per-role speed / acceleration / jerk (upstream GCode::_extrude) — see params.h.
  p.inner_wall_speed = json_number(params_json,"inner_wall_speed",p.inner_wall_speed);
  p.sparse_infill_speed = json_number(params_json,"sparse_infill_speed",p.sparse_infill_speed);
  p.internal_solid_infill_speed = json_number(params_json,"internal_solid_infill_speed",p.internal_solid_infill_speed);
  p.top_surface_speed = json_number(params_json,"top_surface_speed",p.top_surface_speed);
  p.support_speed = json_number(params_json,"support_speed",p.support_speed);
  p.support_interface_speed = json_number(params_json,"support_interface_speed",p.support_interface_speed);
  p.initial_layer_infill_speed = json_number(params_json,"initial_layer_infill_speed",p.initial_layer_infill_speed);
  p.skirt_speed = json_number(params_json,"skirt_speed",p.skirt_speed);
  p.initial_layer_travel_speed = json_number(params_json,"initial_layer_travel_speed",p.initial_layer_travel_speed);
  p.default_acceleration = json_number(params_json,"default_acceleration",p.default_acceleration);
  p.outer_wall_acceleration = json_number(params_json,"outer_wall_acceleration",p.outer_wall_acceleration);
  p.inner_wall_acceleration = json_number(params_json,"inner_wall_acceleration",p.inner_wall_acceleration);
  p.top_surface_acceleration = json_number(params_json,"top_surface_acceleration",p.top_surface_acceleration);
  p.sparse_infill_acceleration = json_number(params_json,"sparse_infill_acceleration",p.sparse_infill_acceleration);
  p.internal_solid_infill_acceleration = json_number(params_json,"internal_solid_infill_acceleration",p.internal_solid_infill_acceleration);
  p.bridge_acceleration = json_number(params_json,"bridge_acceleration",p.bridge_acceleration);
  p.initial_layer_acceleration = json_number(params_json,"initial_layer_acceleration",p.initial_layer_acceleration);
  p.travel_acceleration = json_number(params_json,"travel_acceleration",p.travel_acceleration);
  p.initial_layer_travel_acceleration = json_number(params_json,"initial_layer_travel_acceleration",p.initial_layer_travel_acceleration);
  p.default_jerk = json_number(params_json,"default_jerk",p.default_jerk);
  p.outer_wall_jerk = json_number(params_json,"outer_wall_jerk",p.outer_wall_jerk);
  p.inner_wall_jerk = json_number(params_json,"inner_wall_jerk",p.inner_wall_jerk);
  p.top_surface_jerk = json_number(params_json,"top_surface_jerk",p.top_surface_jerk);
  p.infill_jerk = json_number(params_json,"infill_jerk",p.infill_jerk);
  p.initial_layer_jerk = json_number(params_json,"initial_layer_jerk",p.initial_layer_jerk);
  p.travel_jerk = json_number(params_json,"travel_jerk",p.travel_jerk);
  p.initial_layer_travel_jerk = json_number(params_json,"initial_layer_travel_jerk",p.initial_layer_travel_jerk);
  p.machine_max_acceleration_extruding = json_number(params_json,"machine_max_acceleration_extruding",p.machine_max_acceleration_extruding);
  p.machine_max_acceleration_travel = json_number(params_json,"machine_max_acceleration_travel",p.machine_max_acceleration_travel);
  p.machine_max_acceleration_y = json_number(params_json,"machine_max_acceleration_y",p.machine_max_acceleration_y);
  p.machine_max_jerk_y = json_number(params_json,"machine_max_jerk_y",p.machine_max_jerk_y);
  p.accel_to_decel_factor = json_number(params_json,"accel_to_decel_factor",p.accel_to_decel_factor);
  p.slow_down_layers = (int)json_number(params_json,"slow_down_layers",p.slow_down_layers);
  p.small_perimeter_speed = json_number(params_json,"small_perimeter_speed",p.small_perimeter_speed);
  p.small_perimeter_threshold = json_number(params_json,"small_perimeter_threshold",p.small_perimeter_threshold);
  p.accel_to_decel_enable = json_bool(params_json,"accel_to_decel_enable",p.accel_to_decel_enable);
  p.top_shell_layers   = (int)json_number(params_json,"top_shell_layers",p.top_shell_layers);
  p.bottom_shell_layers= (int)json_number(params_json,"bottom_shell_layers",p.bottom_shell_layers);
  p.skirt_loops        = (int)json_number(params_json,"skirt_loops",p.skirt_loops);
  p.skirt_distance     = json_number(params_json,"skirt_distance",p.skirt_distance);
  p.brim_width         = json_number(params_json,"brim_width",p.brim_width);
  p.retract_length     = json_number(params_json,"retract_length",p.retract_length);
  p.retract_speed      = json_number(params_json,"retract_speed",p.retract_speed);
  p.z_hop              = json_number(params_json,"z_hop",p.z_hop);
  p.infill_angle       = json_number(params_json,"infill_angle",p.infill_angle);
  p.enable_support     = json_bool(params_json,"enable_support",p.enable_support);
  p.support_threshold_angle       = json_number(params_json,"support_threshold_angle",p.support_threshold_angle);
  p.support_density               = json_number(params_json,"support_density",p.support_density);
  p.support_top_z_distance        = json_number(params_json,"support_top_z_distance",p.support_top_z_distance);
  p.support_bottom_z_distance     = json_number(params_json,"support_bottom_z_distance",p.support_bottom_z_distance);
  p.support_xy_distance           = json_number(params_json,"support_xy_distance",p.support_xy_distance);
  p.support_interface_top_layers  = (int)json_number(params_json,"support_interface_top_layers",p.support_interface_top_layers);
  p.support_line_width            = json_number(params_json,"support_line_width",p.support_line_width);
  p.support_auto                  = json_bool(params_json,"support_auto",p.support_auto);
  // Keys added in stage 33 when the hardcoding was removed
  p.support_angle                 = json_number(params_json,"support_angle",p.support_angle);
  p.support_base_pattern          = json_string(params_json,"support_base_pattern",p.support_base_pattern);
  p.support_interface_pattern     = json_string(params_json,"support_interface_pattern",p.support_interface_pattern);
  p.support_interface_spacing     = json_number(params_json,"support_interface_spacing",p.support_interface_spacing);
  p.support_base_pattern_spacing  = json_number(params_json,"support_base_pattern_spacing",p.support_base_pattern_spacing);
  p.support_overhang_min_area     = json_number(params_json,"support_overhang_min_area",p.support_overhang_min_area);
  p.support_remove_small_overhang = json_bool(params_json,"support_remove_small_overhang",p.support_remove_small_overhang);
  p.bridge_no_support             = json_bool(params_json,"bridge_no_support",p.bridge_no_support);
  p.support_expansion             = json_number(params_json,"support_expansion",p.support_expansion);
  p.support_threshold_overlap     = json_number(params_json,"support_threshold_overlap",p.support_threshold_overlap);
  p.support_on_build_plate_only   = json_bool(params_json,"support_on_build_plate_only",p.support_on_build_plate_only);
  p.support_interface_bottom_layers = (int)json_number(params_json,"support_interface_bottom_layers",p.support_interface_bottom_layers);
  p.support_grid_snap             = json_bool(params_json,"support_grid_snap",p.support_grid_snap);
  p.support_filament              = (int)json_number(params_json,"support_filament",p.support_filament);
  p.support_interface_filament    = (int)json_number(params_json,"support_interface_filament",p.support_interface_filament);
  p.tree_lite_shrink              = json_number(params_json,"tree_lite_shrink",p.tree_lite_shrink);
  p.tree_lite_min_radius          = json_number(params_json,"tree_lite_min_radius",p.tree_lite_min_radius);
  // WP1: parsing the real tree support shape keys — the upstream UI keys (with the organic suffix) win, falling back to the suffix-less keys
  p.tree_style                    = json_string(params_json,"tree_style",p.tree_style);
  p.tree_support_branch_angle     = json_number(params_json,"tree_support_branch_angle_organic",json_number(params_json,"tree_support_branch_angle",p.tree_support_branch_angle));
  p.tree_support_angle_slow       = json_number(params_json,"tree_support_angle_slow",p.tree_support_angle_slow);
  p.tree_support_branch_diameter  = json_number(params_json,"tree_support_branch_diameter_organic",json_number(params_json,"tree_support_branch_diameter",p.tree_support_branch_diameter));
  p.tree_support_branch_distance  = json_number(params_json,"tree_support_branch_distance_organic",json_number(params_json,"tree_support_branch_distance",p.tree_support_branch_distance));
  p.tree_support_branch_diameter_angle = json_number(params_json,"tree_support_branch_diameter_angle",p.tree_support_branch_diameter_angle);
  p.tree_support_tip_diameter     = json_number(params_json,"tree_support_tip_diameter",p.tree_support_tip_diameter);
  p.tree_support_top_rate         = json_number(params_json,"tree_support_top_rate",p.tree_support_top_rate);
  p.tree_support_wall_count       = (int)json_number(params_json,"tree_support_wall_count",p.tree_support_wall_count);
  p.printable_height              = json_number(params_json,"printable_height",p.printable_height);
  p.independent_support_layer_height = json_bool(params_json,"independent_support_layer_height",p.independent_support_layer_height);
  p.support_object_first_layer_gap= json_number(params_json,"support_object_first_layer_gap",p.support_object_first_layer_gap);
  p.raft_expansion                = json_number(params_json,"raft_expansion",p.raft_expansion);
  p.raft_contact_distance         = json_number(params_json,"raft_contact_distance",p.raft_contact_distance);
  p.raft_first_layer_height       = json_number(params_json,"raft_first_layer_height",p.raft_first_layer_height);
  p.skirt_height        = (int)json_number(params_json,"skirt_height",p.skirt_height);
  p.brim_object_gap               = json_number(params_json,"brim_object_gap",p.brim_object_gap);
  p.retraction_minimum_travel     = json_number(params_json,"retraction_minimum_travel",p.retraction_minimum_travel);
  p.gcode_resolution              = json_number(params_json,"gcode_resolution",p.gcode_resolution);
  p.prime_tower_x                 = json_number(params_json,"prime_tower_x",p.prime_tower_x);
  p.prime_tower_y                 = json_number(params_json,"prime_tower_y",p.prime_tower_y);
  p.prime_tower_ring_size         = json_number(params_json,"prime_tower_ring_size",p.prime_tower_ring_size);
  p.raft_layers        = (int)json_number(params_json,"raft_layers",p.raft_layers);
  p.bed_width          = json_number(params_json,"bed_width",p.bed_width);
  p.bed_depth          = json_number(params_json,"bed_depth",p.bed_depth);
  p.bed_origin_x       = json_number(params_json,"bed_origin_x",p.bed_origin_x);   // printable_area's lower-left corner (printer coordinates)
  p.bed_origin_y       = json_number(params_json,"bed_origin_y",p.bed_origin_y);
  p.bed_height         = json_number(params_json,"bed_height",p.bed_height);
  p.machine_start_gcode = json_string(params_json,"machine_start_gcode",p.machine_start_gcode);
  p.machine_end_gcode   = json_string(params_json,"machine_end_gcode",p.machine_end_gcode);
  p.placeholder_config  = json_string(params_json,"placeholder_config",p.placeholder_config);
  p.sparse_infill_pattern         = json_string(params_json,"sparse_infill_pattern",p.sparse_infill_pattern);
  p.fan_speed                     = json_number(params_json,"fan_speed",p.fan_speed);
  p.close_fan_the_first_x_layers  = (int)json_number(params_json,"close_fan_the_first_x_layers",p.close_fan_the_first_x_layers);
  p.full_fan_speed_layer          = (int)json_number(params_json,"full_fan_speed_layer",p.full_fan_speed_layer);
  p.slow_down_layer_time          = json_number(params_json,"slow_down_layer_time",p.slow_down_layer_time);
  p.enable_arc_fitting            = json_bool(params_json,"enable_arc_fitting",p.enable_arc_fitting);
  p.seam_position                 = json_string(params_json,"seam_position",p.seam_position);
  p.spiral_mode                   = json_bool(params_json,"spiral_mode",p.spiral_mode);
  p.seam_slope_type               = json_string(params_json,"seam_slope_type",p.seam_slope_type);
  p.scarf_length                  = json_number(params_json,"scarf_length",p.scarf_length);
  p.print_flow_ratio              = json_number(params_json,"print_flow_ratio",p.print_flow_ratio);
  p.top_solid_infill_flow_ratio   = json_number(params_json,"top_solid_infill_flow_ratio",p.top_solid_infill_flow_ratio);
  p.bottom_solid_infill_flow_ratio = json_number(params_json,"bottom_solid_infill_flow_ratio",p.bottom_solid_infill_flow_ratio);
  p.bridge_flow                   = json_number(params_json,"bridge_flow",p.bridge_flow);
  p.brim_flow_ratio               = json_number(params_json,"brim_flow_ratio",p.brim_flow_ratio);
  p.scarf_joint_flow_ratio        = json_number(params_json,"scarf_joint_flow_ratio",p.scarf_joint_flow_ratio);
  p.thick_bridges                 = json_bool(params_json,"thick_bridges",p.thick_bridges);
  p.set_other_flow_ratios         = json_bool(params_json,"set_other_flow_ratios",p.set_other_flow_ratios);
  p.outer_wall_flow_ratio         = json_number(params_json,"outer_wall_flow_ratio",p.outer_wall_flow_ratio);
  p.inner_wall_flow_ratio         = json_number(params_json,"inner_wall_flow_ratio",p.inner_wall_flow_ratio);
  p.sparse_infill_flow_ratio      = json_number(params_json,"sparse_infill_flow_ratio",p.sparse_infill_flow_ratio);
  p.internal_solid_infill_flow_ratio = json_number(params_json,"internal_solid_infill_flow_ratio",p.internal_solid_infill_flow_ratio);
  p.gap_fill_flow_ratio           = json_number(params_json,"gap_fill_flow_ratio",p.gap_fill_flow_ratio);
  p.support_flow_ratio            = json_number(params_json,"support_flow_ratio",p.support_flow_ratio);
  p.support_interface_flow_ratio  = json_number(params_json,"support_interface_flow_ratio",p.support_interface_flow_ratio);
  p.first_layer_flow_ratio        = json_number(params_json,"first_layer_flow_ratio",p.first_layer_flow_ratio);
  p.enable_pressure_advance       = json_bool(params_json,"enable_pressure_advance",p.enable_pressure_advance);
  p.pressure_advance              = json_number(params_json,"pressure_advance",p.pressure_advance);
  p.support_style                 = json_string(params_json,"support_style",p.support_style);
  p.bridge_speed                  = json_number(params_json,"bridge_speed",p.bridge_speed);
  p.ironing_type                  = json_string(params_json,"ironing_type",p.ironing_type);
  p.ironing_spacing               = json_number(params_json,"ironing_spacing",p.ironing_spacing);
  p.ironing_flow                  = json_number(params_json,"ironing_flow",p.ironing_flow);
  p.ironing_speed                 = json_number(params_json,"ironing_speed",p.ironing_speed);
  p.reduce_crossing_wall          = json_bool(params_json,"reduce_crossing_wall",p.reduce_crossing_wall);
  p.max_volumetric_extrusion_rate_slope = json_number(params_json,"max_volumetric_extrusion_rate_slope",p.max_volumetric_extrusion_rate_slope);
  p.extruder_count                = (int)json_number(params_json,"extruder_count",p.extruder_count);
  p.extruder_nozzle_temp          = json_number_array(params_json,"extruder_nozzle_temp");
  p.extruder_filament_diameter    = json_number_array(params_json,"extruder_filament_diameter");
  p.extruder_flow_ratio           = json_number_array(params_json,"extruder_flow_ratio");
  p.extruder_retract_length       = json_number_array(params_json,"extruder_retract_length");
  p.extruder_retract_speed        = json_number_array(params_json,"extruder_retract_speed");
  p.extruder_z_hop                = json_number_array(params_json,"extruder_z_hop");
  p.extruder_first_layer_temp     = json_number_array(params_json,"extruder_first_layer_temp");
  p.mm_group_split                = (int)json_number(params_json,"mm_group_split",p.mm_group_split);
  p.mm_group_splits               = json_number_array(params_json,"mm_group_splits");
  p.mm_group_tools                = json_number_array(params_json,"mm_group_tools");
  p.single_tool                   = std::max(0, (int)json_number(params_json,"single_tool",p.single_tool));
  p.outer_wall_filament_id        = (int)json_number(params_json,"outer_wall_filament_id",p.outer_wall_filament_id);
  p.inner_wall_filament_id        = (int)json_number(params_json,"inner_wall_filament_id",p.inner_wall_filament_id);
  p.sparse_infill_filament_id     = (int)json_number(params_json,"sparse_infill_filament_id",p.sparse_infill_filament_id);
  p.top_surface_filament_id       = (int)json_number(params_json,"top_surface_filament_id",p.top_surface_filament_id);
  p.bottom_surface_filament_id    = (int)json_number(params_json,"bottom_surface_filament_id",p.bottom_surface_filament_id);
  p.internal_solid_filament_id    = (int)json_number(params_json,"internal_solid_filament_id",p.internal_solid_filament_id);
  p.filament_map                  = json_number_array(params_json,"filament_map");
  p.enable_prime_tower            = json_bool(params_json,"enable_prime_tower",p.enable_prime_tower);
  p.flush_into_infill              = json_bool(params_json,"flush_into_infill",p.flush_into_infill);
  p.flush_volumes_matrix          = json_number_array(params_json,"flush_volumes_matrix");
  p.flush_multiplier              = json_number(params_json,"flush_multiplier",p.flush_multiplier);
  p.prime_volume                  = json_number(params_json,"prime_volume",p.prime_volume);
  p.filament_type                 = json_string_array(params_json,"filament_type");
  p.filament_settings_id          = json_string_array(params_json,"filament_settings_id");
  p.filament_density              = json_number_array(params_json,"filament_density");
  p.filament_max_volumetric_speed = json_number_array(params_json,"filament_max_volumetric_speed");
  p.filament_cost                 = json_number_array(params_json,"filament_cost");
  p.gcode_stats_block             = json_bool(params_json,"gcode_stats_block",p.gcode_stats_block);
  p.gcode_config_block            = json_bool(params_json,"gcode_config_block",p.gcode_config_block);
  p.params_json                   = params_json;
  p.auto_center                   = json_bool(params_json,"auto_center",p.auto_center);   // stage 28
  p.wipe_tower_real               = json_bool(params_json,"wipe_tower_real",p.wipe_tower_real);
  p.prime_tower_width             = json_number(params_json,"prime_tower_width",p.prime_tower_width);
  p.wall_generator                = json_string(params_json,"wall_generator",p.wall_generator);
  p.detect_thin_wall              = json_bool(params_json,"detect_thin_wall",p.detect_thin_wall);
  p.wall_sequence                 = json_string(params_json,"wall_sequence",p.wall_sequence);
  p.wall_direction                = json_string(params_json,"wall_direction",p.wall_direction);
  p.filter_out_gap_fill           = json_number(params_json,"filter_out_gap_fill",p.filter_out_gap_fill);
  p.gap_infill_speed              = json_number_array(params_json,"gap_infill_speed");
  p.infill_wall_overlap           = json_number(params_json,"infill_wall_overlap",p.infill_wall_overlap);
  p.top_bottom_infill_wall_overlap = json_number(params_json,"top_bottom_infill_wall_overlap",p.top_bottom_infill_wall_overlap);
  p.precise_outer_wall            = json_bool(params_json,"precise_outer_wall",p.precise_outer_wall);
  p.only_one_wall_first_layer     = json_bool(params_json,"only_one_wall_first_layer",p.only_one_wall_first_layer);
  p.alternate_extra_wall          = json_bool(params_json,"alternate_extra_wall",p.alternate_extra_wall);
  p.pe_lite                       = json_bool(params_json,"pe_lite",p.pe_lite);
  p.extrusion_rate_slope_segment_length = json_number(params_json,"extrusion_rate_slope_segment_length",p.extrusion_rate_slope_segment_length);
  p.pe_external_perimeter_only    = json_bool(params_json,"pe_external_perimeter_only",p.pe_external_perimeter_only);
  p.emit_pe_tags                  = json_bool(params_json,"emit_pe_tags",p.emit_pe_tags);
  p.gcode_role_tags               = json_bool(params_json,"gcode_role_tags",p.gcode_role_tags);
  p.pe_strip_tags                 = json_bool(params_json,"pe_strip_tags",p.pe_strip_tags);
  p.machine_accel_print           = json_number(params_json,"machine_accel_print",p.machine_accel_print);
  p.machine_accel_travel          = json_number(params_json,"machine_accel_travel",p.machine_accel_travel);
  p.machine_accel_retract         = json_number(params_json,"machine_accel_retract",p.machine_accel_retract);
  p.machine_jerk_xy               = json_number(params_json,"machine_jerk_xy",p.machine_jerk_xy);
  p.machine_jerk_z                = json_number(params_json,"machine_jerk_z",p.machine_jerk_z);
  p.machine_jerk_e                = json_number(params_json,"machine_jerk_e",p.machine_jerk_e);
  p.machine_max_accel_xy          = json_number(params_json,"machine_max_accel_xy",p.machine_max_accel_xy);
  p.machine_max_accel_z           = json_number(params_json,"machine_max_accel_z",p.machine_max_accel_z);
  p.machine_max_accel_e           = json_number(params_json,"machine_max_accel_e",p.machine_max_accel_e);
  p.machine_max_speed_xy          = json_number(params_json,"machine_max_speed_xy",p.machine_max_speed_xy);
  p.machine_max_speed_z           = json_number(params_json,"machine_max_speed_z",p.machine_max_speed_z);
  p.machine_max_speed_e           = json_number(params_json,"machine_max_speed_e",p.machine_max_speed_e);
  p.time_engine                   = json_string(params_json,"time_engine",p.time_engine);
  p.economy                       = json_bool(params_json,"economy",p.economy);
  p.reuse_stages                  = (int)json_number(params_json,"reuse_stages",p.reuse_stages);
  p.keep_stages                   = json_bool(params_json,"keep_stages",p.keep_stages);
  p.arachne_dump                  = json_bool(params_json,"arachne_dump",p.arachne_dump);
  // Stage 21: resolve per-feature widths (after nozzle parsing). When line_width is 0 it is promoted to the upstream auto (the viewer sends 0.42 by default -> unchanged).
  {
    const double nozzle = p.nozzle_diameter;
    if (p.line_width <= 0) p.line_width = auto_line_width(nozzle, false);
    p.outer_wall_line_width            = resolve_line_width(json_width_raw(params_json,"outer_wall_line_width",nozzle),            nozzle, p.line_width, false);
    p.inner_wall_line_width            = resolve_line_width(json_width_raw(params_json,"inner_wall_line_width",nozzle),            nozzle, p.line_width, false);
    p.top_surface_line_width           = resolve_line_width(json_width_raw(params_json,"top_surface_line_width",nozzle),           nozzle, p.line_width, true);   // top surface → nozzle auto
    p.sparse_infill_line_width         = resolve_line_width(json_width_raw(params_json,"sparse_infill_line_width",nozzle),         nozzle, p.line_width, false);
    p.internal_solid_infill_line_width = resolve_line_width(json_width_raw(params_json,"internal_solid_infill_line_width",nozzle), nozzle, p.line_width, false);
    p.initial_layer_line_width         = resolve_line_width(json_width_raw(params_json,"initial_layer_line_width",nozzle),         nozzle, p.line_width, false);
  }
  return p;
}
