// Stage-8 bridge: plain-type interface to the ported OrcaSlicer PressureEqualizer (real segment-
// splitting pressure equalizer). slicer_core.cpp includes ONLY this header.
#pragma once
#include <string>
namespace pe_bridge {
// Pressure-equalize a whole-print g-code string. Returns the processed g-code (feedrates smoothed,
// long segments split). relative_e must match the kernel's M83 output. max_slope in mm^3/s^2.
std::string equalize(const std::string& gcode, double filament_diameter_mm, double max_slope_mm3_s2,
                     double segment_length_mm, bool relative_e, bool external_perimeter_only);
}
