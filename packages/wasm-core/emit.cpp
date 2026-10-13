// emit.cpp — extracted verbatim from slicer_core.cpp (pure code move; no behavior change).
//  `static` is kept on the helpers used only here (push_seg / pe_role_of); the emit_* entry points lost it
//  because emit.h now declares them for the other translation units.
#include "emit.h"

#include <algorithm>
#include <cmath>
#include <cstdio>

// Toolpath types: 0=travel,1=wall,2=sparse,3=solid,4=skirt/brim,5=support,6=raft,7=gap-fill,8=thin-wall,9=bridge,10=ironing,11=prime-tower
// Per-segment width tracking (for the stage-7 variable-width walls). When g_seg_w is set, every push_seg records the current width into a parallel array.
//  (The existing paths format keeps stride 8 -> the 88 tests are unaffected. widths is one optional extra array with one entry per segment.)
// G003: thread_local so parallel writers (a GW per layer) record their own widths — semantics unchanged on the st/serial path.
bool g_keep_island = false;   // G003: when the cache is kept, emit copies island instead of moving it (so the cache can be reused repeatedly)
thread_local std::vector<float>* g_seg_w = nullptr;
thread_local float g_seg_w_cur = 0.42f;
// Printing extruder folded into the role field: value = role + tool*16 (the viewer decodes role = value & 15,
//  tool = value >>> 4 in viewer/src/toolpath_segments.js). Roles only ever run 0..11, so the spare high bits carry
//  the tool instead of widening the stride to 9 — the segment stream is the largest array the viewer holds and a
//  9th float would cost +12.5% of it for one small integer. With the untooled default (0) the field IS the bare
//  role, which is what keeps every single-material stream byte-for-byte what it was.
thread_local int g_seg_tool = 0;
static inline void push_seg(std::vector<float>& toolpaths,double x0,double y0,double x1,double y1,double z,float type){
  const float encodedRole = type + (float)(g_seg_tool * 16);
  toolpaths.push_back((float)x0);
  toolpaths.push_back((float)y0);
  toolpaths.push_back((float)z);
  toolpaths.push_back(encodedRole);
  toolpaths.push_back((float)x1);
  toolpaths.push_back((float)y1);
  toolpaths.push_back((float)z);
  toolpaths.push_back(encodedRole);
  if (g_seg_w) g_seg_w->push_back(g_seg_w_cur);
}
em::val to_f32(const std::vector<float>& values){
  return em::val(em::typed_memory_view(values.size(), values.data())).call<em::val>("slice");
}
// Stage 9: toolpath type -> OrcaSlicer ExtrusionRole integer (for the PressureEqualizer tags, the ExtrusionEntity.hpp enum)
//  0none 1perim 2extperim 4internalinfill 5solidinfill 8ironing 9bridge 11gapfill 12skirt 14support 17wipetower
static int pe_role_of(float type){
  switch ((int)type) {
    case 1: return 2;   // wall → erExternalPerimeter
    case 2: return 4;   // sparse → erInternalInfill
    case 3: return 5;   // solid → erSolidInfill
    case 4: return 12;  // skirt/brim → erSkirt
    case 5: return 14;  // support → erSupportMaterial
    case 6: return 14;  // raft → erSupportMaterial
    case 7: return 11;  // gap-fill → erGapFill
    case 8: return 1;   // thin-wall → erPerimeter
    case 9: return 9;   // bridge → erBridgeInfill
    case 10:return 8;   // ironing → erIroning
    case 11:return 17;  // prime-tower → erWipeTower
    default:return 0;   // erNone
  }
}
// The dry pass's stand-in for one path's travel to (x0, y0) and its extrusion: the writer's acceleration and jerk move
//  as the real emit's would (GW::apply_travel_motion / apply_print_motion), so a parallel writer starts from the
//  state the serial emit reaches. Called before the dry pass moves the position.
static void dry_path_motion(GW& writer, double x0, double y0) {
  const double distance = std::hypot(x0 - writer.position_x, y0 - writer.position_y);
  if (distance >= 1e-6) writer.apply_travel_motion(distance);
  writer.apply_print_motion();
}
// Closed loops (walls/skirt/raft). seamMode: -1 = no rotation, 0 = back, 1 = nearest, 2 = aligned, 3 = random.
// With updateSeam=true the start point is recorded into SeamCtx (for the next layer of aligned).
void emit_loops(GW& writer, std::vector<float>& toolpaths, Paths loops, double z, float type, int fPrint, int fTravel,
                       int seamMode, SeamCtx& seamContext, bool updateSeam){
  if (writer.dry_run) {   // G003 E1: seam rotation, position and current_feed only — the writer pass reproduces the bytes from an identical entry state
    for (Path loop : loops) {
      if (loop.size() < 2) continue;
      rotate_seam(loop, seamMode, seamContext, writer.position_x, writer.position_y);
      dry_path_motion(writer, loop[0].x()*INV, loop[0].y()*INV);
      writer.position_x = loop[0].x()*INV;
      writer.position_y = loop[0].y()*INV;
      writer.current_feed = fPrint;
      if (writer.small_perimeter_length > 0) writer.current_feed = writer.loop_feed(paths_len(Paths{loop}, true), fPrint);
      if (updateSeam) {
        seamContext.lastX=writer.position_x;
        seamContext.lastY=writer.position_y;
        seamContext.hasLast=true;
      }
    }
    return;
  }
  bool anyRun=false;
  for (Path loop : loops) {
    if (loop.size() < 2) continue;
    if (!anyRun) {
      writer.role_tag((int)type);
      writer.pe_begin_run(pe_role_of(type), fPrint);
      anyRun=true;
    }
    rotate_seam(loop, seamMode, seamContext, writer.position_x, writer.position_y);
    std::vector<DPt> points;
    points.reserve(loop.size()+1);
    for (auto& vertex:loop) points.push_back({vertex.x()*INV, vertex.y()*INV});
    points.push_back(points.front());                             // close the loop
    push_seg(toolpaths, writer.position_x, writer.position_y, points[0].x, points[0].y, z, 0.0f);
    writer.travel(points[0].x, points[0].y, fTravel);
    for (size_t i=1;i<points.size();++i) push_seg(toolpaths, points[i-1].x,points[i-1].y, points[i].x,points[i].y, z, type);
    int fLoop = fPrint;
    if (writer.small_perimeter_length > 0) fLoop = writer.loop_feed(paths_len(Paths{loop}, true), fPrint);
    writer.path_begin(fLoop);
    writer.extrude_run(points, fLoop, type);
    writer.path_end();
    if (updateSeam) {
      seamContext.lastX=points[0].x;
      seamContext.lastY=points[0].y;
      seamContext.hasLast=true;
    }
  }
  if (anyRun) writer.pe_end_run();
}
// Open lines (infill/support). Arc fitting applies.
void emit_lines(GW& writer, std::vector<float>& toolpaths, const Paths& lines, double z, float type, int fPrint, int fTravel){
  if (writer.dry_run) {
    for (const Path& line : lines) if (line.size() >= 2) {
      dry_path_motion(writer, line[0].x()*INV, line[0].y()*INV);
      writer.position_x = line.back().x()*INV;
      writer.position_y = line.back().y()*INV;
      writer.current_feed = fPrint;
    }
    return;
  }
  bool anyRun=false;
  for (const Path& line : lines) {
    if (line.size() < 2) continue;
    if (!anyRun) {
      writer.role_tag((int)type);
      writer.pe_begin_run(pe_role_of(type), fPrint);
      anyRun=true;
    }
    std::vector<DPt> points;
    points.reserve(line.size());
    for (auto& vertex:line) points.push_back({vertex.x()*INV, vertex.y()*INV});
    push_seg(toolpaths, writer.position_x, writer.position_y, points[0].x, points[0].y, z, 0.0f);
    writer.travel(points[0].x, points[0].y, fTravel);
    for (size_t i=1;i<points.size();++i) push_seg(toolpaths, points[i-1].x,points[i-1].y, points[i].x,points[i].y, z, type);
    writer.path_begin(fPrint);
    writer.extrude_run(points, fPrint, type);
    writer.path_end();
  }
  if (anyRun) writer.pe_end_run();
}
// Stage 19 -> WP3: tree support emission — open polylines with per-path width. E uses the upstream mm3_per_mm when present
//  (set_e_per_mm_vol — reproducing the upstream Flow rate, e.g. on bridging contact layers), otherwise the old width x height rectangular approximation.
//  The PE role splits runs by each path's upstream role (base 14 / interface 15), preserving the upstream role distinction.
void emit_lines_vw(GW& writer, std::vector<float>& toolpaths, const std::vector<TreePath>& lines,
                          double z, double layerHeight, const Params& params, float type, int fPrint, int fTravel){
  if (writer.dry_run) {   // G003 E1: position and current_feed only (E/flow state is reset at every layer start, so it does not chain)
    for (const auto& treePath : lines) {
      if (treePath.path.size() < 2) continue;
      dry_path_motion(writer, treePath.path[0].x()*INV, treePath.path[0].y()*INV);
      writer.position_x = treePath.path.back().x()*INV;
      writer.position_y = treePath.path.back().y()*INV;
      // The flow the real emit sets for this line, so the volumetric cap leaves current_feed where the real emit would.
      if (treePath.mm3_per_mm > 1e-9) writer.set_e_per_mm_vol(treePath.mm3_per_mm, params);
      else if (treePath.height > 1e-6) writer.set_e_per_mm_width(treePath.width, treePath.height, params);
      else writer.set_e_per_mm_width(treePath.width, layerHeight, params);
      writer.current_feed = writer.capped_feed(fPrint);
    }
    return;
  }
  int currentRole = -1;
  for (const auto& treePath : lines) {
    const Path& line = treePath.path;
    if (line.size() < 2) continue;
    int role;
    if (treePath.role > 0) role = treePath.role;
    else role = pe_role_of(type);
    writer.role_tag((int)type);
    if (role != currentRole) {
      if (currentRole >= 0) writer.pe_end_run();
      writer.pe_begin_run(role, fPrint);
      currentRole = role;
    }
    double pathHeight = layerHeight;
    if (treePath.height > 1e-6) pathHeight = treePath.height;
    if (treePath.mm3_per_mm > 1e-9) writer.set_e_per_mm_vol(treePath.mm3_per_mm, params);
    else                     writer.set_e_per_mm_width(treePath.width, pathHeight, params);
    g_seg_w_cur = treePath.width;
    std::vector<DPt> points;
    points.reserve(line.size());
    for (auto& vertex:line) points.push_back({vertex.x()*INV, vertex.y()*INV});
    push_seg(toolpaths, writer.position_x, writer.position_y, points[0].x, points[0].y, z, 0.0f);
    writer.travel(points[0].x, points[0].y, fTravel);
    for (size_t i=1;i<points.size();++i) push_seg(toolpaths, points[i-1].x,points[i-1].y, points[i].x,points[i].y, z, type);
    writer.path_begin(fPrint);
    writer.extrude_run(points, fPrint, type);
    writer.path_end();
  }
  if (currentRole >= 0) writer.pe_end_run();
  g_seg_w_cur = (float)params.line_width;   // restore the default width/E
  writer.set_e_per_mm(layerHeight, params);
}
// Stage 7: emit the real ported Arachne variable-width walls. E is computed from the per-segment width (set_e_per_mm_width) and widths is recorded.
void emit_arachne_walls(GW& writer, std::vector<float>& toolpaths, const std::vector<arachne_bridge::WLine>& walls,
                               double z, double layerHeight, const Params& params, const RoleFeeds& feeds, int fTravel){
  bool anyRun=false;
  for (const auto& wall : walls) {
    if (wall.junctions.size() < 2) continue;
    FlowRole flowRole = FlowRole::InnerWall;
    if (wall.inset_index == 0) flowRole = FlowRole::OuterWall;
    writer.role_flow = role_flow_ratio(params, flowRole, writer.on_first_layer);
    writer.set_feature((int)flowRole);
    int fPrint = feeds.of(flowRole);
    if (wall.closed) {
      double loopLength = std::hypot(wall.junctions.front().x - wall.junctions.back().x, wall.junctions.front().y - wall.junctions.back().y);
      for (size_t k = 1; k < wall.junctions.size(); ++k) loopLength += std::hypot(wall.junctions[k].x - wall.junctions[k-1].x, wall.junctions[k].y - wall.junctions[k-1].y);
      fPrint = writer.loop_feed(loopLength, fPrint);
    }
    if (!anyRun) {
      writer.role_tag(1);
      writer.pe_begin_run(2 /*erExternalPerimeter*/, fPrint);
      anyRun=true;
    }
    push_seg(toolpaths, writer.position_x, writer.position_y, wall.junctions[0].x, wall.junctions[0].y, z, 0.0f);
    writer.travel(wall.junctions[0].x, wall.junctions[0].y, fTravel);
    writer.path_begin(fPrint);
    size_t pointCount = wall.junctions.size();
    for (size_t i=1;i<pointCount;++i) {
      double segmentWidth = 0.5*(wall.junctions[i-1].width + wall.junctions[i].width);
      writer.set_e_per_mm_width(segmentWidth, layerHeight, params);
      g_seg_w_cur = (float)segmentWidth;
      push_seg(toolpaths, wall.junctions[i-1].x, wall.junctions[i-1].y, wall.junctions[i].x, wall.junctions[i].y, z, 1.0f);
      writer.extrude(wall.junctions[i].x, wall.junctions[i].y, fPrint);
    }
    if (wall.closed) {
      double segmentWidth = 0.5*(wall.junctions[pointCount-1].width + wall.junctions[0].width);
      writer.set_e_per_mm_width(segmentWidth, layerHeight, params);
      g_seg_w_cur = (float)segmentWidth;
      push_seg(toolpaths, wall.junctions[pointCount-1].x, wall.junctions[pointCount-1].y, wall.junctions[0].x, wall.junctions[0].y, z, 1.0f);
      writer.extrude(wall.junctions[0].x, wall.junctions[0].y, fPrint);
    }
    writer.path_end();
  }
  if (anyRun) writer.pe_end_run();
  g_seg_w_cur = (float)params.line_width;
}
// Spiral (vase): a single outer wall rising continuously from z0 to z0+h around the perimeter
void emit_spiral(GW& writer, std::vector<float>& toolpaths, const Paths& outerWall, double z0, double layerHeight, int fPrint, int fTravel){
  if (outerWall.empty() || outerWall[0].size()<2) return;
  const Path& wallPath = outerWall[0];
  std::vector<DPt> points;
  for (auto& vertex:wallPath) points.push_back({vertex.x()*INV, vertex.y()*INV});
  points.push_back(points.front());
  push_seg(toolpaths, writer.position_x, writer.position_y, points[0].x, points[0].y, z0, 0.0f);
  writer.travel(points[0].x, points[0].y, fTravel);
  writer.role_tag(1);
  writer.path_begin(fPrint);
  double totalLength=0;
  for (size_t i=1;i<points.size();++i) totalLength+=std::hypot(points[i].x-points[i-1].x, points[i].y-points[i-1].y);
  double travelled=0;
  for (size_t i=1;i<points.size();++i){
    travelled += std::hypot(points[i].x-points[i-1].x, points[i].y-points[i-1].y);
    double riseFraction = 0.0;
    if (totalLength>1e-9) riseFraction = travelled/totalLength;
    double pointZ = z0 + layerHeight*riseFraction;
    writer.extrude_z(points[i].x, points[i].y, pointZ, fPrint);
    push_seg(toolpaths, points[i-1].x,points[i-1].y, points[i].x,points[i].y, pointZ, 1.0f);
  }
  writer.path_end();
}
// Scarf joint seam (outer wall loop): ramp z (z-h -> z) and flow (0 -> 1) up at the start, then ramp down over the same length at the end with an overlap (flow 1 -> 0).
//  ⚠ An approximation — a gentle sloped joint instead of a z-seam blob. Applied to the outer wall only when seam_slope_type=external/all.
void emit_scarf_loop(GW& writer, std::vector<float>& toolpaths, Path loop, double z, double layerHeight,
                            int fPrint, int fTravel, int seamMode, SeamCtx& seamContext){
  if (loop.size() < 3) return;
  rotate_seam(loop, seamMode, seamContext, writer.position_x, writer.position_y);
  std::vector<DPt> points;
  points.reserve(loop.size()+1);
  for (auto& vertex:loop) points.push_back({vertex.x()*INV, vertex.y()*INV});
  points.push_back(points.front());
  double loopLength=0;
  for (size_t i=1;i<points.size();++i) loopLength+=std::hypot(points[i].x-points[i-1].x, points[i].y-points[i-1].y);
  fPrint = writer.loop_feed(loopLength, fPrint);
  double scarfLength = std::min(writer.scarf_length, 0.45*loopLength);
  if (scarfLength < 1e-3) scarfLength = 0.45*loopLength;
  push_seg(toolpaths, writer.position_x, writer.position_y, points[0].x, points[0].y, z, 0.0f);
  writer.travel(points[0].x, points[0].y, fTravel);
  writer.raw("; scarf");
  writer.path_begin(fPrint);
  writer.role_tag(1);
  double startZ = z - layerHeight;
  double stepLength = std::max(0.2, scarfLength/8.0);   // ramp subdivision step (so long straight walls also rise continuously in z)
  // Ramp up: over the first scarfLength, z goes (z-h) -> z and flow 0 -> 1 (subdivided into segments)
  double rampDistance=0;
  size_t i=1;
  for (; i<points.size(); ++i){
    double deltaX=points[i].x-points[i-1].x;
    double deltaY=points[i].y-points[i-1].y;
    double segmentLength=std::hypot(deltaX,deltaY);
    int steps = std::max(1, (int)std::ceil(segmentLength/stepLength));
    for (int step=1; step<=steps; ++step){
      double stepFraction=(double)step/steps;
      double x=points[i-1].x+deltaX*stepFraction;
      double y=points[i-1].y+deltaY*stepFraction;
      double rampFraction=std::min(1.0, (rampDistance+segmentLength*stepFraction)/scarfLength);
      double rampZ=startZ + layerHeight*rampFraction;
      double flow=std::max(0.05, rampFraction);
      double fromX=writer.position_x;
      double fromY=writer.position_y;
      writer.extrude_zf(x, y, rampZ, flow, fPrint);
      push_seg(toolpaths, fromX,fromY, x,y, rampZ, 1.0f);
    }
    rampDistance+=segmentLength;
    if (rampDistance>=scarfLength) {
      ++i;
      break;
    }
  }
  // Flat middle: z, flow 1
  for (; i<points.size(); ++i){
    double fromX=writer.position_x;
    double fromY=writer.position_y;
    writer.extrude(points[i].x, points[i].y, fPrint);
    push_seg(toolpaths, fromX,fromY, points[i].x,points[i].y, z, 1.0f);
  }
  // Overlapping ramp down: retrace scarfLength from the start, keeping z and taking flow 1 -> 0 (finishing over the ramp-up)
  double rampDownDistance=0;
  for (size_t k=1;k<points.size();++k){
    double deltaX=points[k].x-points[k-1].x;
    double deltaY=points[k].y-points[k-1].y;
    double segmentLength=std::hypot(deltaX,deltaY);
    int steps = std::max(1, (int)std::ceil(segmentLength/stepLength));
    for (int step=1; step<=steps; ++step){
      double stepFraction=(double)step/steps;
      double x=points[k-1].x+deltaX*stepFraction;
      double y=points[k-1].y+deltaY*stepFraction;
      double rampFraction=std::min(1.0,(rampDownDistance+segmentLength*stepFraction)/scarfLength);
      double flow=std::max(0.05, 1.0-rampFraction);
      double fromX=writer.position_x;
      double fromY=writer.position_y;
      writer.extrude_zf(x, y, z, flow, fPrint);
      push_seg(toolpaths, fromX,fromY, x,y, z, 1.0f);
    }
    rampDownDistance+=segmentLength;
    if (rampDownDistance>=scarfLength) break;
  }
  seamContext.lastX=points[0].x;
  seamContext.lastY=points[0].y;
  seamContext.hasLast=true;
  writer.path_end();
}

// ---- G-code footer blocks (upstream GCode.cpp) --------------------------------------------------------------
//  Two things upstream always writes and this kernel used to sum into a single "; filament used: N mm":
//   · the per-filament totals, in millimetres, cm3, grams and cost — the last two only when the host supplied a
//     density / price, because inventing one would be worse than omitting the line;
//   · the parameters the slice ran with, delimited so a tool can find them (upstream re-imports its own exports
//     from exactly this block).
void emit_gcode_footer_blocks(GW& writer, const Params& params, const std::vector<double>& filamentByTool, int toolChanges) {
  if (params.gcode_stats_block) {
    // One entry per filament, comma separated, in filament order — upstream's own layout, so the same parsers read it.
    std::vector<double> used = filamentByTool;
    if (used.empty()) used.push_back(writer.filament);      // single-material: the whole print is filament 1
    const double area = PI * params.filament_diameter * params.filament_diameter / 4.0;   // mm2
    std::string mm = "; filament used [mm] = ";
    std::string cm3 = "; filament used [cm3] = ";
    std::string grams = "; filament used [g] = ";
    std::string cost = "; filament cost = ";
    bool anyWeight = false;
    bool anyCost = false;
    double totalWeight = 0;
    double totalCost = 0;
    char formatted[64];
    for (size_t tool = 0; tool < used.size(); ++tool) {
      if (tool) {
        mm += ", ";
        cm3 += ", ";
        grams += ", ";
        cost += ", ";
      }
      const double volume_mm3 = used[tool] * area;
      std::snprintf(formatted, sizeof formatted, "%.2f", used[tool]);
      mm  += formatted;
      std::snprintf(formatted, sizeof formatted, "%.2f", volume_mm3 * 0.001);
      cm3 += formatted;
      // density is g/cm3 and cost is per kg, the units the filament profiles use.
      const double density = Params::forTool(params.filament_density, (int)tool, 0.0);
      const double weight  = volume_mm3 * 0.001 * density;
      const double price   = Params::forTool(params.filament_cost, (int)tool, 0.0) * weight * 0.001;
      std::snprintf(formatted, sizeof formatted, "%.2f", weight);
      grams += formatted;
      std::snprintf(formatted, sizeof formatted, "%.2f", price);
      cost  += formatted;
      if (weight > 0) {
        anyWeight = true;
        totalWeight += weight;
      }
      if (price  > 0) {
        anyCost   = true;
        totalCost   += price;
      }
    }
    writer.raw(mm.c_str());
    writer.raw(cm3.c_str());
    if (anyWeight) writer.raw(grams.c_str());
    if (anyCost)   writer.raw(cost.c_str());
    if (anyWeight) {
      std::snprintf(formatted, sizeof formatted, "; total filament used [g] = %.2f", totalWeight);
      writer.raw(formatted);
    }
    if (anyCost) {
      std::snprintf(formatted, sizeof formatted, "; total filament cost = %.2f", totalCost);
      writer.raw(formatted);
    }
    if (toolChanges > 0) {
      std::snprintf(formatted, sizeof formatted, "; total filament change = %d", toolChanges);
      writer.raw(formatted);
    }
    // The material each filament is, so the export says what it is made of and not only how much it used.
    for (size_t tool = 0; tool < used.size(); ++tool) {
      const std::string type = [&]() -> std::string {
        if (tool < params.filament_type.size()) return params.filament_type[tool];
        return std::string();
      }();
      const std::string settingsId = [&]() -> std::string {
        if (tool < params.filament_settings_id.size()) return params.filament_settings_id[tool];
        return std::string();
      }();
      if (type.empty() && settingsId.empty()) continue;
      std::string line = "; filament " + std::to_string(tool + 1) + " =";
      if (!type.empty())       line += " " + type;
      if (!settingsId.empty()) line += " (" + settingsId + ")";
      writer.raw(line.c_str());
    }
  }
  if (params.gcode_config_block) {
    // Upstream dumps its whole config here; the kernel's config IS the params object it was handed, so that is what
    //  goes in — one `; key = value` per entry, which is the form upstream's own block uses.
    writer.raw("; CONFIG_BLOCK_START");
    const std::string& json = params.params_json;
    size_t cursor = json.find('{');
    if (cursor != std::string::npos) {
      ++cursor;
      while (cursor < json.size()) {
        while (cursor < json.size() && (json[cursor]==' '||json[cursor]=='\t'||json[cursor]=='\n'||json[cursor]==',')) ++cursor;
        if (cursor >= json.size() || json[cursor] == '}') break;
        if (json[cursor] != '"') break;               // not a key — stop rather than emit garbage
        size_t keyEnd = json.find('"', cursor + 1);
        if (keyEnd == std::string::npos) break;
        const std::string key = json.substr(cursor + 1, keyEnd - cursor - 1);
        size_t colon = json.find(':', keyEnd);
        if (colon == std::string::npos) break;
        size_t valueCursor = colon + 1;
        while (valueCursor < json.size() && (json[valueCursor]==' '||json[valueCursor]=='\t'||json[valueCursor]=='\n')) ++valueCursor;
        // Copy the value verbatim, tracking nesting and strings so a nested array or an escaped quote cannot end it early.
        size_t start = valueCursor;
        int depth = 0;
        bool inString = false;
        for (; valueCursor < json.size(); ++valueCursor) {
          const char character = json[valueCursor];
          if (inString) {
            if (character == '\\') ++valueCursor;
            else if (character == '"') inString = false;
            continue;
          }
          if (character == '"') {
            inString = true;
            continue;
          }
          if (character == '[' || character == '{') ++depth;
          else if (character == ']' || character == '}') {
            if (depth == 0) break;
            --depth;
          }
          else if (character == ',' && depth == 0) break;
        }
        std::string value = json.substr(start, valueCursor - start);
        while (!value.empty() && (value.back()==' '||value.back()=='\n'||value.back()=='\t')) value.pop_back();
        // Newlines would break the one-comment-per-line form (custom G-code arrives as one multi-line string).
        for (char& character : value) if (character == '\n' || character == '\r') character = ' ';
        writer.raw(("; " + key + " = " + value).c_str());
        cursor = valueCursor;
      }
    }
    writer.raw("; CONFIG_BLOCK_END");
  }
}

double role_flow_ratio(const Params& params, FlowRole role, bool firstLayer) {
  double ratio = 1.0;
  if (role == FlowRole::TopSurface) ratio *= params.top_solid_infill_flow_ratio;
  else if (role == FlowRole::BottomSurface) ratio *= params.bottom_solid_infill_flow_ratio;
  else if (role == FlowRole::Brim) ratio *= params.brim_flow_ratio;
  // A bridge's flow is its own Flow upstream: the regular section times bridge_flow, or a round thread when thick.
  else if (role == FlowRole::Bridge && !params.thick_bridges) ratio *= params.bridge_flow;
  if (!params.set_other_flow_ratios) return ratio;
  if (role == FlowRole::OuterWall) ratio *= params.outer_wall_flow_ratio;
  else if (role == FlowRole::InnerWall) ratio *= params.inner_wall_flow_ratio;
  else if (role == FlowRole::SparseInfill) ratio *= params.sparse_infill_flow_ratio;
  else if (role == FlowRole::InternalSolid) ratio *= params.internal_solid_infill_flow_ratio;
  else if (role == FlowRole::GapFill) ratio *= params.gap_fill_flow_ratio;
  else if (role == FlowRole::Support) ratio *= params.support_flow_ratio;
  else if (role == FlowRole::SupportInterface) ratio *= params.support_interface_flow_ratio;
  // Additionally on the first layer, except brims and skirts
  if (firstLayer && role != FlowRole::Brim && role != FlowRole::Skirt) ratio *= params.first_layer_flow_ratio;
  return ratio;
}

namespace {
bool any_role_speed(const Params& params) {
  return params.inner_wall_speed >= 0 || params.sparse_infill_speed >= 0 || params.internal_solid_infill_speed >= 0 || params.top_surface_speed >= 0 ||
         params.support_speed >= 0 || params.support_interface_speed >= 0 || params.initial_layer_infill_speed >= 0 || params.skirt_speed >= 0;
}
// A per-role speed the host did not send prints at print_speed (outer_wall_speed), what every role printed at before.
double sent_or(double value, double fallback) {
  if (value >= 0) return value;
  return fallback;
}
}  // namespace

RoleFeeds role_feeds(const Params& params, bool firstLayer, int printedLayer, int raftLayerCount, int legacy, int legacyBridge, double capSpeed) {
  RoleFeeds feeds;
  if (!any_role_speed(params)) {
    for (int k = 0; k < FLOW_ROLE_COUNT; ++k) feeds.feedByRole[k] = legacy;
    feeds.feedByRole[(int)FlowRole::Bridge] = legacyBridge;
    return feeds;
  }
  const double outer = params.print_speed;   // outer_wall_speed
  const double firstLayerSpeed = params.first_layer_speed;   // initial_layer_speed
  const double firstLayerInfill = sent_or(params.initial_layer_infill_speed, firstLayerSpeed);
  for (int k = 0; k < FLOW_ROLE_COUNT; ++k) {
    const FlowRole role = (FlowRole)k;
    double speed = outer;
    switch (role) {
      case FlowRole::OuterWall:        speed = outer; break;
      case FlowRole::InnerWall:        speed = sent_or(params.inner_wall_speed, outer); break;
      case FlowRole::SparseInfill:     speed = sent_or(params.sparse_infill_speed, outer); break;
      case FlowRole::InternalSolid:    speed = sent_or(params.internal_solid_infill_speed, outer); break;
      case FlowRole::TopSurface:       speed = sent_or(params.top_surface_speed, outer); break;
      case FlowRole::BottomSurface:    speed = sent_or(params.internal_solid_infill_speed, outer); break;
      case FlowRole::Bridge:           speed = params.bridge_speed; break;
      case FlowRole::GapFill:          speed = Params::forTool(params.gap_infill_speed, 0, outer); break;
      case FlowRole::Support:          speed = sent_or(params.support_speed, outer); break;
      case FlowRole::SupportInterface: speed = sent_or(params.support_interface_speed, outer); break;
      // Upstream prints the skirt and the brim with support_speed (GCode::process_layer passes it to extrude_loop).
      case FlowRole::Skirt:            speed = sent_or(params.support_speed, outer); break;
      case FlowRole::Brim:             speed = sent_or(params.support_speed, outer); break;
      case FlowRole::Ironing:          speed = params.ironing_speed; break;
      case FlowRole::Other:            speed = outer; break;
    }
    // 0 = as fast as the filament's volumetric limit allows: the writer's cap (GW::capped_feed) does the rest.
    if (speed == 0) speed = params.machine_max_speed_xy;
    const bool perimeterLike = role == FlowRole::OuterWall || role == FlowRole::InnerWall || role == FlowRole::Brim;
    double rampFrom = firstLayerInfill;
    if (perimeterLike) rampFrom = firstLayerSpeed;
    if (firstLayer) {
      // The first layer's bottom solid is upstream's erBottomSurface, which already has initial_layer_infill_speed.
      if (role == FlowRole::BottomSurface) speed = firstLayerInfill;
      else speed = rampFrom;
    } else if (params.slow_down_layers > 1) {
      const int layer = printedLayer - raftLayerCount;   // upstream counts from the first object layer when there is a raft
      bool ramping = layer > 0 && layer < params.slow_down_layers;
      if (raftLayerCount > 0) ramping = printedLayer > raftLayerCount && layer < params.slow_down_layers;
      if (ramping && rampFrom < speed)
        speed = std::min(speed, rampFrom + (speed - rampFrom) * (double)layer / params.slow_down_layers);
    }
    if (role == FlowRole::Skirt && params.skirt_speed > 0) speed = params.skirt_speed;
    if (capSpeed > 0 && role != FlowRole::Bridge) speed = std::min(speed, capSpeed);
    feeds.feedByRole[k] = (int)std::llround(speed * 60);
  }
  return feeds;
}

void gw_setup_motion(GW& writer, const Params& params, bool is_bbl) {
  writer.motion_accel = params.default_acceleration > 0;
  writer.motion_jerk = params.default_jerk > 0;
  writer.motion_bbl = is_bbl;
  writer.outer_wall_role = (int)FlowRole::OuterWall;
  const Flavor flavor = flavor_or_marlin(writer.flavor);
  // GCodeWriter::apply_print_config: the clamps exist for the flavors that have machine limits.
  const bool machineLimits = flavor == Flavor::MarlinLegacy || flavor == Flavor::MarlinFirmware || flavor == Flavor::Klipper ||
                             flavor == Flavor::RepRapFirmware;
  if (machineLimits) {
    double extruding = std::round(params.machine_max_acceleration_extruding);
    if (flavor == Flavor::Klipper) {   // SET_VELOCITY_LIMIT ACCEL applies to every move: the X/Y limits cap it too
      if (std::round(params.machine_max_accel_xy) > 0) extruding = std::min(extruding, std::round(params.machine_max_accel_xy));
      if (std::round(params.machine_max_acceleration_y) > 0) extruding = std::min(extruding, std::round(params.machine_max_acceleration_y));
    }
    writer.max_accel = (unsigned)std::max(0.0, extruding);
    if (machine_separate_travel_acceleration(flavor)) writer.max_travel_accel = (unsigned)std::max(0.0, std::round(params.machine_max_acceleration_travel));
    writer.max_jerk_x = std::round(params.machine_jerk_xy);
    writer.max_jerk_y = std::round(params.machine_max_jerk_y);
  }
  writer.jerk_z = params.machine_jerk_z;
  writer.jerk_e = params.machine_jerk_e;
  writer.accel_to_decel = params.accel_to_decel_enable;
  writer.accel_to_decel_factor = params.accel_to_decel_factor;
  auto rounded = [](double accel) { return (unsigned)std::floor(std::max(0.0, accel) + 0.5); };
  for (int firstLayer = 0; firstLayer < 2; ++firstLayer) {
    for (int k = 0; k < FLOW_ROLE_COUNT; ++k) {
      const FlowRole role = (FlowRole)k;
      double accel = params.default_acceleration;
      if (firstLayer && params.initial_layer_acceleration > 0) accel = params.initial_layer_acceleration;
      else if (params.bridge_acceleration > 0 && role == FlowRole::Bridge) accel = params.bridge_acceleration;
      else if (params.sparse_infill_acceleration > 0 && role == FlowRole::SparseInfill) accel = params.sparse_infill_acceleration;
      else if (params.internal_solid_infill_acceleration > 0 && role == FlowRole::InternalSolid) accel = params.internal_solid_infill_acceleration;
      else if (params.outer_wall_acceleration > 0 && role == FlowRole::OuterWall) accel = params.outer_wall_acceleration;
      else if (params.inner_wall_acceleration > 0 && role == FlowRole::InnerWall) accel = params.inner_wall_acceleration;
      else if (params.top_surface_acceleration > 0 && role == FlowRole::TopSurface) accel = params.top_surface_acceleration;
      writer.role_accel[firstLayer][k] = rounded(accel);
      // is_infill (ExtrusionEntity.hpp): every infill role, top and bottom surfaces and bridges included.
      const bool infill = role == FlowRole::SparseInfill || role == FlowRole::InternalSolid || role == FlowRole::TopSurface ||
                          role == FlowRole::BottomSurface || role == FlowRole::Bridge;
      double jerk = params.default_jerk;
      if (firstLayer && params.initial_layer_jerk > 0) jerk = params.initial_layer_jerk;
      else if (params.outer_wall_jerk > 0 && role == FlowRole::OuterWall) jerk = params.outer_wall_jerk;
      else if (params.inner_wall_jerk > 0 && role == FlowRole::InnerWall) jerk = params.inner_wall_jerk;
      else if (params.top_surface_jerk > 0 && role == FlowRole::TopSurface) jerk = params.top_surface_jerk;
      else if (params.infill_jerk > 0 && infill) jerk = params.infill_jerk;
      writer.role_jerk[firstLayer][k] = jerk;
    }
  }
  // Travels: the firstLayer layer's own when set, else travel_acceleration / travel_jerk (0 = leave as is).
  writer.travel_accel[1] = rounded(params.initial_layer_travel_acceleration);
  writer.travel_jerk[1] = params.initial_layer_travel_jerk;
  writer.travel_accel[0] = rounded(params.travel_acceleration);
  writer.travel_jerk[0] = params.travel_jerk;
  writer.inner_wall_role = (int)FlowRole::InnerWall;
  writer.bridge_role = (int)FlowRole::Bridge;
  writer.support_interface_role = (int)FlowRole::SupportInterface;
  writer.ironing_role = (int)FlowRole::Ironing;
  if (params.small_perimeter_speed >= 0 && params.small_perimeter_threshold > 0) {
    double speed = params.small_perimeter_speed;
    if (speed == 0) speed = params.print_speed * 0.5;   // 0 = half the outer wall's speed (GCode.cpp:6671)
    writer.small_perimeter_length = params.small_perimeter_threshold * 2 * PI;
    writer.small_perimeter_feed = (int)std::llround(speed * 60);
  }
  writer.short_travel_accel = rounded(params.outer_wall_acceleration);
  writer.short_travel_jerk = params.outer_wall_jerk;
}

double thick_bridge_mm3_per_mm(const Params& params) {
  double thread = params.nozzle_diameter;
  if (params.bridge_flow > 0.0) thread *= std::sqrt(params.bridge_flow);
  return PI * thread * thread / 4.0;
}
