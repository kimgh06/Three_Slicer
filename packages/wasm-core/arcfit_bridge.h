// Arc fitting bridge: plain-type interface to upstream's ArcFitter (OrcaSlicer src/libslic3r/ArcFitter.cpp, ported
// verbatim in arachne_port/). gcode_writer.h includes ONLY this header, keeping the kernel's ClipperLib apart from
// the port's Slic3r types, the same isolation arachne_bridge.h and classic_bridge.h give their generators.
#pragma once
#include <cstddef>
#include <utility>
#include <vector>

namespace arcfit_bridge {

enum MoveKind { Linear = 0, ArcClockwise = 1, ArcCounterClockwise = 2 };

// One run of the input polyline: points [start, end] as straight moves, or one arc from points[start] to points[end].
struct Move {
  std::size_t start, end;
  int         kind;        // MoveKind
  double      centerX, centerY;   // mm, arcs only
  double      length;             // mm, arcs only: upstream's ArcSegment::length
};

// ArcFitter::do_arc_fitting over a polyline in mm, with the tolerance in mm.
void fit(const std::vector<std::pair<double, double>>& points, double tolerance, std::vector<Move>& moves);

} // namespace arcfit_bridge
