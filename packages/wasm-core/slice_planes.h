// slice_planes.h — extracted from slicer_core.cpp; the static helpers became `inline`. Segments are oriented
//  (intersect_triangle_with_plane) so the loops can be filled NonZero, as upstream's Regular slicing mode does.
#pragma once
#include "clip_util.h"
#include "stl_parse.h"

#include <algorithm>
#include <cmath>
#include <unordered_map>
#include <vector>

// Two segment ends closer than this (mm) are the same chain vertex — the quantum of the endpoint hash key.
static constexpr double CHAIN_KEY_QUANTUM_MM = 1e-3;
// The low 32 bits of a hash key hold the quantised y, the high bits the quantised x.
static constexpr long long CHAIN_KEY_Y_MASK = 0xffffffffLL;

// ---- Triangle-plane intersection -> segments ------------------------------------
struct SliceSegment { double x0, y0, x1, y1; };
// The object's layers, upstream's generate_object_layers for a fixed layer height (Slicing.cpp:807): a layer exists
//  while its middle is below the object's top, and it is cut at that middle (Layer::slice_z). The kernel used to cut
//  at each layer's top and keep only tops below the object's height, so the top face's plane cut nothing and the
//  last layer was lost: a 20 mm cube printed 99 layers, 19.8 mm (measured against OrcaSlicer 2.4.2: 100 layers).
//  `top` keeps the old accumulation (z += layer_height), so the print z of every layer is the one it always had.
struct LayerPlan { std::vector<double> top, plane; };
inline LayerPlan plan_layers(double first_layer_height, double layer_height, double height) {
  LayerPlan plan;
  double currentLayerHeight = first_layer_height;
  for (double z = first_layer_height; z - 0.5 * currentLayerHeight < height - 1e-4; z += layer_height, currentLayerHeight = layer_height) {
    plan.top.push_back(z);
    plan.plane.push_back(z - 0.5 * currentLayerHeight);
  }
  return plan;
}

inline bool intersect_triangle_with_plane(const Triangle& triangle, double z, SliceSegment& out) {
  double crossingX[3];
  double crossingY[3];
  int crossingCount = 0;
  for (int edgeIndex = 0; edgeIndex < 3; ++edgeIndex) {
    const Vertex& edgeStart = triangle.vertices[edgeIndex];
    const Vertex& edgeEnd = triangle.vertices[(edgeIndex + 1) % 3];
    const bool edgeCrossesPlane = (edgeStart.z < z && edgeEnd.z >= z) || (edgeEnd.z < z && edgeStart.z >= z);
    if (edgeCrossesPlane) {
      const double crossingFraction = (z - edgeStart.z) / (edgeEnd.z - edgeStart.z);
      if (crossingCount < 2) {
        crossingX[crossingCount] = edgeStart.x + crossingFraction*(edgeEnd.x-edgeStart.x);
        crossingY[crossingCount] = edgeStart.y + crossingFraction*(edgeEnd.y-edgeStart.y);
      }
      ++crossingCount;
    }
  }
  if (crossingCount != 2) return false;
  // Oriented like upstream's IntersectionLine: the solid on the LEFT, so an outer loop runs CCW and a hole CW. The
  //  facet normal comes from the vertex winding (the STL's stored normal is not trusted, as upstream does not); the
  //  segment is flipped when that normal's XY part points to its left. Without this every segment's direction was
  //  whichever edge the loop above met first, so only an even-odd fill could make sense of the loops — and even-odd
  //  counts two coincident shells as "inside twice" = outside: two objects on the same spot sliced to nothing.
  const double firstEdgeX = triangle.vertices[1].x - triangle.vertices[0].x;
  const double firstEdgeY = triangle.vertices[1].y - triangle.vertices[0].y;
  const double firstEdgeZ = triangle.vertices[1].z - triangle.vertices[0].z;
  const double secondEdgeX = triangle.vertices[2].x - triangle.vertices[0].x;
  const double secondEdgeY = triangle.vertices[2].y - triangle.vertices[0].y;
  const double secondEdgeZ = triangle.vertices[2].z - triangle.vertices[0].z;
  // The XY part of the facet normal (firstEdge x secondEdge); its z part plays no role in a horizontal cut.
  const double normalX = firstEdgeY * secondEdgeZ - firstEdgeZ * secondEdgeY;
  const double normalY = firstEdgeZ * secondEdgeX - firstEdgeX * secondEdgeZ;
  const double segmentDirectionX = crossingX[1] - crossingX[0];
  const double segmentDirectionY = crossingY[1] - crossingY[0];
  // The right-hand perpendicular of the travel direction is (dirY, -dirX); its dot with the normal is positive when
  //  the normal points right of travel, i.e. the solid is on the left.
  const double normalAlongRightHand = segmentDirectionY * normalX - segmentDirectionX * normalY;
  const bool solidOnRight = normalAlongRightHand < 0;
  if (solidOnRight) out = { crossingX[1],crossingY[1],crossingX[0],crossingY[0] };
  else out = { crossingX[0],crossingY[0],crossingX[1],crossingY[1] };
  return true;
}
inline long long qkey(double x, double y) {
  const long long quantisedX = (long long)std::llround(x/CHAIN_KEY_QUANTUM_MM);
  const long long quantisedY = (long long)std::llround(y/CHAIN_KEY_QUANTUM_MM);
  return (quantisedX << 32) ^ (quantisedY & CHAIN_KEY_Y_MASK);
}
// Segments arrive oriented (intersect_triangle_with_plane), and a loop keeps the direction of its first segment: at each point the
//  continuation that STARTS there is preferred, so where two shells touch or coincide (four segments meeting) the
//  walk does not turn back along an incoming one. A loop assembled mostly against its segments' own direction — a
//  shell with flipped facets — is reversed, so it still winds the way its majority of facets says. With a
//  consistently oriented manifold mesh there is exactly one unused continuation and it always starts at the point,
//  so the chain visits what it did before; only the direction of a loop can differ.
inline Paths chain_polygons(std::vector<SliceSegment>& segments) {
  const int segmentCount = (int)segments.size();
  std::vector<char> used(segmentCount,0);
  // Endpoint key -> references to the segment ends there, encoded as segment*2 + end (0 = its start, 1 = its end).
  std::unordered_map<long long,std::vector<int>> endsAtPoint;
  endsAtPoint.reserve(segmentCount*2);
  for (int segmentIndex=0;segmentIndex<segmentCount;++segmentIndex){
    endsAtPoint[qkey(segments[segmentIndex].x0,segments[segmentIndex].y0)].push_back(segmentIndex*2);
    endsAtPoint[qkey(segments[segmentIndex].x1,segments[segmentIndex].y1)].push_back(segmentIndex*2+1);
  }
  const auto toClipperPoint = [](double x, double y) { return IntPoint((cInt)std::llround(x*SCALE),(cInt)std::llround(y*SCALE)); };
  Paths out;
  for (int firstSegment=0;firstSegment<segmentCount;++firstSegment){
    if (used[firstSegment]) continue;
    used[firstSegment]=1;
    const double loopStartX=segments[firstSegment].x0;
    const double loopStartY=segments[firstSegment].y0;
    double currentX=segments[firstSegment].x1;
    double currentY=segments[firstSegment].y1;
    Path polygon;
    polygon.push_back(toClipperPoint(loopStartX, loopStartY));
    polygon.push_back(toClipperPoint(currentX, currentY));
    int segmentsWalkedForward=1;
    int segmentsWalkedBackward=0;
    for (int step=0;step<segmentCount;++step){
      if (qkey(currentX,currentY)==qkey(loopStartX,loopStartY)) break;
      const auto endsHere=endsAtPoint.find(qkey(currentX,currentY));
      int nextSegment=-1;
      int nextEnd=-1;
      if (endsHere!=endsAtPoint.end()) for (const int reference:endsHere->second){
        const int candidateSegment=reference/2;
        const int candidateEnd=reference%2;
        if (used[candidateSegment]) continue;
        const bool candidateStartsHere = candidateEnd==0;
        if (nextSegment<0 || (nextEnd!=0 && candidateStartsHere)) {
          nextSegment=candidateSegment;
          nextEnd=candidateEnd;
        }
        if (nextEnd==0) break;
      }
      if (nextSegment<0) break;
      used[nextSegment]=1;
      if (nextEnd==0){
        currentX=segments[nextSegment].x1;
        currentY=segments[nextSegment].y1;
        ++segmentsWalkedForward;
      } else {
        currentX=segments[nextSegment].x0;
        currentY=segments[nextSegment].y0;
        ++segmentsWalkedBackward;
      }
      polygon.push_back(toClipperPoint(currentX, currentY));
    }
    if (segmentsWalkedBackward > segmentsWalkedForward) std::reverse(polygon.begin(), polygon.end());
    if (polygon.size()>=3) out.push_back(std::move(polygon));
  }
  return out;
}
