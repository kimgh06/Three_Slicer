// gcode_writer.h — extracted verbatim from slicer_core.cpp (pure code move; no behavior change).
//  Header-only (like clip_util.h / slice_planes.h): GW's members are all defined inside the struct,
//  and the fixed-point formatters they call keep their original `static inline` linkage.
#pragma once
#include "arcfit_bridge.h"
#include "clip_util.h"
#include "geom_helpers.h"
#include "params.h"

#include <cmath>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

struct GWBedOverflow { double x = 0.0, y = 0.0, z = 0.0; bool any() const { return x > 0.0 || y > 0.0 || z > 0.0; } };

// ---- G-code writer (relative E, z_hop, parameterized retraction) ----------------
// (performance) Fixed-point formatter for the G-code hot path — ~5x faster than snprintf (fmt_bench2 measurements: 2 datasets x 2 runs, 0 mismatches out of 2M).
//  At a rounding boundary (|frac−0.5|<1e-6) it returns nullptr -> the caller falls back to snprintf, guaranteeing byte-identical output.
//  The sign comes from signbit(v) (including −0.0) — matching snprintf's "-0.000" output.
static const long long FMT_P10[] = {1,10,100,1000,10000,100000};
static inline char* fmt_fixed_safe(char* p, double v, int prec) {
  double av = std::fabs(v);
  double t  = av * FMT_P10[prec];
  double fr = t - std::floor(t);
  if (fr > 0.5 - 1e-6 && fr < 0.5 + 1e-6) return nullptr;   // rounding boundary -> snprintf fallback
  long long sc = (long long)llround(t);
  if (std::signbit(v)) *p++ = '-';
  long long ip = sc / FMT_P10[prec], fp = sc % FMT_P10[prec];
  char tmp[24]; int n = 0;
  do { tmp[n++] = (char)('0' + ip % 10); ip /= 10; } while (ip);
  while (n) *p++ = tmp[--n];
  *p++ = '.';
  for (int k = prec - 1; k >= 0; --k) { p[k] = (char)('0' + fp % 10); fp /= 10; }
  return p + prec;
}
static inline char* fmt_i(char* p, int v) {
  if (v < 0) { *p++ = '-'; v = -v; }
  char tmp[12]; int n = 0;
  do { tmp[n++] = (char)('0' + v % 10); v /= 10; } while (v);
  while (n) *p++ = tmp[--n];
  return p;
}

struct GW {
  bool dry=false;   // G003 E1 dry run: skips strings/toolpaths and only updates position, curF, fan and seam state (to chain the entry state)
  std::string s;
  double px=0, py=0, z=0;
  double e_per_mm=0, filament=0;
  long   segments=0;
  // Extent of everything actually EXTRUDED, in model coordinates (the G-code adds offX/offY on the way out).
  //  The model's own bbox cannot answer "does this print fit on the bed": support, skirt, brim and the raft are
  //  generated during slicing and reach past it. Upstream asks the same question of the finished G-code
  //  (BuildVolume::all_paths_inside over GCodeProcessorResult::moves), which is what makes it indifferent to
  //  WHICH feature produced a path. Travels are excluded there and here — only extrusions have to stay on the bed.
  double exMinX=1e18, exMaxX=-1e18, exMinY=1e18, exMaxY=-1e18, exMaxZ=-1e18;
  inline void note_xy(double x, double y) {
    if (x < exMinX) exMinX = x;   if (x > exMaxX) exMaxX = x;
    if (y < exMinY) exMinY = y;   if (y > exMaxY) exMaxY = y;
    if (z > exMaxZ) exMaxZ = z;   // the layer z this extrusion is being written at
  }
  bool extruded_anything() const { return exMaxX >= exMinX; }
  int    curF=-1;
  double retract_len=0.8; int retractF=1800; // mm, mm/min
  double retract_min_travel=2.0;             // stage 33: retraction_minimum_travel (formerly the TRAVEL_RETRACT_MIN constant)
  double z_hop=0.0;
  double offX=128.0, offY=128.0;   // G-code XY offset = bed/2
  int    lastFan=-1;               // current cooling fan value (M106 only on change)
  bool   arc_fitting=false;        // G2/G3 arc fitting
  double arc_resolution=0.01;     // the print's `resolution` (mm): the arc fitting tolerance outside sparse infill and support
  double scarf_len=10.0;           // length of the scarf seam ramp (mm)
  // Stage 6: PE-lite (limit on the volumetric flow change rate between adjacent extrusions)
  double pe_slope=0.0;             // mm³/s² (0=off)
  double filament_area=2.405;      // π·d²/4 (set in the preamble)
  // Multi-material: the flow math has to follow the tool currently loaded, not the single material Params names.
  //  Set next to filament_area at preamble time and re-set on every tool change; the defaults match the Params
  //  defaults so a caller that never touches them is unchanged.
  double tool_filament_diameter=1.75, tool_flow_ratio=1.0;
  // Currently loaded tool, so support_filament can print support with a different extruder. tool<0 means "keep the
  //  current one" (the upstream 0 = Default), and a T is written only on an actual change — with the defaults
  //  nothing is ever emitted and the single-material G-code is byte-identical to before.
  int    cur_tool=0;
  void set_tool(int tool){
    if (tool < 0 || tool == cur_tool) return;
    cur_tool = tool;
    char t[16]; std::snprintf(t, sizeof t, "T%d", tool); raw(t);
  }
  double last_vol_flow=-1.0;       // previous extrusion volumetric flow in mm³/s (reset at layer start, not reset by travels)
  // Stage 6: wall-avoiding travel
  Paths  island;                   // region travels should stay inside (inside the walls). Empty means no check.
  bool   avoid_walls=false;
  long   wall_crossings=0;         // number of travels that actually crossed a wall (for cross-checking)
  // Upstream's ;TYPE: role tag (Params::gcode_role_tags). `type` is the kernel's toolpath type, the value push_seg
  //  records into the stream (0=travel … 11=prime tower, emit.cpp), so the text and the stream name the same role.
  //  Stated again after every layer marker, because a reader keyed on layers (gcode_parse.js) resets its role there.
  //  Upstream's own names where one exists; upstream folds raft into Support and thin walls into walls, which would
  //  recolour both on a read-back here, so those two keep names of their own (upstream reads them as Undefined).
  bool   emit_role_tags=false;
  int    tag_type=-1;
  void role_tag(int type){
    if (!emit_role_tags || dry || type <= 0 || type == tag_type) return;
    static const char* const NAMES[] = { "", "Outer wall", "Sparse infill", "Internal solid infill", "Skirt", "Support",
      "Raft", "Gap infill", "Thin wall", "Bridge", "Ironing", "Prime tower" };
    if (type >= (int)(sizeof NAMES / sizeof NAMES[0])) return;
    tag_type = type;
    s += ";TYPE:"; s += NAMES[type]; s += '\n';
  }
  void role_tag_unknown(){ tag_type = -1; }
  void layer_begin(const char* marker){ raw(marker); tag_type = -1; }
  // Stage 9: emitting the real PE tags (OrcaSlicer format)
  bool   emit_pe_tags=false;
  int    pe_cur_role=-1;
  char   buf[200];
  void pe_reset(){ last_vol_flow=-1.0; }
  // Start an extrusion run: ;_EXTRUSION_ROLE on a role change, then G1 F<v> ;_EXTRUDE_SET_SPEED (opening the block)
  //  curF is set to f so later extrusion G1s omit F (inheriting the SET_SPEED speed) — PE adjusts the flow within the block.
  void pe_begin_run(int role, int f){
    if (!emit_pe_tags) return;
    if (role != pe_cur_role) { std::snprintf(buf,sizeof buf,";_EXTRUSION_ROLE:%d",role); raw(buf); pe_cur_role=role; }
    std::snprintf(buf,sizeof buf,"G1 F%d ;_EXTRUDE_SET_SPEED",f); raw(buf); curF=f;
  }
  void pe_end_run(){ if (emit_pe_tags) raw(";_EXTRUDE_END"); }
  // PE-lite: limits the volumetric flow change rate (mm³/s²) between adjacent extrusions. With segment time Δt=d/v_n and v_n=Fn/A,
  //  slope = |Fn−Fl|·Fn/(d·A) ≤ pe_slope, S=pe_slope·d·A.
  //  acceleration (Fn>Fl): the Fn ceiling = (Fl+√(Fl²+4S))/2.  deceleration (Fn<Fl): inside a steep drop band (lo,hi), clamp to hi (the minimum drop).
  //  An approximation that adjusts only the per-segment speed at emission time, without splitting segments.
  int pe_feed(double dist, int fReq){
    double A=e_per_mm*filament_area, vreq=fReq/60.0, desired=A*vreq;
    if (pe_slope<=0.0 || last_vol_flow<0.0 || dist<1e-6 || A<=1e-9) { last_vol_flow=desired; return fReq; }
    double Fl=last_vol_flow, Fn=desired, S=pe_slope*dist*A;
    if (desired > Fl) {                                     // acceleration (more flow)
      double cap=(Fl+std::sqrt(Fl*Fl+4.0*S))/2.0; if (Fn>cap) Fn=cap;
    } else if (desired < Fl) {                              // deceleration (less flow)
      double disc=Fl*Fl-4.0*S;
      if (disc>0) { double sq=std::sqrt(disc), hi=(Fl+sq)/2.0, lo=(Fl-sq)/2.0; if (Fn>lo && Fn<hi) Fn=hi; }
    }
    int fUse=(int)std::llround((Fn/A)*60.0); if (fUse<60) fUse=60;
    last_vol_flow=A*(fUse/60.0);
    return fUse;
  }
  void set_e_per_mm(double h, const Params& p) {
    double A = h * (p.line_width - h * (1.0 - PI/4.0));
    double fa = PI * tool_filament_diameter * tool_filament_diameter / 4.0;
    e_per_mm = A / fa * tool_flow_ratio;
  }
  // Stage 7: sets the flow for an arbitrary width (variable-width Arachne walls). Cross-section A = h·(w − h·(1−π/4)).
  void set_e_per_mm_width(double wseg, double h, const Params& p) {
    double A = h * (wseg - h * (1.0 - PI/4.0)); if (A < 0) A = 0;
    double fa = PI * tool_filament_diameter * tool_filament_diameter / 4.0;
    e_per_mm = A / fa * tool_flow_ratio;
  }
  // WP3: sets the upstream volumetric flow (mm³/mm, ExtrusionPath::mm3_per_mm) directly — lets tree support reproduce the flow
  //  computed by the upstream Flow verbatim (including cases where it differs from the rectangular width x height approximation, such as bridging contact layers).
  void set_e_per_mm_vol(double mm3, const Params& p) {
    if (mm3 < 0) mm3 = 0;
    double fa = PI * tool_filament_diameter * tool_filament_diameter / 4.0;
    e_per_mm = mm3 / fa * tool_flow_ratio;
  }
  void raw(const char* c){ if (dry) return; s += c; s += '\n'; }
  // Hot-path line emission — when the fast path (fixed point) fails, fall back to the original snprintf format (byte-identical).
  inline void line_xyf(const char* head, double a, double b, int f, const char* fbfmt) {
    char* q = buf; size_t hl = strlen(head); memcpy(q, head, hl); q += hl;
    char* r = fmt_fixed_safe(q, a, 3);
    if (r) { memcpy(r, " Y", 2); r = fmt_fixed_safe(r+2, b, 3); }
    if (r) { memcpy(r, " F", 2); r = fmt_i(r+2, f); *r = '\0'; raw(buf); return; }
    std::snprintf(buf, sizeof buf, fbfmt, a, b, f); raw(buf);
  }
  inline void line_vf(const char* head, double v, int prec, int f, const char* fbfmt) {
    char* q = buf; size_t hl = strlen(head); memcpy(q, head, hl); q += hl;
    char* r = fmt_fixed_safe(q, v, prec);
    if (r) { memcpy(r, " F", 2); r = fmt_i(r+2, f); *r = '\0'; raw(buf); return; }
    std::snprintf(buf, sizeof buf, fbfmt, v, f); raw(buf);
  }
  // Straight travel including retraction (upstream behavior)
  void travel_raw(double x, double y, int fTravel) {
    double d = std::hypot(x-px, y-py); if (d < 1e-6) return;
    bool retract = d > retract_min_travel && retract_len > 0;
    if (retract) {
      line_vf("G1 E-", retract_len, 4, retractF, "G1 E-%.4f F%d");
      if (z_hop > 0) line_vf("G1 Z", z + z_hop, 3, fTravel, "G1 Z%.3f F%d");
    }
    line_xyf("G0 X", x+offX, y+offY, fTravel, "G0 X%.3f Y%.3f F%d");
    if (retract) {
      if (z_hop > 0) line_vf("G1 Z", z, 3, fTravel, "G1 Z%.3f F%d");
      line_vf("G1 E", retract_len, 4, retractF, "G1 E%.4f F%d");
    }
    px=x; py=y; curF=-1;
  }
  // Detour move inside the material (no retraction — stays inside the material, the §6.5 desktop behavior)
  void travel_hop(double x, double y, int fTravel) {
    double d = std::hypot(x-px, y-py); if (d < 1e-6) return;
    line_xyf("G0 X", x+offX, y+offY, fTravel, "G0 X%.3f Y%.3f F%d");
    px=x; py=y; curF=-1;
  }
  // True when the straight line A->B lies (almost) entirely inside the island (inside the walls)
  bool seg_inside(double ax,double ay,double bx,double by){
    if (island.empty()) return true;
    Path seg; seg.push_back(IntPoint((cInt)std::llround(ax*SCALE),(cInt)std::llround(ay*SCALE)));
    seg.push_back(IntPoint((cInt)std::llround(bx*SCALE),(cInt)std::llround(by*SCALE)));
    Paths one; one.push_back(seg);
    double full=std::hypot(bx-ax,by-ay), got=paths_len(clip_open(one, island), false);
    return got >= full - 0.05;
  }
  // Detour along the island boundary: walk the boundary of the polygon nearest A from the vertex nearest A to the vertex nearest B (the shorter way)
  std::vector<DPt> detour_path(double ax,double ay,double bx,double by){
    const Path* best=nullptr; double bestD=1e30;
    IntPoint pa((cInt)std::llround(ax*SCALE),(cInt)std::llround(ay*SCALE));
    for (const Path& poly : island){
      if (poly.size()<3 || Area(poly)<=0) continue;                 // outlines only (positive area)
      if (PointInPolygon(pa, poly)!=0){ best=&poly; break; }
      for (const IntPoint& q:poly){ double dd=std::hypot(q.x()*INV-ax,q.y()*INV-ay); if(dd<bestD){bestD=dd;best=&poly;} }
    }
    if (!best) return {};
    const Path& poly=*best; int n=(int)poly.size();
    auto nearestIdx=[&](double x,double y){ int bi=0; double bd=1e30; for(int i=0;i<n;++i){double dd=std::hypot(poly[i].x()*INV-x,poly[i].y()*INV-y); if(dd<bd){bd=dd;bi=i;}} return bi; };
    int ia=nearestIdx(ax,ay), ib=nearestIdx(bx,by);
    if (ia==ib) return {};
    auto arcLen=[&](int dir){ double L=0; int i=ia; while(i!=ib){ int nx=(i+dir+n)%n; L+=std::hypot((poly[nx].x()-poly[i].x())*INV,(poly[nx].y()-poly[i].y())*INV); i=nx; } return L; };
    int dir = (arcLen(+1)<=arcLen(-1))?+1:-1;
    std::vector<DPt> way; way.push_back({poly[ia].x()*INV, poly[ia].y()*INV});
    int i=ia; while(i!=ib){ i=(i+dir+n)%n; way.push_back({poly[i].x()*INV, poly[i].y()*INV}); }
    return way;
  }
  // Smart travel: detect wall crossings -> detour along the boundary (when avoiding), otherwise a straight line and a crossing count
  // Fast guard (statistics only) — with avoid_walls=false the verdict only feeds the wall_crossings counter (no effect on G-code).
  //  Replaces Clipper clip_open (measured at ~20µs per travel, the single largest cost in the serial emission section) with an integer
  //  orientation intersection test plus an even-odd PIP on the midpoint. Only boundary cases (tangency, collinearity) may disagree with the clip verdict (counter error accepted).
  //  With avoid_walls=true the detour path (G-code) depends on the verdict -> the existing seg_inside (clip_open) is kept.
  bool seg_inside_fast(double ax,double ay,double bx,double by){
    const cInt x1=(cInt)std::llround(ax*SCALE), y1=(cInt)std::llround(ay*SCALE);
    const cInt x2=(cInt)std::llround(bx*SCALE), y2=(cInt)std::llround(by*SCALE);
    auto orient=[](cInt ox,cInt oy,cInt px_,cInt py_,cInt qx,cInt qy)->int{
      long long v=(long long)(px_-ox)*(long long)(qy-oy)-(long long)(py_-oy)*(long long)(qx-ox);
      return v>0?1:(v<0?-1:0); };
    for (const Path& poly : island){
      size_t n=poly.size(); if (n<3) continue;
      for (size_t i=0;i<n;++i){
        const IntPoint& c=poly[i]; const IntPoint& d=poly[(i+1)%n];
        int o1=orient(x1,y1,x2,y2,c.x(),c.y()), o2=orient(x1,y1,x2,y2,d.x(),d.y());
        if (o1*o2>=0) continue;
        int o3=orient(c.x(),c.y(),d.x(),d.y(),x1,y1), o4=orient(c.x(),c.y(),d.x(),d.y(),x2,y2);
        if (o3*o4<0) return false;               // proper intersection -> crosses the boundary
      }
    }
    IntPoint m((x1+x2)/2,(y1+y2)/2);             // no crossing -> decide by whether the midpoint is inside
    int cnt=0;
    for (const Path& poly : island){ int r=PointInPolygon(m,poly); if (r==-1) return true; if (r!=0) ++cnt; }
    return (cnt&1)==1;
  }
  void travel(double x, double y, int fTravel) {
    double d = std::hypot(x-px, y-py); if (d < 1e-6) return;
    if (dry) { px=x; py=y; curF=-1; return; }   // G003: a detour ends at the same point -> position only
    if (!island.empty() && !(avoid_walls ? seg_inside(px,py,x,y) : seg_inside_fast(px,py,x,y))) {
      if (avoid_walls) {
        std::vector<DPt> way = detour_path(px,py,x,y);
        if (!way.empty()) { for (auto& wp:way) travel_hop(wp.x,wp.y,fTravel); travel_hop(x,y,fTravel); return; }
      }
      ++wall_crossings;                          // no detour / detour failed -> a real crossing
    }
    travel_raw(x, y, fTravel);
  }
  void extrude(double x, double y, int fPrint) {
    double d = std::hypot(x-px, y-py); if (d < 1e-9) return;
    if (dry) { px=x; py=y; curF=fPrint; return; }   // G003 dry run (assumes pe off — guarded in parallel mode)
    int fUse = pe_feed(d, fPrint);               // PE-lite: apply the flow change rate limit (fPrint when off)
    double dE = e_per_mm * d; filament += dE; ++segments;
    note_xy(px, py); note_xy(x, y);   // both ends: an open path's first point follows a travel, so it is noted nowhere else
    char* r = buf; memcpy(r, "G1 X", 4); r += 4;
    r = fmt_fixed_safe(r, x+offX, 3);
    if (r) { memcpy(r, " Y", 2); r = fmt_fixed_safe(r+2, y+offY, 3); }
    if (r) { memcpy(r, " E", 2); r = fmt_fixed_safe(r+2, dE, 5); }
    if (r) {                                     // fast path succeeded — F only when it changes
      if (fUse != curF) { memcpy(r, " F", 2); r = fmt_i(r+2, fUse); }
      *r = '\0';
    } else if (fUse != curF) std::snprintf(buf,sizeof buf,"G1 X%.3f Y%.3f E%.5f F%d", x+offX,y+offY,dE,fUse);
    else                     std::snprintf(buf,sizeof buf,"G1 X%.3f Y%.3f E%.5f",     x+offX,y+offY,dE);
    curF = fUse;
    raw(buf); px=x; py=y;
  }
  // For spiral mode: extrusion that raises Z as it goes
  void extrude_z(double x, double y, double zz, int fPrint) {
    double d = std::hypot(x-px, y-py); if (d < 1e-9) { z=zz; return; }
    double dE = e_per_mm * d; filament += dE; ++segments;
    note_xy(px, py); note_xy(x, y);
    if (zz > exMaxZ) exMaxZ = zz;     // z ramps within the move here, so the member z is one layer behind
    if (fPrint != curF) { std::snprintf(buf,sizeof buf,"G1 X%.3f Y%.3f Z%.3f E%.5f F%d", x+offX,y+offY,zz,dE,fPrint); curF=fPrint; }
    else                { std::snprintf(buf,sizeof buf,"G1 X%.3f Y%.3f Z%.3f E%.5f",     x+offX,y+offY,zz,dE); }
    raw(buf); px=x; py=y; z=zz;
  }
  // For the scarf seam: extrusion applying both Z and flow (an E multiplier) (Z always written)
  void extrude_zf(double x, double y, double zz, double flowMul, int fPrint) {
    double d = std::hypot(x-px, y-py); if (d < 1e-9) { z=zz; return; }
    double dE = e_per_mm * d * flowMul; filament += dE; ++segments;
    note_xy(px, py); note_xy(x, y);
    if (zz > exMaxZ) exMaxZ = zz;     // z ramps within the move here, so the member z is one layer behind
    if (fPrint != curF) { std::snprintf(buf,sizeof buf,"G1 X%.3f Y%.3f Z%.3f E%.5f F%d", x+offX,y+offY,zz,dE,fPrint); curF=fPrint; }
    else                { std::snprintf(buf,sizeof buf,"G1 X%.3f Y%.3f Z%.3f E%.5f",     x+offX,y+offY,zz,dE); }
    raw(buf); px=x; py=y; z=zz;
  }
  // Cooling fan (M106 emitted only on change)
  void set_fan(int S) { if (S==lastFan) return; lastFan=S; if (dry) return; std::snprintf(buf,sizeof buf,"M106 S%d",S); raw(buf); }
  // Emit a continuous polyline (pts[0] = current position). G2/G3 with arc_fitting, otherwise G1.
  //  The arcs are upstream's ArcFitter (arcfit_bridge.cpp) at upstream's per-role tolerance (LayerRegion::simplify_path,
  //  Layer::simplify_support_path): SPARSE_INFILL_RESOLUTION for sparse infill, SUPPORT_RESOLUTION for support and raft,
  //  the print's `resolution` for everything else. `type` is the toolpath type the caller emits (emit.cpp).
  void extrude_run(const std::vector<DPt>& pts, int fPrint, float type) {
    if (dry) { if (pts.size()>1) { px=pts.back().x; py=pts.back().y; curF=fPrint; } return; }
    if (!arc_fitting) { for (size_t i=1;i<pts.size();++i) extrude(pts[i].x,pts[i].y,fPrint); return; }
    // An arc stands for the points it was fitted to, so they never reach extrude() and its note_xy. Noting every
    //  input point here keeps the extent honest: the arc stays within the fitting tolerance of them.
    for (const DPt& q : pts) note_xy(q.x, q.y);
    double tolerance = arc_resolution;
    if ((int)type == 2) tolerance = 0.04;                          // SPARSE_INFILL_RESOLUTION (libslic3r.h)
    if ((int)type == 5 || (int)type == 6) tolerance = 0.0375;      // SUPPORT_RESOLUTION
    std::vector<std::pair<double,double>> points; points.reserve(pts.size());
    for (const DPt& q : pts) points.emplace_back(q.x, q.y);
    std::vector<arcfit_bridge::Move> moves;
    arcfit_bridge::fit(points, tolerance, moves);
    for (const arcfit_bridge::Move& move : moves) {
      if (move.kind == arcfit_bridge::Linear) {
        for (size_t k=move.start+1; k<=move.end && k<pts.size(); ++k) extrude(pts[k].x, pts[k].y, fPrint);
        continue;
      }
      if (move.length < 1e-9) continue;                            // upstream GCode.cpp skips a zero-length arc
      extrude_arc(pts[move.end], move.centerX, move.centerY, move.length, move.kind == arcfit_bridge::ArcCounterClockwise, fPrint);
    }
  }
  // One G2/G3 from the current position to `end` around (centerX, centerY), E from upstream's arc length.
  void extrude_arc(DPt end, double centerX, double centerY, double length, bool counterClockwise, int fPrint) {
    double dE = e_per_mm*length; filament+=dE; ++segments;
    double I=centerX-px, J=centerY-py;
    const char* command = "G2";
    if (counterClockwise) command = "G3";
    if (fPrint!=curF){ std::snprintf(buf,sizeof buf,"%s X%.3f Y%.3f I%.3f J%.3f E%.5f F%d",command,end.x+offX,end.y+offY,I,J,dE,fPrint); curF=fPrint; }
    else            { std::snprintf(buf,sizeof buf,"%s X%.3f Y%.3f I%.3f J%.3f E%.5f",   command,end.x+offX,end.y+offY,I,J,dE); }
    raw(buf); px=end.x; py=end.y;
  }
};

// How far the EMITTED extrusions reach past the printable area, per axis in mm (0 on an axis that stays inside).
//  This is the check that sees support, skirt, brim, raft and the prime tower: all of them are produced during
//  slicing, so the model bbox prepare_model() measures cannot predict any of them. Upstream answers the same
//  question the same way, over the finished G-code rather than the model (BuildVolume::all_paths_inside).
//  Z is measured here too, for the same reason: a raft lifts every model layer, so the model's own height cannot
//  answer whether the print clears the ceiling. Upstream splits this into a second warning taken from the same
//  G-code (ToolHeightOutside — the top layer's z against max_print_height), and this is that check.
//  The tolerance is upstream's BedEpsilon (3 * EPSILON, libslic3r.h): it absorbs coordinate noise, not an overhang.
inline GWBedOverflow extrusion_bed_overflow(const GW& gw, const Params& p) {
  GWBedOverflow over;
  if (!gw.extruded_anything()) return over;          // nothing was printed -> nothing can be off the bed
  const double eps = 3e-4;
  const double halfW = p.bed_width * 0.5, halfD = p.bed_depth * 0.5;
  over.x = std::max(0.0, std::max(gw.exMaxX - halfW, -halfW - gw.exMinX) - eps);
  over.y = std::max(0.0, std::max(gw.exMaxY - halfD, -halfD - gw.exMinY) - eps);
  // bed_height 0 = the profile states no ceiling, so nothing is ever too tall (same rule as prepare_model).
  if (p.bed_height > 0.0) over.z = std::max(0.0, gw.exMaxZ - p.bed_height - eps);
  return over;
}
