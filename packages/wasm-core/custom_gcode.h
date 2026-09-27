// custom_gcode.h — issue 63: the kernel side of a printer profile's custom G-code. Whether the templates are
// expanded is decided by one thing: the host sent the flattened settings (`placeholder_config`). Without them the
// raw path stays exactly as it was (the start/end strings are copied as written), which is what keeps every
// existing caller byte-identical.
#pragma once
#include "custom_gcode_bridge.h"

#include <string>
#include <vector>

struct Params;
struct GW;
struct LayerData;

bool custom_gcode_active(const Params& p);

// The start block, expanded: the temperature lines upstream writes around it and the template itself.
struct CustomStart {
  std::string before, text, after;
};

// The Facts of a single-material slice (one filament, T0): the first layer's outline is the model's layer-0
// contour with its support, skirt and brim, or the raft with its skirt, the same geometry pass2/raft emit.
custom_gcode_bridge::Facts single_material_facts(const Params& p, const std::vector<LayerData>& L, int N,
                                                 double offX, double offY);

// Loads the settings and expands machine_start_gcode. Returns "" or the error the slice fails with.
std::string custom_gcode_start(const Params& p, const custom_gcode_bridge::Facts& facts, CustomStart& out);

// Writes the end block the way GCode::_do_export does (GCode.cpp:3881-3930): fan off, the Bambu Lab spaghetti
// detector off, every filament's filament_end_gcode, then machine_end_gcode. Returns "" or the error.
std::string custom_gcode_end(GW& gw, int layer_num, double layer_z, double max_layer_z, int current_extruder);

// The error text a slice returns, CUSTOM_GCODE_ERROR: <template key>: <parser message>.
std::string custom_gcode_error(const std::string& reason);
