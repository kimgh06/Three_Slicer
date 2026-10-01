// custom_gcode.cpp — issue 63, see custom_gcode.h.
#include "custom_gcode.h"

#include "clip_util.h"
#include "slice_ctx.h"

#include <algorithm>
#include <cmath>

bool custom_gcode_active(const Params& p) {
  return !p.placeholder_config.empty();
}

std::string custom_gcode_error(const std::string& reason) {
  return "CUSTOM_GCODE_ERROR: " + reason;
}

namespace {

void append_points(std::vector<double>& out, const Paths& paths, double offX, double offY) {
  for (const Path& path : paths)
    for (const IntPoint& point : path) {
      out.push_back(point.x() * INV + offX);
      out.push_back(point.y() * INV + offY);
    }
}

void append_bbox(std::vector<double>& out, const Paths& paths, double offX, double offY) {
  double minX, minY, maxX, maxY;
  bbox_of(paths, minX, minY, maxX, maxY);
  if (maxX < minX)
    return;
  out.insert(out.end(), { minX + offX, minY + offY, maxX + offX, maxY + offY });
}

}  // namespace

custom_gcode_bridge::Facts single_material_facts(const Params& p, const std::vector<LayerData>& L, int N,
                                                 double offX, double offY) {
  custom_gcode_bridge::Facts facts;
  facts.used_filaments = {p.single_tool};
  facts.filament_order = {p.single_tool};
  facts.first_layer_filaments = {p.single_tool};
  facts.initial_extruder = p.single_tool;
  facts.initial_no_support_extruder = p.single_tool;
  if (L.empty())
    return facts;
  const double w = p.line_width;
  const LayerData& first = L[0];
  Paths objectAndSupport = union_paths(union_paths(first.contour, first.supIface), first.supBase);
  const int nraft = std::max(0, p.raft_layers);
  const bool raft = nraft > 0 && !first.contour.empty();   // raft_emit's own condition
  Paths firstLayer = objectAndSupport;
  double zShift = 0.0;
  if (raft) {
    firstLayer = offset_paths(objectAndSupport, p.raft_expansion);
    zShift = p.raft_first_layer_height + (nraft - 1) * p.layer_height + p.raft_contact_distance;
  }
  // Skirt and brim, outermost ring only — raft.cpp / pass2.cpp place ring k at distance + w/2 + k*w. The convex
  //  hull of the rings inside it is contained in the hull of the outermost one.
  Paths outline = firstLayer;
  if (p.skirt_loops > 0)
    outline = union_paths(outline, offset_paths(firstLayer, p.skirt_distance + w * 0.5 + (p.skirt_loops - 1) * w));
  const int brimRings = (int)std::llround(p.brim_width / w);
  if (!raft && brimRings > 0) {
    Paths brimOuter = offset_paths(first.contour, p.brim_object_gap + w * 0.5 + brimRings * w);
    outline = union_paths(outline, brimOuter);
    firstLayer = union_paths(firstLayer, brimOuter);
  }
  append_points(facts.first_layer_points, outline, offX, offY);
  facts.first_layer_area_mm2 = paths_area(firstLayer);
  // The kernel slices every object as one merged mesh, so the objects are one box here. Upstream unions each
  //  instance's box for in_head_wrap_detect_zone, so the gap between separate objects counts as occupied here.
  Paths everyLayer;
  for (const LayerData& layer : L)
    for (const Path& path : layer.contour)
      everyLayer.push_back(path);
  append_bbox(facts.object_bboxes, everyLayer, offX, offY);
  append_bbox(facts.object_first_layer_bboxes, first.contour, offX, offY);
  facts.total_layer_count = N;
  if (raft)
    facts.total_layer_count += nraft;
  facts.max_print_z = L.back().z + zShift;
  return facts;
}

std::string custom_gcode_start(const Params& p, const custom_gcode_bridge::Facts& facts, CustomStart& out) {
  std::string error = custom_gcode_bridge::begin(p.placeholder_config, facts);
  if (!error.empty())
    return custom_gcode_error(error);
  std::vector<std::string> templ = custom_gcode_bridge::strings("machine_start_gcode");
  if (templ.empty())
    return std::string();
  custom_gcode_bridge::Expanded start = custom_gcode_bridge::expand("machine_start_gcode", templ[0], facts.initial_extruder);
  if (!start.error.empty())
    return custom_gcode_error(start.error);
  out.text = start.text;
  custom_gcode_bridge::TemperatureLines temperatures = custom_gcode_bridge::start_temperatures(start.text);
  out.before = temperatures.before;
  out.after = temperatures.after;
  return std::string();
}

std::string custom_gcode_end(GW& gw, int layer_num, double layer_z, double max_layer_z, int current_extruder) {
  gw.raw("M107");
  if (custom_gcode_bridge::is_bbl_printer())
    gw.raw("M981 S0 P20000 ; close spaghetti detector");
  std::vector<std::string> filamentEnds = custom_gcode_bridge::strings("filament_end_gcode");
  for (size_t filament = 0; filament < filamentEnds.size(); ++filament) {
    custom_gcode_bridge::Expanded end = custom_gcode_bridge::expand("filament_end_gcode", filamentEnds[filament], (int)filament,
                                                                    layer_num, layer_z, max_layer_z, (int)filament);
    if (!end.error.empty())
      return custom_gcode_error(end.error);
    gw.raw_lines(end.text);
  }
  std::vector<std::string> machineEnd = custom_gcode_bridge::strings("machine_end_gcode");
  if (!machineEnd.empty()) {
    custom_gcode_bridge::Expanded end = custom_gcode_bridge::expand("machine_end_gcode", machineEnd[0], current_extruder,
                                                                    layer_num, layer_z, max_layer_z);
    if (!end.error.empty())
      return custom_gcode_error(end.error);
    gw.raw_lines(end.text);
  }
  custom_gcode_bridge::end();
  return std::string();
}
