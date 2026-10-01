// Stage-8 bridge: plain-type interface to the ported OrcaSlicer Fill/ framework (real FillGyroid,
// FillHoneycomb, Fill3DHoneycomb, FillCrossHatch, FillConcentric). slicer_core.cpp includes ONLY
// this header (no Slic3r types), same isolation pattern as arachne_bridge.
#pragma once
#include <vector>
#include <utility>
#include <string>

namespace fill_bridge {
using Poly = std::vector<std::pair<double,double>>;   // polygon/polyline as (x,y) mm

// region_mm[0] = outer contour, [1..] = holes (mm, kernel coords).
// pattern: "gyroid" | "honeycomb" | "3dhoneycomb" | "crosshatch" | "concentric".
// density in <0,1>, spacing_mm = base line width, angle_deg, z_mm (unscaled), layer_id.
// Returns infill polylines (each = (x,y) mm). Empty on unknown pattern / empty region.
std::vector<Poly> generate_fill(const std::vector<Poly>& region_mm, const std::string& pattern,
                                double density, double spacing_mm, double angle_deg,
                                double z_mm, int layer_id);

// The length (mm) of path chain_and_reorder_extrusion_entities (ShortestPath.cpp) keeps out of a fixed layer: a 10 mm
//  path in a collection whose first child is an empty collection, and a 5 mm path in a collection whose last child is a
//  path without points. 15 when both are kept; upstream's check dropped both collections whole. test.mjs pins it.
double chain_reorder_kept_length();
} // namespace fill_bridge
