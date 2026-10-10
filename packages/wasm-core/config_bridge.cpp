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
    auto d = print_config_def.get(key);
    if (!d || !d->default_value) return std::string();
    return d->default_value->serialize();
}

// ---- coordinate + E helpers for splicing the real WipeTower block into the kernel output ----

// Shift the absolute X/Y of a G0/G1/G2/G3 move by (dx,dy) in-place in a gcode line, leaving Z/E/F and
// arc I/J (relative offsets) untouched. Returns the rewritten line.
static std::string shift_axis(std::string line, char axis, double d) {
    // find " <axis><number>" (axis preceded by whitespace so we don't touch letters inside comments)
    for (size_t i = 1; i < line.size(); ++i) {
        if (line[i] == axis && (line[i-1] == ' ' || line[i-1] == '\t')) {
            size_t j = i + 1, start = j;
            while (j < line.size() && (std::isdigit((unsigned char)line[j]) || line[j]=='.' || line[j]=='-' || line[j]=='+')) ++j;
            if (j == start) continue;
            double v = std::atof(line.substr(start, j-start).c_str());
            char buf[32]; std::snprintf(buf, sizeof buf, "%.3f", v + d);
            line = line.substr(0, i+1) + buf + line.substr(j);
            break; // one occurrence per line
        }
    }
    return line;
}

WipeTowerBlock wipe_tower_block(double bed_x0, double bed_y0, double bed_w, double bed_d, double first_layer_h, double layer_h,
                                double z, bool is_first_layer, int old_tool, int new_tool,
                                double tower_x, double tower_y, double tower_width,
                                double filament_diameter, double purge_volume_mm3) {
    WipeTowerBlock out;
    try {
        PrintConfig cfg; // real StaticPrintConfig from print_config_def defaults
        cfg.printable_area.values = { Vec2d(bed_x0,bed_y0), Vec2d(bed_x0+bed_w,bed_y0), Vec2d(bed_x0+bed_w,bed_y0+bed_d), Vec2d(bed_x0,bed_y0+bed_d) };
        cfg.nozzle_diameter.values = { 0.4, 0.4 };
        cfg.single_extruder_multi_material.value = true;
        cfg.wipe_tower_x.values = { tower_x };
        cfg.wipe_tower_y.values = { tower_y };
        cfg.wipe_tower_rotation_angle.value = 0.0;
        cfg.prime_tower_width.value = tower_width;
        cfg.filament_diameter.values = { filament_diameter, filament_diameter };
        cfg.travel_speed.values = { 120.0 };
        cfg.initial_layer_speed.values = { 30.0 };
        cfg.filament_change_length.values = { 0.0, 0.0 };
        cfg.hotend_heating_rate.values = { 2.0, 2.0 };
        cfg.physical_extruder_map.values = { 0, 1 };
        cfg.extruder_max_nozzle_count.values = { 1, 1 };
        cfg.extruder_printable_height.values = {};

        const float height = (float)std::max(z + layer_h, 2.0);
        WipeTower wt(cfg, 0, Vec3d(0,0,0), (size_t)old_tool, height,
                     std::vector<unsigned int>{ (unsigned)old_tool, (unsigned)new_tool });
        wt.set_extruder(0, cfg);
        wt.set_extruder(1, cfg);
        wt.set_layer((float)z, (float)layer_h, 1, is_first_layer, false);
        // 100 was a placeholder standing in for "some purge". Upstream feeds plan_toolchange the volume its
        //  flush matrix computed for exactly this pair (ToolOrdering.cpp get_flush_volume), which is what makes a
        //  white->black change cost more than white->white.
        const float wipe_volume = purge_volume_mm3 >= 0 ? (float)purge_volume_mm3 : 100.0f;
        wt.plan_toolchange((float)z, (float)layer_h, (unsigned)old_tool, (unsigned)new_tool, wipe_volume, 0.0f);

        std::vector<std::vector<WipeTower::ToolChangeResult>> result;
        wt.generate(result);

        const double offX = bed_x0 + bed_w * 0.5, offY = bed_y0 + bed_d * 0.5;   // the bed centre (Params::bed_center_x/y)
        std::ostringstream gc;
        for (auto& layer : result) {
            for (auto& tcr : layer) {
                // The ToolChangeResult gcode assumes the nozzle already sits at the tower start
                // (the real GCode pipeline travels there). Prepend that travel (bed coords).
                { char t[80]; std::snprintf(t, sizeof t, "G0 X%.3f Y%.3f F9000 ; travel to wipe tower\n",
                    tcr.start_pos.x() + (float)tower_x, tcr.start_pos.y() + (float)tower_y); gc << t; }
                // translate tower-local gcode -> bed coords, sum relative E
                std::istringstream in(tcr.gcode);
                std::string line;
                while (std::getline(in, line)) {
                    // The real WipeTower emits PlaceholderParser tokens ([filament_end_gcode] etc.)
                    // for the surrounding GCode pipeline to expand. The mini-kernel has no parser, so
                    // annotate them as comments instead of emitting raw tokens a printer can't parse.
                    { size_t a = line.find_first_not_of(" \t");
                      if (a != std::string::npos && line[a] == '[') { gc << "; " << line << " (placeholder — not expanded)\n"; continue; } }
                    if (!line.empty() && line[0] == 'G') {
                        line = shift_axis(line, 'X', tower_x);
                        line = shift_axis(line, 'Y', tower_y);
                        // sum E (relative)
                        for (size_t i = 1; i < line.size(); ++i)
                            if (line[i] == 'E' && (line[i-1]==' '||line[i-1]=='\t')) {
                                double e = std::atof(line.c_str() + i + 1);
                                if (e > 0) out.filament_mm += e;
                                break;
                            }
                    }
                    gc << line << '\n';
                }
                // toolpath from extrusion polyline (tower-local -> MODEL coords = bed - off)
                const auto& ex = tcr.extrusions;
                for (size_t i = 1; i < ex.size(); ++i) {
                    if (ex[i].width <= 0.f) continue; // travel move
                    float x0 = ex[i-1].pos.x() + (float)(tower_x - offX);
                    float y0 = ex[i-1].pos.y() + (float)(tower_y - offY);
                    float x1 = ex[i].pos.x()   + (float)(tower_x - offX);
                    float y1 = ex[i].pos.y()   + (float)(tower_y - offY);
                    out.toolpath.push_back(x0); out.toolpath.push_back(y0); out.toolpath.push_back((float)z); out.toolpath.push_back(11.0f);
                    out.toolpath.push_back(x1); out.toolpath.push_back(y1); out.toolpath.push_back((float)z); out.toolpath.push_back(11.0f);
                }
            }
        }
        out.gcode = gc.str();
        out.ok = !out.gcode.empty();
    } catch (...) {
        out.ok = false;
    }
    return out;
}

} // namespace config_bridge
