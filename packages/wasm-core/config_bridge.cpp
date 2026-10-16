// Stage-12 bridge implementation: the ONLY translation unit in the MAIN build where the kernel meets
// the real Slic3r config subsystem. Includes the real ported PrintConfig.hpp (resolved relative to
// wasm-core/); its internal includes (Config.hpp, Polygon.hpp, CommonDefs.hpp) fall through to
// arachne_port/libslic3r (real). Everything Slic3r stays inside this TU; config_bridge.h exposes only
// plain types.
#include "config_bridge.h"
#include "arachne_port/config/libslic3r/PrintConfig.hpp"
#include "arachne_port/wipetower/GCode/WipeTower.hpp"   // real ported WipeTower (TriangleMesh stub via -Iwipetower/inc)
#include <sstream>
#include <cctype>
#include <cstdlib>

using namespace Slic3r;

namespace config_bridge {

int option_count() {
    return (int) print_config_def.options.size();
}

std::string option_default(const std::string& key) {
    auto definition = print_config_def.get(key);
    if (!definition || !definition->default_value) return std::string();
    return definition->default_value->serialize();
}

// ---- coordinate + E helpers for splicing the real WipeTower block into the kernel output ----

// Shift the absolute X/Y of a G0/G1/G2/G3 move by (dx,dy) in-place in a gcode line, leaving Z/E/F and
// arc I/J (relative offsets) untouched. Returns the rewritten line.
static std::string shift_axis(std::string line, char axis, double offset) {
    // find " <axis><number>" (axis preceded by whitespace so we don't touch letters inside comments)
    for (size_t i = 1; i < line.size(); ++i) {
        if (line[i] == axis && (line[i-1] == ' ' || line[i-1] == '\t')) {
            size_t j = i + 1, start = j;
            while (j < line.size() && (std::isdigit((unsigned char)line[j]) || line[j]=='.' || line[j]=='-' || line[j]=='+')) ++j;
            if (j == start) continue;
            double value = std::atof(line.substr(start, j-start).c_str());
            char formatted[32];
            std::snprintf(formatted, sizeof formatted, "%.3f", value + offset);
            line = line.substr(0, i+1) + formatted + line.substr(j);
            break; // one occurrence per line
        }
    }
    return line;
}

WipeTowerBlock wipe_tower_block(double bed_x0, double bed_y0, double bed_width, double bed_depth, double first_layer_height, double layer_height,
                                double z, bool is_first_layer, int old_tool, int new_tool,
                                double tower_x, double tower_y, double tower_width,
                                double filament_diameter, double purge_volume_mm3) {
    WipeTowerBlock out;
    try {
        PrintConfig config; // real StaticPrintConfig from print_config_def defaults
        config.printable_area.values = { Vec2d(bed_x0,bed_y0), Vec2d(bed_x0+bed_width,bed_y0), Vec2d(bed_x0+bed_width,bed_y0+bed_depth), Vec2d(bed_x0,bed_y0+bed_depth) };
        config.nozzle_diameter.values = { 0.4, 0.4 };
        config.single_extruder_multi_material.value = true;
        config.wipe_tower_x.values = { tower_x };
        config.wipe_tower_y.values = { tower_y };
        config.wipe_tower_rotation_angle.value = 0.0;
        config.prime_tower_width.value = tower_width;
        config.filament_diameter.values = { filament_diameter, filament_diameter };
        config.travel_speed.values = { 120.0 };
        config.initial_layer_speed.values = { 30.0 };
        config.filament_change_length.values = { 0.0, 0.0 };
        config.hotend_heating_rate.values = { 2.0, 2.0 };
        config.physical_extruder_map.values = { 0, 1 };
        config.extruder_max_nozzle_count.values = { 1, 1 };
        config.extruder_printable_height.values = {};

        const float height = (float)std::max(z + layer_height, 2.0);
        WipeTower wipe_tower(config, 0, Vec3d(0,0,0), (size_t)old_tool, height,
                     std::vector<unsigned int>{ (unsigned)old_tool, (unsigned)new_tool });
        wipe_tower.set_extruder(0, config);
        wipe_tower.set_extruder(1, config);
        wipe_tower.set_layer((float)z, (float)layer_height, 1, is_first_layer, false);
        // 100 was a placeholder standing in for "some purge". Upstream feeds plan_toolchange the volume its
        //  flush matrix computed for exactly this pair (ToolOrdering.cpp get_flush_volume), which is what makes a
        //  white->black change cost more than white->white.
        float wipe_volume = 100.0f;
        if (purge_volume_mm3 >= 0) wipe_volume = (float)purge_volume_mm3;
        wipe_tower.plan_toolchange((float)z, (float)layer_height, (unsigned)old_tool, (unsigned)new_tool, wipe_volume, 0.0f);

        std::vector<std::vector<WipeTower::ToolChangeResult>> result;
        wipe_tower.generate(result);

        const double offset_x = bed_x0 + bed_width * 0.5, offset_y = bed_y0 + bed_depth * 0.5;   // the bed centre (Params::bed_center_x/y)
        std::ostringstream gcode_stream;
        for (auto& layer : result) {
            for (auto& toolchange : layer) {
                // The ToolChangeResult gcode assumes the nozzle already sits at the tower start
                // (the real GCode pipeline travels there). Prepend that travel (bed coords).
                {
                    char travel_line[80];
                    std::snprintf(travel_line, sizeof travel_line, "G0 X%.3f Y%.3f F9000 ; travel to wipe tower\n",
                        toolchange.start_pos.x() + (float)tower_x, toolchange.start_pos.y() + (float)tower_y);
                    gcode_stream << travel_line;
                }
                // translate tower-local gcode -> bed coords, sum relative E
                std::istringstream in(toolchange.gcode);
                std::string line;
                while (std::getline(in, line)) {
                    // The real WipeTower emits PlaceholderParser tokens ([filament_end_gcode] etc.)
                    // for the surrounding GCode pipeline to expand. The mini-kernel has no parser, so
                    // annotate them as comments instead of emitting raw tokens a printer can't parse.
                    {
                        size_t first_char = line.find_first_not_of(" \t");
                        if (first_char != std::string::npos && line[first_char] == '[') {
                            gcode_stream << "; " << line << " (placeholder — not expanded)\n";
                            continue;
                        }
                    }
                    if (!line.empty() && line[0] == 'G') {
                        line = shift_axis(line, 'X', tower_x);
                        line = shift_axis(line, 'Y', tower_y);
                        // sum E (relative)
                        for (size_t i = 1; i < line.size(); ++i)
                            if (line[i] == 'E' && (line[i-1]==' '||line[i-1]=='\t')) {
                                double extrusion = std::atof(line.c_str() + i + 1);
                                if (extrusion > 0) out.filament_mm += extrusion;
                                break;
                            }
                    }
                    gcode_stream << line << '\n';
                }
                // toolpath from extrusion polyline (tower-local -> MODEL coords = bed - off)
                const auto& extrusions = toolchange.extrusions;
                for (size_t i = 1; i < extrusions.size(); ++i) {
                    if (extrusions[i].width <= 0.f) continue; // travel move
                    float x0 = extrusions[i-1].pos.x() + (float)(tower_x - offset_x);
                    float y0 = extrusions[i-1].pos.y() + (float)(tower_y - offset_y);
                    float x1 = extrusions[i].pos.x()   + (float)(tower_x - offset_x);
                    float y1 = extrusions[i].pos.y()   + (float)(tower_y - offset_y);
                    out.toolpath.push_back(x0);
                    out.toolpath.push_back(y0);
                    out.toolpath.push_back((float)z);
                    out.toolpath.push_back(11.0f);
                    out.toolpath.push_back(x1);
                    out.toolpath.push_back(y1);
                    out.toolpath.push_back((float)z);
                    out.toolpath.push_back(11.0f);
                }
            }
        }
        out.gcode = gcode_stream.str();
        out.ok = !out.gcode.empty();
    } catch (...) {
        out.ok = false;
    }
    return out;
}

} // namespace config_bridge
