// geom_helpers.cpp — extracted verbatim from slicer_core.cpp (pure code move; no behavior change).
#include "geom_helpers.h"

#include "fill_bridge.h"      // stage 8: bridge to the real ported OrcaSlicer Fill patterns (gyroid TPMS, …)

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <string>
#include <utility>
#include <vector>

double paths_area(const Paths& paths){
  double area=0;
  for (const Path& path:paths) area+=Area(path);
  return std::fabs(area);
}
// morphological open: erode(-r) then dilate(+r) -> a "thick core" with parts thinner than 2r removed
Paths morph_open(const Paths& in, double radius){
  if (in.empty()||radius<=1e-6) return in;
  return offset_paths(offset_paths(in, -radius), radius);
}
// Split connected components recursively via PolyTree (each component = one outline plus its holes)
static void collect_component(PolyNode* node, std::vector<Paths>& out){
  Paths component;
  component.push_back(node->Contour);
  for (PolyNode* hole : node->Childs){
    component.push_back(hole->Contour);                 // hole
    for (PolyNode* inner : hole->Childs) collect_component(inner, out);  // an island inside a hole = a new component
  }
  out.push_back(std::move(component));
}
std::vector<Paths> split_components(const Paths& in){
  std::vector<Paths> out;
  if (in.empty()) return out;
  Clipper clipper;
  clipper.AddPaths(in, ptSubject, true);
  PolyTree tree;
  clipper.Execute(ctUnion, tree, pftNonZero, pftNonZero);
  for (PolyNode* node : tree.Childs) collect_component(node, out);
  return out;
}
// One layer of tree-lite shrink: components narrower than 2·minRadius are kept (minimum pillar), otherwise shrunk by -shrink and merged.
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
  double minx,miny,maxx,maxy;
  bounding_box_of(region, minx,miny,maxx,maxy);
  const long firstColumn=(long)std::floor(minx/cell);
  const long lastColumn=(long)std::ceil(maxx/cell);
  const long firstRow=(long)std::floor(miny/cell);
  const long lastRow=(long)std::ceil(maxy/cell);
  if ((lastColumn-firstColumn+1) > 2000 || (lastRow-firstRow+1) > 2000 || (lastColumn-firstColumn+1)*(lastRow-firstRow+1) > 200000) return region;  // guard: return the input when the grid would be too large
  Paths cells;
  for (long i=firstColumn;i<=lastColumn;++i) for (long j=firstRow;j<=lastRow;++j) {
    const double x0=i*cell;
    const double y0=j*cell;
    const double x1=x0+cell;
    const double y1=y0+cell;
    Path cellPath;
    cellPath.push_back(IntPoint((cInt)std::llround(x0*SCALE),(cInt)std::llround(y0*SCALE)));
    cellPath.push_back(IntPoint((cInt)std::llround(x1*SCALE),(cInt)std::llround(y0*SCALE)));
    cellPath.push_back(IntPoint((cInt)std::llround(x1*SCALE),(cInt)std::llround(y1*SCALE)));
    cellPath.push_back(IntPoint((cInt)std::llround(x0*SCALE),(cInt)std::llround(y1*SCALE)));
    if (clip_paths(Paths{cellPath}, region, ctIntersection).empty()) continue;   // does support touch this cell
    cells.push_back(std::move(cellPath));
  }
  if (cells.empty()) return region;
  return SimplifyPolygons(cells, pftNonZero);   // merge adjacent cells
}

Paths tree_taper(const Paths& in, double shrink, double minRadius){
  if (in.empty()) return in;
  Paths out;
  for (const Paths& component : split_components(in)){
    Paths minTest = offset_paths(component, -minRadius);
    if (minTest.empty()) {   // minimum pillar: not shrunk
      for (const Path& path:component) out.push_back(path);
      continue;
    }
    Paths shrunk = offset_paths(component, -shrink);
    if (shrunk.empty()) {
      for (const Path& path:component) out.push_back(path);
    } else {
      for (const Path& path:shrunk) out.push_back(path);
    }
  }
  return clip_paths(out, Paths{}, ctUnion);   // union overlapping pillars
}
// gyroid approximation: a sine wave line per spacing, with the phase rotated by z (3D variation per layer)
static Paths gyroid_lines(const Paths& region, double spacing, double z) {
  Paths lines;
  if (region.empty()||spacing<=1e-6) return lines;
  double minx,miny,maxx,maxy;
  bounding_box_of(region,minx,miny,maxx,maxy);
  double amplitude=spacing*0.55;
  double lambda=spacing*2.0;
  double phase=z*(2*PI/lambda);
  double step=lambda/12.0;
  for (double base=miny-amplitude; base<=maxy+amplitude+spacing; base+=spacing) {
    Path line;
    for (double x=minx-1.0; x<=maxx+1.0; x+=step)
      line.push_back(IntPoint((cInt)std::llround(x*SCALE),(cInt)std::llround((base+amplitude*std::sin(2*PI*x/lambda+phase))*SCALE)));
    if (line.size()>=2) lines.push_back(std::move(line));
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
    Path line = lines[i];
    if (i & 1) std::reverse(line.begin(), line.end());
    for (auto& point:line) chain.push_back(point);
  }
  Paths out;
  if (chain.size()>=2) out.push_back(std::move(chain));
  return out;
}
// Stage 8: call the real ported OrcaSlicer Fill patterns (per component ExPolygon -> fill_bridge -> open paths).
//  region = ClipperLib Paths (scaled by SCALE). density = fraction, lineWidth (mm), angleDeg, z (mm).
static Paths real_fill(const Paths& region, const std::string& pattern, double density, double lineWidth, double angleDeg, double z, int layerIndex) {
  Paths out;
  for (const Paths& component : split_components(region)) {   // component[0] = outline, [1..] = holes
    std::vector<std::vector<std::pair<double,double>>> polygons;
    for (const Path& ring : component) {
      std::vector<std::pair<double,double>> polygon;
      polygon.reserve(ring.size());
      for (const IntPoint& point : ring) polygon.push_back({ point.x()*INV, point.y()*INV });
      if (polygon.size() >= 3) polygons.push_back(std::move(polygon));
    }
    if (polygons.empty() || polygons[0].size() < 3) continue;
    auto lines = fill_bridge::generate_fill(polygons, pattern, density, lineWidth, angleDeg, z, layerIndex);
    for (const auto& polyline : lines) {
      Path path;
      path.reserve(polyline.size());
      for (const auto& point : polyline) path.push_back(IntPoint((cInt)std::llround(point.first*SCALE),(cInt)std::llround(point.second*SCALE)));
      if (path.size() >= 2) out.push_back(std::move(path));
    }
  }
  return out;
}
// Sparse pattern dispatch (returns open paths). density = fraction (for the real ported Fill patterns).
Paths build_sparse(const Paths& region, const std::string& pattern, double base, double spacing, int layerIndex, double z, double lineWidth, double density) {
  if (region.empty()||spacing<=1e-6) return {};
  if (pattern=="grid") {
    Paths lines = infill_lines(region, base, spacing*2.0);
    for (auto& line:infill_lines(region, base+90.0, spacing*2.0)) lines.push_back(line);
    return clip_open(lines, region);
  }
  if (pattern=="triangles") {
    Paths lines = infill_lines(region, base, spacing*3.0);
    for (auto& line:infill_lines(region, base+60.0,  spacing*3.0)) lines.push_back(line);
    for (auto& line:infill_lines(region, base+120.0, spacing*3.0)) lines.push_back(line);
    return clip_open(lines, region);
  }
  // Stage 8: the real ported Fill patterns (gyroid is replaced by the real TPMS; the old sine approximation is preserved as gyroid_approx)
  if (pattern=="gyroid"||pattern=="honeycomb"||pattern=="3dhoneycomb"||pattern=="crosshatch"||pattern=="concentric") {
    Paths realLines = real_fill(region, pattern, density, lineWidth, base, z, layerIndex);
    if (!realLines.empty()) return realLines;   // on failure, fall through to rectilinear below
  }
  if (pattern=="gyroid_approx") return clip_open(gyroid_lines(region, spacing, z), region);  // backwards compatible: the old sine approximation
  double alternateOffset = 0.0;
  if (layerIndex%2) alternateOffset = 90.0;
  double angle = base + alternateOffset;         // alternate per layer
  if (pattern=="zigzag")  return zigzag_connect(infill_clipped(region, angle, spacing), angle);
  return infill_clipped(region, angle, spacing);           // rectilinear (default)
}
// Path length (for estimating layer time)
static double path_length(const Path& path, bool closed) {
  double length=0;
  for (size_t i=1;i<path.size();++i) length+=std::hypot((path[i].x()-path[i-1].x())*INV,(path[i].y()-path[i-1].y())*INV);
  if (closed && path.size()>=2) length+=std::hypot((path[0].x()-path.back().x())*INV,(path[0].y()-path.back().y())*INV);
  return length;
}
double paths_length(const Paths& paths, bool closed){
  double length=0;
  for (auto& path:paths) length+=path_length(path,closed);
  return length;
}
double walls_length(const std::vector<Paths>& walls){
  double length=0;
  for (auto& wall:walls) length+=paths_length(wall,true);
  return length;
}
// Cooling fan ramp: [0,close)=0, [full,∞)=target, linear in between
int fan_S(int layerIndex, const Params& params) {
  double target = 255.0 * (params.fan_speed/100.0);
  int closeLayers = std::max(0,params.close_fan_the_first_x_layers);
  int fullLayer = std::max(closeLayers+1,params.full_fan_speed_layer);
  if (layerIndex < closeLayers) return 0;
  if (layerIndex >= fullLayer) return (int)std::llround(target);
  return (int)std::llround(target * (double)(layerIndex-closeLayers+1)/(double)(fullLayer-closeLayers+1));
}
// Monotonic emission: sort infill lines by their projection onto the fill normal axis (so top solid advances in one direction)
void sort_monotonic(Paths& lines, double angleDeg) {
  double angleRad = angleDeg*PI/180.0;
  double normalX=-std::sin(angleRad);
  double normalY=std::cos(angleRad);
  std::stable_sort(lines.begin(), lines.end(), [&](const Path& first, const Path& second){
    if (first.empty()||second.empty()) return false;
    double firstProjection=(first[0].x()*INV)*normalX+(first[0].y()*INV)*normalY;
    double secondProjection=(second[0].x()*INV)*normalX+(second[0].y()*INV)*normalY;
    return firstProjection < secondProjection;
  });
}
static uint32_t lcg(uint32_t& state){
  state = state*1664525u + 1013904223u;
  return state;
}
// Seam modes: 0=back (max Y) 1=nearest (closest to the nozzle) 2=aligned (previous seam) 3=random, -1=no rotation
void rotate_seam(Path& path, int mode, SeamContext& seamContext, double nozzleX, double nozzleY) {
  if (mode < 0 || path.size() < 3) return;
  size_t best = 0;
  if (mode == 0 || (mode == 2 && !seamContext.hasLast)) {          // back / the first layer of aligned
    cInt bestY=path[0].y();
    for (size_t i=1;i<path.size();++i) {
      if (path[i].y()>bestY) {
        bestY=path[i].y();
        best=i;
      }
    }
  } else if (mode == 1 || mode == 2) {                 // nearest nozzle / aligned to the previous seam
    double targetX;
    double targetY;
    if (mode==1) {
      targetX=nozzleX;
      targetY=nozzleY;
    } else {
      targetX=seamContext.lastX;
      targetY=seamContext.lastY;
    }
    double bestDistance=1e30;
    for (size_t i=0;i<path.size();++i) {
      double distance=std::hypot(path[i].x()*INV-targetX, path[i].y()*INV-targetY);
      if (distance<bestDistance) {
        bestDistance=distance;
        best=i;
      }
    }
  } else {                                             // random (deterministic)
    best = lcg(seamContext.randomState) % path.size();
  }
  std::rotate(path.begin(), path.begin()+best, path.end());
}
