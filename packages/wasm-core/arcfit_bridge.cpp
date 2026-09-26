// Arc fitting bridge implementation (see arcfit_bridge.h). The kernel used its own fitter, which accepted a run as
// an arc when its VERTICES lay on one circle and never looked at the segments between them, so the zigzag of an infill
// or support region whose turning points sit on a round boundary became one arc along that boundary (measured on a
// Benchy with the Bambu Lab A1 mini defaults: 2321 of 13152 support arcs strayed from the real path by more than
// 0.05mm, worst 5.4mm). Upstream's ArcSegment::try_create_arc also checks each segment's closest approach to the
// centre, the arc length against the path length, and that the points stay inside the arc's angular slice.
#include "arcfit_bridge.h"

#include "arachne_port/libslic3r/ArcFitter.hpp"

#include <cmath>

using namespace Slic3r;

namespace arcfit_bridge {

void fit(const std::vector<std::pair<double, double>>& points, double tolerance, std::vector<Move>& moves)
{
    moves.clear();
    Points scaled_points;
    scaled_points.reserve(points.size());
    for (const std::pair<double, double>& point : points)
        scaled_points.emplace_back(coord_t(std::llround(point.first / SCALING_FACTOR)), coord_t(std::llround(point.second / SCALING_FACTOR)));

    std::vector<PathFittingData> fitting;
    ArcFitter::do_arc_fitting(scaled_points, fitting, scale_(tolerance));

    moves.reserve(fitting.size());
    for (const PathFittingData& data : fitting) {
        Move move{ data.start_point_index, data.end_point_index, Linear, 0.0, 0.0, 0.0 };
        if (data.path_type == EMovePathType::Arc_move_cw)  move.kind = ArcClockwise;
        if (data.path_type == EMovePathType::Arc_move_ccw) move.kind = ArcCounterClockwise;
        if (move.kind != Linear) {
            move.centerX = data.arc_data.center.x() * SCALING_FACTOR;
            move.centerY = data.arc_data.center.y() * SCALING_FACTOR;
            move.length  = data.arc_data.length * SCALING_FACTOR;
        }
        moves.push_back(move);
    }
}

} // namespace arcfit_bridge
