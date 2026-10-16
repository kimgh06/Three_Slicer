// Stage-8: prove the real ported PressureEqualizer smooths/splits a flow discontinuity.
// Synthetic layer: a low-flow extrusion then a high-flow extrusion over a long distance. With a
// tight slope limit the real PE must ramp the feedrate across the fast move (splitting it).
#include <cstdio>
#include <string>
#include <regex>
#include "../pe_bridge.h"

static int countG1(const std::string& gcode){
    int count=0;
    size_t position=0;
    while((position=gcode.find("\nG1 ",position))!=std::string::npos){
        ++count;
        ++position;
    }
    return count;
}
static double eSum(const std::string& gcode){
    double sum=0;
    std::regex e_value("E(-?[0-9.]+)");
    auto match_begin=std::sregex_iterator(gcode.begin(),gcode.end(),e_value);
    auto match_end=std::sregex_iterator();
    for(auto it=match_begin;it!=match_end;++it) sum+=std::stod((*it)[1].str());
    return sum;
}

int main() {
    // relative-E g-code (M83), wrapped in OrcaSlicer's EXTRUDE_SET_SPEED/EXTRUDE_END markers so the
    // real PE treats the extrusions as adjustable. Long fast move after a slow one → big volumetric jump.
    std::string in =
        "M83\n"
        ";_EXTRUSION_ROLE:2\n"
        "G1 X0 Y0 F9000\n"
        ";_EXTRUDE_SET_SPEED\n"
        "G1 X10 Y0 E0.30 F600\n"      // slow, low flow
        "G1 X60 Y0 E7.50 F3600\n"     // 50mm fast, high flow — must be ramped/split
        ";_EXTRUDE_END\n"
        "G1 X61 Y0 E0.15 F600\n";
    std::string out = pe_bridge::equalize(in, /*filament_dia*/1.75, /*max_slope mm3/s2*/2.0,
                                          /*segment_len mm*/1.0, /*relative_e*/true, /*ext_perim_only*/false);
    printf("IN  G1=%d Esum=%.4f\n", countG1(in), eSum(in));
    printf("OUT G1=%d Esum=%.4f\n", countG1(out), eSum(out));
    int split = 0;
    if (countG1(out) > countG1(in)) split = 1;
    int e_conserved = 0;
    if (std::abs(eSum(out) - eSum(in)) < 1e-3) e_conserved = 1;
    printf("split=%d (OUT G1 > IN G1)  E_conserved=%d\n", split, e_conserved);
    // show a snippet
    printf("--- OUT (first 500 chars) ---\n%s\n", out.substr(0, 500).c_str());
    return 0;
}
