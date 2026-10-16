#include "slasupport_bridge.h"

#include <tbb/parallel_for.h>     // the treesupport stub — real threads only inside a ParallelScope (mt)
#include <tbb/stub_parallel.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <limits>
#include <unordered_map>
#include <utility>

namespace slasupport_bridge {
namespace {

constexpr double kTolerance = 1e-7;

// A directed cross-section segment: start->end follows the slicing convention (solid on the LEFT, so outer
// boundaries chain CCW). `oriented` is false for near-horizontal triangles whose direction is unreliable —
// they still chain geometrically but do not vote on the loop's winding.
struct Segment { Vec2 start; Vec2 end; bool oriented = false; };

bool close(double first, double second) { return std::abs(first - second) <= kTolerance; }
bool close(const Vec2& first, const Vec2& second) { return close(first.x, second.x) && close(first.y, second.y); }

double signed_area(const Polygon& polygon) {
  double area = 0.0;
  for (std::size_t i = 0; i < polygon.size(); ++i) {
    const Vec2& vertex = polygon[i];
    const Vec2& next_vertex = polygon[(i + 1) % polygon.size()];
    area += vertex.x * next_vertex.y - next_vertex.x * vertex.y;
  }
  return area / 2.0;
}

bool contains(const Polygon& polygon, const Vec2& point) {
  bool inside = false;
  for (std::size_t i = 0, previous = polygon.size() - 1; i < polygon.size(); previous = i++) {
    const Vec2& vertex = polygon[i];
    const Vec2& previous_vertex = polygon[previous];
    if ((vertex.y > point.y) != (previous_vertex.y > point.y) &&
        point.x < (previous_vertex.x - vertex.x) * (point.y - vertex.y) / (previous_vertex.y - vertex.y) + vertex.x)
      inside = !inside;
  }
  return inside;
}

bool intersect_triangle(const float* triangle, double height, Segment& segment) {
  Vec3 vertices[3];
  for (int i = 0; i < 3; ++i)
    vertices[i] = {triangle[i * 3], triangle[i * 3 + 1], triangle[i * 3 + 2]};
  Vec2 points[3];
  int count = 0;
  for (int i = 0; i < 3; ++i) {
    const Vec3& edge_start = vertices[i];
    const Vec3& edge_end = vertices[(i + 1) % 3];
    if (!((edge_start.z < height && edge_end.z >= height) || (edge_end.z < height && edge_start.z >= height))) continue;
    const double fraction = (height - edge_start.z) / (edge_end.z - edge_start.z);
    const Vec2 point{edge_start.x + (edge_end.x - edge_start.x) * fraction, edge_start.y + (edge_end.y - edge_start.y) * fraction};
    if (count == 0 || !close(points[count - 1], point)) points[count++] = point;
  }
  if (count != 2 || close(points[0], points[1])) return false;
  segment = {points[0], points[1]};

  // Direct the segment from the triangle's own winding: with outward normal n, d = z x n points along the
  // cross-section so that the solid lies on the LEFT of a->b — outer loops come out CCW, true cavities CW
  // (checked on a cylinder's +x facet: n=(1,0,0) -> d=(0,1), the CCW tangent).
  // This is what makes a soup of INTERPENETRATING closed solids (a pillar through its pedestal, a bridge
  // through a pillar) union correctly downstream: nesting depth cannot tell such an inner boundary from a
  // hole, the winding can.
  const Vec3& vertex0 = vertices[0];
  const Vec3& vertex1 = vertices[1];
  const Vec3& vertex2 = vertices[2];
  const double edge1_x = vertex1.x - vertex0.x;
  const double edge1_y = vertex1.y - vertex0.y;
  const double edge1_z = vertex1.z - vertex0.z;
  const double edge2_x = vertex2.x - vertex0.x;
  const double edge2_y = vertex2.y - vertex0.y;
  const double edge2_z = vertex2.z - vertex0.z;
  const double normal_x = edge1_y * edge2_z - edge1_z * edge2_y;
  const double normal_y = edge1_z * edge2_x - edge1_x * edge2_z;
  const double direction_x = -normal_y;                  // (0,0,1) x n
  const double direction_y = normal_x;
  const double along = (segment.end.x - segment.start.x) * direction_x + (segment.end.y - segment.start.y) * direction_y;
  const double squared_lengths = (direction_x * direction_x + direction_y * direction_y) *
    ((segment.end.x - segment.start.x) * (segment.end.x - segment.start.x) +
     (segment.end.y - segment.start.y) * (segment.end.y - segment.start.y));
  if (along * along > 1e-12 * squared_lengths) {         // direction is meaningful for this triangle
    if (along < 0.0) std::swap(segment.start, segment.end);
    segment.oriented = true;
  }
  return true;
}

std::vector<Polygon> chain_closed_loops(const std::vector<Segment>& segments, std::string& error) {
  std::vector<Polygon> loops;
  std::vector<long> votes;   // per loop: directed segments agreeing with the chained order, minus disagreeing
  // The original chained with a linear find_if + erase — O(S^2) per layer, and the support raster's
  // dominant cost on pillar-heavy scenes. This quantized endpoint index reproduces its exact matching
  // semantics: the candidate chosen is the FIRST unused segment in insertion order whose endpoint is
  // close() to the open end (erase kept relative order, so "first remaining" == lowest original index),
  // and each new loop seeds from the LAST unused segment (== segments.back() of the shrinking vector).
  // One cell equals kTolerance, so close() partners sit at most one cell apart on each axis.
  const auto cell = [](double coordinate) -> std::int64_t { return std::llround(coordinate / kTolerance); };
  const auto pack = [](std::int64_t cell_x, std::int64_t cell_y) -> std::uint64_t {
    return (std::uint64_t)(std::uint32_t)(std::int32_t)cell_x | ((std::uint64_t)(std::uint32_t)(std::int32_t)cell_y << 32);
  };
  // Open-addressing flat table (25% load, duplicate keys allowed): the per-layer node-allocating
  // unordered_map showed up as the chaining cost itself once the O(S^2) scan was gone.
  const std::uint32_t kNone = std::numeric_limits<std::uint32_t>::max();
  std::size_t capacity = 16;
  while (capacity < segments.size() * 4 + 8) capacity <<= 1;
  const std::uint64_t mask = capacity - 1;
  const auto mix = [](std::uint64_t key) {
    key ^= key >> 33;
    key *= 0xff51afd7ed558ccdULL;
    key ^= key >> 33;
    return key;
  };
  std::vector<std::uint64_t> slot_key(capacity);
  std::vector<std::uint32_t> slot_segment(capacity, kNone);   // kNone == empty slot
  const auto insert = [&](std::uint64_t key, std::uint32_t segment_index) {
    std::uint64_t slot = mix(key) & mask;
    while (slot_segment[slot] != kNone) slot = (slot + 1) & mask;
    slot_key[slot] = key;
    slot_segment[slot] = segment_index;
  };
  for (std::uint32_t i = 0; i < segments.size(); ++i) {
    insert(pack(cell(segments[i].start.x), cell(segments[i].start.y)), i);
    insert(pack(cell(segments[i].end.x), cell(segments[i].end.y)), i);
  }
  std::vector<char> used(segments.size(), 0);
  const auto first_unused_match = [&](const Vec2& end) -> std::uint32_t {
    std::uint32_t best = kNone;
    const std::int64_t cell_x = cell(end.x);
    const std::int64_t cell_y = cell(end.y);
    for (std::int64_t offset_x = -1; offset_x <= 1; ++offset_x)
      for (std::int64_t offset_y = -1; offset_y <= 1; ++offset_y) {
        const std::uint64_t key = pack(cell_x + offset_x, cell_y + offset_y);
        for (std::uint64_t slot = mix(key) & mask; slot_segment[slot] != kNone; slot = (slot + 1) & mask) {
          if (slot_key[slot] != key) continue;
          const std::uint32_t i = slot_segment[slot];
          if (used[i] || i >= best) continue;
          if (close(segments[i].start, end) || close(segments[i].end, end)) best = i;
        }
      }
    return best;
  };
  std::size_t seed_scan = segments.size();
  while (true) {
    while (seed_scan > 0 && used[seed_scan - 1]) --seed_scan;
    if (seed_scan == 0) break;
    const std::uint32_t seed = (std::uint32_t)(seed_scan - 1);
    used[seed] = 1;
    Polygon loop{segments[seed].start, segments[seed].end};
    long vote = 0;
    if (segments[seed].oriented) vote = 1;
    while (!close(loop.back(), loop.front())) {
      const std::uint32_t next = first_unused_match(loop.back());
      if (next == kNone) {
        error = "generic mesh sweep produced an open contour";
        return {};
      }
      used[next] = 1;
      const bool forward = close(segments[next].start, loop.back());
      if (segments[next].oriented) {
        if (forward) vote += 1;
        else vote += -1;
      }
      if (forward) loop.push_back(segments[next].end);
      else loop.push_back(segments[next].start);
    }
    loop.pop_back();
    if (loop.size() >= 3 && std::abs(signed_area(loop)) > kTolerance) {
      loops.push_back(std::move(loop));
      votes.push_back(vote);
    }
  }
  // Winding comes from the triangles (majority vote of the loop's directed segments), because a soup of
  // interpenetrating solids has inner boundaries whose nesting depth LOOKS like a hole but is solid. The
  // old depth-parity rule remains only as a fallback for the (degenerate) all-horizontal case with no vote.
  for (std::size_t i = 0; i < loops.size(); ++i) {
    if (votes[i] != 0) {
      // The chained order either follows the triangle convention (keep) or runs against it (reverse);
      // the signed area is NOT consulted — a genuine cavity is legitimately clockwise.
      if (votes[i] < 0) std::reverse(loops[i].begin(), loops[i].end());
    } else {
      std::size_t depth = 0;
      for (std::size_t j = 0; j < loops.size(); ++j)
        if (i != j && contains(loops[j], loops[i].front())) ++depth;
      const bool outer = depth % 2 == 0;
      if ((signed_area(loops[i]) > 0) != outer) std::reverse(loops[i].begin(), loops[i].end());
    }
  }
  return loops;
}

std::uint64_t height_key(double height) {
  std::uint64_t key = 0;
  static_assert(sizeof(key) == sizeof(height), "double key size");
  std::memcpy(&key, &height, sizeof(key));
  return key;
}

}

SupportSlicerCapability support_slicer_capability() { return {}; }

SupportSliceBatch slice_support_mesh_fallback(
  const std::vector<float>& triangle_soup,
  const std::vector<double>& heights)
{
  SupportSliceBatch result;
  if (triangle_soup.empty() || triangle_soup.size() % 9 != 0) {
    result.error = "support mesh: expected non-empty triangle soup";
    return result;
  }
  for (float coordinate : triangle_soup)
    if (!std::isfinite(coordinate)) {
      result.error = "support mesh: non-finite coordinate";
      return result;
    }
  // Deduplicate heights with the same bit-pattern cache the per-height loop had (first
  // occurrence is the miss, repeats are hits), keeping unique heights in first-seen order.
  std::unordered_map<std::uint64_t, std::uint32_t> slice_id;
  std::vector<double> unique_heights;
  std::vector<std::uint32_t> slice_of(heights.size());
  for (std::size_t k = 0; k < heights.size(); ++k) {
    if (!std::isfinite(heights[k])) {
      result.error = "support heights: non-finite value";
      return result;
    }
    const auto inserted = slice_id.emplace(height_key(heights[k]), (std::uint32_t)unique_heights.size());
    if (inserted.second) {
      unique_heights.push_back(heights[k]);
      ++result.cache.misses;
    }
    else ++result.cache.hits;
    slice_of[k] = inserted.first->second;
  }

  // Facet-major sweep: visit only the heights inside each triangle's z band, instead of scanning the
  // whole soup once per height (O(heights x facets) — the other half of the raster bottleneck). A
  // triangle contributes segments exactly for zmin < h <= zmax (the edge-crossing rule inside
  // intersect_triangle), and per-height segment order stays the soup's facet order, so the chained
  // loops come out byte-identical to the per-height scan's.
  std::vector<std::uint32_t> by_height((std::uint32_t)unique_heights.size());
  for (std::uint32_t i = 0; i < by_height.size(); ++i) by_height[i] = i;
  std::sort(by_height.begin(), by_height.end(), [&](std::uint32_t left, std::uint32_t right) {
    return unique_heights[left] < unique_heights[right];
  });
  std::vector<double> sorted_heights(by_height.size());
  for (std::uint32_t i = 0; i < by_height.size(); ++i) sorted_heights[i] = unique_heights[by_height[i]];
  std::vector<std::vector<Segment>> layer_segments(unique_heights.size());
  for (std::size_t offset = 0; offset < triangle_soup.size(); offset += 9) {
    const float* triangle = triangle_soup.data() + offset;
    const double zmin = std::min({triangle[2], triangle[5], triangle[8]});
    const double zmax = std::max({triangle[2], triangle[5], triangle[8]});
    Segment segment;
    for (auto it = std::upper_bound(sorted_heights.begin(), sorted_heights.end(), zmin);
         it != sorted_heights.end() && *it <= zmax; ++it)
      if (intersect_triangle(triangle, *it, segment))
        layer_segments[by_height[it - sorted_heights.begin()]].push_back(segment);
  }

  // Chain each height's segments into loops — per-height slots, so mt threads (inside the
  // ParallelScope) produce byte-identical results to the serial st walk. On error the lowest
  // first-seen height's message wins, matching the serial walk's first-error semantics.
  std::vector<std::vector<Polygon>> sliced(unique_heights.size());
  std::vector<std::string> chain_errors(unique_heights.size());
  {
    tbb_stub::ParallelScope parallel_scope;
    tbb::parallel_for(tbb::blocked_range<std::uint32_t>(0, (std::uint32_t)unique_heights.size()),
                      [&](const tbb::blocked_range<std::uint32_t>& range) {
                        for (std::uint32_t height_index = range.begin(); height_index < range.end(); ++height_index)
                          sliced[height_index] = chain_closed_loops(layer_segments[height_index], chain_errors[height_index]);
                      });
  }
  for (std::uint32_t height_index = 0; height_index < unique_heights.size(); ++height_index)
    if (!chain_errors[height_index].empty()) {
      result.error = chain_errors[height_index];
      return result;
    }
  result.slices.reserve(heights.size());
  for (std::size_t k = 0; k < heights.size(); ++k) result.slices.push_back(sliced[slice_of[k]]);
  result.ok = true;
  return result;
}

}
