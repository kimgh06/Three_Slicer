// contour_phase.cpp — see contour_phase.h.
#include "contour_phase.h"
#include "slice_planes.h"

#include <emscripten.h>
#include <algorithm>
#include <atomic>
#include <cstring>
#include <numeric>
#include <thread>

namespace contour_phase {

int mode = OFF;
bool captured = false;
std::vector<Paths> loops, contours;
std::vector<float> mesh_tris;
std::vector<double> mesh_planes;
std::vector<unsigned char> open_layers;
GpuInput input;
std::vector<int> result;

void parallel(int count, void (*task)(int index, void* context), void* context) {
#ifdef __EMSCRIPTEN_PTHREADS__
  const unsigned threadCount = std::min<unsigned>(std::max(1u, std::thread::hardware_concurrency()), (unsigned)std::max(1, count));
  std::atomic<int> next{0};
  auto work = [&] { int index; while ((index = next.fetch_add(1)) < count) task(index, context); };
  std::vector<std::thread> threads; threads.reserve(threadCount - 1);
  for (unsigned t = 1; t < threadCount; ++t) {
    try { threads.emplace_back(work); }
    catch (...) { break; }   // the pthread pool can be momentarily empty: the caller and the threads that started take the rest
  }
  work();
  for (auto& thread : threads) thread.join();
#else
  for (int index = 0; index < count; ++index) task(index, context);
#endif
}

namespace {

struct Edge { cInt ax, ay, bx, by; };

// an edge's two ends in a fixed order, so both directions of one place sort together
inline bool startIsLow(const Edge& e) { return e.ax < e.bx || (e.ax == e.bx && e.ay < e.by); }
struct Place { cInt lx, ly, hx, hy; };
inline Place placeOf(const Edge& e) {
  if (startIsLow(e)) return { e.ax, e.ay, e.bx, e.by };
  return { e.bx, e.by, e.ax, e.ay };
}
inline bool samePlace(const Place& a, const Place& b) { return a.lx == b.lx && a.ly == b.ly && a.hx == b.hx && a.hy == b.hy; }
inline bool placeLess(const Place& a, const Place& b) {
  if (a.lx != b.lx) return a.lx < b.lx;
  if (a.ly != b.ly) return a.ly < b.ly;
  if (a.hx != b.hx) return a.hx < b.hx;
  return a.hy < b.hy;
}

}  // namespace

void cancel_coincident(Paths& layerLoops) {
  std::vector<Edge> edges;
  { size_t total = 0; for (const Path& path : layerLoops) total += path.size(); edges.reserve(total); }
  for (const Path& path : layerLoops) {
    const size_t n = path.size();
    for (size_t v = 0; v < n; ++v) {
      size_t next = v + 1; if (next == n) next = 0;
      const IntPoint& a = path[v]; const IntPoint& b = path[next];
      if (a.x() == b.x() && a.y() == b.y()) continue;
      edges.push_back({ a.x(), a.y(), b.x(), b.y() });
    }
  }
  const int edgeCount = (int)edges.size();
  std::vector<int> order(edgeCount); std::iota(order.begin(), order.end(), 0);
  std::sort(order.begin(), order.end(), [&](int p, int q) {
    const Place a = placeOf(edges[p]), b = placeOf(edges[q]);
    if (!samePlace(a, b)) return placeLess(a, b);
    const bool pLow = startIsLow(edges[p]), qLow = startIsLow(edges[q]);
    if (pLow != qLow) return pLow;
    return p < q;
  });
  // within one place: the first min(forward, backward) edges of each direction cancel
  std::vector<char> dead(edgeCount, 0); int removed = 0;
  for (int from = 0; from < edgeCount; ) {
    const Place place = placeOf(edges[order[from]]);
    int to = from, forward = 0;
    while (to < edgeCount && samePlace(placeOf(edges[order[to]]), place)) { if (startIsLow(edges[order[to]])) ++forward; ++to; }
    const int backward = (to - from) - forward, pairs = std::min(forward, backward);
    for (int k = 0; k < pairs; ++k) { dead[order[from + k]] = 1; dead[order[from + forward + k]] = 1; }
    removed += pairs * 2;
    from = to;
  }
  if (removed == 0) return;

  // chain what is left. Every vertex keeps as many edges in as out, so a walk that follows any unused edge out of the
  //  vertex it arrived at ends where it began.
  std::vector<int> byStart; byStart.reserve(edgeCount - removed);
  for (int e = 0; e < edgeCount; ++e) if (!dead[e]) byStart.push_back(e);
  std::sort(byStart.begin(), byStart.end(), [&](int p, int q) {
    if (edges[p].ax != edges[q].ax) return edges[p].ax < edges[q].ax;
    if (edges[p].ay != edges[q].ay) return edges[p].ay < edges[q].ay;
    return p < q;
  });
  std::vector<char> used(edgeCount, 0);
  auto takeFrom = [&](cInt x, cInt y) {
    auto first = std::lower_bound(byStart.begin(), byStart.end(), 0, [&](int e, int) {
      if (edges[e].ax != x) return edges[e].ax < x;
      return edges[e].ay < y;
    });
    for (auto it = first; it != byStart.end() && edges[*it].ax == x && edges[*it].ay == y; ++it)
      if (!used[*it]) return *it;
    return -1;
  };
  Paths chained;
  for (int first = 0; first < edgeCount; ++first) {
    if (dead[first] || used[first]) continue;
    Path path; int edge = first;
    while (edge >= 0) {
      used[edge] = 1;
      path.emplace_back(edges[edge].ax, edges[edge].ay);
      edge = takeFrom(edges[edge].bx, edges[edge].by);
    }
    if (path.size() >= 2) chained.push_back(std::move(path));
  }
  layerLoops.swap(chained);
}

namespace {

const int CELL_SIZE = 2000000;   // the pipeline's grid cell, in kernel units (2 mm)

// one polygon: the start point of every segment it keeps (a segment whose ends coincide is dropped), layer-relative,
//  written from `cursor` on. Returns how many it kept; fewer than 2 is no polygon.
int write_polygon(const Path& path, int minx, int miny, int cursor) {
  const int n = (int)path.size(); if (n == 0) return 0;
  int kept = 0;
  cInt nextX = path[0].x(), nextY = path[0].y();
  for (int v = n - 1; v >= 0; --v) {   // backwards: each point's successor is at hand
    const cInt x = path[v].x(), y = path[v].y();
    if (x != nextX || y != nextY) ++kept;
    nextX = x; nextY = y;
  }
  if (kept < 2) return 0;
  int* out = &input.points[(size_t)cursor * 2];
  nextX = path[0].x(); nextY = path[0].y(); int slot = kept;
  for (int v = n - 1; v >= 0; --v) {
    const cInt x = path[v].x(), y = path[v].y();
    if (x != nextX || y != nextY) { --slot; out[slot * 2] = (int)(x - minx); out[slot * 2 + 1] = (int)(y - miny); }
    nextX = x; nextY = y;
  }
  return kept;
}

// how many (segment, grid cell) entries the polygon's segments take: the size of the pipeline's cell list
long long cell_entries(int first, int count) {
  long long entries = 0; const int* base = &input.points[(size_t)first * 2];
  int ax = base[(count - 1) * 2], ay = base[(count - 1) * 2 + 1];
  for (int i = 0; i < count; ++i) {
    const int bx = base[i * 2], by = base[i * 2 + 1];
    entries += (long long)(std::max(ax, bx) / CELL_SIZE - std::min(ax, bx) / CELL_SIZE + 1) * (std::max(ay, by) / CELL_SIZE - std::min(ay, by) / CELL_SIZE + 1);
    ax = bx; ay = by;
  }
  return entries;
}

struct InputWork {
  std::vector<int> extentX, extentY, segmentsOf;
  std::vector<size_t> pointsOf, slotStart;
  std::vector<std::vector<int>> polygonsOf;   // per layer: (first within its slot, count) pairs
  std::vector<long long> entriesOf;
};

}  // namespace

void build_gpu_input() {
  const double started = emscripten_get_now();
  const int layerCount = (int)loops.size();
  input = GpuInput(); input.layerCount = layerCount;
  input.layerMin.assign(layerCount * 2, 0); input.layerStart.assign(layerCount + 1, 0); input.layerInfo.assign(layerCount * 4, 0);
  InputWork work;
  work.extentX.assign(layerCount, 0); work.extentY.assign(layerCount, 0); work.pointsOf.assign(layerCount, 0);
  work.segmentsOf.assign(layerCount, 0); work.polygonsOf.resize(layerCount); work.entriesOf.assign(layerCount, 0);
  // pass 1, per layer: its origin and extent
  parallel(layerCount, [](int L, void* context) {
    InputWork& w = *(InputWork*)context;
    cInt minx = 0, miny = 0, maxx = 0, maxy = 0; bool any = false; size_t count = 0;
    for (const Path& path : loops[L]) {
      if (path.empty()) continue;
      if (!any) { minx = maxx = path[0].x(); miny = maxy = path[0].y(); any = true; }
      for (const IntPoint& point : path) {
        const cInt x = point.x(), y = point.y();
        if (x < minx) minx = x;
        if (x > maxx) maxx = x;
        if (y < miny) miny = y;
        if (y > maxy) maxy = y;
      }
      count += path.size();
    }
    input.layerMin[L * 2] = (int)minx; input.layerMin[L * 2 + 1] = (int)miny;
    w.extentX[L] = (int)(maxx - minx); w.extentY[L] = (int)(maxy - miny); w.pointsOf[L] = count;
  }, &work);
  int cells = 0;
  for (int L = 0; L < layerCount; ++L) {
    const int gw = work.extentX[L] / CELL_SIZE + 1, gh = work.extentY[L] / CELL_SIZE + 1;
    input.layerInfo[L * 4] = gw; input.layerInfo[L * 4 + 1] = gh; input.layerInfo[L * 4 + 2] = cells; cells += gw * gh;
  }
  // pass 2: every layer writes into a slot sized for all its points, in parallel; the slots are then closed up in order
  work.slotStart.assign(layerCount + 1, 0);
  for (int L = 0; L < layerCount; ++L) work.slotStart[L + 1] = work.slotStart[L] + work.pointsOf[L];
  input.points.resize(work.slotStart[layerCount] * 2);
  parallel(layerCount, [](int L, void* context) {
    InputWork& w = *(InputWork*)context;
    const int minx = input.layerMin[L * 2], miny = input.layerMin[L * 2 + 1];
    int cursor = (int)w.slotStart[L]; long long entries = 0;
    w.polygonsOf[L].reserve(loops[L].size() * 2);
    for (const Path& path : loops[L]) {
      const int count = write_polygon(path, minx, miny, cursor);
      if (count == 0) continue;
      entries += cell_entries(cursor, count);
      w.polygonsOf[L].push_back(cursor - (int)w.slotStart[L]); w.polygonsOf[L].push_back(count);
      cursor += count;
    }
    w.segmentsOf[L] = cursor - (int)w.slotStart[L]; w.entriesOf[L] = entries;
  }, &work);
  int polygonCount = 0; long long entries = 0;
  for (int L = 0; L < layerCount; ++L) {
    input.layerStart[L + 1] = input.layerStart[L] + work.segmentsOf[L];
    polygonCount += (int)work.polygonsOf[L].size() / 2; entries += work.entriesOf[L];
    if (input.layerStart[L] != work.slotStart[L] && work.segmentsOf[L] > 0)
      std::memmove(&input.points[(size_t)input.layerStart[L] * 2], &input.points[work.slotStart[L] * 2], (size_t)work.segmentsOf[L] * 2 * sizeof(int));
  }
  const int segmentCount = (int)input.layerStart[layerCount];
  input.points.resize((size_t)segmentCount * 2); input.polyInfo.resize((size_t)polygonCount * 4); input.polyLayer.resize(polygonCount);
  int polygon = 0;
  for (int L = 0; L < layerCount; ++L) for (size_t k = 0; k + 1 < work.polygonsOf[L].size(); k += 2) {
    unsigned* poly = &input.polyInfo[(size_t)polygon * 4];
    poly[0] = input.layerStart[L] + work.polygonsOf[L][k]; poly[1] = work.polygonsOf[L][k + 1]; poly[2] = input.layerStart[L]; poly[3] = input.layerStart[L + 1];
    input.polyLayer[polygon++] = L;
  }
  input.segmentCount = segmentCount; input.cellCount = cells; input.polygonCount = polygonCount; input.cellEntryCount = (int)entries;
  input.ms = emscripten_get_now() - started;
}

namespace {

struct WalkWork {
  size_t pieceCount = 0; int layerCount = 0;
  std::vector<unsigned char> visited, bad;
  std::vector<size_t> rangeStart;
};

// loops of the pieces in [from, to): the loop's length first (this marks its pieces), then a path of exactly that size
void walk(WalkWork& w, size_t from, size_t to) {
  const int* pieces = result.data(); const size_t E = w.pieceCount;
  for (size_t first = from; first < to; ++first) {
    if (w.visited[first]) continue;
    const int layer = pieces[first * 4 + 3];
    if (layer < 0 || layer >= w.layerCount) continue;
    size_t length = 0, piece = first; bool closed = false;
    while (piece < E) {
      if (w.visited[piece]) { closed = piece == first; break; }
      w.visited[piece] = 1; ++length;
      piece = (size_t)(unsigned)pieces[piece * 4 + 2];
    }
    if (!closed) { w.bad[layer] = 1; continue; }
    if (length < 3) continue;
    const int minx = input.layerMin[layer * 2], miny = input.layerMin[layer * 2 + 1];
    contours[layer].emplace_back();
    Path& out = contours[layer].back(); out.reserve(length);
    piece = first;
    for (size_t k = 0; k < length; ++k) {
      const int* entry = &pieces[piece * 4];
      out.emplace_back(entry[0] + minx, entry[1] + miny);
      piece = (size_t)(unsigned)entry[2];
    }
  }
}

}  // namespace

void set_layer_count(int layerCount) {
  input = GpuInput(); input.layerCount = layerCount;
  input.layerMin.assign((size_t)std::max(0, layerCount) * 2, 0);
  open_layers.assign((size_t)std::max(0, layerCount), 0);
}

namespace {

// MESH: one layer's loops as pass1 would capture them (tri_plane over every triangle, chain_polys, cancel_coincident)
struct MeshWork { const std::vector<int>* layers; };
void mesh_layer_loops(int index, void* context) {
  const int layer = (*((MeshWork*)context)->layers)[index];
  const Tri* triangles = reinterpret_cast<const Tri*>(mesh_tris.data());
  const size_t triangleCount = mesh_tris.size() / 9;
  const double z = mesh_planes[layer];
  std::vector<Seg> segments; Seg segment;
  for (size_t t = 0; t < triangleCount; ++t) {
    const Tri& triangle = triangles[t];
    const double zmin = std::min({triangle.v[0].z, triangle.v[1].z, triangle.v[2].z}), zmax = std::max({triangle.v[0].z, triangle.v[1].z, triangle.v[2].z});
    if (zmin <= z && z < zmax && tri_plane(triangle, z, segment)) segments.push_back(segment);   // pass1's inclusion rule
  }
  loops[layer] = chain_polys(segments);
  cancel_coincident(loops[layer]);
}

}  // namespace

Assembled assemble() {
  Assembled out;
  const double walkStarted = emscripten_get_now();
  const int layerCount = input.layerCount;   // CAPTURE: build_gpu_input() set it to loops.size(); MESH: set_layer_count()
  WalkWork work; work.pieceCount = result.size() / 4; work.layerCount = layerCount;
  contours.assign(layerCount, Paths());
  work.visited.assign(work.pieceCount, 0); work.bad.assign(layerCount, 0);
  // the pipeline emits pieces in segment order, so a layer's pieces are one range and no loop leaves it
  work.rangeStart.assign(layerCount + 1, work.pieceCount);
  bool ordered = true; size_t piece = 0;
  for (int layer = 0; layer < layerCount; ++layer) {
    work.rangeStart[layer] = piece;
    while (piece < work.pieceCount && result[piece * 4 + 3] == layer) ++piece;
    if (piece < work.pieceCount && result[piece * 4 + 3] < layer) { ordered = false; break; }
  }
  if (piece != work.pieceCount) ordered = false;
  if (ordered) parallel(layerCount, [](int layer, void* context) { WalkWork& w = *(WalkWork*)context; walk(w, w.rangeStart[layer], w.rangeStart[layer + 1]); }, &work);
  else {
    // not the order the pipeline promises: nothing of it is trusted
    contours.assign(layerCount, Paths());
    std::fill(work.bad.begin(), work.bad.end(), (unsigned char)1);
  }
  out.walkMs = emscripten_get_now() - walkStarted;
  const double fallbackStarted = emscripten_get_now();
  for (int layer = 0; layer < layerCount; ++layer) if (work.bad[layer] || (layer < (int)open_layers.size() && open_layers[layer])) out.fallbackLayers.push_back(layer);
  if ((int)loops.size() != layerCount) {   // MESH: nothing captured; the fallback layers are cut from the mesh here
    if (!out.fallbackLayers.empty() && (mesh_tris.empty() || (int)mesh_planes.size() != layerCount)) {
      out.unavailable = true;
      out.fallbackMs = emscripten_get_now() - fallbackStarted;
      return out;
    }
    loops.assign(layerCount, Paths());
    MeshWork meshWork{ &out.fallbackLayers };
    parallel((int)out.fallbackLayers.size(), mesh_layer_loops, &meshWork);
  }
  std::vector<float>().swap(mesh_tris);   // nothing reads the mesh after the contours are known
  parallel((int)out.fallbackLayers.size(), [](int index, void* context) {
    const int layer = (*(std::vector<int>*)context)[index];
    contours[layer] = SimplifyPolygons(loops[layer], pftNonZero);
  }, &out.fallbackLayers);
  out.fallbackMs = emscripten_get_now() - fallbackStarted;
  return out;
}

}  // namespace contour_phase
