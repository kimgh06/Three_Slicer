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
// Closed loops (walls/skirt/raft). seamMode: -1 = no rotation, 0 = back, 1 = nearest, 2 = aligned, 3 = random.
// With updateSeam=true the start point is recorded into SeamCtx (for the next layer of aligned).
void emit_loops(GW& gw, std::vector<float>& tp, Paths loops, double z, float type, int fPrint, int fTravel,
                       int seamMode, SeamCtx& sc, bool updateSeam){
  if (gw.dry) {   // G003 E1: seam rotation, position and curF only — the writer pass reproduces the bytes from an identical entry state
    for (Path wp : loops) {
      if (wp.size() < 2) continue;
      rotate_seam(wp, seamMode, sc, gw.px, gw.py);
      gw.px = wp[0].x()*INV; gw.py = wp[0].y()*INV; gw.curF = fPrint;
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
    gw.extrude_run(pts, fPrint);
    if (updateSeam) { sc.lastX=pts[0].x; sc.lastY=pts[0].y; sc.has=true; }
  }
  if (anyRun) gw.pe_end_run();
}
// Open lines (infill/support). Arc fitting applies.
void emit_lines(GW& gw, std::vector<float>& tp, const Paths& lines, double z, float type, int fPrint, int fTravel){
  if (gw.dry) {
    for (const Path& ln : lines) if (ln.size() >= 2) { gw.px = ln.back().x()*INV; gw.py = ln.back().y()*INV; gw.curF = fPrint; }
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
    gw.extrude_run(pts, fPrint);
  }
  if (anyRun) gw.pe_end_run();
}
// Stage 19 -> WP3: tree support emission — open polylines with per-path width. E uses the upstream mm3_per_mm when present
//  (set_e_per_mm_vol — reproducing the upstream Flow rate, e.g. on bridging contact layers), otherwise the old width x height rectangular approximation.
//  The PE role splits runs by each path's upstream role (base 14 / interface 15), preserving the upstream role distinction.
void emit_lines_vw(GW& gw, std::vector<float>& tp, const std::vector<TreePath>& lines,
                          double z, double h, const Params& p, float type, int fPrint, int fTravel){
  if (gw.dry) {   // G003 E1: position and curF only (E/flow state is reset at every layer start, so it does not chain)
    for (const auto& lw : lines) if (lw.pl.size() >= 2) { gw.px = lw.pl.back().x()*INV; gw.py = lw.pl.back().y()*INV; gw.curF = fPrint; }
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
    gw.extrude_run(pts, fPrint);
  }
  if (curRole >= 0) gw.pe_end_run();
  g_seg_w_cur = (float)p.line_width; gw.set_e_per_mm(h, p);   // restore the default width/E
}
// Stage 7: emit the real ported Arachne variable-width walls. E is computed from the per-segment width (set_e_per_mm_width) and widths is recorded.
void emit_arachne_walls(GW& gw, std::vector<float>& tp, const std::vector<arachne_bridge::WLine>& walls,
                               double z, double h, const Params& p, int fPrint, int fTravel){
  bool anyRun=false;
  for (const auto& wl : walls) {
    if (wl.pts.size() < 2) continue;
    if (!anyRun) { gw.role_tag(1); gw.pe_begin_run(2 /*erExternalPerimeter*/, fPrint); anyRun=true; }
    push_seg(tp, gw.px, gw.py, wl.pts[0].x, wl.pts[0].y, z, 0.0f);
    gw.travel(wl.pts[0].x, wl.pts[0].y, fTravel);
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
  double total=0; for (size_t i=1;i<pts.size();++i) total+=std::hypot(pts[i].x-pts[i-1].x, pts[i].y-pts[i-1].y);
  double acc=0;
  for (size_t i=1;i<pts.size();++i){
    acc += std::hypot(pts[i].x-pts[i-1].x, pts[i].y-pts[i-1].y);
    double zz = z0 + h*(total>1e-9 ? acc/total : 0.0);
    gw.extrude_z(pts[i].x, pts[i].y, zz, fPrint);
    push_seg(tp, pts[i-1].x,pts[i-1].y, pts[i].x,pts[i].y, zz, 1.0f);
  }
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
  double slen = std::min(gw.scarf_len, 0.45*L); if (slen < 1e-3) slen = 0.45*L;
  push_seg(tp, gw.px, gw.py, pts[0].x, pts[0].y, z, 0.0f);
  gw.travel(pts[0].x, pts[0].y, fTravel);
  gw.raw("; scarf");
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
