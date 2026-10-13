// geom_helpers.h — extracted verbatim from slicer_core.cpp (pure code move; no behavior change).
//  Declarations only; the definitions (with their comments) live in geom_helpers.cpp.
#pragma once
#include "clip_util.h"
#include "params.h"

#include <cstdint>
#include <string>
#include <vector>

// ---- Stage 5 helpers: area · component split · morphological open · center line · tree shrink ------------------
double paths_area(const Paths& paths);
Paths morph_open(const Paths& in, double radius);
std::vector<Paths> split_components(const Paths& in);
Paths grid_snap(const Paths& region, double cell);
Paths tree_taper(const Paths& in, double shrink, double minRadius);
Paths build_sparse(const Paths& region, const std::string& pattern, double base, double spacing, int layerIdx, double z, double lineW, double density);
double paths_length(const Paths& paths, bool closed);
double walls_length(const std::vector<Paths>& walls);
int fan_S(int layerIndex, const Params& params);
void sort_monotonic(Paths& lines, double angleDeg);   // (defined in geom_helpers.cpp) for zigzag ordering
struct MillimetrePoint { double x, y; };
// Seam context (aligned = the previous layer's seam, random = a deterministic LCG)
struct SeamContext { double lastX=0, lastY=0; bool hasLast=false; uint32_t randomState=1; };
void rotate_seam(Path& path, int mode, SeamContext& seamContext, double nozzleX, double nozzleY);
