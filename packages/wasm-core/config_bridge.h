// Stage-12 bridge: plain-type interface to the ported REAL OrcaSlicer config subsystem
// (Config.cpp + PrintConfig.cpp, i.e. the global print_config_def + StaticPrintConfig hierarchy).
// slicer_core.cpp includes ONLY this header — no Slic3r / PrintConfig / ClipperLib types leak in, so
// the kernel keeps its own global ClipperLib separate from the port's Slic3r::ClipperLib. This is the
// ONLY seam where the main build meets the real config subsystem (same isolation as arachne_bridge).
#pragma once
#include <vector>
#include <string>
#include <utility>

namespace config_bridge {

// Number of options in the real global print_config_def (build-based ground truth).
// Referencing this from an embind export keeps the whole config subsystem linked (not dead-stripped)
// and proves the main module runs on the real config at startup.
int option_count();

// Serialized default of one print_config_def option (empty if the key is unknown / has no default).
std::string option_default(const std::string& key);

// -------- Stage-12 item 2: real WipeTower tool-change block (wipe_tower_real) --------
// One tool-change wipe-tower block from the REAL ported WipeTower.generate(), placed at (tower_x,
// tower_y) on the bed. `gcode` is ready to splice into the kernel output (bed coords = final coords,
// relative E — matches the kernel's M83 mode, original markers ; CP TOOLCHANGE / ; WIPE_TOWER_START
// preserved). `toolpath` is flat push_seg octets [x0,y0,z,type, x1,y1,z,type] in MODEL coords (bed
// minus bed/2 offset), type = 11 (prime tower), for the viewer. `filament_mm` = summed relative E.
struct WipeTowerBlock {
    std::string        gcode;
    std::vector<float> toolpath;
    double             filament_mm = 0.0;
    bool               ok = false;
};
WipeTowerBlock wipe_tower_block(double bed_x0, double bed_y0, double bed_w, double bed_d, double first_layer_h, double layer_h,
                                double z, bool is_first_layer, int old_tool, int new_tool,
                                double tower_x, double tower_y, double tower_width,
                                double filament_diameter,
                                // mm³ this filament pair has to purge (Params::flushVolume). <0 = the host sent no
                                // purge table, and the tower keeps the fixed volume it used before one existed.
                                double purge_volume_mm3);

} // namespace config_bridge
