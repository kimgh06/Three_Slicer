// clip_util.h — extracted verbatim from slicer_core.cpp (pure code move; no behavior change).
//  The static helpers became `inline` so they can be shared by geom_helpers.cpp as well.
#pragma once
#include "clipper.hpp"

#include <algorithm>
#include <cmath>

using namespace ClipperLib;

static const double SCALE  = 1e6;          // mm -> clipper integer coordinates
static const double INV    = 1.0 / SCALE;
static const double PI     = 3.14159265358979323846;
// Stage 33: BED_CENTER (=128.0, assuming a 256mm bed) removed — it was declared and never referenced (measured).
//  The bed center is Params::bed_center_x/y (the printable area's corner plus half its size) -> gw.offX/offY.
// TRAVEL_RETRACT_MIN was removed too — wired to p.retraction_minimum_travel instead.

// ---- Clipper helpers -----------------------------------------------------------
inline Paths offset_paths(const Paths& in, double delta_mm, JoinType jt=jtMiter) {
  Paths out; if (in.empty()) return out;
  ClipperOffset co; co.AddPaths(in, jt, etClosedPolygon); co.Execute(out, delta_mm*SCALE);
  return out;
}
inline Paths clip_paths(const Paths& a, const Paths& b, ClipType ct) {
  Paths out;
  if (a.empty()) return (ct==ctUnion) ? b : Paths{};
  Clipper c; c.AddPaths(a, ptSubject, true);
  if (!b.empty()) c.AddPaths(b, ptClip, true);
  else if (ct==ctIntersection) return {};   // ∩ with the empty set = empty
  c.Execute(ct, out, pftNonZero, pftNonZero);
  return out;
}
inline Paths union_paths(const Paths& a, const Paths& b) {
  if (a.empty()) return b; if (b.empty()) return a; return clip_paths(a,b,ctUnion);
}
// Generate parallel lines at a given angle, then clip them to a region (open paths)
inline void bbox_of(const Paths& ps, double& minx,double& miny,double& maxx,double& maxy){
  minx=miny=1e18; maxx=maxy=-1e18;
  for (const Path& p:ps) for (const IntPoint& pt:p){ double x=pt.x()*INV,y=pt.y()*INV;
    minx=std::min(minx,x);miny=std::min(miny,y);maxx=std::max(maxx,x);maxy=std::max(maxy,y);} }
inline Paths infill_lines(const Paths& region, double angleDeg, double spacing) {
  Paths lines; if (region.empty()||spacing<=1e-6) return lines;
  double minx,miny,maxx,maxy; bbox_of(region,minx,miny,maxx,maxy);
  double a=angleDeg*PI/180.0, dx=std::cos(a),dy=std::sin(a), nx=-std::sin(a),ny=std::cos(a);
  // Each line is laid through the point o*(nx,ny) — the foot of the perpendicular from the ORIGIN — and extends
  //  +-diag along the pattern direction. diag was the region's own size, which only covers the region while the
  //  region sits near the origin: move it far enough ALONG the direction and the segment stops short, so the
  //  clip below returns nothing and that part of the layer comes out with no infill at all. Measured on a 20mm
  //  cube: 828 sparse segments centred, 414 at x[30,50] y[20,40] — half the infill silently missing, no error.
  //  The reach therefore has to include how far the region is from the origin, not just how big it is. Extending
  //  the segment cannot change the result for a region that was already covered: the line is clipped to the
  //  region either way, so a longer line is a superset that clips to the same thing.
  double nmin=1e18,nmax=-1e18, along=0.0;
  double cx[4]={minx,maxx,minx,maxx}, cy[4]={miny,miny,maxy,maxy};
  for (int i=0;i<4;++i){ double pr=cx[i]*nx+cy[i]*ny; nmin=std::min(nmin,pr); nmax=std::max(nmax,pr);
    along=std::max(along, std::fabs(cx[i]*dx+cy[i]*dy)); }
  const double diag=std::hypot(maxx-minx,maxy-miny)+2.0+along;
  for (double o=nmin;o<=nmax;o+=spacing){
    double bx=o*nx,by=o*ny; Path ln;
    ln.push_back(IntPoint((cInt)std::llround((bx-dx*diag)*SCALE),(cInt)std::llround((by-dy*diag)*SCALE)));
    ln.push_back(IntPoint((cInt)std::llround((bx+dx*diag)*SCALE),(cInt)std::llround((by+dy*diag)*SCALE)));
    lines.push_back(std::move(ln));
  }
  return lines;
}
inline Paths clip_open(const Paths& lines, const Paths& region) {   // open paths ∩ region
  if (lines.empty()||region.empty()) return {};
  Clipper c; c.AddPaths(lines, ptSubject, false); c.AddPaths(region, ptClip, true);
  PolyTree pt; c.Execute(ctIntersection, pt, pftNonZero, pftNonZero);
  Paths out; OpenPathsFromPolyTree(pt, out); return out;
}
inline Paths infill_clipped(const Paths& region, double angleDeg, double spacing) {
  return clip_open(infill_lines(region, angleDeg, spacing), region);
}
