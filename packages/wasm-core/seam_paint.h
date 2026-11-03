#pragma once
// Painted seams. The viewer sends the painted facets as triangles; each is cut with every layer's plane, and a wall loop
//  starts at the mark nearest it. Empty params leave the seam mode alone: no marks, no change to any output.
#include "clip_util.h"
#include "params.h"

#include <vector>

struct SeamMark { double x, y; };
struct SeamMarks { std::vector<SeamMark> enforcers, blockers; };

void seam_marks_prepare(const Params& params, const std::vector<double>& planes);
const SeamMarks* seam_marks_of(int layerIndex);       // null when the slice carries no seam paint
bool seam_nearest_enforcer(const Path& path, const SeamMarks& marks, size_t& edge, double& x, double& y);
bool seam_on_enforcer(Path& path, const SeamMarks& marks);
size_t seam_off_blockers(const Path& path, size_t best, const SeamMarks& marks);
