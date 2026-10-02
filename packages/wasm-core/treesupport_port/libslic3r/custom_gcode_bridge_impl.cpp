// Issue 63: the port side of custom_gcode_bridge.h. Lives inside treesupport_port/libslic3r/ so every Slic3r include
// is file-relative (port-local), like selector_bridge_impl.cpp, and so PlaceholderParser gets the real Flow.
//
// The variables are set in the order and under the names of GCode::_do_export (GCode.cpp:3180-3510) and
// GCode::update_placeholder_parser_with_variant_params (GCode.cpp:8654). Where upstream reads the Print, the value
// comes from Facts, and the object names from the host ($object_names). A template reading a variable this file
// does not set stops with the parser's "Variable does not exist" error, which reaches the viewer as the slice
// error, rather than expanding to a guess.
// Multi-nozzle printers (extruder_max_nozzle_count > 1, the H2C/A2L grouping) are modelled as upstream's static
// filament map: see nozzle_diameters_by_nozzle_id. print_time_sec and
// used_filament_length are left out as well; see set_start_variables.
#include "../../custom_gcode_bridge.h"

#include "PlaceholderParser.hpp"
#include "PrintConfig.hpp"
#include "Flow.hpp"
#include "BoundingBox.hpp"
#include "ClipperUtils.hpp"
#include "Geometry/ConvexHull.hpp"
#include "GCodeWriter.hpp"
#include "settings_json.hpp"

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <map>
#include <memory>
#include <random>
#include <sstream>

namespace custom_gcode_bridge {

using namespace Slic3r;

namespace {

struct Session {
  DynamicPrintConfig config;
  PlaceholderParser parser;
  PlaceholderParser::ContextData context;
  DynamicConfig output_config;
  Facts facts;
  double weight_total = 0.0;   // extruded_weight_total as last set (set_extruded_volumes)
  bool is_bbl = false;
  GCodeFlavor flavor = gcfMarlinLegacy;
  // The tool change state GCode keeps between set_extruder calls: the filament the start G-code left loaded
  //  (m_start_gcode_filament), the filament each extruder holds (the writer's m_curr_filament_extruder) and
  //  m_toolchange_count.
  int start_filament = -1;
  int current_filament = -1;                 // the writer's loaded filament, -1 = none yet
  std::map<int, int> loaded_on_extruder;
  int toolchange_count = 0;
};
std::unique_ptr<Session> g_session;

// The values a template may print that are not settings (model, plate and object names). They ride in the same
//  JSON object under a '$' prefix, which no config option has, so load_string_map skips them as unknown keys.
//  `$object_names` is a list (one per printable object, merge order); the others are strings.
std::map<std::string, std::string> g_extra_strings;
std::vector<std::string> g_object_names;
std::string extra_string(const char* key) {
  auto found = g_extra_strings.find(key);
  if (found == g_extra_strings.end())
    return std::string();
  return found->second;
}

// PrintBase::update_object_placeholders (PrintBase.cpp:25) over the object names the host sent. The kernel gets
//  baked geometry, so an instance's scale is already applied and the `scale` entries read 100%, which is what
//  upstream prints for an object whose instance is unscaled.
void set_object_variables(PlaceholderParser& parser) {
  const int num_objects = int(g_object_names.size());
  parser.set("num_objects", num_objects);
  parser.set("num_instances", num_objects);
  parser.set("scale", new ConfigOptionStrings(std::vector<std::string>(g_object_names.size(), "x:100% y:100% z:100%")));
  std::string first_object_name;
  if (!g_object_names.empty())
    first_object_name = g_object_names.front();
  parser.set("first_object_name", new ConfigOptionString(first_object_name));
  // input_file falls back to the object's source file upstream; the host sends one name per object, so the name
  //  is both. Basename, then everything before the last '.'.
  std::string input_filename = first_object_name.substr(first_object_name.find_last_of("/\\") + 1);
  const std::string input_filename_base = input_filename.substr(0, input_filename.find_last_of('.'));
  parser.set("input_filename", new ConfigOptionString(input_filename_base + ".gcode"));
  parser.set("input_filename_base", new ConfigOptionString(input_filename_base));
}

// The adaptive bed mesh variables, GCode.cpp:3363-3385, from the first layer's bounding box.
void set_bed_mesh_variables(PlaceholderParser& parser, const DynamicPrintConfig& config, const BoundingBoxf& bbox, GCodeFlavor flavor) {
  BoundingBoxf mesh_bbox(config.option<ConfigOptionPoint>("bed_mesh_min")->value, config.option<ConfigOptionPoint>("bed_mesh_max")->value);
  auto         mesh_margin = config.opt_float("adaptive_bed_mesh_margin");
  mesh_bbox.min            = mesh_bbox.min.cwiseMax((bbox.min.array() - mesh_margin).matrix());
  mesh_bbox.max            = mesh_bbox.max.cwiseMin((bbox.max.array() + mesh_margin).matrix());
  parser.set("adaptive_bed_mesh_min", new ConfigOptionFloats({mesh_bbox.min.x(), mesh_bbox.min.y()}));
  parser.set("adaptive_bed_mesh_max", new ConfigOptionFloats({mesh_bbox.max.x(), mesh_bbox.max.y()}));

  const Vec2d probe_distance = config.option<ConfigOptionPoint>("bed_mesh_probe_distance")->value;
  auto probe_dist_x  = std::max(1., probe_distance.x());
  auto probe_dist_y  = std::max(1., probe_distance.y());
  int  probe_count_x = std::max(3, (int) std::ceil(mesh_bbox.size().x() / probe_dist_x) + 1);
  int  probe_count_y = std::max(3, (int) std::ceil(mesh_bbox.size().y() / probe_dist_y) + 1);
  auto bed_mesh_algo = "bicubic";
  if (probe_count_x * probe_count_y <= 6) { // lagrange needs up to a total of 6 mesh points
      bed_mesh_algo = "lagrange";
  }
  else
      if(flavor == gcfKlipper){
        // bicubic needs 4 probe points per axis
        probe_count_x = std::max(probe_count_x,4);
        probe_count_y = std::max(probe_count_y,4);
      }
  parser.set("bed_mesh_probe_count", new ConfigOptionInts({probe_count_x, probe_count_y}));
  parser.set("bed_mesh_algo", bed_mesh_algo);
}


// get_extruder_id: the physical extruder a filament prints from. filament_map is 1-based.
int extruder_of(const DynamicPrintConfig& config, int filament) {
  const auto* nozzles = config.option<ConfigOptionFloats>("nozzle_diameter");
  if (nozzles == nullptr || nozzles->values.size() <= 1)
    return 0;
  const auto* map = config.option<ConfigOptionInts>("filament_map");
  if (map == nullptr || map->values.empty())
    return 0;
  return std::max(0, map->get_at(filament) - 1);
}

// The hotend a placeholder names (GCode.cpp:105-170, first_hotend_id_for_gcode_placeholder): -1 on a multi-nozzle
//  printer (an extruder_max_nozzle_count entry above 1 — the H2C/A2L nozzle clusters) and on the X2D, the extruder id
//  everywhere else. Upstream returns a real nozzle id only on its dynamic nozzle map, which no create() call sets.
int hotend_for(const DynamicPrintConfig& config, int extruder_id) {
  const auto& counts = config.option<ConfigOptionInts>("extruder_max_nozzle_count")->values;
  if (std::any_of(counts.begin(), counts.end(), [](int count) { return count > 1; }))
    return -1;
  if (config.opt_string("printer_model") == "Bambu Lab X2D")
    return -1;
  return extruder_id;
}

// The logical nozzle list of a static filament map, ToolOrdering.cpp build_default_nozzle_list: one nozzle per
//  extruder, nozzle id == extruder id, so a filament's nozzle is its extruder's. A multi-nozzle printer's automatic
//  grouping (FilamentGroup) can spread filaments over an extruder's nozzle cluster instead; that engine is not
//  ported, so such a print resolves here to each extruder's first nozzle. Every nozzle of a cluster carries the
//  extruder's diameter (MultiNozzleUtils.cpp create), so nozzle_diameter_at_nozzle_id[initial_nozzle_id] — the only
//  form the bundled templates read — is the same either way. Upstream leaves both lists empty only when it has no
//  group result at all, which a real slice always has.
std::vector<double> nozzle_diameters_by_nozzle_id(const DynamicPrintConfig& config) {
  return config.option<ConfigOptionFloats>("nozzle_diameter")->values;
}
// get_nozzle_volume_types_by_nozzle_id (GCode.cpp:202): up to the highest nozzle a used filament prints with.
std::vector<std::string> nozzle_volume_types_by_nozzle_id(const DynamicPrintConfig& config, const std::vector<int>& used_filaments) {
  const size_t nozzle_count = config.option<ConfigOptionFloats>("nozzle_diameter")->values.size();
  int max_nozzle_id = 0;
  for (int filament : used_filaments)
    max_nozzle_id = std::max(max_nozzle_id, extruder_of(config, filament));
  const auto& volume_types = config.option<ConfigOptionEnumsGeneric>("nozzle_volume_type")->values;
  std::vector<std::string> out(max_nozzle_id + 1, get_nozzle_volume_type_string(NozzleVolumeType::nvtStandard));
  for (int id = 0; id <= max_nozzle_id && size_t(id) < nozzle_count; ++id)
    if (size_t(id) < volume_types.size())
      out[id] = get_nozzle_volume_type_string(NozzleVolumeType(volume_types[id]));
  return out;
}

// custom_gcode_sets_temperature, verbatim from GCode.cpp:671 (a static there).
bool custom_gcode_sets_temperature(const std::string &gcode, const int mcode_set_temp_dont_wait, const int mcode_set_temp_and_wait, const bool include_g10, int &temp_out)
{
    temp_out = -1;
    if (gcode.empty())
        return false;

    const char *ptr = gcode.data();
    bool temp_set_by_gcode = false;
    while (*ptr != 0) {
        // Skip whitespaces.
        for (; *ptr == ' ' || *ptr == '\t'; ++ ptr);
        if (*ptr == 'M' || // Line starts with 'M'. It is a machine command.
            (*ptr == 'G' && include_g10)) { // Only check for G10 if requested
            bool is_gcode = *ptr == 'G';
            ++ ptr;
            // Parse the M or G code value.
            char *endptr = nullptr;
            int mgcode = int(strtol(ptr, &endptr, 10));
            bool matched = false;
            if (endptr != nullptr && endptr != ptr && is_gcode)
                matched = mgcode == 10;   // G10 found
            else if (endptr != nullptr && endptr != ptr)
                matched = mgcode == mcode_set_temp_dont_wait || mgcode == mcode_set_temp_and_wait;   // M104/M109 or M140/M190 found.
            if (matched) {
                ptr = endptr;
                if (! is_gcode)
                    // Let the caller know that the custom M-code sets the temperature.
                    temp_set_by_gcode = true;
                // Now try to parse the temperature value.
                // While not at the end of the line:
                while (strchr(";\r\n\0", *ptr) == nullptr) {
                    // Skip whitespaces.
                    for (; *ptr == ' ' || *ptr == '\t'; ++ ptr);
                    if (*ptr == 'S') {
                        // Skip whitespaces.
                        for (++ ptr; *ptr == ' ' || *ptr == '\t'; ++ ptr);
                        // Parse an int.
                        endptr = nullptr;
                        long temp_parsed = strtol(ptr, &endptr, 10);
                        if (endptr > ptr) {
                            ptr = endptr;
                            temp_out = temp_parsed;
                            // Let the caller know that the custom G-code sets the temperature
                            // Only do this after successfully parsing temperature since G10
                            // can be used for other reasons
                            temp_set_by_gcode = true;
                        }
                    } else {
                        // Skip this word.
                        for (; strchr(" \t;\r\n\0", *ptr) == nullptr; ++ ptr);
                    }
                }
            }
        }
        // Skip the rest of the line.
        for (; *ptr != 0 && *ptr != '\r' && *ptr != '\n'; ++ ptr);
        // Skip the end of line indicators.
        for (; *ptr == '\r' || *ptr == '\n'; ++ ptr);
    }
    return temp_set_by_gcode;
}

// get_outer_wall_volumetric_speed, GCode.cpp:651, reading the flattened config for the Print's default region.
float outer_wall_volumetric_speed(const DynamicPrintConfig& config, int filament_id, int extruder_id) {
  float filament_max_volumetric_speed = float(config.option<ConfigOptionFloats>("filament_max_volumetric_speed")->get_at(filament_id));
  const double filament_diameter = config.option<ConfigOptionFloats>("filament_diameter")->get_at(filament_id);
  float outer_wall_line_width = float(config.option<ConfigOptionFloatOrPercent>("outer_wall_line_width")->get_abs_value(filament_diameter));
  if (outer_wall_line_width == 0.0) {
    float default_line_width = float(config.option<ConfigOptionFloatOrPercent>("line_width")->get_abs_value(filament_diameter));
    outer_wall_line_width = float(filament_diameter);
    if (default_line_width != 0.0)
      outer_wall_line_width = default_line_width;
  }
  Flow outer_wall_flow = Flow(outer_wall_line_width, float(config.opt_float("layer_height")),
                              float(config.option<ConfigOptionFloats>("nozzle_diameter")->get_at(extruder_id)));
  float outer_wall_speed = float(config.option<ConfigOptionFloatsNullable>("outer_wall_speed")->get_at(extruder_id));
  float volumetric_speed = outer_wall_speed * float(outer_wall_flow.mm3_per_mm());
  if (volumetric_speed > filament_max_volumetric_speed)
    volumetric_speed = filament_max_volumetric_speed;
  return volumetric_speed;
}

int bed_temperature(const DynamicPrintConfig& config, int filament, bool first_layer) {
  BedType bed_type = config.opt_enum<BedType>("curr_bed_type");
  std::string key = get_bed_temp_key(bed_type);
  if (first_layer)
    key = get_bed_temp_1st_layer_key(bed_type);
  return config.option<ConfigOptionInts>(key)->get_at(filament);
}

// The first-layer bed temperature GCode::_print_first_layer_bed_temperature writes.
int first_layer_bed_temperature(const Session& session) {
  const DynamicPrintConfig& config = session.config;
  if (config.opt_enum<BedTempFormula>("bed_temperature_formula") == BedTempFormula::btfHighestTemp) {
    int highest = 0;
    for (int filament : session.facts.first_layer_filaments)
      highest = std::max(highest, bed_temperature(config, filament, true));
    return highest;
  }
  return bed_temperature(config, session.facts.initial_extruder, true);
}

void set_start_variables(Session& session) {
  PlaceholderParser& parser = session.parser;
  const DynamicPrintConfig& config = session.config;
  const Facts& facts = session.facts;
  const int initial_extruder_id = facts.initial_extruder;
  const int initial_non_support_extruder_id = facts.initial_no_support_extruder;
  const int extruder_id = extruder_of(config, initial_extruder_id);
  const size_t nozzle_count = config.option<ConfigOptionFloats>("nozzle_diameter")->values.size();

  // ToolOrdering::cal_non_support_filaments (ToolOrdering.cpp:1058) over the filaments in first-use order: one entry
  //  per extruder, its first filament and its first filament that is not support (-1 = none), with the same early
  //  returns. filament_map is 1-based; a static map only (this kernel has no dynamic nozzle grouping).
  std::vector<int> first_filaments(nozzle_count, -1);
  std::vector<int> first_non_support_filaments(nozzle_count, -1);
  {
    const auto* filament_map = config.option<ConfigOptionInts>("filament_map");
    const auto* is_support = config.option<ConfigOptionBools>("filament_is_support");
    const bool has_map = filament_map != nullptr && !filament_map->values.empty();
    const bool has_non_support = std::any_of(facts.used_filaments.begin(), facts.used_filaments.end(),
                                             [&](int filament) { return !is_support->get_at(filament); });
    auto extruder_for = [&](int filament) { return filament_map->get_at(filament) - 1; };
    auto in_range = [&](int extruder) { return extruder >= 0 && extruder < int(nozzle_count); };
    int first_count = 0;
    int non_support_count = 0;
    for (int filament : facts.filament_order) {
      if (has_map && in_range(extruder_for(filament)) && first_filaments[extruder_for(filament)] == -1) {
        first_filaments[extruder_for(filament)] = filament;
        first_count++;
      }
      if (has_non_support) {
        if (is_support->get_at(filament))
          continue;
        if (!has_map)
          break;
        if (in_range(extruder_for(filament)) && first_non_support_filaments[extruder_for(filament)] == -1) {
          first_non_support_filaments[extruder_for(filament)] = filament;
          non_support_count++;
        }
        if (non_support_count == int(nozzle_count))
          break;
      } else if (first_count == int(nozzle_count) || !has_map) {
        break;
      }
    }
  }
  // match_physical_extruder_for_each_filament (GCode.cpp:3172): logical extruder e is physical_extruder_map[e]. A
  //  map entry outside the extruder range is skipped, where upstream would write past the vector.
  auto to_physical = [&](const std::vector<int>& filaments) {
    const auto* physical_map = config.option<ConfigOptionInts>("physical_extruder_map");
    std::vector<int> physical(filaments.size(), 0);
    for (size_t extruder = 0; extruder < filaments.size(); ++extruder) {
      const int target = physical_map->get_at(extruder);
      if (target >= 0 && target < int(physical.size()))
        physical[target] = filaments[extruder];
    }
    return physical;
  };
  first_filaments = to_physical(first_filaments);
  parser.set("first_tools", new ConfigOptionInts(first_filaments));
  parser.set("first_filaments", new ConfigOptionInts(first_filaments));
  parser.set("initial_tool", initial_extruder_id);
  parser.set("initial_extruder", initial_extruder_id);
  first_non_support_filaments = to_physical(first_non_support_filaments);
  std::vector<int> first_non_support_hotends;
  for (int filament_id : first_non_support_filaments) {
    if (filament_id < 0)
      first_non_support_hotends.push_back(-1);
    else
      first_non_support_hotends.push_back(hotend_for(config, extruder_of(config, filament_id)));
  }
  parser.set("first_non_support_tools", new ConfigOptionInts(first_non_support_filaments));
  parser.set("first_non_support_filaments", new ConfigOptionInts(first_non_support_filaments));
  parser.set("first_non_support_hotend", new ConfigOptionInts(first_non_support_hotends));
  parser.set("initial_no_support_tool", initial_non_support_extruder_id);
  parser.set("initial_no_support_extruder", initial_non_support_extruder_id);
  parser.set("initial_no_support_hotend", hotend_for(config, extruder_of(config, initial_non_support_extruder_id)));
  parser.set("current_extruder", initial_extruder_id);
  parser.set("current_hotend", hotend_for(config, extruder_id));
  parser.set("current_filament_id", initial_extruder_id);
  parser.set("current_extruder_id", extruder_id);
  parser.set("current_nozzle_id", extruder_id);
  parser.set("initial_filament_id", initial_extruder_id);
  parser.set("initial_no_support_filament_id", initial_non_support_extruder_id);
  parser.set("initial_nozzle_id", extruder_id);
  parser.set("nozzle_diameter_at_nozzle_id", new ConfigOptionFloats(nozzle_diameters_by_nozzle_id(config)));
  parser.set("nozzle_volume_types", new ConfigOptionStrings(nozzle_volume_types_by_nozzle_id(config, facts.used_filaments)));
  parser.set("retraction_distance_when_cut", config.option<ConfigOptionFloats>("retraction_distances_when_cut")->get_at(initial_extruder_id));
  parser.set("long_retraction_when_cut", bool(config.option<ConfigOptionBools>("long_retractions_when_cut")->get_at(initial_extruder_id)));
  parser.set("retraction_distance_when_ec", config.option<ConfigOptionFloatsNullable>("retraction_distances_when_ec")->get_at(initial_extruder_id));
  parser.set("long_retraction_when_ec", bool(config.option<ConfigOptionBoolsNullable>("long_retractions_when_ec")->get_at(initial_extruder_id)));
  parser.set("temperature", new ConfigOptionInts(config.option<ConfigOptionInts>("nozzle_temperature")->values));
  parser.set("long_retractions_when_cut", new ConfigOptionBools(config.option<ConfigOptionBools>("long_retractions_when_cut")->values));
  parser.set("retraction_distances_when_ec", new ConfigOptionFloatsNullable(config.option<ConfigOptionFloatsNullable>("retraction_distances_when_ec")->values));
  parser.set("long_retractions_when_ec", new ConfigOptionBoolsNullable(config.option<ConfigOptionBoolsNullable>("long_retractions_when_ec")->values));

  // ToolOrdering::cal_max_additional_fan over the filaments that print.
  float max_additional_fan = 0.f;
  for (int filament : facts.used_filaments)
    max_additional_fan = std::max(max_additional_fan, float(config.option<ConfigOptionInts>("additional_cooling_fan_speed")->get_at(filament)));
  parser.set("max_additional_fan", double(max_additional_fan));
  parser.set("first_x_layer_fan_speed", new ConfigOptionFloats(config.option<ConfigOptionFloats>("first_x_layer_fan_speed")->values));
  parser.set("close_additional_fan_first_x_layers", new ConfigOptionInts(config.option<ConfigOptionInts>("close_additional_fan_first_x_layers")->values));
  parser.set("additional_fan_full_speed_layer", new ConfigOptionInts(config.option<ConfigOptionInts>("additional_fan_full_speed_layer")->values));

  parser.set("total_layer_count", facts.total_layer_count);
  parser.set("current_object_idx", 0);
  parser.set("has_wipe_tower", facts.has_wipe_tower);

  BoundingBoxf printer_bed_bbx(config.option<ConfigOptionPoints>("printable_area")->values);
  Vec2f wipe_tower_center = Vec2f::Zero();
  bool wipe_tower_center_valid = false;
  if (facts.has_wipe_tower) {
    const Vec2d tower_min(facts.wipe_tower_bbox[0], facts.wipe_tower_bbox[1]);
    const Vec2d tower_max(facts.wipe_tower_bbox[2], facts.wipe_tower_bbox[3]);
    const double tower_center_x = (tower_min.x() + tower_max.x()) * 0.5;
    const float tower_center_y = float((tower_min.y() + tower_max.y()) * 0.5);
    if (tower_center_x < printer_bed_bbx.center().x())
      wipe_tower_center = Vec2f(float(tower_max.x() + 2.f), tower_center_y);
    else
      wipe_tower_center = Vec2f(float(tower_min.x() - 2.f), tower_center_y);
    // The shared printable polygon of every extruder is the printable area for single- and dual-extruder printers.
    if (wipe_tower_center.x() < printer_bed_bbx.min[0]) wipe_tower_center.x() = float(printer_bed_bbx.min[0]);
    if (wipe_tower_center.x() > printer_bed_bbx.max[0]) wipe_tower_center.x() = float(printer_bed_bbx.max[0]);
    wipe_tower_center_valid = true;
  }
  parser.set("wipe_tower_center_pos_x", new ConfigOptionFloat(wipe_tower_center.x()));
  parser.set("wipe_tower_center_pos_y", new ConfigOptionFloat(wipe_tower_center.y()));
  parser.set("wipe_tower_center_pos_valid", new ConfigOptionBool(wipe_tower_center_valid));
  // Type2 towers only; this kernel's tower is upstream's WipeTower (Type1).
  parser.set("has_single_extruder_multi_material_priming", false);
  parser.set("total_toolchanges", facts.total_toolchanges);
  parser.set("num_extruders", int(nozzle_count));
  parser.set("retract_length", new ConfigOptionFloats(config.option<ConfigOptionFloats>("retraction_length")->values));

  std::vector<unsigned char> is_extruder_used(std::max(size_t(MAXIMUM_EXTRUDER_NUMBER), config.option<ConfigOptionFloats>("filament_diameter")->values.size()), 0);
  for (int filament : facts.used_filaments)
    if (filament >= 0 && size_t(filament) < is_extruder_used.size())
      is_extruder_used[filament] = true;
  parser.set("is_extruder_used", new ConfigOptionBools(is_extruder_used));

  {
    BoundingBoxf bbox_bed = printer_bed_bbx;
    parser.set("print_bed_min", new ConfigOptionFloats({ bbox_bed.min.x(), bbox_bed.min.y() }));
    parser.set("print_bed_max", new ConfigOptionFloats({ bbox_bed.max.x(), bbox_bed.max.y() }));
    parser.set("print_bed_size", new ConfigOptionFloats({ bbox_bed.size().x(), bbox_bed.size().y() }));

    // Convex hull of the 1st layer extrusions (objects, support, skirt, brim, wipe tower).
    Points first_layer_points;
    for (size_t i = 0; i + 1 < facts.first_layer_points.size(); i += 2)
      first_layer_points.emplace_back(scale_(facts.first_layer_points[i]), scale_(facts.first_layer_points[i + 1]));
    Polygon first_layer_convex_hull = Geometry::convex_hull(first_layer_points);
    auto pts = std::make_unique<ConfigOptionPoints>();
    pts->values.reserve(first_layer_convex_hull.size());
    for (const Point &pt : first_layer_convex_hull.points)
      pts->values.emplace_back(unscale(pt));
    BoundingBoxf bbox = BoundingBoxf(pts->values);
    parser.set("first_layer_print_convex_hull", pts.release());
    parser.set("first_layer_print_min", new ConfigOptionFloats({ bbox.min.x(), bbox.min.y() }));
    parser.set("first_layer_print_max", new ConfigOptionFloats({ bbox.max.x(), bbox.max.y() }));
    parser.set("first_layer_print_size", new ConfigOptionFloats({ bbox.size().x(), bbox.size().y() }));

    {
      // use first layer convex_hull union with each object's bbox to check whether in head detect zone
      Polygons object_projections;
      for (size_t i = 0; i + 3 < facts.object_bboxes.size(); i += 4) {
        Point min_p{ coord_t(scale_(facts.object_bboxes[i])), coord_t(scale_(facts.object_bboxes[i + 1])) };
        Point max_p{ coord_t(scale_(facts.object_bboxes[i + 2])), coord_t(scale_(facts.object_bboxes[i + 3])) };
        Polygon instance_projection = { {min_p.x(), min_p.y()}, {max_p.x(), min_p.y()}, {max_p.x(), max_p.y()}, {min_p.x(), max_p.y()} };
        object_projections.emplace_back(std::move(instance_projection));
      }
      object_projections.emplace_back(first_layer_convex_hull);
      Polygons project_polys = union_(object_projections);
      Polygon head_wrap_detect_zone;
      for (auto& point : config.option<ConfigOptionPoints>("head_wrap_detect_zone")->values)
        head_wrap_detect_zone.append(scale_(point).cast<coord_t>());
      parser.set("in_head_wrap_detect_zone", !intersection_pl(project_polys, Polygons{ head_wrap_detect_zone }).empty());
    }

    parser.set("max_print_z", new ConfigOptionInt(int(std::ceil(facts.max_print_z))));
    set_bed_mesh_variables(parser, config, bbox, session.flavor);

    // get center without wipe tower
    BoundingBoxf bbox_wo_wt;
    for (size_t i = 0; i + 3 < facts.object_first_layer_bboxes.size(); i += 4)
      bbox_wo_wt.merge(BoundingBoxf(Vec2d(facts.object_first_layer_bboxes[i], facts.object_first_layer_bboxes[i + 1]),
                                    Vec2d(facts.object_first_layer_bboxes[i + 2], facts.object_first_layer_bboxes[i + 3])));
    auto center = bbox_wo_wt.center();
    parser.set("first_layer_center_no_wipe_tower", new ConfigOptionFloats{ {center.x(), center.y()} });
  }

  bool activate_chamber_temp_control = false;
  int max_chamber_temp = 0;
  for (int filament : facts.used_filaments) {
    activate_chamber_temp_control |= bool(config.option<ConfigOptionBools>("activate_chamber_temp_control")->get_at(filament));
    max_chamber_temp = std::max(max_chamber_temp, config.option<ConfigOptionInts>("chamber_temperature")->get_at(filament));
  }
  (void)activate_chamber_temp_control;
  {
    BedType curr_bed_type = config.opt_enum<BedType>("curr_bed_type");
    int min_temperature_vitrification = std::numeric_limits<int>::max();
    for (int filament : facts.used_filaments)
      min_temperature_vitrification = std::min(min_temperature_vitrification, config.option<ConfigOptionInts>("temperature_vitrification")->get_at(filament));

    const ConfigOptionInts* first_bed_temp_opt = config.option<ConfigOptionInts>(get_bed_temp_1st_layer_key(curr_bed_type));
    const ConfigOptionInts* bed_temp_opt = config.option<ConfigOptionInts>(get_bed_temp_key(curr_bed_type));
    int target_bed_temp = first_layer_bed_temperature(session);

    parser.set("bbl_bed_temperature_gcode", new ConfigOptionBool(false));
    parser.set("bed_temperature_initial_layer", new ConfigOptionInts(*first_bed_temp_opt));
    parser.set("bed_temperature", new ConfigOptionInts(*bed_temp_opt));
    parser.set("bed_temperature_initial_layer_single", new ConfigOptionInt(target_bed_temp));
    parser.set("bed_temperature_initial_layer_vector", new ConfigOptionString());
    parser.set("chamber_temperature", new ConfigOptionInts(config.option<ConfigOptionInts>("chamber_temperature")->values));
    parser.set("overall_chamber_temperature", new ConfigOptionInt(max_chamber_temp));
    parser.set("chamber_minimal_temperature", new ConfigOptionInts(config.option<ConfigOptionInts>("chamber_minimal_temperature")->values));
    // !Print::need_check_multi_filaments_compatibility(): the app preference enable_high_low_temp_mixed_printing,
    //  whose default is false (AppConfig.cpp:453). There is no preference here.
    parser.set("enable_high_low_temp_mix", new ConfigOptionBool(false));
    parser.set("min_vitrification_temperature", new ConfigOptionInt(min_temperature_vitrification));

    parser.set("first_layer_bed_temperature", new ConfigOptionInts(*first_bed_temp_opt));
    parser.set("first_layer_temperature", new ConfigOptionInts(config.option<ConfigOptionInts>("nozzle_temperature_initial_layer")->values));
    parser.set("max_print_height", new ConfigOptionInt(int(config.opt_float("printable_height"))));
    parser.set("z_offset", new ConfigOptionFloat(config.opt_float("z_offset")));
    parser.set("model_name", new ConfigOptionString(extra_string("$model_name")));
    parser.set("plate_number", new ConfigOptionString(extra_string("$plate_number")));
    parser.set("plate_name", new ConfigOptionString(extra_string("$plate_name")));
    parser.set("first_layer_height", new ConfigOptionFloat(config.opt_float("initial_layer_print_height")));

    const auto* vendors = config.option<ConfigOptionStrings>("filament_vendor");
    parser.set("is_all_bbl_filament", std::all_of(facts.used_filaments.begin(), facts.used_filaments.end(), [&](int idx) {
      return vendors->get_at(idx) == "Bambu Lab";
    }));

    std::vector<int> during_print_exhaust_fan_speed_num;
    for (const auto& item : config.option<ConfigOptionInts>("during_print_exhaust_fan_speed")->values)
      during_print_exhaust_fan_speed_num.emplace_back((int)(item / 100.0 * 255));
    parser.set("during_print_exhaust_fan_speed_num", new ConfigOptionInts(during_print_exhaust_fan_speed_num));

    parser.set("outer_wall_volumetric_speed", new ConfigOptionFloat(
      outer_wall_volumetric_speed(config, initial_non_support_extruder_id, extruder_of(config, initial_non_support_extruder_id))));

    const auto* filament_types = config.option<ConfigOptionStrings>("filament_type");
    bool has_tpu_in_first_layer = std::any_of(facts.first_layer_filaments.begin(), facts.first_layer_filaments.end(),
                                              [&](int idx) { return filament_types->get_at(idx) == "TPU"; });
    parser.set("has_tpu_in_first_layer", new ConfigOptionBool(has_tpu_in_first_layer));
  }
  {
    // hold chamber temp for flat print: thresholds in mm^2 and mm (GCode.cpp:3462)
    double print_area_sum_threshold = 40000.0, pring_hight_threshold = 0.3;
    bool hold_chamber_temp_for_flat_print = facts.max_print_z > 0 && facts.max_print_z < pring_hight_threshold &&
                                            facts.first_layer_area_mm2 > print_area_sum_threshold;
    parser.set("hold_chamber_temp_for_flat_print", new ConfigOptionBool(hold_chamber_temp_for_flat_print));
  }

  // print_time_sec and used_filament_length are not set. Upstream sets them to GCodeProcessor reserved tags that
  //  its post-process replaces with the estimate (GCode.cpp:3505); the kernel streams the G-code text out layer by
  //  layer and never runs that post-process, so the tag itself would reach the printer. A template reading one
  //  stops with "Variable does not exist" instead (4 Creality machine profiles).

  // The profile aliases Print::apply sets for output_filename (PrintApply.cpp:1390), and the object placeholders
  //  GCode::_do_export sets through update_object_placeholders (GCode.cpp:3035).
  parser.set("print_preset", config.option("print_settings_id")->clone());
  parser.set("filament_preset", config.option("filament_settings_id")->clone());
  parser.set("printer_preset", config.option("printer_settings_id")->clone());
  set_object_variables(parser);

  // update_placeholder_parser_with_variant_params (GCode.cpp:8654). Without extruder variants the filament config
  //  index is the filament id, so each remap is the option's own values.
  parser.set("filament_max_volumetric_speed", new ConfigOptionFloats(config.option<ConfigOptionFloats>("filament_max_volumetric_speed")->values));
  parser.set("filament_pre_cooling_temperature", new ConfigOptionInts(config.option<ConfigOptionInts>("filament_pre_cooling_temperature")->values));
  parser.set("filament_pre_cooling_temperature_nc", new ConfigOptionInts(config.option<ConfigOptionInts>("filament_pre_cooling_temperature_nc")->values));
  parser.set("filament_cooling_before_tower", new ConfigOptionFloats(config.option<ConfigOptionFloats>("filament_cooling_before_tower")->values));
  parser.set("nozzle_temperature_initial_layer", new ConfigOptionInts(config.option<ConfigOptionInts>("nozzle_temperature_initial_layer")->values));
  parser.set("nozzle_temperature", new ConfigOptionInts(config.option<ConfigOptionInts>("nozzle_temperature")->values));
  parser.set("first_layer_temperature", new ConfigOptionInts(config.option<ConfigOptionInts>("nozzle_temperature_initial_layer")->values));
  parser.set("retraction_distances_when_cut", new ConfigOptionFloats(config.option<ConfigOptionFloats>("retraction_distances_when_cut")->values));
  parser.set("filament_map", new ConfigOptionInts(config.option<ConfigOptionInts>("filament_map")->values));
  {
    const size_t num_filaments = config.option<ConfigOptionStrings>("filament_type")->values.size();
    bool use_fast_flush = config.opt_enum<PrimeVolumeMode>("prime_volume_mode") == pvmFast;
    std::string flush_temp_key = "filament_flush_temp";
    if (use_fast_flush)
      flush_temp_key = "filament_flush_temp_fast";
    std::vector<double> flush_v_speed(num_filaments);
    std::vector<int> flush_temps(num_filaments);
    for (size_t i = 0; i < num_filaments; ++i) {
      flush_v_speed[i] = config.option<ConfigOptionFloats>("filament_flush_volumetric_speed")->get_at(i);
      flush_temps[i] = config.option<ConfigOptionInts>(flush_temp_key)->get_at(i);
      if (flush_v_speed[i] == 0)
        flush_v_speed[i] = config.option<ConfigOptionFloats>("filament_max_volumetric_speed")->get_at(i);
      if (flush_temps[i] == 0)
        flush_temps[i] = config.option<ConfigOptionInts>("nozzle_temperature_range_high")->get_at(i);
    }
    parser.set("flush_volumetric_speeds", new ConfigOptionFloats(flush_v_speed));
    parser.set("flush_temperatures", new ConfigOptionInts(flush_temps));
  }
}

}  // namespace

std::string begin(const std::string& settings_json, const Facts& facts) {
  g_session.reset();
  g_extra_strings.clear();
  g_object_names.clear();
  auto session = std::make_unique<Session>();
  std::vector<std::pair<std::string, std::string>> extras;
  std::vector<std::string> object_names;
  {
    std::string error = load_settings_json(settings_json, session->config, extras, object_names);
    if (!error.empty())
      return error;
  }
  for (const auto& [key, value] : extras)
    g_extra_strings[key] = value;
  g_object_names = object_names;
  session->facts = facts;
  const std::string printer_model = session->config.opt_string("printer_model");
  // Upstream decides this by the preset's vendor (PresetBundle::is_bbl_vendor). The flattened preset carries the
  //  model, and among the bundled profiles "Bambu Lab ..." is exactly the BBL vendor's machines (56 of 56, and none
  //  of the other 873).
  session->is_bbl = is_bbl_model(printer_model);
  session->flavor = session->config.opt_enum<GCodeFlavor>("gcode_flavor");
  try {
    session->parser.apply_config(session->config);
    // A fixed seed rather than upstream's clock (GCode.cpp:3032): the same input gives the same G-code.
    session->context.rng = std::mt19937(0);
    session->context.global_config = std::make_unique<DynamicConfig>();
    // PlaceholderParserIntegration::init with nothing extruded yet: the script-writable outputs and the
    //  read-only extrusion totals. Relative E (M83) is the kernel's mode, so there is no e_position.
    session->output_config.set_key_value("e_retracted", new ConfigOptionFloats(MAXIMUM_EXTRUDER_NUMBER, 0.));
    session->output_config.set_key_value("e_restart_extra", new ConfigOptionFloats(MAXIMUM_EXTRUDER_NUMBER, 0.));
    session->output_config.set_key_value("position", new ConfigOptionFloats(3, 0.));
    const size_t num_extruders = session->config.option<ConfigOptionFloats>("filament_diameter")->values.size();
    session->parser.set("extruded_volume", new ConfigOptionFloats(num_extruders, 0.));
    session->parser.set("extruded_weight", new ConfigOptionFloats(num_extruders, 0.));
    session->parser.set("extruded_volume_total", new ConfigOptionFloat(0.));
    session->parser.set("extruded_weight_total", new ConfigOptionFloat(0.));
    session->parser.set("zhop", new ConfigOptionFloat(0.));
    set_start_variables(*session);
  } catch (const std::exception& error) {
    return std::string("placeholder variables could not be set: ") + error.what();
  }
  g_session = std::move(session);
  return std::string();
}

Expanded expand(const std::string& key, const std::string& templ, int current_extruder,
                int layer_num, double layer_z, double max_layer_z, int filament_extruder_id) {
  Expanded out;
  if (!g_session) {
    out.error = key + ": no settings loaded";
    return out;
  }
  DynamicConfig config_override;
  if (layer_num >= 0) {
    config_override.set_key_value("layer_num", new ConfigOptionInt(layer_num));
    config_override.set_key_value("layer_z", new ConfigOptionFloat(layer_z));
    config_override.set_key_value("max_layer_z", new ConfigOptionFloat(max_layer_z));
    config_override.set_key_value("nozzle_diameter_at_nozzle_id", new ConfigOptionFloats(nozzle_diameters_by_nozzle_id(g_session->config)));
    config_override.set_key_value("nozzle_volume_types", new ConfigOptionStrings(nozzle_volume_types_by_nozzle_id(g_session->config, g_session->facts.used_filaments)));
  }
  if (filament_extruder_id >= 0) {
    const int extruder_id = extruder_of(g_session->config, filament_extruder_id);
    config_override.set_key_value("filament_extruder_id", new ConfigOptionInt(filament_extruder_id));
    config_override.set_key_value("current_filament_id", new ConfigOptionInt(filament_extruder_id));
    config_override.set_key_value("current_extruder_id", new ConfigOptionInt(extruder_id));
    config_override.set_key_value("current_nozzle_id", new ConfigOptionInt(extruder_id));
  }
  try {
    const DynamicConfig* override_ptr = nullptr;
    if (layer_num >= 0 || filament_extruder_id >= 0)
      override_ptr = &config_override;
    out.text = g_session->parser.process(templ, (unsigned int)std::max(0, current_extruder), override_ptr,
                                         &g_session->output_config, &g_session->context);
  } catch (const std::exception& error) {
    out.text.clear();
    out.error = key + ": " + error.what();
  }
  return out;
}

Expanded expand_with(const std::string& key, const std::string& templ, int current_extruder, const std::vector<Variable>& variables) {
  Expanded out;
  if (!g_session) {
    out.error = key + ": no settings loaded";
    return out;
  }
  DynamicConfig config_override;
  for (const Variable& variable : variables) {
    if (variable.integer) config_override.set_key_value(variable.name, new ConfigOptionInt(int(std::lround(variable.value))));
    else config_override.set_key_value(variable.name, new ConfigOptionFloat(variable.value));
  }
  config_override.set_key_value("nozzle_diameter_at_nozzle_id", new ConfigOptionFloats(nozzle_diameters_by_nozzle_id(g_session->config)));
  config_override.set_key_value("nozzle_volume_types", new ConfigOptionStrings(nozzle_volume_types_by_nozzle_id(g_session->config, g_session->facts.used_filaments)));
  try {
    out.text = g_session->parser.process(templ, (unsigned int)std::max(0, current_extruder), &config_override,
                                         &g_session->output_config, &g_session->context);
  } catch (const std::exception& error) {
    out.text.clear();
    out.error = key + ": " + error.what();
  }
  return out;
}

Expanded expand_file_start() {
  Expanded out;
  if (!g_session) return out;
  const std::vector<std::string> templ = strings("file_start_gcode");
  if (templ.empty() || templ.front().empty()) return out;
  DynamicConfig top_config;
  PlaceholderParser::update_timestamp(top_config);
  PlaceholderParser::update_user_name(top_config);
  top_config.set_key_value("print_time_sec", new ConfigOptionString("@PRINT_TIME_SEC@"));
  top_config.set_key_value("used_filament_length", new ConfigOptionString("@USED_FILAMENT_LENGTH@"));
  try {
    out.text = g_session->parser.process(templ.front(), 0, &top_config, &g_session->output_config, &g_session->context);
  } catch (const std::exception& error) {
    out.text.clear();
    out.error = std::string("file_start_gcode: ") + error.what();
  }
  return out;
}

void set_extruded_volumes(const std::vector<double>& mm3_by_filament) {
  if (!g_session) return;
  const DynamicPrintConfig& config = g_session->config;
  const size_t count = config.option<ConfigOptionFloats>("filament_diameter")->values.size();
  std::vector<double> volume(count, 0.), weight(count, 0.);
  double total_volume = 0., total_weight = 0.;
  for (size_t filament = 0; filament < count && filament < mm3_by_filament.size(); ++filament) {
    volume[filament] = mm3_by_filament[filament];
    weight[filament] = volume[filament] * config.option<ConfigOptionFloats>("filament_density")->get_at(filament) * 0.001;
    total_volume += volume[filament];
    total_weight += weight[filament];
  }
  g_session->parser.set("extruded_volume", new ConfigOptionFloats(volume));
  g_session->parser.set("extruded_weight", new ConfigOptionFloats(weight));
  g_session->parser.set("extruded_volume_total", new ConfigOptionFloat(total_volume));
  g_session->parser.set("extruded_weight_total", new ConfigOptionFloat(total_weight));
  g_session->weight_total = total_weight;
}

double extruded_weight_total() {
  if (!g_session) return 0.;
  return g_session->weight_total;
}

void y_acceleration_limit(double mass_g, double& limit, double& accumulated) {
  limit = -1; accumulated = -1;
  if (!g_session) return;
  const DynamicPrintConfig& config = g_session->config;
  double curr_acceleration_y_config = 1e10;
  for (double value : config.option<ConfigOptionFloats>("machine_max_acceleration_y")->values)
    if (curr_acceleration_y_config > value) curr_acceleration_y_config = value;
  accumulated = mass_g;
  const double machine_max_force_Y = config.opt_float("machine_max_force_Y"), machine_bed_mass_Y = config.opt_float("machine_bed_mass_Y");
  if (machine_max_force_Y > EPSILON && machine_bed_mass_Y > EPSILON) {
    const double virtual_force_g_mms2 = machine_max_force_Y * 1e6;
    if (accumulated > EPSILON) limit = std::min(virtual_force_g_mms2 / (machine_bed_mass_Y + accumulated), curr_acceleration_y_config);
    else limit = curr_acceleration_y_config;
  } else {
    limit = curr_acceleration_y_config;
  }
}

bool has_template(const std::string& key) {
  for (const std::string& value : strings(key))
    if (!value.empty()) return true;
  return false;
}

int logical_extruder(int filament) {
  if (!g_session) return 0;
  return extruder_of(g_session->config, filament);
}

bool multi_nozzle_printer() {
  if (!g_session) return false;
  const auto& counts = g_session->config.option<ConfigOptionInts>("extruder_max_nozzle_count")->values;
  return std::any_of(counts.begin(), counts.end(), [](int count) { return count > 1; });
}

int physical_extruder(int filament) {
  if (!g_session) return 0;
  const int extruder = extruder_of(g_session->config, filament);
  return g_session->config.option<ConfigOptionInts>("physical_extruder_map")->get_at(extruder);
}

std::vector<std::string> strings(const std::string& key) {
  std::vector<std::string> values;
  if (!g_session)
    return values;
  const ConfigOption* option = g_session->config.option(key);
  if (option == nullptr)
    return values;
  if (option->type() == coStrings)
    return static_cast<const ConfigOptionStrings*>(option)->values;
  if (option->type() == coString)
    values.push_back(static_cast<const ConfigOptionString*>(option)->value);
  return values;
}

bool is_bbl_model(const std::string& printer_model) {
  return printer_model.rfind("Bambu Lab", 0) == 0;
}

bool is_bbl_printer() {
  return g_session && g_session->is_bbl;
}

TemperatureLines start_temperatures(const std::string& expanded_start) {
  TemperatureLines lines;
  if (!g_session)
    return lines;
  const Session& session = *g_session;
  const DynamicPrintConfig& config = session.config;
  const auto* first_layer_temps = config.option<ConfigOptionInts>("nozzle_temperature_initial_layer");
  const bool multiple_extruders = session.facts.used_filaments.size() > 1;
  const bool single_extruder_multi_material = config.opt_bool("single_extruder_multi_material");
  int temp_by_gcode = -1;
  // _print_first_layer_extruder_temperatures (GCode.cpp:4563) as text; the writer's temperature state has no
  //  counterpart here.
  auto extruder_temperatures = [&](bool wait) {
    std::string text;
    if (custom_gcode_sets_temperature(expanded_start, 104, 109, session.flavor == gcfRepRapFirmware, temp_by_gcode))
      return text;
    if (single_extruder_multi_material) {
      int temp = first_layer_temps->get_at(session.facts.initial_extruder);
      if (temp > 0)
        text += GCodeWriter::set_temperature(temp, session.flavor, wait, -1);
      return text;
    }
    for (int tool_id : session.facts.used_filaments) {
      int temp = first_layer_temps->get_at(tool_id);
      int tool = -1;
      if (multiple_extruders)
        tool = tool_id;
      if (temp > 0)
        text += GCodeWriter::set_temperature(temp, session.flavor, wait, tool);
    }
    return text;
  };
  if (session.flavor != gcfKlipper) {
    // _print_first_layer_bed_temperature (GCode.cpp:4530), wait = true.
    lines.bed_set = first_layer_bed_temperature(session);
    if (!custom_gcode_sets_temperature(expanded_start, 140, 190, false, temp_by_gcode))
      lines.before += "M190 S" + std::to_string(lines.bed_set) + " ; set bed temperature and wait for it to be reached\n";
    else if (temp_by_gcode >= 0 && temp_by_gcode < 1000)
      lines.bed_set = temp_by_gcode;
    lines.before += extruder_temperatures(false);
  }
  // Chamber: GCode.cpp:3522 — the highest chamber temperature of the used filaments, with wait, when one of them asks
  //  for chamber control and the start G-code does not set it itself.
  {
    bool activate = false;
    int max_chamber_temp = 0;
    for (int filament : session.facts.used_filaments) {
      activate |= bool(config.option<ConfigOptionBools>("activate_chamber_temp_control")->get_at(filament));
      max_chamber_temp = std::max(max_chamber_temp, config.option<ConfigOptionInts>("chamber_temperature")->get_at(filament));
    }
    int chamber_by_gcode = 0;
    if (activate && max_chamber_temp > 0 && !custom_gcode_sets_temperature(expanded_start, 141, 191, false, chamber_by_gcode)) {
      std::string chamber = "M191 S" + std::to_string(max_chamber_temp) + " ;set chamber_temperature and wait for it to be reached\n";
      if (config.opt_bool("auxiliary_fan"))
        chamber = "M106 P2 S255 \n" + chamber + "M106 P2 S0 \n";
      lines.chamber = chamber;
    }
  }
  if (session.is_bbl)
    lines.after = extruder_temperatures(true);
  return lines;
}

void note_start_gcode(const std::string& expanded_start, int initial_filament) {
  if (!g_session) return;
  Session& session = *g_session;
  session.loaded_on_extruder.clear();
  session.start_filament = -1;
  session.current_filament = -1;
  session.toolchange_count = 0;
  if (session.is_bbl) {   // m_writer.init_extruder(initial_non_support_extruder_id), GCode.cpp:3543
    session.loaded_on_extruder[extruder_of(session.config, initial_filament)] = initial_filament;
    session.current_filament = initial_filament;
    return;
  }
  // GCodeProcessor::get_gcode_last_filament: the last line that starts with T and a number below 255.
  size_t from = 0;
  while (from < expanded_start.size()) {
    size_t to = expanded_start.find('\n', from);
    if (to == std::string::npos) to = expanded_start.size();
    std::string line = expanded_start.substr(from, to - from);
    from = to + 1;
    line.erase(0, line.find_first_not_of(' '));
    line.erase(line.find_last_not_of(' ') + 1);
    if (line.empty() || line[0] != 'T') continue;
    char* end = nullptr;
    const long number = std::strtol(line.c_str() + 1, &end, 10);
    if (end != line.c_str() + 1 && *end == '\0' && number >= 0 && number < 255) session.start_filament = int(number);
  }
}

namespace {
// get_wipe_avoid_pos_x, GCode.cpp:553.
float wipe_avoid_pos_x(float tower_min_x, float tower_max_x, float offset) {
  const float left = 100, right = 250, default_value = 110.f;
  const float a = tower_max_x + offset, b = tower_min_x - offset;
  if (a > left && a < right) return a;
  if (b > left && b < right) return b;
  return default_value;
}

// get_path_of_change_filament, GCode.cpp:230: the path a cutter printer's head takes to its cutter, around the
//  objects' x ranges. The objects are the facts' bounding boxes.
std::vector<Vec2d> path_of_change_filament(const DynamicPrintConfig& config, const std::vector<double>& object_bboxes) {
  std::vector<Vec2d> out_points = { Vec2d(54, 0), Vec2d(54, 0), Vec2d(54, 245) };
  const Pointfs& points = config.option<ConfigOptionPoints>("start_end_points")->values;
  if (points.size() != 2) return out_points;
  const Vec2d start_point = points[0], end_point = points[1];
  const Pointfs& exclude_area = config.option<ConfigOptionPoints>("bed_exclude_area")->values;
  if (exclude_area.size() != 4) return out_points;
  const double cutter_area_y = exclude_area[2].y() + 2;
  const double start_x_position = start_point.x(), end_x_position = end_point.x(), end_y_position = end_point.y();
  bool can_travel_form_left = true;
  std::vector<std::pair<double, double>> object_intervals;
  for (size_t k = 0; k + 3 < object_bboxes.size(); k += 4) {
    const double min_x = object_bboxes[k], min_y = object_bboxes[k + 1], max_x = object_bboxes[k + 2];
    if (min_x < start_x_position && min_y < cutter_area_y) can_travel_form_left = false;
    std::pair<double, double> object_scope = std::make_pair(min_x - 2, max_x + 2);
    if (object_intervals.empty()) { object_intervals.push_back(object_scope); continue; }
    std::vector<std::pair<double, double>> new_object_intervals;
    bool intervals_intersect = false;
    std::pair<double, double> new_merged_scope;
    for (auto object_interval : object_intervals) {
      if (object_interval.second >= object_scope.first && object_interval.first <= object_scope.second) {
        if (intervals_intersect)
          new_merged_scope = std::make_pair(std::min(object_interval.first, new_merged_scope.first), std::max(object_interval.second, new_merged_scope.second));
        else
          new_merged_scope = std::make_pair(std::min(object_interval.first, object_scope.first), std::max(object_interval.second, object_scope.second));
        intervals_intersect = true;
      } else {
        new_object_intervals.push_back(object_interval);
      }
    }
    if (intervals_intersect) { new_object_intervals.push_back(new_merged_scope); object_intervals = new_object_intervals; }
    else object_intervals.push_back(object_scope);
  }
  std::sort(object_intervals.begin(), object_intervals.end(),
            [](const std::pair<double, double>& left, const std::pair<double, double>& right) { return left.first < right.first; });
  std::vector<std::pair<double, double>> available_intervals;
  double start_position = 0;
  for (auto object_interval : object_intervals) {
    if (object_interval.first > start_position) available_intervals.push_back(std::make_pair(start_position, object_interval.first));
    start_position = object_interval.second;
  }
  available_intervals.push_back(std::make_pair(start_position, 255));
  double new_path = 255;
  for (auto available_interval : available_intervals) {
    if (available_interval.first > end_x_position) {
      const double distance = available_interval.first - end_x_position;
      if (!(std::abs(end_x_position - new_path) < distance)) new_path = available_interval.first;
      break;
    }
    if (available_interval.second >= end_x_position) { new_path = end_x_position; break; }
    if (!can_travel_form_left && available_interval.second < start_x_position) continue;
    new_path = available_interval.second;
  }
  if (new_path < start_x_position)
    return { Vec2d(start_x_position, cutter_area_y), Vec2d(new_path, cutter_area_y), Vec2d(new_path, end_y_position) };
  return { Vec2d(new_path, 0), Vec2d(new_path, 0), Vec2d(new_path, end_y_position) };
}

// custom_gcode_changes_tool, GCode.cpp:361: the template writes the tool change itself.
bool custom_gcode_changes_tool(const std::string& custom_gcode, const std::string& tch_prefix, unsigned next_extruder) {
  bool ok = false;
  size_t from_pos = 0, pos = 0;
  while ((pos = custom_gcode.find(tch_prefix, from_pos)) != std::string::npos) {
    if (pos + 1 == custom_gcode.size()) break;
    from_pos = pos + 1;
    bool only_whitespace = true;   // only whitespace is allowed before the command
    while (--pos < custom_gcode.size() && custom_gcode[pos] != '\n')
      if (!std::isspace((unsigned char)custom_gcode[pos])) { only_whitespace = false; break; }
    if (!only_whitespace) continue;
    std::istringstream ss(custom_gcode.substr(from_pos, std::string::npos));
    unsigned num = 0;
    if (ss >> num) ok = (num == next_extruder);
  }
  return ok;
}

// The purge table for `filament_count` filaments: a project keeps flush_volumes_matrix at filament_count² per nozzle
//  (PresetBundle::update_multi_material_filament_presets, PresetBundle.cpp:5360); a printer that never set one carries
//  the schema's 4x4 default. Resized the way upstream resizes it: the old pairs kept, a new pair is the sum of the two
//  filaments' wiping_volumes_extruders entries, the diagonal 0.
std::vector<double> flush_matrix_for(const DynamicPrintConfig& config, size_t filament_count) {
  const std::vector<double>& old_matrix = config.option<ConfigOptionFloats>("flush_volumes_matrix")->values;
  const size_t nozzle_nums = std::max<size_t>(1, config.option<ConfigOptionFloats>("nozzle_diameter")->values.size());
  const size_t new_matrix_size = filament_count * filament_count;
  if (old_matrix.size() == new_matrix_size * nozzle_nums) return old_matrix;
  const size_t old_number = size_t(std::sqrt(double(old_matrix.size() / nozzle_nums)) + EPSILON);
  const size_t old_matrix_size = old_number * old_number;
  std::vector<double> filaments = config.option<ConfigOptionFloats>("wiping_volumes_extruders")->values;
  while (filaments.size() < 2 * filament_count) {
    double unload = 140., load = 140.;
    if (filaments.size() > 1) { unload = filaments[0]; load = filaments[1]; }
    filaments.push_back(unload);
    filaments.push_back(load);
  }
  std::vector<double> new_matrix(new_matrix_size * nozzle_nums, 0);
  for (size_t i = 0; i < filament_count; ++i)
    for (size_t j = 0; j < filament_count; ++j)
      for (size_t nozzle_id = 0; nozzle_id < nozzle_nums; ++nozzle_id) {
        double value = 0.;
        if (i < old_number && j < old_number && old_matrix_size * (nozzle_id + 1) <= old_matrix.size())
          value = old_matrix[i * old_number + j + old_matrix_size * nozzle_id];
        else if (i != j)
          value = filaments[2 * i] + filaments[2 * j + 1];
        new_matrix[i * filament_count + j + new_matrix_size * nozzle_id] = value;
      }
  return new_matrix;
}

void check_add_eol(std::string& gcode) {
  if (!gcode.empty() && gcode.back() != '\n') gcode += '\n';
}
}  // namespace

ToolchangeText expand_toolchange(const Toolchange& change) {
  ToolchangeText out;
  if (!g_session) { out.error = "change_filament_gcode: no settings loaded"; return out; }
  Session& session = *g_session;
  const DynamicPrintConfig& config = session.config;
  const int new_filament_id = change.to;
  const int new_extruder_id = extruder_of(config, new_filament_id);
  const bool on_first_layer = change.layer == 0;
  auto ints = [&](const char* key) { return config.option<ConfigOptionInts>(key); };
  auto floats = [&](const char* key) { return config.option<ConfigOptionFloats>(key); };
  auto nullable_floats = [&](const char* key) { return config.option<ConfigOptionFloatsNullable>(key); };
  auto nullable_ints = [&](const char* key) { return config.option<ConfigOptionIntsNullable>(key); };

  // The filament loaded now (the writer's); need_toolchange: selecting it again writes nothing.
  int old_filament_id = session.current_filament, old_extruder_id = -1;
  const bool writer_has_filament = old_filament_id >= 0;
  if (writer_has_filament) old_extruder_id = extruder_of(config, old_filament_id);
  if (writer_has_filament && old_filament_id == new_filament_id) return out;
  ++session.toolchange_count;
  const std::string toolchange_prefix = [&]() -> std::string {
    if (config.opt_bool("manual_filament_change")) return "; MANUAL_TOOL_CHANGE T";
    if (session.flavor == gcfMakerWare) return "M135 T";
    if (session.flavor == gcfSailfish) return "M108 T";
    return "T";
  }();

  // filament_end_gcode of the filament being unloaded (set_extruder :8771 / append_tcr :956).
  if (writer_has_filament) {
    const std::string& filament_end_gcode = config.option<ConfigOptionStrings>("filament_end_gcode")->get_at(old_filament_id);
    if (!filament_end_gcode.empty()) {
      DynamicConfig dyn;
      dyn.set_key_value("layer_num", new ConfigOptionInt(change.layer));
      dyn.set_key_value("layer_z", new ConfigOptionFloat(change.layer_z));
      dyn.set_key_value("max_layer_z", new ConfigOptionFloat(change.max_layer_z));
      dyn.set_key_value("filament_extruder_id", new ConfigOptionInt(old_extruder_id));
      dyn.set_key_value("current_filament_id", new ConfigOptionInt(old_filament_id));
      dyn.set_key_value("current_nozzle_id", new ConfigOptionInt(old_extruder_id));
      dyn.set_key_value("nozzle_diameter_at_nozzle_id", new ConfigOptionFloats(nozzle_diameters_by_nozzle_id(config)));
      dyn.set_key_value("nozzle_volume_types", new ConfigOptionStrings(nozzle_volume_types_by_nozzle_id(config, session.facts.used_filaments)));
      try {
        out.end = session.parser.process(filament_end_gcode, (unsigned int)old_filament_id, &dyn, &session.output_config, &session.context);
      } catch (const std::exception& error) { out.error = std::string("filament_end_gcode: ") + error.what(); return out; }
      check_add_eol(out.end);
    }
  }
  if (!writer_has_filament && session.start_filament >= 0) {   // m_start_gcode_filament
    old_filament_id = session.start_filament;
    old_extruder_id = extruder_of(config, old_filament_id);
  }
  session.start_filament = -1;

  // The values set_extruder computes for the template (GCode.cpp:8812-8990), append_tcr's where they differ.
  const size_t new_fi = size_t(new_filament_id);
  const float new_retract_length = float(floats("retraction_length")->get_at(new_fi));
  const float new_retract_length_toolchange = float(floats("retract_length_toolchange")->get_at(new_fi));
  int new_filament_temp = ints("nozzle_temperature")->get_at(new_fi);
  if (on_first_layer || std::abs(change.layer_z) < EPSILON) new_filament_temp = ints("nozzle_temperature_initial_layer")->get_at(new_fi);
  const float filament_area = float((M_PI / 4.f) * std::pow(floats("filament_diameter")->get_at(new_fi), 2));
  float old_retract_length = 0.f, old_retract_length_toolchange = 0.f, wipe_volume = 0.f;
  int old_filament_temp = 0, old_filament_e_feedrate = 200;
  if (old_filament_id >= 0) {
    const size_t old_fi = size_t(old_filament_id);
    old_retract_length = float(floats("retraction_length")->get_at(old_fi));
    old_retract_length_toolchange = float(floats("retract_length_toolchange")->get_at(old_fi));
    old_filament_temp = ints("nozzle_temperature")->get_at(old_fi);
    if (on_first_layer) old_filament_temp = ints("nozzle_temperature_initial_layer")->get_at(old_fi);
    const size_t number_of_extruders = config.option<ConfigOptionStrings>("filament_colour")->values.size();
    const std::vector<double> flush_matrix = get_flush_volumes_matrix(flush_matrix_for(config, number_of_extruders), size_t(new_extruder_id),
                                                                       floats("nozzle_diameter")->values.size());
    const float grab_purge_volume = float(floats("grab_length")->get_at(new_extruder_id) * 2.4);
    auto flush_between = [&](int from_filament) {
      const size_t index = size_t(from_filament) * number_of_extruders + new_fi;
      if (index >= flush_matrix.size()) return 0.f;
      return float(flush_matrix[index] * floats("flush_multiplier")->get_at(new_extruder_id));
    };
    if (old_extruder_id != new_extruder_id) {
      auto held = session.loaded_on_extruder.find(new_extruder_id);
      if (held != session.loaded_on_extruder.end()) wipe_volume = flush_between(held->second);
    } else {
      wipe_volume = flush_between(old_filament_id);
    }
    wipe_volume = std::max(0.f, wipe_volume - grab_purge_volume);
    old_filament_e_feedrate = int(60.0 * floats("filament_max_volumetric_speed")->get_at(old_fi) / filament_area);
    if (old_filament_e_feedrate == 0) old_filament_e_feedrate = 100;
  }
  if (change.tower) {   // append_tcr: the tower's purge, at least g_min_purge_volume
    // The kernel's tower purges the host's table; without one it prints a fixed tower, and the volume is the table's.
    float purge_volume = wipe_volume;
    if (change.purge_mm3 >= 0) purge_volume = float(change.purge_mm3);
    wipe_volume = 0.f;
    if (purge_volume >= EPSILON) wipe_volume = std::max(purge_volume, 100.f);
  }
  const float wipe_length = wipe_volume / filament_area;
  int new_filament_e_feedrate = int(60.0 * floats("filament_max_volumetric_speed")->get_at(new_fi) / filament_area);
  if (new_filament_e_feedrate == 0) new_filament_e_feedrate = 100;

  DynamicConfig dyn;
  dyn.set_key_value("outer_wall_volumetric_speed", new ConfigOptionFloat(outer_wall_volumetric_speed(config, new_filament_id, new_extruder_id)));
  dyn.set_key_value("previous_extruder", new ConfigOptionInt(old_filament_id));
  dyn.set_key_value("next_extruder", new ConfigOptionInt(new_filament_id));
  dyn.set_key_value("current_hotend", new ConfigOptionInt(hotend_for(config, old_extruder_id)));
  dyn.set_key_value("next_hotend", new ConfigOptionInt(hotend_for(config, new_extruder_id)));
  dyn.set_key_value("current_nozzle_id", new ConfigOptionInt(old_extruder_id));
  dyn.set_key_value("next_nozzle_id", new ConfigOptionInt(new_extruder_id));
  dyn.set_key_value("current_filament_id", new ConfigOptionInt(old_filament_id));
  dyn.set_key_value("next_filament_id", new ConfigOptionInt(new_filament_id));
  {
    const auto& extruder_variants = config.option<ConfigOptionStrings>("printer_extruder_variant")->values;
    std::string old_variant, new_variant;
    if (old_extruder_id >= 0 && old_extruder_id < (int)extruder_variants.size()) old_variant = extruder_variants[old_extruder_id];
    if (new_extruder_id >= 0 && new_extruder_id < (int)extruder_variants.size()) new_variant = extruder_variants[new_extruder_id];
    dyn.set_key_value("old_extruder_variant", new ConfigOptionString(old_variant));
    dyn.set_key_value("new_extruder_variant", new ConfigOptionString(new_variant));
  }
  dyn.set_key_value("nozzle_diameter_at_nozzle_id", new ConfigOptionFloats(nozzle_diameters_by_nozzle_id(config)));
  dyn.set_key_value("nozzle_volume_types", new ConfigOptionStrings(nozzle_volume_types_by_nozzle_id(config, session.facts.used_filaments)));
  {
    float retract_length_nc = 0.f;
    if (old_filament_id != -1) retract_length_nc = float(nullable_floats("filament_retract_length_nc")->get_at(size_t(old_filament_id)));
    dyn.set_key_value("filament_retract_length_nc", new ConfigOptionFloat(retract_length_nc));
  }
  dyn.set_key_value("new_extruder_retracted_length", new ConfigOptionFloat(0.f));   // the kernel parks no retraction
  dyn.set_key_value("layer_num", new ConfigOptionInt(change.layer));
  dyn.set_key_value("layer_z", new ConfigOptionFloat(change.layer_z));
  dyn.set_key_value("max_layer_z", new ConfigOptionFloat(change.max_layer_z));
  dyn.set_key_value("relative_e_axis", new ConfigOptionBool(config.opt_bool("use_relative_e_distances")));
  dyn.set_key_value("toolchange_count", new ConfigOptionInt(session.toolchange_count));
  dyn.set_key_value("fan_speed", new ConfigOptionInt(0));
  dyn.set_key_value("old_retract_length", new ConfigOptionFloat(old_retract_length));
  dyn.set_key_value("new_retract_length", new ConfigOptionFloat(new_retract_length));
  dyn.set_key_value("old_retract_length_toolchange", new ConfigOptionFloat(old_retract_length_toolchange));
  dyn.set_key_value("new_retract_length_toolchange", new ConfigOptionFloat(new_retract_length_toolchange));
  dyn.set_key_value("old_filament_temp", new ConfigOptionInt(old_filament_temp));
  dyn.set_key_value("new_filament_temp", new ConfigOptionInt(new_filament_temp));
  dyn.set_key_value("x_after_toolchange", new ConfigOptionFloat(change.x));
  dyn.set_key_value("y_after_toolchange", new ConfigOptionFloat(change.y));
  dyn.set_key_value("z_after_toolchange", new ConfigOptionFloat(change.z));
  dyn.set_key_value("first_flush_volume", new ConfigOptionFloat(wipe_length / 2.f));
  dyn.set_key_value("second_flush_volume", new ConfigOptionFloat(wipe_length / 2.f));
  dyn.set_key_value("old_filament_e_feedrate", new ConfigOptionInt(old_filament_e_feedrate));
  dyn.set_key_value("new_filament_e_feedrate", new ConfigOptionInt(new_filament_e_feedrate));
  {
    const std::vector<Vec2d> travel = path_of_change_filament(config, session.facts.object_bboxes);
    const char* names[3][2] = { { "travel_point_1_x", "travel_point_1_y" }, { "travel_point_2_x", "travel_point_2_y" },
                                { "travel_point_3_x", "travel_point_3_y" } };
    for (int point = 0; point < 3; ++point) {
      dyn.set_key_value(names[point][0], new ConfigOptionFloat(float(travel[point].x())));
      dyn.set_key_value(names[point][1], new ConfigOptionFloat(float(travel[point].y())));
    }
  }
  {
    float avoid_x = 110.f;
    if (change.tower && session.facts.has_wipe_tower) {
      const double* box = session.facts.wipe_tower_bbox;
      avoid_x = wipe_avoid_pos_x(float(box[0]), float(box[2]), 3.f);
      // The nozzle heats just outside the tower (append_tcr :1100), clamped to the bed.
      float stop_x = float(change.tower_x);
      if (stop_x < (box[0] + box[2]) / 2) stop_x -= 2.f;
      else stop_x += 2.f;
      BoundingBoxf bed(config.option<ConfigOptionPoints>("printable_area")->values);
      stop_x = std::clamp(stop_x, float(bed.min.x()), float(bed.max.x()));
      dyn.set_key_value("wipe_tower_center_pos_x", new ConfigOptionFloat(stop_x));
      dyn.set_key_value("wipe_tower_center_pos_y", new ConfigOptionFloat(float(change.tower_y)));
      dyn.set_key_value("wipe_tower_center_pos_valid", new ConfigOptionBool(true));
    }
    dyn.set_key_value("wipe_avoid_perimeter", new ConfigOptionBool(false));
    dyn.set_key_value("wipe_avoid_pos_x", new ConfigOptionFloat(avoid_x));
  }
  dyn.set_key_value("is_prime_tower_interface", new ConfigOptionBool(false));
  dyn.set_key_value("filament_tower_interface_purge_volume", new ConfigOptionFloat(floats("filament_tower_interface_purge_volume")->get_at(new_fi)));
  {
    int interface_temp = ints("filament_tower_interface_print_temp")->get_at(new_fi);
    if (interface_temp == -1) interface_temp = ints("nozzle_temperature_range_high")->get_at(new_fi);
    dyn.set_key_value("filament_tower_interface_print_temp", new ConfigOptionInt(interface_temp));
  }
  {
    const size_t num_filaments = config.option<ConfigOptionStrings>("filament_type")->values.size();
    const bool use_fast_flush = config.opt_enum<PrimeVolumeMode>("prime_volume_mode") == PrimeVolumeMode::pvmFast;
    std::vector<double> flush_v_speed(num_filaments), filament_cooling_before_tower(num_filaments, 0.0);
    std::vector<int> flush_temps(num_filaments);
    for (size_t idx = 0; idx < num_filaments; ++idx) {
      flush_v_speed[idx] = nullable_floats("filament_flush_volumetric_speed")->get_at(idx);
      if (flush_v_speed[idx] == 0) flush_v_speed[idx] = floats("filament_max_volumetric_speed")->get_at(idx);
      flush_temps[idx] = nullable_ints("filament_flush_temp")->get_at(idx);
      if (use_fast_flush) flush_temps[idx] = nullable_ints("filament_flush_temp_fast")->get_at(idx);
      if (flush_temps[idx] == 0) flush_temps[idx] = ints("nozzle_temperature_range_high")->get_at(idx);
      // append_tcr keeps the cooling unless the change is a contact or on the first layer; set_extruder zeroes it.
      if (change.tower && change.layer != 0) filament_cooling_before_tower[idx] = nullable_floats("filament_cooling_before_tower")->get_at(idx);
    }
    dyn.set_key_value("flush_volumetric_speeds", new ConfigOptionFloats(flush_v_speed));
    dyn.set_key_value("flush_temperatures", new ConfigOptionInts(flush_temps));
    dyn.set_key_value("filament_cooling_before_tower", new ConfigOptionFloats(filament_cooling_before_tower));
  }
  dyn.set_key_value("flush_length", new ConfigOptionFloat(wipe_length));
  {
    const int g_max_flush_count = 4;
    const float g_purge_volume_one_time = 135.f;
    const int flush_count = std::min(g_max_flush_count, (int)std::round(wipe_volume / g_purge_volume_one_time));
    const float flush_unit = wipe_length / flush_count;
    for (int flush_idx = 0; flush_idx < g_max_flush_count; ++flush_idx) {
      float length = 0.f;
      if (flush_idx < flush_count) length = flush_unit;
      dyn.set_key_value("flush_length_" + std::to_string(flush_idx + 1), new ConfigOptionFloat(length));
    }
  }
  dyn.set_key_value("toolchange_z", new ConfigOptionFloat(change.layer_z));

  // change_filament_gcode, skipped for the first change under manual_filament_change.
  std::string toolchange_gcode_parsed;
  const std::string& change_filament_gcode = config.opt_string("change_filament_gcode");
  if (!change_filament_gcode.empty() && !(config.opt_bool("manual_filament_change") && session.toolchange_count == 1)) {
    try {
      toolchange_gcode_parsed = session.parser.process(change_filament_gcode, (unsigned int)new_filament_id, &dyn, &session.output_config, &session.context);
    } catch (const std::exception& error) { out.error = std::string("change_filament_gcode: ") + error.what(); return out; }
    check_add_eol(toolchange_gcode_parsed);
    out.change = toolchange_gcode_parsed + ";_FORCE_RESUME_FAN_SPEED\n";
  }
  // set_extruder resets E for a single-nozzle machine (reset_e), then the writer's toolchange command unless the
  //  template changed the tool itself: Tn, M1020 on a Bambu Lab printer (GCodeWriter::toolchange :686).
  const bool resets_e = session.flavor != gcfMach3 && session.flavor != gcfMakerWare && session.flavor != gcfSailfish &&
                        !config.opt_bool("use_relative_e_distances");
  if (config.opt_bool("single_extruder_multi_material") && resets_e) out.change += "G92 E0\n";
  if (!custom_gcode_changes_tool(toolchange_gcode_parsed, toolchange_prefix, (unsigned)new_filament_id)) {
    std::string command = toolchange_prefix + std::to_string(new_filament_id);
    if (session.is_bbl && !config.opt_bool("manual_filament_change"))
      command = "M1020 S" + std::to_string(new_filament_id) + " H" + std::to_string(new_extruder_id);
    if (config.opt_bool("gcode_comments")) command += " ; change extruder";
    out.change += command + "\n";
    if (resets_e) out.change += "G92 E0\n";
  }
  // The temperature, when no wipe tower sets it (single nozzle only).
  if (!change.tower && config.opt_bool("single_extruder_multi_material") && !config.opt_bool("enable_prime_tower")) {
    int temp = ints("nozzle_temperature")->get_at(new_fi);
    if (change.layer <= 0) temp = ints("nozzle_temperature_initial_layer")->get_at(new_fi);
    out.change += GCodeWriter::set_temperature((unsigned int)temp, session.flavor, false, -1);
  }
  session.loaded_on_extruder[new_extruder_id] = new_filament_id;
  session.current_filament = new_filament_id;

  // filament_start_gcode of the new filament.
  const std::string& filament_start_gcode = config.option<ConfigOptionStrings>("filament_start_gcode")->get_at(new_fi);
  if (!filament_start_gcode.empty()) {
    DynamicConfig start;
    start.set_key_value("layer_num", new ConfigOptionInt(change.layer));
    start.set_key_value("layer_z", new ConfigOptionFloat(change.layer_z));
    start.set_key_value("max_layer_z", new ConfigOptionFloat(change.max_layer_z));
    start.set_key_value("filament_extruder_id", new ConfigOptionInt(new_filament_id));
    start.set_key_value("current_filament_id", new ConfigOptionInt(new_filament_id));
    start.set_key_value("current_nozzle_id", new ConfigOptionInt(new_extruder_id));
    start.set_key_value("retraction_distance_when_cut", new ConfigOptionFloat(floats("retraction_distances_when_cut")->get_at(new_fi)));
    start.set_key_value("long_retraction_when_cut", new ConfigOptionBool(config.option<ConfigOptionBools>("long_retractions_when_cut")->get_at(new_fi)));
    start.set_key_value("nozzle_diameter_at_nozzle_id", new ConfigOptionFloats(nozzle_diameters_by_nozzle_id(config)));
    start.set_key_value("nozzle_volume_types", new ConfigOptionStrings(nozzle_volume_types_by_nozzle_id(config, session.facts.used_filaments)));
    try {
      out.start = session.parser.process(filament_start_gcode, (unsigned int)new_filament_id, &start, &session.output_config, &session.context);
    } catch (const std::exception& error) { out.error = std::string("filament_start_gcode: ") + error.what(); return out; }
    check_add_eol(out.start);
  }
  // The placeholder parser's current tool for every later template (set_extruder :9065).
  session.parser.set("current_extruder", new_filament_id);
  session.parser.set("current_filament_id", new_filament_id);
  session.parser.set("current_extruder_id", new_extruder_id);
  session.parser.set("current_nozzle_id", new_extruder_id);
  session.parser.set("retraction_distance_when_cut", floats("retraction_distances_when_cut")->get_at(new_fi));
  session.parser.set("long_retraction_when_cut", config.option<ConfigOptionBools>("long_retractions_when_cut")->get_at(new_fi));
  session.parser.set("retraction_distance_when_ec", nullable_floats("retraction_distances_when_ec")->get_at(new_fi));
  session.parser.set("long_retraction_when_ec", config.option<ConfigOptionBoolsNullable>("long_retractions_when_ec")->get_at(new_fi));
  if (config.option<ConfigOptionBools>("enable_pressure_advance")->get_at(new_fi))
    out.pressure_advance = floats("pressure_advance")->get_at(new_fi);
  return out;
}

void end() {
  g_session.reset();
  g_extra_strings.clear();
  g_object_names.clear();
}

} // namespace custom_gcode_bridge
