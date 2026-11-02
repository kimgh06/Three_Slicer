#include "seam_paint.h"

#include "slice_planes.h"

#include <algorithm>
#include <cmath>

namespace {
// A loop this close to a painted mark takes its seam there. Inner walls sit a few line widths behind the painted
//  surface, and they should follow it.
constexpr double SEAM_REACH_MM = 2.0;
constexpr double BLOCKER_REACH_MM = 1.0;

std::vector<SeamMarks> g_marks;

void collect(const std::vector<double>& triangles, const std::vector<double>& planes, std::vector<SeamMarks>& layers,
             std::vector<SeamMark> SeamMarks::*slot) {
  for (size_t at = 0; at + 9 <= triangles.size(); at += 9) {
    Triangle triangle;
    double lowest = 1e30, highest = -1e30;
    for (int corner = 0; corner < 3; ++corner) {
      triangle.vertices[corner].x = (float)triangles[at + corner * 3];
      triangle.vertices[corner].y = (float)triangles[at + corner * 3 + 1];
      triangle.vertices[corner].z = (float)triangles[at + corner * 3 + 2];
      lowest = std::min(lowest, triangles[at + corner * 3 + 2]);
      highest = std::max(highest, triangles[at + corner * 3 + 2]);
    }
    auto plane = std::lower_bound(planes.begin(), planes.end(), lowest);
    for (; plane != planes.end() && *plane <= highest; ++plane) {
      SliceSegment segment;
      if (!intersect_triangle_with_plane(triangle, *plane, segment)) continue;
      auto& marks = layers[plane - planes.begin()].*slot;
      marks.push_back({ (segment.x0 + segment.x1) / 2, (segment.y0 + segment.y1) / 2 });
    }
  }
}
}  // namespace

void seam_marks_prepare(const Params& params, const std::vector<double>& planes) {
  g_marks.clear();
  if (params.seam_enforcers.empty() && params.seam_blockers.empty()) return;
  g_marks.resize(planes.size());
  collect(params.seam_enforcers, planes, g_marks, &SeamMarks::enforcers);
  collect(params.seam_blockers, planes, g_marks, &SeamMarks::blockers);
}

const SeamMarks* seam_marks_of(int layerIndex) {
  if (layerIndex < 0 || layerIndex >= (int)g_marks.size()) return nullptr;
  return &g_marks[layerIndex];
}

// Starts the loop at the point of it nearest any enforcer mark, adding that point when it falls along an edge: a flat
//  wall has no vertex where the paint is.
bool seam_on_enforcer(Path& path, const SeamMarks& marks) {
  double bestDistance = SEAM_REACH_MM;
  size_t bestEdge = path.size();
  double bestX = 0, bestY = 0;
  for (const SeamMark& mark : marks.enforcers) {
    for (size_t edge = 0; edge < path.size(); ++edge) {
      const double ax = path[edge].x() * INV, ay = path[edge].y() * INV;
      const IntPoint& next = path[(edge + 1) % path.size()];
      const double dx = next.x() * INV - ax, dy = next.y() * INV - ay;
      const double lengthSquared = dx * dx + dy * dy;
      if (lengthSquared == 0) continue;
      const double along = std::clamp(((mark.x - ax) * dx + (mark.y - ay) * dy) / lengthSquared, 0.0, 1.0);
      const double x = ax + along * dx, y = ay + along * dy;
      const double distance = std::hypot(x - mark.x, y - mark.y);
      if (distance < bestDistance) { bestDistance = distance; bestEdge = edge; bestX = x; bestY = y; }
    }
  }
  if (bestEdge == path.size()) return false;
  const IntPoint seam((cInt)std::llround(bestX * SCALE), (cInt)std::llround(bestY * SCALE));
  path.insert(path.begin() + bestEdge + 1, seam);
  std::rotate(path.begin(), path.begin() + bestEdge + 1, path.end());
  return true;
}

// The vertex nearest `best`, walking along the loop, that no blocker mark covers. A loop blocked everywhere keeps `best`.
size_t seam_off_blockers(const Path& path, size_t best, const SeamMarks& marks) {
  if (marks.blockers.empty()) return best;
  const auto blocked = [&](size_t vertex) {
    const double x = path[vertex].x() * INV, y = path[vertex].y() * INV;
    for (const SeamMark& mark : marks.blockers) if (std::hypot(x - mark.x, y - mark.y) < BLOCKER_REACH_MM) return true;
    return false;
  };
  for (size_t step = 0; step <= path.size() / 2; ++step) {
    const size_t forward = (best + step) % path.size();
    if (!blocked(forward)) return forward;
    const size_t backward = (best + path.size() - step) % path.size();
    if (!blocked(backward)) return backward;
  }
  return best;
}
