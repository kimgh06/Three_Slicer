// Stage-11 WipeTower link+run probe: constructs a real WipeTower on the ported real PrintConfig and
// drives it far enough to emit the original tool-change g-code markers (; WIPE_TOWER_START etc.).
#include <cstdio>
#include <vector>
#include <string>
#include "WipeTower.hpp"
#include "PrintConfig.hpp"

using namespace Slic3r;

int main() {
    PrintConfig config; // real StaticPrintConfig, default-initialized from print_config_def

    // Minimal multi-material setup (direct static-config member writes).
    config.printable_area.values = { Vec2d(0,0), Vec2d(200,0), Vec2d(200,200), Vec2d(0,200) };
    config.nozzle_diameter.values = { 0.4, 0.4 };
    config.single_extruder_multi_material.value = true;
    config.wipe_tower_x.values = { 15.0 };
    config.wipe_tower_y.values = { 15.0 };
    config.travel_speed.values = { 120.0 };
    config.initial_layer_speed.values = { 30.0 };
    config.filament_change_length.values = { 0.0, 0.0 };
    config.hotend_heating_rate.values = { 2.0, 2.0 };
    config.physical_extruder_map.values = { 0, 1 };
    config.extruder_max_nozzle_count.values = { 1, 1 };
    config.extruder_printable_height.values = {};

    printf("PrintConfig built: nozzle_diameter.size=%zu prime_tower_width=%.1f\n",
           config.nozzle_diameter.size(), (double)config.prime_tower_width.value);

    WipeTower wipe_tower(config, 0, Vec3d(0,0,0), 0, 30.0f, std::vector<unsigned int>{0u,1u});
    printf("WipeTower constructed: width=%.2f pos=(%.1f,%.1f)\n",
           (double)wipe_tower.width(), (double)wipe_tower.position().x(), (double)wipe_tower.position().y());

    // Drive a single tool change and generate.
    int marker_start = 0;
    int marker_change_layer = 0;
    int marker_feature = 0;
    int total_gcode = 0;
    try {
        wipe_tower.set_extruder(0, config);
        wipe_tower.set_extruder(1, config);
        wipe_tower.plan_toolchange(0.2f, 0.2f, 0, 1, 100.0f, 0.0f);
        std::vector<std::vector<WipeTower::ToolChangeResult>> result;
        wipe_tower.generate(result);
        for (auto& layer : result)
            for (auto& change_result : layer) {
                total_gcode += (int)change_result.gcode.size();
                if (change_result.gcode.find("WIPE_TOWER_START") != std::string::npos) marker_start++;
                if (change_result.gcode.find("CHANGE_LAYER") != std::string::npos || change_result.gcode.find("CHANGE LAYER") != std::string::npos) marker_change_layer++;
                if (change_result.gcode.find("FEATURE") != std::string::npos || change_result.gcode.find("TYPE:") != std::string::npos) marker_feature++;
            }
        printf("generate() ok: layers=%zu total_gcode_bytes=%d markers{wipe_tower_start=%d change_layer=%d feature=%d}\n",
               result.size(), total_gcode, marker_start, marker_change_layer, marker_feature);
        // Emit a snippet of the first non-empty gcode for eyeballing markers.
        for (auto& layer : result) {
            for (auto& change_result : layer)
                if (!change_result.gcode.empty()) {
                    std::string snippet = change_result.gcode.substr(0, 400);
                    printf("---- first tcr gcode (first 400 bytes) ----\n%s\n----\n", snippet.c_str());
                    return 0;
                }
        }
    } catch (const std::exception& error) {
        printf("generate() threw: %s (construct+link OK; generation needs deeper pipeline setup)\n", error.what());
    }
    return 0;
}
