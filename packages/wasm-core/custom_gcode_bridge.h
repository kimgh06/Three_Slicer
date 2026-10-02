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
  std::vector<int> filament_order;          // every filament that extrudes, in the order it first extrudes (the walk
                                            //  ToolOrdering::cal_non_support_filaments makes over the layer tools)
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

// A template with named variables on top of the session's: GCode::placeholder_parser_process's config_override,
//  for the templates whose variables are not the end G-code's (the layer change, the filament start).
struct Variable { std::string name; double value; bool integer; };
Expanded expand_with(const std::string& key, const std::string& templ, int current_extruder, const std::vector<Variable>& variables);
// PlaceholderParserIntegration::update_from_gcodewriter's totals before a template runs: the extruded volume (mm3)
//  per filament so far, from which extruded_weight(_total) follow by filament_density.
void set_extruded_volumes(const std::vector<double>& mm3_by_filament);
// file_start_gcode as GCode::_do_export writes it (GCode.cpp:2877): at the very top, with print_time_sec and
//  used_filament_length set to upstream's reserved tags (@PRINT_TIME_SEC@, @USED_FILAMENT_LENGTH@), which the host
//  replaces once the estimate exists (finalizeGcode).
Expanded expand_file_start();
// The printed mass so far (grams), extruded_weight_total.
double extruded_weight_total();
// GCode::mass_load_limited_machine_acceleration (GCode.cpp:5038) for a printed mass in grams.
void y_acceleration_limit(double mass_g, double& limit, double& accumulated);
// Whether a template key holds text (for a per-filament key: any filament's).
bool has_template(const std::string& key);
// The filament's physical extruder (physical_extruder_map), and the logical one (filament_map, 0-based).
int physical_extruder(int filament);
int logical_extruder(int filament);
// Whether the printer is a multi-nozzle one (an extruder_max_nozzle_count entry above 1).
bool multi_nozzle_printer();

// A template setting's values: one entry for a string option, one per filament for a strings option
// (filament_end_gcode). Empty if the key is unknown.
std::vector<std::string> strings(const std::string& key);

// Whether the loaded settings describe a Bambu Lab printer (see begin() in the impl for how this is decided).
bool is_bbl_printer();
// The rule itself, for a caller that has the printer model but no session (the multi-material path writes its modes
//  before the start block's session exists).
bool is_bbl_model(const std::string& printer_model);

// The temperature lines upstream writes around the start G-code: before it, the first-layer bed temperature
// (M190) and the nozzle temperatures (M104) unless the expanded start G-code sets them itself
// (_print_first_layer_bed_temperature / _print_first_layer_extruder_temperatures), skipped for Klipper; after it,
// the nozzle temperatures again with wait (M109), for Bambu Lab printers only (GCode.cpp:3592).
struct TemperatureLines {
  std::string before;
  std::string after;
  // The bed temperature upstream's writer believes is set once the block has run: the one it wrote, or the one the
  //  template set itself (_print_first_layer_bed_temperature always updates the state). 0 on Klipper, where that
  //  function is not called — so the second layer's M140 is always written there.
  int bed_set = 0;
  // The chamber block upstream writes between the role tag and the start G-code (GCode.cpp:3522), or "".
  std::string chamber;
};
TemperatureLines start_temperatures(const std::string& expanded_start);

// The filament the expanded start G-code leaves loaded (its last T line, GCodeProcessor::get_gcode_last_filament), or
//  -1: the "previous" filament of the first tool change on a printer other than Bambu Lab's. On a Bambu Lab printer
//  the writer starts with the first object filament loaded (init_extruder) and that change writes nothing.
void note_start_gcode(const std::string& expanded_start, int initial_filament);

// One tool change, as GCode::set_extruder (GCode.cpp:8714) writes it without a wipe tower and append_tcr
//  (GCode.cpp:956-1440) with one. The kernel records where the change happens and the session supplies the rest
//  from the settings, in print order (the tool change count and the filament each extruder last held are state).
struct Toolchange {
  int to = 0;                 // the filament switched to (0-based); the session knows the one loaded
  int layer = 0;              // m_layer_index
  double layer_z = 0.0;       // the print_z of the change
  double max_layer_z = 0.0;
  double x = 0.0, y = 0.0, z = 0.0;   // the nozzle where the change starts, printer frame
  bool tower = false;         // the change purges into the prime tower (append_tcr's variables)
  double purge_mm3 = 0.0;     // with the tower: the volume it purges
  double tower_x = 0.0, tower_y = 0.0;   // with the tower: where its block starts
};
struct ToolchangeText {
  std::string end, change, start;   // filament_end_gcode, change_filament_gcode with the T command, filament_start_gcode
  double pressure_advance = -1.0;   // the new filament's pressure advance when it enables it, else -1
  std::string error;
};
ToolchangeText expand_toolchange(const Toolchange& change);

void end();

} // namespace custom_gcode_bridge
