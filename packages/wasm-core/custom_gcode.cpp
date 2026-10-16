// custom_gcode.cpp — issue 63, see custom_gcode.h.
#include "custom_gcode.h"

#include "clip_util.h"
#include "slice_ctx.h"
#include "gcode_writer.h"
#include "machine_writer.h"

#include <algorithm>
#include <cmath>

bool custom_gcode_active(const Params& params) {
  return !params.placeholder_config.empty();
}

bool custom_gcode_is_bbl(const Params& params) {
  // placeholder_config is JSON.stringify output (no whitespace), and printer_model a plain string option.
  static const std::string key = "\"printer_model\":\"";
  const size_t at = params.placeholder_config.find(key);
  if (at == std::string::npos) return false;
  const size_t start = at + key.size();
  const size_t end = params.placeholder_config.find('"', start);
  if (end == std::string::npos) return false;
  return custom_gcode_bridge::is_bbl_model(params.placeholder_config.substr(start, end - start));
}

std::string custom_gcode_error(const std::string& reason) {
  return "CUSTOM_GCODE_ERROR: " + reason;
}

namespace {

void append_points(std::vector<double>& out, const Paths& paths, double offsetX, double offsetY) {
  for (const Path& path : paths)
    for (const IntPoint& point : path) {
      out.push_back(point.x() * INV + offsetX);
      out.push_back(point.y() * INV + offsetY);
    }
}

void append_bounding_box(std::vector<double>& out, const Paths& paths, double offsetX, double offsetY) {
  double minX, minY, maxX, maxY;
  bounding_box_of(paths, minX, minY, maxX, maxY);
  if (maxX < minX)
    return;
  out.insert(out.end(), { minX + offsetX, minY + offsetY, maxX + offsetX, maxY + offsetY });
}

}  // namespace

custom_gcode_bridge::Facts single_material_facts(const Params& params, const std::vector<LayerData>& layers, int layerCount,
                                                 double offsetX, double offsetY) {
  custom_gcode_bridge::Facts facts;
  facts.used_filaments = {params.single_tool};
  facts.filament_order = {params.single_tool};
  facts.first_layer_filaments = {params.single_tool};
  facts.initial_extruder = params.single_tool;
  facts.initial_no_support_extruder = params.single_tool;
  if (layers.empty())
    return facts;
  const double lineWidth = params.line_width;
  const LayerData& first = layers[0];
  Paths objectAndSupport = union_paths(union_paths(first.contour, first.supportInterface), first.supportBase);
  const int raftLayers = std::max(0, params.raft_layers);
  const bool raft = raftLayers > 0 && !first.contour.empty();   // raft_emit's own condition
  Paths firstLayer = objectAndSupport;
  double zShift = 0.0;
  if (raft) {
    firstLayer = offset_paths(objectAndSupport, params.raft_expansion);
    zShift = params.raft_first_layer_height + (raftLayers - 1) * params.layer_height + params.raft_contact_distance;
  }
  // Skirt and brim, outermost ring only — raft.cpp / pass2.cpp place ring k at distance + w/2 + k*w. The convex
  //  hull of the rings inside it is contained in the hull of the outermost one.
  Paths outline = firstLayer;
  if (params.skirt_loops > 0)
    outline = union_paths(outline, offset_paths(firstLayer, params.skirt_distance + lineWidth * 0.5 + (params.skirt_loops - 1) * lineWidth));
  const int brimRings = (int)std::llround(params.brim_width / lineWidth);
  if (!raft && brimRings > 0) {
    Paths brimOuter = offset_paths(first.contour, params.brim_object_gap + lineWidth * 0.5 + brimRings * lineWidth);
    outline = union_paths(outline, brimOuter);
    firstLayer = union_paths(firstLayer, brimOuter);
  }
  append_points(facts.first_layer_points, outline, offsetX, offsetY);
  facts.first_layer_area_mm2 = paths_area(firstLayer);
  // The kernel slices every object as one merged mesh, so the objects are one box here. Upstream unions each
  //  instance's box for in_head_wrap_detect_zone, so the gap between separate objects counts as occupied here.
  Paths everyLayer;
  for (const LayerData& layer : layers)
    for (const Path& path : layer.contour)
      everyLayer.push_back(path);
  append_bounding_box(facts.object_bounding_boxes, everyLayer, offsetX, offsetY);
  append_bounding_box(facts.object_first_layer_bounding_boxes, first.contour, offsetX, offsetY);
  facts.total_layer_count = layerCount;
  if (raft)
    facts.total_layer_count += raftLayers;
  facts.max_print_z = layers.back().z + zShift;
  return facts;
}

std::string custom_gcode_start(const Params& params, const custom_gcode_bridge::Facts& facts, CustomStart& out) {
  std::string error = custom_gcode_bridge::begin(params.placeholder_config, facts);
  if (!error.empty())
    return custom_gcode_error(error);
  std::vector<std::string> startTemplates = custom_gcode_bridge::strings("machine_start_gcode");
  if (startTemplates.empty())
    return std::string();
  custom_gcode_bridge::Expanded start = custom_gcode_bridge::expand("machine_start_gcode", startTemplates[0], facts.initial_extruder);
  if (!start.error.empty())
    return custom_gcode_error(start.error);
  out.text = start.text;
  custom_gcode_bridge::note_start_gcode(start.text, facts.initial_no_support_extruder);
  {
    custom_gcode_bridge::Expanded fileStart = custom_gcode_bridge::expand_file_start();
    if (!fileStart.error.empty()) return custom_gcode_error(fileStart.error);
    out.file_start = fileStart.text;
  }
  // A Bambu Lab printer's start block also carries the first filament's filament_start_gcode and marks that filament
  //  (GCode.cpp:3538-3562: ";VT<n>", with " H-1" on a multi-nozzle printer whose nozzle map is static).
  if (custom_gcode_bridge::is_bbl_printer()) {
    const int filament = facts.initial_no_support_extruder;
    std::vector<std::string> starts = custom_gcode_bridge::strings("filament_start_gcode");
    if (filament >= 0 && filament < (int)starts.size() && !starts[filament].empty()) {
      const int extruder = custom_gcode_bridge::logical_extruder(filament);
      custom_gcode_bridge::Expanded filamentStart = custom_gcode_bridge::expand_with("filament_start_gcode", starts[filament], filament,
        { { "filament_extruder_id", (double)filament, true }, { "current_filament_id", (double)filament, true },
          { "current_extruder_id", (double)extruder, true }, { "current_nozzle_id", (double)extruder, true },
          { "layer_num", -1.0, true } });
      if (!filamentStart.error.empty())
        return custom_gcode_error(filamentStart.error);
      if (!out.text.empty() && out.text.back() != '\n') out.text += '\n';
      out.text += filamentStart.text;
    }
    if (!out.text.empty() && out.text.back() != '\n') out.text += '\n';
    if (custom_gcode_bridge::multi_nozzle_printer()) out.text += ";VT" + std::to_string(facts.initial_extruder) + " H-1\n";
    else out.text += ";VT" + std::to_string(facts.initial_extruder) + "\n";
  }
  custom_gcode_bridge::TemperatureLines temperatures = custom_gcode_bridge::start_temperatures(start.text);
  out.before = temperatures.before;
  out.after = temperatures.after;
  out.bed_set = temperatures.bed_set;
  out.chamber = temperatures.chamber;
  return std::string();
}

std::string custom_gcode_end(GcodeWriter& writer, int layer_num, double layer_z, double max_layer_z, int current_extruder) {
  writer.raw("M107");
  if (custom_gcode_bridge::is_bbl_printer())
    writer.raw("M981 S0 P20000 ; close spaghetti detector");
  std::vector<std::string> filamentEnds = custom_gcode_bridge::strings("filament_end_gcode");
  for (size_t filament = 0; filament < filamentEnds.size(); ++filament) {
    custom_gcode_bridge::Expanded end = custom_gcode_bridge::expand("filament_end_gcode", filamentEnds[filament], (int)filament,
                                                                    layer_num, layer_z, max_layer_z, (int)filament);
    if (!end.error.empty())
      return custom_gcode_error(end.error);
    writer.raw_lines(end.text);
  }
  std::vector<std::string> machineEnd = custom_gcode_bridge::strings("machine_end_gcode");
  if (!machineEnd.empty()) {
    custom_gcode_bridge::Expanded end = custom_gcode_bridge::expand("machine_end_gcode", machineEnd[0], current_extruder,
                                                                    layer_num, layer_z, max_layer_z);
    if (!end.error.empty())
      return custom_gcode_error(end.error);
    writer.raw_lines(end.text);
  }
  custom_gcode_bridge::end();
  return std::string();
}

// ---- Layer templates -------------------------------------------------------------------------------------------
namespace {
double g_max_layer_z = 0.0;   // GCode::m_max_layer_z
double g_last_mass = 0.0;     // GCode::m_last_layer_accumulated_mass (grams)

// A template's text where the slot line was: with its own trailing newline, empty when it expands to nothing.
std::string as_lines(std::string text) {
  if (!text.empty() && text.back() != '\n') text += '\n';
  return text;
}

// Replaces the first `slot` line (with its newline) by `replacement`.
void fill_slot(std::string& text, const char* slot, const std::string& replacement) {
  const std::string line = std::string(slot) + "\n";
  const size_t at = text.find(line);
  if (at == std::string::npos) return;
  text.replace(at, line.size(), replacement);
}
}  // namespace

bool custom_gcode_layer_slots() {
  const bool isBambuLab = custom_gcode_bridge::is_bbl_printer();
  return custom_gcode_bridge::has_template("before_layer_change_gcode") || custom_gcode_bridge::has_template("layer_change_gcode") ||
         (!isBambuLab && custom_gcode_bridge::has_template("time_lapse_gcode")) || (!isBambuLab && custom_gcode_bridge::has_template("filament_start_gcode"));
}

void custom_gcode_layers_begin() {
  g_max_layer_z = 0.0;
  g_last_mass = 0.0;
}

std::string custom_gcode_layer(std::string text, int layer, double layer_z, int tool, const std::vector<double>& extruded_mm3,
                               std::string& error) {
  using custom_gcode_bridge::Variable;
  g_max_layer_z = std::max(g_max_layer_z, layer_z);
  custom_gcode_bridge::set_extruded_volumes(extruded_mm3);
  const bool isBambuLab = custom_gcode_bridge::is_bbl_printer();
  auto first = [](const std::vector<std::string>& values) {
    if (values.empty()) return std::string();
    return values.front();
  };
  auto expand = [&](const char* key, const std::string& templateText, const std::vector<Variable>& variables, std::string& out) {
    if (templateText.empty() || !error.empty()) return;
    custom_gcode_bridge::Expanded expanded = custom_gcode_bridge::expand_with(key, templateText, tool, variables);
    if (!expanded.error.empty()) {
      error = custom_gcode_error(expanded.error);
      return;
    }
    out += as_lines(expanded.text);
  };

  // Before the Z move: before_layer_change_gcode with the layer it is about to start.
  std::string before;
  expand("before_layer_change_gcode", first(custom_gcode_bridge::strings("before_layer_change_gcode")),
         { { "layer_num", (double)layer, true }, { "layer_z", layer_z, false }, { "max_layer_z", g_max_layer_z, false } }, before);

  // After it: the timelapse (Bambu Lab printers insert theirs elsewhere), then layer_change_gcode with the printed
  //  mass and the Y acceleration it implies (mass_load_limited_machine_acceleration).
  std::string after;
  if (!isBambuLab)
    expand("time_lapse_gcode", first(custom_gcode_bridge::strings("time_lapse_gcode")),
           { { "layer_num", (double)layer, true }, { "layer_z", layer_z, false }, { "max_layer_z", g_max_layer_z, false } }, after);
  {
    const double mass = custom_gcode_bridge::extruded_weight_total();
    double yLimit = -1, accumulated = -1;
    custom_gcode_bridge::y_acceleration_limit(mass, yLimit, accumulated);
    double layerMass = mass - g_last_mass;
    if (layerMass <= 1e-6) layerMass = 0.0;
    g_last_mass = mass;
    expand("layer_change_gcode", first(custom_gcode_bridge::strings("layer_change_gcode")),
           { { "most_used_physical_extruder_id", (double)custom_gcode_bridge::physical_extruder(tool), true },
             { "layer_num", (double)layer, true }, { "layer_z", layer_z, false },
             { "current_filament_id", (double)tool, true }, { "current_nozzle_id", (double)custom_gcode_bridge::logical_extruder(tool), true },
             { "curr_y_acceleration_limit", yLimit, false }, { "curr_accumulated_mass", accumulated, false },
             { "curr_layer_mass", layerMass, false } }, after);
  }
  // The first layer's filament: upstream's set_extruder writes filament_start_gcode as the first tool is selected
  //  (GCode.cpp:8736); a Bambu Lab printer's start block carries it instead (custom_gcode_start).
  if (layer == 0 && !isBambuLab) {
    std::vector<std::string> starts = custom_gcode_bridge::strings("filament_start_gcode");
    std::string templateText;
    if (tool >= 0 && tool < (int)starts.size()) templateText = starts[tool];
    expand("filament_start_gcode", templateText,
           { { "layer_num", (double)layer, true }, { "layer_z", layer_z, false }, { "max_layer_z", g_max_layer_z, false },
             { "filament_extruder_id", (double)tool, true } }, after);
  }
  if (!error.empty()) return text;
  fill_slot(text, BEFORE_LAYER_SLOT, before);
  fill_slot(text, AFTER_LAYER_SLOT, after);
  return text;
}

std::string custom_gcode_toolchanges(std::string text, const std::vector<ToolchangeAt>& changes, Flavor flavor, std::string& error) {
  const std::string slot = TOOLCHANGE_SLOT;
  size_t at = 0;
  while (error.empty() && (at = text.find(slot, at)) != std::string::npos) {
    size_t lineEnd = text.find('\n', at);
    if (lineEnd == std::string::npos) lineEnd = text.size();
    else ++lineEnd;
    const size_t index = (size_t)std::strtoul(text.c_str() + at + slot.size(), nullptr, 10);
    std::string replacement;
    if (index < changes.size()) {
      custom_gcode_bridge::Toolchange change = changes[index].change;
      change.max_layer_z = std::max(g_max_layer_z, change.layer_z);
      const custom_gcode_bridge::ToolchangeText expanded = custom_gcode_bridge::expand_toolchange(change);
      if (!expanded.error.empty()) {
        error = custom_gcode_error(expanded.error);
        return text;
      }
      replacement = as_lines(expanded.end) + as_lines(expanded.change);
      if (!changes[index].initial) replacement += as_lines(expanded.start);
      if (expanded.pressure_advance >= 0)
        replacement += machine_set_pressure_advance(expanded.pressure_advance, flavor, custom_gcode_bridge::is_bbl_printer());
    }
    text.replace(at, lineEnd - at, replacement);
    at += replacement.size();
  }
  return text;
}
