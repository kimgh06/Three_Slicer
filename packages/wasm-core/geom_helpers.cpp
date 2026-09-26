// geom_helpers.cpp — extracted verbatim from slicer_core.cpp (pure code move; no behavior change).
#include "geom_helpers.h"

#include "fill_bridge.h"      // stage 8: bridge to the real ported OrcaSlicer Fill patterns (gyroid TPMS, …)

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <string>
#include <utility>
#include <vector>

double paths_area(const Paths& ps){ double a=0; for (const Path& p:ps) a+=Area(p); return std::fabs(a); }
// morphological open: erode(-r) then dilate(+r) -> a "thick core" with parts thinner than 2r removed
Paths morph_open(const Paths& in, double r){
  if (in.empty()||r<=1e-6) return in;
  return offset_paths(offset_paths(in, -r), r);
}
// Split connected components recursively via PolyTree (each component = one outline plus its holes)
static void collect_component(PolyNode* n, std::vector<Paths>& out){
  Paths comp; comp.push_back(n->Contour);
  for (PolyNode* hole : n->Childs){
    comp.push_back(hole->Contour);                 // hole
    for (PolyNode* inner : hole->Childs) collect_component(inner, out);  // an island inside a hole = a new component
  }
  out.push_back(std::move(comp));
}
std::vector<Paths> split_components(const Paths& in){
  std::vector<Paths> out; if (in.empty()) return out;
  Clipper c; c.AddPaths(in, ptSubject, true);
  PolyTree tree; c.Execute(ctUnion, tree, pftNonZero, pftNonZero);
  for (PolyNode* n : tree.Childs) collect_component(n, out);
  return out;
}
// One layer of tree-lite shrink: components narrower than 2·minR are kept (minimum pillar), otherwise shrunk by -shrink and merged.
// Stage 33: approximation of the upstream SupportGridPattern (SupportMaterial.cpp:637~) — snaps the support region to a grid.
//  Upstream rasterizes the polygons at extrusion-width resolution and seed-fills macro blocks of support_spacing size, so that
//  any support island touching a block is committed at block granularity (rasterize_polygons + seed_fill_block).
//  Effect: (1) pillars align to a fixed grid and (2) **fragments too thin to fill are inflated to at least one cell and become printable**.
//  Without (2), support for thin-walled shapes (e.g. a real Benchy chimney, a ring cross-section) is detected but receives not a single
//  infill line and effectively disappears (measured: it only appeared once support_expansion was applied).
//  Here the equivalent is implemented with Clipper alone — if a cell overlaps the support region, the whole cell is taken.
//  Because the test is a cell-polygon intersection rather than raster/seed fill, the oversampling details are approximate.
Paths grid_snap(const Paths& region, double cell) {
  if (region.empty() || cell <= 1e-6) return region;
  double minx,miny,maxx,maxy; bbox_of(region, minx,miny,maxx,maxy);
  const long i0=(long)std::floor(minx/cell), i1=(long)std::ceil(maxx/cell);
  const long j0=(long)std::floor(miny/cell), j1=(long)std::ceil(maxy/cell);
  if ((i1-i0+1) > 2000 || (j1-j0+1) > 2000 || (i1-i0+1)*(j1-j0+1) > 200000) return region;  // guard: return the input when the grid would be too large
  Paths cells;
  for (long i=i0;i<=i1;++i) for (long j=j0;j<=j1;++j) {
    const double x0=i*cell, y0=j*cell, x1=x0+cell, y1=y0+cell;
    Path c;
    c.push_back(IntPoint((cInt)std::llround(x0*SCALE),(cInt)std::llround(y0*SCALE)));
    c.push_back(IntPoint((cInt)std::llround(x1*SCALE),(cInt)std::llround(y0*SCALE)));
    c.push_back(IntPoint((cInt)std::llround(x1*SCALE),(cInt)std::llround(y1*SCALE)));
    c.push_back(IntPoint((cInt)std::llround(x0*SCALE),(cInt)std::llround(y1*SCALE)));
    if (clip_paths(Paths{c}, region, ctIntersection).empty()) continue;   // does support touch this cell
    cells.push_back(std::move(c));
  }
  if (cells.empty()) return region;
  return SimplifyPolygons(cells, pftNonZero);   // merge adjacent cells
}

Paths tree_taper(const Paths& in, double shrink, double minR){
  if (in.empty()) return in;
  Paths out;
  for (const Paths& comp : split_components(in)){
    Paths minTest = offset_paths(comp, -minR);
    if (minTest.empty()) { for (const Path& pp:comp) out.push_back(pp); continue; }  // minimum pillar: not shrunk
    Paths s = offset_paths(comp, -shrink);
    if (s.empty()) { for (const Path& pp:comp) out.push_back(pp); }
    else           { for (const Path& pp:s) out.push_back(pp); }
  }
  return clip_paths(out, Paths{}, ctUnion);   // union overlapping pillars
}
// gyroid approximation: a sine wave line per spacing, with the phase rotated by z (3D variation per layer)
static Paths gyroid_lines(const Paths& region, double spacing, double z) {
  Paths lines; if (region.empty()||spacing<=1e-6) return lines;
  double minx,miny,maxx,maxy; bbox_of(region,minx,miny,maxx,maxy);
  double A=spacing*0.55, lambda=spacing*2.0, phase=z*(2*PI/lambda), step=lambda/12.0;
  for (double base=miny-A; base<=maxy+A+spacing; base+=spacing) {
    Path ln;
    for (double x=minx-1.0; x<=maxx+1.0; x+=step)
      ln.push_back(IntPoint((cInt)std::llround(x*SCALE),(cInt)std::llround((base+A*std::sin(2*PI*x/lambda+phase))*SCALE)));
    if (ln.size()>=2) lines.push_back(std::move(ln));
  }
  return lines;
}
// Zigzag: connect sorted parallel lines at the boundary (back and forth) -> a single continuous path, fewer travels
static Paths zigzag_connect(Paths lines, double angleDeg) {
  if (lines.size()<2) return lines;
  sort_monotonic(lines, angleDeg);
  Path chain;
  for (size_t i=0;i<lines.size();++i) {
    if (lines[i].size()<2) continue;
    Path ln = lines[i];
    if (i & 1) std::reverse(ln.begin(), ln.end());
    for (auto& q:ln) chain.push_back(q);
  }
  Paths out; if (chain.size()>=2) out.push_back(std::move(chain));
  return out;
}
// Stage 8: call the real ported OrcaSlicer Fill patterns (per component ExPolygon -> fill_bridge -> open paths).
//  region = ClipperLib Paths (scaled by SCALE). density = fraction, lineW = line width (mm), angleDeg, z (mm).
static Paths real_fill(const Paths& region, const std::string& pat, double density, double lineW, double angleDeg, double z, int layerIdx) {
  Paths out;
  for (const Paths& comp : split_components(region)) {   // comp[0] = outline, [1..] = holes
    std::vector<std::vector<std::pair<double,double>>> polys;
    for (const Path& p : comp) {
      std::vector<std::pair<double,double>> poly; poly.reserve(p.size());
      for (const IntPoint& q : p) poly.push_back({ q.x()*INV, q.y()*INV });
      if (poly.size() >= 3) polys.push_back(std::move(poly));
    }
    if (polys.empty() || polys[0].size() < 3) continue;
    auto lines = fill_bridge::generate_fill(polys, pat, density, lineW, angleDeg, z, layerIdx);
    for (const auto& pl : lines) {
      Path path; path.reserve(pl.size());
      for (const auto& xy : pl) path.push_back(IntPoint((cInt)std::llround(xy.first*SCALE),(cInt)std::llround(xy.second*SCALE)));
      if (path.size() >= 2) out.push_back(std::move(path));
    }
  }
  return out;
}
// Sparse pattern dispatch (returns open paths). lineW = line width, density = fraction (for the real ported Fill patterns).
Paths build_sparse(const Paths& region, const std::string& pat, double base, double spacing, int layerIdx, double z, double lineW, double density) {
  if (region.empty()||spacing<=1e-6) return {};
  if (pat=="grid") {
    Paths l = infill_lines(region, base, spacing*2.0);
    for (auto& q:infill_lines(region, base+90.0, spacing*2.0)) l.push_back(q);
    return clip_open(l, region);
  }
  if (pat=="triangles") {
    Paths l = infill_lines(region, base, spacing*3.0);
    for (auto& q:infill_lines(region, base+60.0,  spacing*3.0)) l.push_back(q);
    for (auto& q:infill_lines(region, base+120.0, spacing*3.0)) l.push_back(q);
    return clip_open(l, region);
  }
  // Stage 8: the real ported Fill patterns (gyroid is replaced by the real TPMS; the old sine approximation is preserved as gyroid_approx)
  if (pat=="gyroid"||pat=="honeycomb"||pat=="3dhoneycomb"||pat=="crosshatch"||pat=="concentric") {
    Paths rf = real_fill(region, pat, density, lineW, base, z, layerIdx);
    if (!rf.empty()) return rf;   // on failure, fall through to rectilinear below
  }
  if (pat=="gyroid_approx") return clip_open(gyroid_lines(region, spacing, z), region);  // backwards compatible: the old sine approximation
  double a = base + (layerIdx%2 ? 90.0 : 0.0);         // alternate per layer
  if (pat=="zigzag")  return zigzag_connect(infill_clipped(region, a, spacing), a);
  return infill_clipped(region, a, spacing);           // rectilinear (default)
}
// Path length (for estimating layer time)
static double path_len(const Path& p, bool closed) {
  double L=0; for (size_t i=1;i<p.size();++i) L+=std::hypot((p[i].x()-p[i-1].x())*INV,(p[i].y()-p[i-1].y())*INV);
  if (closed && p.size()>=2) L+=std::hypot((p[0].x()-p.back().x())*INV,(p[0].y()-p.back().y())*INV);
  return L;
}
double paths_len(const Paths& ps, bool closed){ double L=0; for (auto& p:ps) L+=path_len(p,closed); return L; }
double vwalls_len(const std::vector<Paths>& ws){ double L=0; for (auto& w:ws) L+=paths_len(w,true); return L; }
// Cooling fan ramp: [0,close)=0, [full,∞)=target, linear in between
int fan_S(int i, const Params& p) {
  double target = 255.0 * (p.fan_speed/100.0);
  int close = std::max(0,p.close_fan_the_first_x_layers), full = std::max(close+1,p.full_fan_speed_layer);
  if (i < close) return 0;
  if (i >= full) return (int)std::llround(target);
  return (int)std::llround(target * (double)(i-close+1)/(double)(full-close+1));
}
// Monotonic emission: sort infill lines by their projection onto the fill normal axis (so top solid advances in one direction)
void sort_monotonic(Paths& lines, double angleDeg) {
  double a = angleDeg*PI/180.0, nx=-std::sin(a), ny=std::cos(a);
  std::stable_sort(lines.begin(), lines.end(), [&](const Path& A, const Path& B){
    if (A.empty()||B.empty()) return false;
    double pa=(A[0].x()*INV)*nx+(A[0].y()*INV)*ny, pb=(B[0].x()*INV)*nx+(B[0].y()*INV)*ny;
    return pa < pb;
  });
}
static uint32_t lcg(uint32_t& s){ s = s*1664525u + 1013904223u; return s; }
// Seam modes: 0=back (max Y) 1=nearest (closest to the nozzle) 2=aligned (previous seam) 3=random, -1=no rotation
void rotate_seam(Path& p, int mode, SeamCtx& sc, double nozX, double nozY) {
  if (mode < 0 || p.size() < 3) return;
  size_t best = 0;
  if (mode == 0 || (mode == 2 && !sc.has)) {          // back / the first layer of aligned
    cInt by=p[0].y(); for (size_t i=1;i<p.size();++i) if (p[i].y()>by){ by=p[i].y(); best=i; }
  } else if (mode == 1 || mode == 2) {                 // nearest nozzle / aligned to the previous seam
    double tx = (mode==1)?nozX:sc.lastX, ty=(mode==1)?nozY:sc.lastY, bd=1e30;
    for (size_t i=0;i<p.size();++i){ double dd=std::hypot(p[i].x()*INV-tx, p[i].y()*INV-ty); if (dd<bd){bd=dd;best=i;} }
  } else {                                             // random (deterministic)
    best = lcg(sc.rng) % p.size();
  }
  std::rotate(p.begin(), p.begin()+best, p.end());
}
