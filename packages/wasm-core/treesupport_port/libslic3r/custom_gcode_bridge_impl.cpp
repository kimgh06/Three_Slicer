// Issue 63: the port side of custom_gcode_bridge.h. Lives inside treesupport_port/libslic3r/ so every Slic3r include
// is file-relative (port-local), like selector_bridge_impl.cpp, and so PlaceholderParser gets the real Flow.
//
// The variables are set in the order and under the names of GCode::_do_export (GCode.cpp:3180-3510) and
// GCode::update_placeholder_parser_with_variant_params (GCode.cpp:8654). Where upstream reads the Print, the value
// comes from Facts. Left out, each because the port's config (older than the checkout the profiles come from) has
// no option to compute it from: adaptive_bed_mesh_min/max, bed_mesh_probe_count and bed_mesh_algo (no bed_mesh_*
// options) and filament_pre_cooling_temperature(_nc). A template that reads one stops with the parser's
// "Variable does not exist" error, which reaches the viewer as the slice error, rather than expanding to a guess.
// Multi-nozzle printers (extruder_max_nozzle_count > 1, the H2C/X2D grouping) are not modelled: the nozzle-group
// variables take upstream's value for a print without a group result (GCode.cpp:157-198). print_time_sec and
// used_filament_length are left out as well; see set_start_variables.
#include "../../custom_gcode_bridge.h"

#include "PlaceholderParser.hpp"
#include "PrintConfig.hpp"
#include "Flow.hpp"
#include "BoundingBox.hpp"
#include "ClipperUtils.hpp"
#include "Geometry/ConvexHull.hpp"
#include "GCodeWriter.hpp"
#include "nlohmann/json.hpp"

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <map>
#include <memory>
#include <random>

namespace custom_gcode_bridge {

using namespace Slic3r;

namespace {

struct Session {
  DynamicPrintConfig config;
  PlaceholderParser parser;
  PlaceholderParser::ContextData context;
  DynamicConfig output_config;
  Facts facts;
  bool is_bbl = false;
  GCodeFlavor flavor = gcfMarlinLegacy;
};
std::unique_ptr<Session> g_session;

// The three strings a template may print that are not settings (model and plate names). They ride in the same
//  JSON object under a '$' prefix, which no config option has, so load_string_map skips them as unknown keys.
std::map<std::string, std::string> g_extra_strings;
std::string extra_string(const char* key) {
  auto found = g_extra_strings.find(key);
  if (found == g_extra_strings.end())
    return std::string();
  return found->second;
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

  parser.set("initial_tool", initial_extruder_id);
  parser.set("initial_extruder", initial_extruder_id);
  // One entry per physical extruder: its first filament that is not support (-1 = none).
  std::vector<int> first_non_support_filaments(nozzle_count, -1);
  first_non_support_filaments[std::min<size_t>(extruder_of(config, initial_non_support_extruder_id), nozzle_count - 1)] = initial_non_support_extruder_id;
  std::vector<int> first_non_support_hotends;
  for (int filament_id : first_non_support_filaments) {
    if (filament_id < 0)
      first_non_support_hotends.push_back(-1);
    else
      first_non_support_hotends.push_back(extruder_of(config, filament_id));
  }
  parser.set("first_non_support_tools", new ConfigOptionInts(first_non_support_filaments));
  parser.set("first_non_support_filaments", new ConfigOptionInts(first_non_support_filaments));
  parser.set("first_non_support_hotend", new ConfigOptionInts(first_non_support_hotends));
  parser.set("initial_no_support_tool", initial_non_support_extruder_id);
  parser.set("initial_no_support_extruder", initial_non_support_extruder_id);
  parser.set("initial_no_support_hotend", extruder_of(config, initial_non_support_extruder_id));
  parser.set("current_extruder", initial_extruder_id);
  parser.set("current_hotend", extruder_id);
  parser.set("current_filament_id", initial_extruder_id);
  parser.set("current_extruder_id", extruder_id);
  parser.set("current_nozzle_id", extruder_id);
  parser.set("initial_filament_id", initial_extruder_id);
  parser.set("initial_no_support_filament_id", initial_non_support_extruder_id);
  parser.set("initial_nozzle_id", extruder_id);
  parser.set("nozzle_diameter_at_nozzle_id", new ConfigOptionFloats());
  parser.set("nozzle_volume_types", new ConfigOptionStrings());
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

  // update_placeholder_parser_with_variant_params (GCode.cpp:8654). Without extruder variants the filament config
  //  index is the filament id, so each remap is the option's own values.
  parser.set("filament_max_volumetric_speed", new ConfigOptionFloats(config.option<ConfigOptionFloats>("filament_max_volumetric_speed")->values));
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

// parse_str_arr, verbatim from the lambda in ConfigBase::load_from_json (Config.cpp:858).
bool parse_str_arr(const nlohmann::json::const_iterator& it, const char single_sep,const char array_sep,const bool escape_string_style,std::string& value_str) {
        // must have consistent type name
        std::string consistent_type;
        for (auto iter = it.value().begin(); iter != it.value().end(); ++iter) {
            if (consistent_type.empty())
                consistent_type = iter.value().type_name();
            else {
                if (consistent_type != iter.value().type_name())
                    return false;
            }
        }

        bool first = true;
        for (auto iter = it.value().begin(); iter != it.value().end(); iter++) {
            if (iter.value().is_array()) {
                if (!first)
                    value_str += array_sep;
                else
                    first = false;
                bool success = parse_str_arr(iter, single_sep, array_sep,escape_string_style, value_str);
                if (!success)
                    return false;
            }
            else if (iter.value().is_string()) {
                if (!first)
                    value_str += single_sep;
                else
                    first = false;
                if (!escape_string_style)
                    value_str += iter.value();
                else {
                    value_str += "\"";
                    value_str += escape_string_cstyle(iter.value());
                    value_str += "\"";
                }
            }
            else {
                //should not happen
                return false;
            }
        }
        return true;
}

}  // namespace

std::string begin(const std::string& settings_json, const Facts& facts) {
  g_session.reset();
  g_extra_strings.clear();
  auto session = std::make_unique<Session>();
  std::map<std::string, std::string> key_values;
  try {
    const nlohmann::json parsed = nlohmann::json::parse(settings_json);
    if (!parsed.is_object())
      return "settings are not a JSON object";
    // The values are what serializeProjectSettings writes for a project_settings.config: a string, or for a vector
    //  option an array of strings. Arrays are joined the way ConfigBase::load_from_json does it (Config.cpp:858 and
    //  :997), since load_from_json itself stops at the first key this port's (older) definition does not know, and
    //  load_string_map skips those instead.
    const ConfigDef* config_def = &print_config_def;
    for (auto item = parsed.begin(); item != parsed.end(); ++item) {
      if (!item.key().empty() && item.key()[0] == '$') {
        if (item.value().is_string())
          g_extra_strings[item.key()] = item.value().get<std::string>();
        continue;
      }
      if (item.value().is_string()) {
        key_values[item.key()] = item.value().get<std::string>();
        continue;
      }
      if (!item.value().is_array())
        return "setting " + item.key() + " is neither a string nor an array";
      const ConfigOptionDef* optdef = config_def->get(item.key());
      if (optdef == nullptr)
        continue;
      char single_sep = ',';
      char array_sep = '#';  // currenty not used
      bool escape_string_type = false;
      switch (optdef->type)
      {
      case coStrings:
          escape_string_type = true;
          single_sep = ';';
          break;
      case coPointsGroups:
          single_sep = '#';
          break;
      default:
          break;
      }
      std::string value_str;
      if (!parse_str_arr(item, single_sep, array_sep, escape_string_type, value_str))
        return "setting " + item.key() + " is not an array of strings";
      key_values[item.key()] = value_str;
    }
    session->config = DynamicPrintConfig::full_print_config();
    session->config.load_string_map(key_values, ForwardCompatibilitySubstitutionRule::EnableSilent);
  } catch (const std::exception& error) {
    return std::string("settings could not be loaded: ") + error.what();
  }
  session->facts = facts;
  const std::string printer_model = session->config.opt_string("printer_model");
  // Upstream decides this by the preset's vendor (PresetBundle::is_bbl_vendor). The flattened preset carries the
  //  model, and among the bundled profiles "Bambu Lab ..." is exactly the BBL vendor's machines (56 of 56, and none
  //  of the other 873).
  session->is_bbl = printer_model.rfind("Bambu Lab", 0) == 0;
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

std::string setting(const std::string& key) {
  if (!g_session)
    return std::string();
  const ConfigOption* option = g_session->config.option(key);
  if (option == nullptr)
    return std::string();
  return option->serialize();
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
    config_override.set_key_value("nozzle_diameter_at_nozzle_id", new ConfigOptionFloats());
    config_override.set_key_value("nozzle_volume_types", new ConfigOptionStrings());
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
    if (!custom_gcode_sets_temperature(expanded_start, 140, 190, false, temp_by_gcode))
      lines.before += "M190 S" + std::to_string(first_layer_bed_temperature(session)) + " ; set bed temperature and wait for it to be reached\n";
    lines.before += extruder_temperatures(false);
  }
  if (session.is_bbl)
    lines.after = extruder_temperatures(true);
  return lines;
}

void end() {
  g_session.reset();
  g_extra_strings.clear();
}

} // namespace custom_gcode_bridge
