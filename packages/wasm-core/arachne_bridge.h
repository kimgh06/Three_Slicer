// Stage-7 bridge: plain-type interface to the ported OrcaSlicer Arachne WallToolPaths.
// slicer_core.cpp includes ONLY this header (no Slic3r/Arachne/clipper types), keeping its
// own ClipperLib separate from the port's Slic3r::ClipperLib / ClipperLib_Z.
#pragma once
#include <vector>
#include <utility>

namespace arachne_bridge {

struct WallJunction { double x, y, width; };            // one junction: XY (mm) + extrusion width (mm)
struct WallLine { std::vector<WallJunction> junctions; bool closed; int inset_index; };

// polygons_mm[0] = outer contour, [1..] = holes (all in mm, kernel-centered coords).
// Returns Arachne variable-width wall lines (outer→inner), each junction carrying its own width.
std::vector<WallLine> generate_walls(const std::vector<std::vector<std::pair<double,double>>>& polygons_mm,
                                  double line_width_mm, int wall_count, double layer_height_mm);

// Stage-14: number of times the REAL CGAL planarity check (VoronoiUtilsCgal::is_voronoi_diagram_planar_angle)
// has run this session. >0 proves the ported CGAL check is invoked (replacing the always-true stub).
int cgal_planar_check_count();

} // namespace arachne_bridge
