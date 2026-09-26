// Classic wall generator bridge: plain-type interface to the port of upstream PerimeterGenerator::process_classic
// (OrcaSlicer src/libslic3r/PerimeterGenerator.cpp). pass1.cpp includes ONLY this header, keeping the kernel's
// ClipperLib apart from the port's Slic3r::ClipperLib, the same isolation arachne_bridge.h gives Arachne.
// Coordinates cross the boundary as integers: the kernel's SCALE (1e6 per mm) equals the port's SCALING_FACTOR (1e-6),
// so no point is rounded on the way in or out.
#pragma once
#include <utility>
#include <vector>

namespace classic_bridge {

using IPoint = std::pair<long long, long long>;
using IPath  = std::vector<IPoint>;

// WallSequence, in upstream's enum order (PrintConfig.hpp).
enum WallSequence { InnerOuter = 0, OuterInner = 1, InnerOuterInner = 2 };

struct Config {
  // Extrusion widths (mm) the kernel resolved for this layer — on the first layer every one of them is
  //  initial_layer_line_width, as upstream's LayerRegion::flow gives them.
  double ext_perimeter_width, perimeter_width, solid_infill_width;
  double layer_height;
  double nozzle_diameter;
  int    wall_loops;
  int    layer_id;                    // object layer index (0 = first object layer)
  int    raft_layers;
  bool   detect_thin_wall;
  bool   has_gap_fill;                // gap_infill_speed > 0
  double filter_out_gap_fill;         // mm
  int    wall_sequence;               // WallSequence
  bool   wall_counter_clockwise;      // wall_direction == ccw
  bool   precise_outer_wall;
  bool   only_one_wall_first_layer;
  bool   alternate_extra_wall;
  double sparse_infill_density;       // percent (0..100), as upstream compares it
  bool   spiral_vase;
  double resolution;                  // mm
  bool   arc_fitting;
  double infill_wall_overlap;         // percent of (inset + solid_infill_spacing/2)
  double top_bottom_infill_wall_overlap;
  bool   is_top_layer;                // upstream's upper_slices == nullptr
};

enum Kind { OuterWall = 0, InnerWall = 1, ThinWall = 2, GapFill = 3 };

struct Extrusion {
  IPath  points;       // a loop does not repeat its first point
  bool   closed;
  int    kind;         // Kind
  int    inset;        // loop depth (0 = external); -1 for thin walls and gap fill
  double width;        // mm, upstream ExtrusionPath::width
};

struct Result {
  std::vector<Extrusion> walls;     // loops and thin walls, in upstream's print order (islands chained, then traverse_loops)
  std::vector<Extrusion> gap_fill;  // variable-width gap fill (erGapFill)
  std::vector<IPath>     fill;      // fill_surfaces: the infill area, contours CCW and holes CW
};

// contour: the layer's slice (contours and holes, any orientation; unioned NonZero inside).
Result generate(const std::vector<IPath>& contour, const Config& config);

} // namespace classic_bridge
