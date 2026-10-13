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
//  The bed center is Params::bed_center_x/y (the printable area's corner plus half its size) -> GW::offset_x/offset_y.
// TRAVEL_RETRACT_MIN was removed too — wired to p.retraction_minimum_travel instead.

// ---- Clipper helpers -----------------------------------------------------------
inline Paths offset_paths(const Paths& in, double delta_mm, JoinType joinType=jtMiter) {
  Paths out;
  if (in.empty()) return out;
  ClipperOffset clipperOffset;
  clipperOffset.AddPaths(in, joinType, etClosedPolygon);
  clipperOffset.Execute(out, delta_mm*SCALE);
  return out;
}
inline Paths clip_paths(const Paths& subject, const Paths& clipRegion, ClipType clipType) {
  Paths out;
  if (subject.empty()) {
    if (clipType==ctUnion) return clipRegion;
    return Paths{};
  }
  Clipper clipper;
  clipper.AddPaths(subject, ptSubject, true);
  if (!clipRegion.empty()) clipper.AddPaths(clipRegion, ptClip, true);
  else if (clipType==ctIntersection) return {};   // ∩ with the empty set = empty
  clipper.Execute(clipType, out, pftNonZero, pftNonZero);
  return out;
}
inline Paths union_paths(const Paths& first, const Paths& second) {
  if (first.empty()) return second;
  if (second.empty()) return first;
  return clip_paths(first,second,ctUnion);
}
// Generate parallel lines at a given angle, then clip them to a region (open paths)
inline void bbox_of(const Paths& paths, double& minx,double& miny,double& maxx,double& maxy){
  minx=miny=1e18;
  maxx=maxy=-1e18;
  for (const Path& path:paths) for (const IntPoint& point:path){
    double x=point.x()*INV;
    double y=point.y()*INV;
    minx=std::min(minx,x);
    miny=std::min(miny,y);
    maxx=std::max(maxx,x);
    maxy=std::max(maxy,y);
  }
}
inline Paths infill_lines(const Paths& region, double angleDeg, double spacing) {
  Paths lines;
  if (region.empty()||spacing<=1e-6) return lines;
  double minx,miny,maxx,maxy;
  bbox_of(region,minx,miny,maxx,maxy);
  double angleRad=angleDeg*PI/180.0;
  double directionX=std::cos(angleRad);
  double directionY=std::sin(angleRad);
  double normalX=-std::sin(angleRad);
  double normalY=std::cos(angleRad);
  // Each line is laid through the point normalOffset*(normalX,normalY) — the foot of the perpendicular from the ORIGIN — and extends
  //  +-halfLength along the pattern direction. halfLength was the region's own size, which only covers the region while the
  //  region sits near the origin: move it far enough ALONG the direction and the segment stops short, so the
  //  clip below returns nothing and that part of the layer comes out with no infill at all. Measured on a 20mm
  //  cube: 828 sparse segments centred, 414 at x[30,50] y[20,40] — half the infill silently missing, no error.
  //  The reach therefore has to include how far the region is from the origin, not just how big it is. Extending
  //  the segment cannot change the result for a region that was already covered: the line is clipped to the
  //  region either way, so a longer line is a superset that clips to the same thing.
  double normalMin=1e18;
  double normalMax=-1e18;
  double along=0.0;
  double cornerX[4]={minx,maxx,minx,maxx};
  double cornerY[4]={miny,miny,maxy,maxy};
  for (int i=0;i<4;++i){
    double projection=cornerX[i]*normalX+cornerY[i]*normalY;
    normalMin=std::min(normalMin,projection);
    normalMax=std::max(normalMax,projection);
    along=std::max(along, std::fabs(cornerX[i]*directionX+cornerY[i]*directionY));
  }
  const double halfLength=std::hypot(maxx-minx,maxy-miny)+2.0+along;
  for (double normalOffset=normalMin;normalOffset<=normalMax;normalOffset+=spacing){
    double baseX=normalOffset*normalX;
    double baseY=normalOffset*normalY;
    Path line;
    line.push_back(IntPoint((cInt)std::llround((baseX-directionX*halfLength)*SCALE),(cInt)std::llround((baseY-directionY*halfLength)*SCALE)));
    line.push_back(IntPoint((cInt)std::llround((baseX+directionX*halfLength)*SCALE),(cInt)std::llround((baseY+directionY*halfLength)*SCALE)));
    lines.push_back(std::move(line));
  }
  return lines;
}
inline Paths clip_open(const Paths& lines, const Paths& region) {   // open paths ∩ region
  if (lines.empty()||region.empty()) return {};
  Clipper clipper;
  clipper.AddPaths(lines, ptSubject, false);
  clipper.AddPaths(region, ptClip, true);
  PolyTree tree;
  clipper.Execute(ctIntersection, tree, pftNonZero, pftNonZero);
  Paths out;
  OpenPathsFromPolyTree(tree, out);
  return out;
}
inline Paths infill_clipped(const Paths& region, double angleDeg, double spacing) {
  return clip_open(infill_lines(region, angleDeg, spacing), region);
}
