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
enum class Flavor;

// The templates expanded here are machine_start_gcode, machine_end_gcode and filament_end_gcode. The host sends the
//  settings when one of them has text (CUSTOM_GCODE_KEYS, settings_core.js); test_custom_gcode.mjs fails when the
//  two lists differ.
bool custom_gcode_active(const Params& p);

// The start block, expanded: the temperature lines upstream writes around it and the template itself.
struct CustomStart {
  std::string before, text, after;
  int bed_set = 0;   // the bed temperature the start block leaves set (the writer's state upstream; 0 = never set)
  std::string chamber;   // M191 when a used filament asks for chamber control and the template does not set it
  std::string file_start;   // file_start_gcode, written at the very top of the file
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

// Whether the host's settings describe a Bambu Lab printer, read from placeholder_config without starting a session.
bool custom_gcode_is_bbl(const Params& p);

// The error text a slice returns, CUSTOM_GCODE_ERROR: <template key>: <parser message>.
std::string custom_gcode_error(const std::string& reason);

// ---- Layer templates (GCode::process_layer :5407-5517) ----------------------------------------------------------
// Whether the printer has any template expanded at a layer change: before_layer_change_gcode, layer_change_gcode, and
//  on a printer other than Bambu Lab's (whose firmware handles both itself) time_lapse_gcode and the first
//  filament's filament_start_gcode. The writers then leave slot lines around each layer's Z move (GW::layer_z).
bool custom_gcode_layer_slots();
// Starts the layer sequence (max_layer_z and the printed mass go back to zero).
void custom_gcode_layers_begin();
// Replaces one layer's slot lines with the expanded templates, in print order. `extruded_mm3` is the volume each
//  filament extruded before this layer. An error leaves the text as it was and sets `error`.
std::string custom_gcode_layer(std::string text, int layer, double layer_z, int tool, const std::vector<double>& extruded_mm3,
                               std::string& error);

// ---- Tool changes (GCode::set_extruder :8714, append_tcr :956) ---------------------------------------------------
// The multi-material writer marks each change with a TOOLCHANGE_SLOT line and records it here; once the template
//  session runs, the slots are replaced in print order by the old filament's filament_end_gcode,
//  change_filament_gcode with the T command it does not write itself, and the new filament's filament_start_gcode
//  and pressure advance. The first selection after the start G-code leaves its filament_start_gcode to the first
//  layer's slot, where the single-material path writes it too.
struct ToolchangeAt {
  custom_gcode_bridge::Toolchange change;
  bool initial = false;
};
std::string custom_gcode_toolchanges(std::string text, const std::vector<ToolchangeAt>& changes, Flavor flavor, std::string& error);
