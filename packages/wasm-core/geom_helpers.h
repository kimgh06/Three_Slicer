// geom_helpers.h — extracted verbatim from slicer_core.cpp (pure code move; no behavior change).
//  Declarations only; the definitions (with their comments) live in geom_helpers.cpp.
#pragma once
#include "clip_util.h"
#include "params.h"

#include <cstdint>
#include <string>
#include <vector>

// ---- Stage 5 helpers: area · component split · morphological open · center line · tree shrink ------------------
double paths_area(const Paths& ps);
Paths morph_open(const Paths& in, double r);
std::vector<Paths> split_components(const Paths& in);
Paths grid_snap(const Paths& region, double cell);
Paths tree_taper(const Paths& in, double shrink, double minR);
Paths build_sparse(const Paths& region, const std::string& pat, double base, double spacing, int layerIdx, double z, double lineW, double density);
double paths_len(const Paths& ps, bool closed);
double vwalls_len(const std::vector<Paths>& ws);
int fan_S(int i, const Params& p);
void sort_monotonic(Paths& lines, double angleDeg);   // (defined in geom_helpers.cpp) for zigzag ordering
struct DPt { double x, y; };
bool circle_from3(DPt a, DPt b, DPt c, double& cx, double& cy, double& r);
// Seam context (aligned = the previous layer's seam, random = a deterministic LCG)
struct SeamCtx { double lastX=0, lastY=0; bool has=false; uint32_t rng=1; };
void rotate_seam(Path& p, int mode, SeamCtx& sc, double nozX, double nozY);
