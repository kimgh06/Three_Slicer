// Issue 63: plain-type interface to upstream's PlaceholderParser (treesupport_port/libslic3r/PlaceholderParser.cpp,
// verbatim), so a printer profile's custom G-code reaches the printer expanded. The kernel includes only this
// header; the Slic3r config and parser types stay on the port side (custom_gcode_bridge_impl.cpp), as with the
// other bridges.
//
// Upstream fills the parser in GCode::_do_export (GCode.cpp:3180-3510) from its Print. This kernel has no Print,
// so the kernel hands over the same facts in plain types (Facts) and the impl sets the variables from them in
// upstream's order and under upstream's names. The settings themselves arrive as the flattened preset, every value
// in upstream's string form, and are loaded the way upstream loads a project's JSON config (load_string_map).
#pragma once
#include <string>
#include <vector>

namespace custom_gcode_bridge {

// What GCode::_do_export reads off the Print before the start G-code. Coordinates are the printer's (bed) frame.
struct Facts {
  int initial_extruder = 0;                 // filament (0-based) of the first extrusion
  int initial_no_support_extruder = 0;      // first filament that prints an object rather than support
  std::vector<int> used_filaments;          // every filament that extrudes, ascending
  std::vector<int> first_layer_filaments;   // the filaments that extrude on the first layer
  int total_layer_count = 0;
  double max_print_z = 0.0;                 // top of the print, mm
  std::vector<double> first_layer_points;   // x,y pairs: every first-layer extrusion outline (objects, support,
                                            //  skirt, brim) — the convex hull of these is first_layer_print_convex_hull
  std::vector<double> object_bboxes;        // min x, min y, max x, max y per object (in_head_wrap_detect_zone)
  std::vector<double> object_first_layer_bboxes;  // the same four per object, first layer only (no wipe tower)
  double first_layer_area_mm2 = 0.0;        // objects + support + brim on the first layer (hold_chamber_temp_for_flat_print)
  bool has_wipe_tower = false;
  double wipe_tower_bbox[4] = {0, 0, 0, 0}; // min x, min y, max x, max y
  int total_toolchanges = 0;
};

// Loads the settings (a JSON object of upstream option strings) and sets every start-G-code variable from the
// facts. Returns "" on success, otherwise the reason. One session at a time (file-static state), like
// gcodeproc_bridge's streamed estimate.
std::string begin(const std::string& settings_json, const Facts& facts);

struct Expanded {
  std::string text;
  std::string error;   // "" = expanded; otherwise upstream's parser message (line, column, reason)
};
// Expands one template the way GCode::placeholder_parser_process does: `key` names it in error messages,
// `current_extruder` is the filament the template runs for. layer_num/layer_z/max_layer_z are set for the end
// G-code (GCode.cpp:3905-3910) when layer_num >= 0, and filament_extruder_id with current_filament_id,
// current_extruder_id and current_nozzle_id for a filament_end_gcode (GCode.cpp:3913-3927) when it is >= 0.
Expanded expand(const std::string& key, const std::string& templ, int current_extruder,
                int layer_num = -1, double layer_z = 0.0, double max_layer_z = 0.0, int filament_extruder_id = -1);

// A template setting's values: one entry for a string option, one per filament for a strings option
// (filament_end_gcode). Empty if the key is unknown.
std::vector<std::string> strings(const std::string& key);

// Whether the loaded settings describe a Bambu Lab printer (see begin() in the impl for how this is decided).
bool is_bbl_printer();

// The temperature lines upstream writes around the start G-code: before it, the first-layer bed temperature
// (M190) and the nozzle temperatures (M104) unless the expanded start G-code sets them itself
// (_print_first_layer_bed_temperature / _print_first_layer_extruder_temperatures), skipped for Klipper; after it,
// the nozzle temperatures again with wait (M109), for Bambu Lab printers only (GCode.cpp:3592).
struct TemperatureLines {
  std::string before;
  std::string after;
};
TemperatureLines start_temperatures(const std::string& expanded_start);

void end();

} // namespace custom_gcode_bridge
