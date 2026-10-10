// Upstream's cooling (GCode/CoolingBuffer.cpp, ported verbatim to treesupport_port/libslic3r/GCode/): per layer, the
// layer time from its G-code, the slowdown that stretches a short layer to slow_down_layer_time, and the part-cooling,
// auxiliary and per-feature fan commands. It runs on the text the kernel writes, between the markers upstream's
// GCode::_extrude writes for it (;_EXTRUDE_SET_SPEED, ;_EXTRUDE_END, ;_EXTERNAL_PERIMETER, ;_OVERHANG_FAN_START, ...),
// which it removes. Plain types here; the Slic3r config stays on the port side (cooling_bridge_impl.cpp).
#pragma once
#include <string>
#include <vector>

namespace cooling_bridge {

// Loads the settings (Params::placeholder_config, settings_json.hpp) and starts a session for one slice. `extruders`
//  are the tools the print uses. Returns "" or the reason. One session at a time (file-static), like the custom
//  G-code session.
std::string begin(const std::string& settings_json, const std::vector<unsigned int>& extruders);
bool active();
// CoolingBuffer::process_layer for one layer, in print order: `current_extruder` is the tool loaded when it starts.
std::string process_layer(std::string&& gcode, int layer_id, unsigned int current_extruder);
// The role fan regions the kernel marks for one filament (GCode::_extrude :7729-7795): the overhang fan when
//  enable_overhang_bridge_fan is on (on the outer wall too when overhang_fan_threshold is 0%), the support interface fan
//  and the ironing fan when their speed is set (not -1).
struct Markers {
  bool overhang = false, overhang_external = false, support_interface = false, ironing = false;
  // overhang_fan_threshold as the overlap a wall segment may have with the layer below and still get the overhang fan
  //  (GCode.cpp check_overhang_fan): 0.9 for 10%, 0.75, 0.5, 0.25, 0.05 for 95%; -1 for 0% (external walls only).
  double overhang_overlap = -1.0;
};
Markers markers(unsigned int extruder);
void end();

} // namespace cooling_bridge
