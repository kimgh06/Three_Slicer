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
static inline void push_seg(std::vector<float>& v,double x0,double y0,double x1,double y1,double z,float type){
  const float enc = type + (float)(g_seg_tool * 16);
  v.push_back((float)x0);v.push_back((float)y0);v.push_back((float)z);v.push_back(enc);
  v.push_back((float)x1);v.push_back((float)y1);v.push_back((float)z);v.push_back(enc);
  if (g_seg_w) g_seg_w->push_back(g_seg_w_cur);
}
em::val to_f32(const std::vector<float>& v){
  return em::val(em::typed_memory_view(v.size(), v.data())).call<em::val>("slice");
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
static void dry_path_motion(GW& gw, double x0, double y0) {
  const double distance = std::hypot(x0 - gw.px, y0 - gw.py);
  if (distance >= 1e-6) gw.apply_travel_motion(distance);
  gw.apply_print_motion();
}
// Closed loops (walls/skirt/raft). seamMode: -1 = no rotation, 0 = back, 1 = nearest, 2 = aligned, 3 = random.
// With updateSeam=true the start point is recorded into SeamCtx (for the next layer of aligned).
void emit_loops(GW& gw, std::vector<float>& tp, Paths loops, double z, float type, int fPrint, int fTravel,
                       int seamMode, SeamCtx& sc, bool updateSeam){
  if (gw.dry) {   // G003 E1: seam rotation, position and curF only — the writer pass reproduces the bytes from an identical entry state
    for (Path wp : loops) {
      if (wp.size() < 2) continue;
      rotate_seam(wp, seamMode, sc, gw.px, gw.py);
      dry_path_motion(gw, wp[0].x()*INV, wp[0].y()*INV);
      gw.px = wp[0].x()*INV; gw.py = wp[0].y()*INV; gw.curF = fPrint;
      if (gw.small_perimeter_length > 0) gw.curF = gw.loop_feed(paths_len(Paths{wp}, true), fPrint);
      if (updateSeam) { sc.lastX=gw.px; sc.lastY=gw.py; sc.has=true; }
    }
    return;
  }
  bool anyRun=false;
  for (Path wp : loops) {
    if (wp.size() < 2) continue;
    if (!anyRun) { gw.role_tag((int)type); gw.pe_begin_run(pe_role_of(type), fPrint); anyRun=true; }
    rotate_seam(wp, seamMode, sc, gw.px, gw.py);
    std::vector<DPt> pts; pts.reserve(wp.size()+1);
    for (auto& q:wp) pts.push_back({q.x()*INV, q.y()*INV});
    pts.push_back(pts.front());                                   // close the loop
    push_seg(tp, gw.px, gw.py, pts[0].x, pts[0].y, z, 0.0f);
    gw.travel(pts[0].x, pts[0].y, fTravel);
    for (size_t i=1;i<pts.size();++i) push_seg(tp, pts[i-1].x,pts[i-1].y, pts[i].x,pts[i].y, z, type);
    int fLoop = fPrint;
    if (gw.small_perimeter_length > 0) fLoop = gw.loop_feed(paths_len(Paths{wp}, true), fPrint);
    gw.path_begin(fLoop);
    gw.extrude_run(pts, fLoop, type);
    gw.path_end();
    if (updateSeam) { sc.lastX=pts[0].x; sc.lastY=pts[0].y; sc.has=true; }
  }
  if (anyRun) gw.pe_end_run();
}
// Open lines (infill/support). Arc fitting applies.
void emit_lines(GW& gw, std::vector<float>& tp, const Paths& lines, double z, float type, int fPrint, int fTravel){
  if (gw.dry) {
    for (const Path& ln : lines) if (ln.size() >= 2) {
      dry_path_motion(gw, ln[0].x()*INV, ln[0].y()*INV);
      gw.px = ln.back().x()*INV; gw.py = ln.back().y()*INV; gw.curF = fPrint;
    }
    return;
  }
  bool anyRun=false;
  for (const Path& ln : lines) {
    if (ln.size() < 2) continue;
    if (!anyRun) { gw.role_tag((int)type); gw.pe_begin_run(pe_role_of(type), fPrint); anyRun=true; }
    std::vector<DPt> pts; pts.reserve(ln.size());
    for (auto& q:ln) pts.push_back({q.x()*INV, q.y()*INV});
    push_seg(tp, gw.px, gw.py, pts[0].x, pts[0].y, z, 0.0f);
    gw.travel(pts[0].x, pts[0].y, fTravel);
    for (size_t i=1;i<pts.size();++i) push_seg(tp, pts[i-1].x,pts[i-1].y, pts[i].x,pts[i].y, z, type);
    gw.path_begin(fPrint);
    gw.extrude_run(pts, fPrint, type);
    gw.path_end();
  }
  if (anyRun) gw.pe_end_run();
}
// Stage 19 -> WP3: tree support emission — open polylines with per-path width. E uses the upstream mm3_per_mm when present
//  (set_e_per_mm_vol — reproducing the upstream Flow rate, e.g. on bridging contact layers), otherwise the old width x height rectangular approximation.
//  The PE role splits runs by each path's upstream role (base 14 / interface 15), preserving the upstream role distinction.
void emit_lines_vw(GW& gw, std::vector<float>& tp, const std::vector<TreePath>& lines,
                          double z, double h, const Params& p, float type, int fPrint, int fTravel){
  if (gw.dry) {   // G003 E1: position and curF only (E/flow state is reset at every layer start, so it does not chain)
    for (const auto& lw : lines) {
      if (lw.pl.size() < 2) continue;
      dry_path_motion(gw, lw.pl[0].x()*INV, lw.pl[0].y()*INV);
      gw.px = lw.pl.back().x()*INV; gw.py = lw.pl.back().y()*INV;
      // The flow the real emit sets for this line, so the volumetric cap leaves curF where the real emit would.
      if (lw.mm3 > 1e-9) gw.set_e_per_mm_vol(lw.mm3, p);
      else if (lw.h > 1e-6) gw.set_e_per_mm_width(lw.w, lw.h, p);
      else gw.set_e_per_mm_width(lw.w, h, p);
      gw.curF = gw.capped_feed(fPrint);
    }
    return;
  }
  int curRole = -1;
  for (const auto& lw : lines) {
    const Path& ln = lw.pl;
    if (ln.size() < 2) continue;
    const int role = (lw.role > 0) ? lw.role : pe_role_of(type);
    gw.role_tag((int)type);
    if (role != curRole) { if (curRole >= 0) gw.pe_end_run(); gw.pe_begin_run(role, fPrint); curRole = role; }
    const double ph = (lw.h > 1e-6) ? lw.h : h;
    if (lw.mm3 > 1e-9) gw.set_e_per_mm_vol(lw.mm3, p);
    else               gw.set_e_per_mm_width(lw.w, ph, p);
    g_seg_w_cur = lw.w;
    std::vector<DPt> pts; pts.reserve(ln.size());
    for (auto& q:ln) pts.push_back({q.x()*INV, q.y()*INV});
    push_seg(tp, gw.px, gw.py, pts[0].x, pts[0].y, z, 0.0f);
    gw.travel(pts[0].x, pts[0].y, fTravel);
    for (size_t i=1;i<pts.size();++i) push_seg(tp, pts[i-1].x,pts[i-1].y, pts[i].x,pts[i].y, z, type);
    gw.path_begin(fPrint);
    gw.extrude_run(pts, fPrint, type);
    gw.path_end();
  }
  if (curRole >= 0) gw.pe_end_run();
  g_seg_w_cur = (float)p.line_width; gw.set_e_per_mm(h, p);   // restore the default width/E
}
// Stage 7: emit the real ported Arachne variable-width walls. E is computed from the per-segment width (set_e_per_mm_width) and widths is recorded.
void emit_arachne_walls(GW& gw, std::vector<float>& tp, const std::vector<arachne_bridge::WLine>& walls,
                               double z, double h, const Params& p, const RoleFeeds& feeds, int fTravel){
  bool anyRun=false;
  for (const auto& wl : walls) {
    if (wl.pts.size() < 2) continue;
    FlowRole flowRole = FlowRole::InnerWall;
    if (wl.inset_idx == 0) flowRole = FlowRole::OuterWall;
    gw.role_flow = role_flow_ratio(p, flowRole, gw.on_first_layer);
    gw.set_feature((int)flowRole);
    int fPrint = feeds.of(flowRole);
    if (wl.closed) {
      double loopLength = std::hypot(wl.pts.front().x - wl.pts.back().x, wl.pts.front().y - wl.pts.back().y);
      for (size_t k = 1; k < wl.pts.size(); ++k) loopLength += std::hypot(wl.pts[k].x - wl.pts[k-1].x, wl.pts[k].y - wl.pts[k-1].y);
      fPrint = gw.loop_feed(loopLength, fPrint);
    }
    if (!anyRun) { gw.role_tag(1); gw.pe_begin_run(2 /*erExternalPerimeter*/, fPrint); anyRun=true; }
    push_seg(tp, gw.px, gw.py, wl.pts[0].x, wl.pts[0].y, z, 0.0f);
    gw.travel(wl.pts[0].x, wl.pts[0].y, fTravel);
    gw.path_begin(fPrint);
    size_t n = wl.pts.size();
    for (size_t i=1;i<n;++i) {
      double sw = 0.5*(wl.pts[i-1].w + wl.pts[i].w);
      gw.set_e_per_mm_width(sw, h, p); g_seg_w_cur = (float)sw;
      push_seg(tp, wl.pts[i-1].x, wl.pts[i-1].y, wl.pts[i].x, wl.pts[i].y, z, 1.0f);
      gw.extrude(wl.pts[i].x, wl.pts[i].y, fPrint);
    }
    if (wl.closed) {
      double sw = 0.5*(wl.pts[n-1].w + wl.pts[0].w);
      gw.set_e_per_mm_width(sw, h, p); g_seg_w_cur = (float)sw;
      push_seg(tp, wl.pts[n-1].x, wl.pts[n-1].y, wl.pts[0].x, wl.pts[0].y, z, 1.0f);
      gw.extrude(wl.pts[0].x, wl.pts[0].y, fPrint);
    }
    gw.path_end();
  }
  if (anyRun) gw.pe_end_run();
  g_seg_w_cur = (float)p.line_width;
}
// Spiral (vase): a single outer wall rising continuously from z0 to z0+h around the perimeter
void emit_spiral(GW& gw, std::vector<float>& tp, const Paths& outerWall, double z0, double h, int fPrint, int fTravel){
  if (outerWall.empty() || outerWall[0].size()<2) return;
  const Path& wp = outerWall[0];
  std::vector<DPt> pts; for (auto& q:wp) pts.push_back({q.x()*INV, q.y()*INV}); pts.push_back(pts.front());
  push_seg(tp, gw.px, gw.py, pts[0].x, pts[0].y, z0, 0.0f);
  gw.travel(pts[0].x, pts[0].y, fTravel);
  gw.role_tag(1);
  gw.path_begin(fPrint);
  double total=0; for (size_t i=1;i<pts.size();++i) total+=std::hypot(pts[i].x-pts[i-1].x, pts[i].y-pts[i-1].y);
  double acc=0;
  for (size_t i=1;i<pts.size();++i){
    acc += std::hypot(pts[i].x-pts[i-1].x, pts[i].y-pts[i-1].y);
    double zz = z0 + h*(total>1e-9 ? acc/total : 0.0);
    gw.extrude_z(pts[i].x, pts[i].y, zz, fPrint);
    push_seg(tp, pts[i-1].x,pts[i-1].y, pts[i].x,pts[i].y, zz, 1.0f);
  }
  gw.path_end();
}
// Scarf joint seam (outer wall loop): ramp z (z-h -> z) and flow (0 -> 1) up at the start, then ramp down over the same length at the end with an overlap (flow 1 -> 0).
//  ⚠ An approximation — a gentle sloped joint instead of a z-seam blob. Applied to the outer wall only when seam_slope_type=external/all.
void emit_scarf_loop(GW& gw, std::vector<float>& tp, Path wp, double z, double h,
                            int fPrint, int fTravel, int seamMode, SeamCtx& sc){
  if (wp.size() < 3) return;
  rotate_seam(wp, seamMode, sc, gw.px, gw.py);
  std::vector<DPt> pts; pts.reserve(wp.size()+1);
  for (auto& q:wp) pts.push_back({q.x()*INV, q.y()*INV});
  pts.push_back(pts.front());
  double L=0; for (size_t i=1;i<pts.size();++i) L+=std::hypot(pts[i].x-pts[i-1].x, pts[i].y-pts[i-1].y);
  fPrint = gw.loop_feed(L, fPrint);
  double slen = std::min(gw.scarf_len, 0.45*L); if (slen < 1e-3) slen = 0.45*L;
  push_seg(tp, gw.px, gw.py, pts[0].x, pts[0].y, z, 0.0f);
  gw.travel(pts[0].x, pts[0].y, fTravel);
  gw.raw("; scarf");
  gw.path_begin(fPrint);
  gw.role_tag(1);
  double startZ = z - h;
  double sub = std::max(0.2, slen/8.0);   // ramp subdivision step (so long straight walls also rise continuously in z)
  // Ramp up: over the first slen, z goes (z-h) -> z and flow 0 -> 1 (subdivided into segments)
  double s=0; size_t i=1;
  for (; i<pts.size(); ++i){
    double segx=pts[i].x-pts[i-1].x, segy=pts[i].y-pts[i-1].y, seg=std::hypot(segx,segy);
    int steps = std::max(1, (int)std::ceil(seg/sub));
    for (int st=1; st<=steps; ++st){
      double f=(double)st/steps, x=pts[i-1].x+segx*f, y=pts[i-1].y+segy*f;
      double t=std::min(1.0, (s+seg*f)/slen), zz=startZ + h*t, flow=std::max(0.05, t);
      double ax=gw.px, ay=gw.py;
      gw.extrude_zf(x, y, zz, flow, fPrint);
      push_seg(tp, ax,ay, x,y, zz, 1.0f);
    }
    s+=seg; if (s>=slen) { ++i; break; }
  }
  // Flat middle: z, flow 1
  for (; i<pts.size(); ++i){
    double ax=gw.px, ay=gw.py;
    gw.extrude(pts[i].x, pts[i].y, fPrint);
    push_seg(tp, ax,ay, pts[i].x,pts[i].y, z, 1.0f);
  }
  // Overlapping ramp down: retrace slen from the start, keeping z and taking flow 1 -> 0 (finishing over the ramp-up)
  double s2=0;
  for (size_t k=1;k<pts.size();++k){
    double segx=pts[k].x-pts[k-1].x, segy=pts[k].y-pts[k-1].y, seg=std::hypot(segx,segy);
    int steps = std::max(1, (int)std::ceil(seg/sub));
    for (int st=1; st<=steps; ++st){
      double f=(double)st/steps, x=pts[k-1].x+segx*f, y=pts[k-1].y+segy*f;
      double t=std::min(1.0,(s2+seg*f)/slen), flow=std::max(0.05, 1.0-t);
      double ax=gw.px, ay=gw.py;
      gw.extrude_zf(x, y, z, flow, fPrint);
      push_seg(tp, ax,ay, x,y, z, 1.0f);
    }
    s2+=seg; if (s2>=slen) break;
  }
  sc.lastX=pts[0].x; sc.lastY=pts[0].y; sc.has=true;
  gw.path_end();
}

// ---- G-code footer blocks (upstream GCode.cpp) --------------------------------------------------------------
//  Two things upstream always writes and this kernel used to sum into a single "; filament used: N mm":
//   · the per-filament totals, in millimetres, cm3, grams and cost — the last two only when the host supplied a
//     density / price, because inventing one would be worse than omitting the line;
//   · the parameters the slice ran with, delimited so a tool can find them (upstream re-imports its own exports
//     from exactly this block).
void emit_gcode_footer_blocks(GW& gw, const Params& p, const std::vector<double>& filamentByTool, int toolChanges) {
  if (p.gcode_stats_block) {
    // One entry per filament, comma separated, in filament order — upstream's own layout, so the same parsers read it.
    std::vector<double> used = filamentByTool;
    if (used.empty()) used.push_back(gw.filament);          // single-material: the whole print is filament 1
    const double area = PI * p.filament_diameter * p.filament_diameter / 4.0;   // mm2
    std::string mm = "; filament used [mm] = ", cm3 = "; filament used [cm3] = ";
    std::string grams = "; filament used [g] = ", cost = "; filament cost = ";
    bool anyWeight = false, anyCost = false;
    double totalWeight = 0, totalCost = 0;
    char buf[64];
    for (size_t t = 0; t < used.size(); ++t) {
      if (t) { mm += ", "; cm3 += ", "; grams += ", "; cost += ", "; }
      const double volume_mm3 = used[t] * area;
      std::snprintf(buf, sizeof buf, "%.2f", used[t]);            mm  += buf;
      std::snprintf(buf, sizeof buf, "%.2f", volume_mm3 * 0.001); cm3 += buf;
      // density is g/cm3 and cost is per kg, the units the filament profiles use.
      const double density = Params::forTool(p.filament_density, (int)t, 0.0);
      const double weight  = volume_mm3 * 0.001 * density;
      const double price   = Params::forTool(p.filament_cost, (int)t, 0.0) * weight * 0.001;
      std::snprintf(buf, sizeof buf, "%.2f", weight); grams += buf;
      std::snprintf(buf, sizeof buf, "%.2f", price);  cost  += buf;
      if (weight > 0) { anyWeight = true; totalWeight += weight; }
      if (price  > 0) { anyCost   = true; totalCost   += price; }
    }
    gw.raw(mm.c_str());
    gw.raw(cm3.c_str());
    if (anyWeight) gw.raw(grams.c_str());
    if (anyCost)   gw.raw(cost.c_str());
    if (anyWeight) { std::snprintf(buf, sizeof buf, "; total filament used [g] = %.2f", totalWeight); gw.raw(buf); }
    if (anyCost)   { std::snprintf(buf, sizeof buf, "; total filament cost = %.2f", totalCost);       gw.raw(buf); }
    if (toolChanges > 0) { std::snprintf(buf, sizeof buf, "; total filament change = %d", toolChanges); gw.raw(buf); }
    // The material each filament is, so the export says what it is made of and not only how much it used.
    for (size_t t = 0; t < used.size(); ++t) {
      const std::string type = t < p.filament_type.size() ? p.filament_type[t] : std::string();
      const std::string id   = t < p.filament_settings_id.size() ? p.filament_settings_id[t] : std::string();
      if (type.empty() && id.empty()) continue;
      std::string line = "; filament " + std::to_string(t + 1) + " =";
      if (!type.empty()) line += " " + type;
      if (!id.empty())   line += " (" + id + ")";
      gw.raw(line.c_str());
    }
  }
  if (p.gcode_config_block) {
    // Upstream dumps its whole config here; the kernel's config IS the params object it was handed, so that is what
    //  goes in — one `; key = value` per entry, which is the form upstream's own block uses.
    gw.raw("; CONFIG_BLOCK_START");
    const std::string& j = p.params_json;
    size_t i = j.find('{');
    if (i != std::string::npos) {
      ++i;
      while (i < j.size()) {
        while (i < j.size() && (j[i]==' '||j[i]=='\t'||j[i]=='\n'||j[i]==',')) ++i;
        if (i >= j.size() || j[i] == '}') break;
        if (j[i] != '"') break;                       // not a key — stop rather than emit garbage
        size_t keyEnd = j.find('"', i + 1);
        if (keyEnd == std::string::npos) break;
        const std::string key = j.substr(i + 1, keyEnd - i - 1);
        size_t colon = j.find(':', keyEnd);
        if (colon == std::string::npos) break;
        size_t v = colon + 1;
        while (v < j.size() && (j[v]==' '||j[v]=='\t'||j[v]=='\n')) ++v;
        // Copy the value verbatim, tracking nesting and strings so a nested array or an escaped quote cannot end it early.
        size_t start = v; int depth = 0; bool inString = false;
        for (; v < j.size(); ++v) {
          const char c = j[v];
          if (inString) { if (c == '\\') ++v; else if (c == '"') inString = false; continue; }
          if (c == '"') { inString = true; continue; }
          if (c == '[' || c == '{') ++depth;
          else if (c == ']' || c == '}') { if (depth == 0) break; --depth; }
          else if (c == ',' && depth == 0) break;
        }
        std::string value = j.substr(start, v - start);
        while (!value.empty() && (value.back()==' '||value.back()=='\n'||value.back()=='\t')) value.pop_back();
        // Newlines would break the one-comment-per-line form (custom G-code arrives as one multi-line string).
        for (char& c : value) if (c == '\n' || c == '\r') c = ' ';
        gw.raw(("; " + key + " = " + value).c_str());
        i = v;
      }
    }
    gw.raw("; CONFIG_BLOCK_END");
  }
}

double role_flow_ratio(const Params& p, FlowRole role, bool firstLayer) {
  double ratio = 1.0;
  if (role == FlowRole::TopSurface) ratio *= p.top_solid_infill_flow_ratio;
  else if (role == FlowRole::BottomSurface) ratio *= p.bottom_solid_infill_flow_ratio;
  else if (role == FlowRole::Brim) ratio *= p.brim_flow_ratio;
  // A bridge's flow is its own Flow upstream: the regular section times bridge_flow, or a round thread when thick.
  else if (role == FlowRole::Bridge && !p.thick_bridges) ratio *= p.bridge_flow;
  if (!p.set_other_flow_ratios) return ratio;
  if (role == FlowRole::OuterWall) ratio *= p.outer_wall_flow_ratio;
  else if (role == FlowRole::InnerWall) ratio *= p.inner_wall_flow_ratio;
  else if (role == FlowRole::SparseInfill) ratio *= p.sparse_infill_flow_ratio;
  else if (role == FlowRole::InternalSolid) ratio *= p.internal_solid_infill_flow_ratio;
  else if (role == FlowRole::GapFill) ratio *= p.gap_fill_flow_ratio;
  else if (role == FlowRole::Support) ratio *= p.support_flow_ratio;
  else if (role == FlowRole::SupportInterface) ratio *= p.support_interface_flow_ratio;
  // Additionally on the first layer, except brims and skirts
  if (firstLayer && role != FlowRole::Brim && role != FlowRole::Skirt) ratio *= p.first_layer_flow_ratio;
  return ratio;
}

namespace {
bool any_role_speed(const Params& p) {
  return p.inner_wall_speed >= 0 || p.sparse_infill_speed >= 0 || p.internal_solid_infill_speed >= 0 || p.top_surface_speed >= 0 ||
         p.support_speed >= 0 || p.support_interface_speed >= 0 || p.initial_layer_infill_speed >= 0 || p.skirt_speed >= 0;
}
// A per-role speed the host did not send prints at print_speed (outer_wall_speed), what every role printed at before.
double sent_or(double value, double fallback) {
  if (value >= 0) return value;
  return fallback;
}
}  // namespace

RoleFeeds role_feeds(const Params& p, bool firstLayer, int printedLayer, int nraft, int legacy, int legacyBridge, double capSpeed) {
  RoleFeeds feeds;
  if (!any_role_speed(p)) {
    for (int k = 0; k < FLOW_ROLE_COUNT; ++k) feeds.f[k] = legacy;
    feeds.f[(int)FlowRole::Bridge] = legacyBridge;
    return feeds;
  }
  const double outer = p.print_speed;   // outer_wall_speed
  const double firstLayerSpeed = p.first_layer_speed;   // initial_layer_speed
  const double firstLayerInfill = sent_or(p.initial_layer_infill_speed, firstLayerSpeed);
  for (int k = 0; k < FLOW_ROLE_COUNT; ++k) {
    const FlowRole role = (FlowRole)k;
    double speed = outer;
    switch (role) {
      case FlowRole::OuterWall:        speed = outer; break;
      case FlowRole::InnerWall:        speed = sent_or(p.inner_wall_speed, outer); break;
      case FlowRole::SparseInfill:     speed = sent_or(p.sparse_infill_speed, outer); break;
      case FlowRole::InternalSolid:    speed = sent_or(p.internal_solid_infill_speed, outer); break;
      case FlowRole::TopSurface:       speed = sent_or(p.top_surface_speed, outer); break;
      case FlowRole::BottomSurface:    speed = sent_or(p.internal_solid_infill_speed, outer); break;
      case FlowRole::Bridge:           speed = p.bridge_speed; break;
      case FlowRole::GapFill:          speed = Params::forTool(p.gap_infill_speed, 0, outer); break;
      case FlowRole::Support:          speed = sent_or(p.support_speed, outer); break;
      case FlowRole::SupportInterface: speed = sent_or(p.support_interface_speed, outer); break;
      // Upstream prints the skirt and the brim with support_speed (GCode::process_layer passes it to extrude_loop).
      case FlowRole::Skirt:            speed = sent_or(p.support_speed, outer); break;
      case FlowRole::Brim:             speed = sent_or(p.support_speed, outer); break;
      case FlowRole::Ironing:          speed = p.ironing_speed; break;
      case FlowRole::Other:            speed = outer; break;
    }
    // 0 = as fast as the filament's volumetric limit allows: the writer's cap (GW::capped_feed) does the rest.
    if (speed == 0) speed = p.machine_max_speed_xy;
    const bool perimeterLike = role == FlowRole::OuterWall || role == FlowRole::InnerWall || role == FlowRole::Brim;
    double rampFrom = firstLayerInfill;
    if (perimeterLike) rampFrom = firstLayerSpeed;
    if (firstLayer) {
      // The first layer's bottom solid is upstream's erBottomSurface, which already has initial_layer_infill_speed.
      if (role == FlowRole::BottomSurface) speed = firstLayerInfill;
      else speed = rampFrom;
    } else if (p.slow_down_layers > 1) {
      const int layer = printedLayer - nraft;   // upstream counts from the first object layer when there is a raft
      bool ramping = layer > 0 && layer < p.slow_down_layers;
      if (nraft > 0) ramping = printedLayer > nraft && layer < p.slow_down_layers;
      if (ramping && rampFrom < speed)
        speed = std::min(speed, rampFrom + (speed - rampFrom) * (double)layer / p.slow_down_layers);
    }
    if (role == FlowRole::Skirt && p.skirt_speed > 0) speed = p.skirt_speed;
    if (capSpeed > 0 && role != FlowRole::Bridge) speed = std::min(speed, capSpeed);
    feeds.f[k] = (int)std::llround(speed * 60);
  }
  return feeds;
}

void gw_setup_motion(GW& gw, const Params& p, bool is_bbl) {
  gw.motion_accel = p.default_acceleration > 0;
  gw.motion_jerk = p.default_jerk > 0;
  gw.motion_bbl = is_bbl;
  gw.outer_wall_role = (int)FlowRole::OuterWall;
  const Flavor flavor = flavor_or_marlin(gw.flavor);
  // GCodeWriter::apply_print_config: the clamps exist for the flavors that have machine limits.
  const bool machineLimits = flavor == Flavor::MarlinLegacy || flavor == Flavor::MarlinFirmware || flavor == Flavor::Klipper ||
                             flavor == Flavor::RepRapFirmware;
  if (machineLimits) {
    double extruding = std::round(p.machine_max_acceleration_extruding);
    if (flavor == Flavor::Klipper) {   // SET_VELOCITY_LIMIT ACCEL applies to every move: the X/Y limits cap it too
      if (std::round(p.machine_max_accel_xy) > 0) extruding = std::min(extruding, std::round(p.machine_max_accel_xy));
      if (std::round(p.machine_max_acceleration_y) > 0) extruding = std::min(extruding, std::round(p.machine_max_acceleration_y));
    }
    gw.max_accel = (unsigned)std::max(0.0, extruding);
    if (machine_separate_travel_acceleration(flavor)) gw.max_travel_accel = (unsigned)std::max(0.0, std::round(p.machine_max_acceleration_travel));
    gw.max_jerk_x = std::round(p.machine_jerk_xy);
    gw.max_jerk_y = std::round(p.machine_max_jerk_y);
  }
  gw.jerk_z = p.machine_jerk_z;
  gw.jerk_e = p.machine_jerk_e;
  gw.accel_to_decel = p.accel_to_decel_enable;
  gw.accel_to_decel_factor = p.accel_to_decel_factor;
  auto rounded = [](double accel) { return (unsigned)std::floor(std::max(0.0, accel) + 0.5); };
  for (int first = 0; first < 2; ++first) {
    for (int k = 0; k < FLOW_ROLE_COUNT; ++k) {
      const FlowRole role = (FlowRole)k;
      double accel = p.default_acceleration;
      if (first && p.initial_layer_acceleration > 0) accel = p.initial_layer_acceleration;
      else if (p.bridge_acceleration > 0 && role == FlowRole::Bridge) accel = p.bridge_acceleration;
      else if (p.sparse_infill_acceleration > 0 && role == FlowRole::SparseInfill) accel = p.sparse_infill_acceleration;
      else if (p.internal_solid_infill_acceleration > 0 && role == FlowRole::InternalSolid) accel = p.internal_solid_infill_acceleration;
      else if (p.outer_wall_acceleration > 0 && role == FlowRole::OuterWall) accel = p.outer_wall_acceleration;
      else if (p.inner_wall_acceleration > 0 && role == FlowRole::InnerWall) accel = p.inner_wall_acceleration;
      else if (p.top_surface_acceleration > 0 && role == FlowRole::TopSurface) accel = p.top_surface_acceleration;
      gw.role_accel[first][k] = rounded(accel);
      // is_infill (ExtrusionEntity.hpp): every infill role, top and bottom surfaces and bridges included.
      const bool infill = role == FlowRole::SparseInfill || role == FlowRole::InternalSolid || role == FlowRole::TopSurface ||
                          role == FlowRole::BottomSurface || role == FlowRole::Bridge;
      double jerk = p.default_jerk;
      if (first && p.initial_layer_jerk > 0) jerk = p.initial_layer_jerk;
      else if (p.outer_wall_jerk > 0 && role == FlowRole::OuterWall) jerk = p.outer_wall_jerk;
      else if (p.inner_wall_jerk > 0 && role == FlowRole::InnerWall) jerk = p.inner_wall_jerk;
      else if (p.top_surface_jerk > 0 && role == FlowRole::TopSurface) jerk = p.top_surface_jerk;
      else if (p.infill_jerk > 0 && infill) jerk = p.infill_jerk;
      gw.role_jerk[first][k] = jerk;
    }
  }
  // Travels: the first layer's own when set, else travel_acceleration / travel_jerk (0 = leave as is).
  gw.travel_accel[1] = rounded(p.initial_layer_travel_acceleration);
  gw.travel_jerk[1] = p.initial_layer_travel_jerk;
  gw.travel_accel[0] = rounded(p.travel_acceleration);
  gw.travel_jerk[0] = p.travel_jerk;
  gw.inner_wall_role = (int)FlowRole::InnerWall;
  gw.bridge_role = (int)FlowRole::Bridge;
  gw.support_interface_role = (int)FlowRole::SupportInterface;
  gw.ironing_role = (int)FlowRole::Ironing;
  if (p.small_perimeter_speed >= 0 && p.small_perimeter_threshold > 0) {
    double speed = p.small_perimeter_speed;
    if (speed == 0) speed = p.print_speed * 0.5;   // 0 = half the outer wall's speed (GCode.cpp:6671)
    gw.small_perimeter_length = p.small_perimeter_threshold * 2 * PI;
    gw.small_perimeter_feed = (int)std::llround(speed * 60);
  }
  gw.short_travel_accel = rounded(p.outer_wall_acceleration);
  gw.short_travel_jerk = p.outer_wall_jerk;
}

double thick_bridge_mm3_per_mm(const Params& p) {
  double thread = p.nozzle_diameter;
  if (p.bridge_flow > 0.0) thread *= std::sqrt(p.bridge_flow);
  return PI * thread * thread / 4.0;
}
