// Stage-13 diagnostic: known g-code, exact E, inspect move-type histogram + filament + print_z.
#include <cstdio>
#include <string>
#include <map>
#include "GCode/GCodeProcessor.hpp"
#include "PrintConfig.hpp"
using namespace Slic3r;

int main() {
    // 3 layers, each: travel + 4 extruding edges E1.0 => expected filament = 3*4*1.0 = 12.0 mm
    std::string gcode = "; test\nG21\nG90\nM83\nG28\n";
    for (int layer=0;layer<3;++layer){
        char line[128];
        std::snprintf(line,sizeof line,"G1 Z%.2f F600\n", 0.2*(layer+1));
        gcode+=line;
        gcode+="G1 X0 Y0 F6000\n";
        gcode+="G1 X40 Y0 E1.0 F1800\nG1 X40 Y40 E1.0 F1800\nG1 X0 Y40 E1.0 F1800\nG1 X0 Y0 E1.0 F1800\n";
    }
    GCodeProcessor processor;
    PrintConfig config;
    processor.apply_config(config);
    processor.process_buffer(gcode);
    processor.finalize(false);
    const auto& result = processor.get_result();
    const int normal_mode=(int)PrintEstimatedStatistics::ETimeMode::Normal;
    std::map<int,int> type_histogram;
    double filament_all=0;
    double filament_extrude=0;
    int moves_with_z=0;
    double max_z=0;
    for (auto& move : result.moves){
        type_histogram[(int)move.type]++;
        if (move.delta_extruder>0){
            filament_all+=move.delta_extruder;
            if(move.type==EMoveType::Extrude) filament_extrude+=move.delta_extruder;
        }
        if (move.print_z>0){
            moves_with_z++;
            if(move.print_z>max_z)max_z=move.print_z;
        }
    }
    printf("total_moves=%zu total_time=%.3f\n", result.moves.size(), result.print_statistics.modes[normal_mode].time);
    printf("filament: all_delta>0=%.3f  extrude_only=%.3f  (expected 12.0)\n", filament_all, filament_extrude);
    printf("moves with print_z>0: %d / %zu  maxz=%.3f\n", moves_with_z, result.moves.size(), max_z);
    printf("type histogram (8=Travel,10=Extrude): ");
    for (auto&entry:type_histogram) printf("[%d]=%d ", entry.first, entry.second);
    printf("\n");
    return 0;
}
