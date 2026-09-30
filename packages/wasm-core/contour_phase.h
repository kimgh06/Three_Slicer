// contour_phase.h — PASS1's per-layer union done outside the kernel (the GPU path, engine/src/contour_gpu.js).
//
// The kernel's slice is synchronous and WebGPU is not, so the union is taken out between two calls of slice():
//   CAPTURE  pass1 stops after chaining every layer's raw loops (what SimplifyPolygons would take) and slice() returns
//            {captured: true}. gpu_input() then hands the loops over in the layout the GPU pipeline reads.
//   INJECT   the GPU's pieces, copied into result_buffer(), are walked into contours (assemble()); the next slice() skips
//            the segment sweep and the union and reads them. A layer the GPU left with an open loop gets the kernel's own
//            union, so the slice never depends on the GPU being right.
// OFF is the kernel as it was: nothing here is reached, which is what keeps the golden output byte-identical.
//
// The result is the same region as the CPU's union (measured: area within 2e-10 relative) with different vertices, so the
// G-code of a GPU slice is not the CPU's byte for byte.
#pragma once
#include "clip_util.h"
#include <vector>

namespace contour_phase {

enum Mode { OFF = 0, CAPTURE = 1, INJECT = 2 };
extern int mode;
extern bool captured;                       // the last CAPTURE slice reached pass1 (false: it took another route)
extern std::vector<Paths> loops, contours;  // per layer

// Segments that coincide exactly in opposite directions add nothing to any winding number; they are removed and the
//  rest chained into loops again. Two shells that share a wall produce them, and the GPU pipeline cannot order the
//  crossings of two segments on one line (measured on a 3M-facet scan: 164,337 such pairs in 342 of 420 layers; with
//  them removed no layer falls back, without them 5 to 100 do). A layer without any keeps its loops untouched.
void cancel_coincident(Paths& layerLoops);

// one task per index on every thread the build has (serial on st)
void parallel(int count, void (*task)(int index, void* context), void* context);

struct GpuInput {
  double ms = 0;
  int layerCount = 0, segmentCount = 0, cellCount = 0, polygonCount = 0, cellEntryCount = 0;
  // one start point per kept segment (layer-relative), per-layer tables, per-polygon tables: see contour_gpu.js
  std::vector<int> points, layerMin, layerInfo;
  std::vector<unsigned> layerStart, polyInfo, polyLayer;
};
extern GpuInput input;
void build_gpu_input();

// 4 x i32 per piece: start x, start y (layer-relative), successor, layer
extern std::vector<int> result;
struct Assembled { double walkMs = 0, fallbackMs = 0; std::vector<int> fallbackLayers; };
Assembled assemble();

}  // namespace contour_phase
