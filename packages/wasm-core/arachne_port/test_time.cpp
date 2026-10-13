// Stage-10: validate the ported time algorithm standalone.
// Build and run natively (no emscripten needed — gcode_time has no platform dependency):
//   clang++ -O1 -std=c++17 -o /tmp/test_time test_time.cpp ../gcode_time.cpp && /tmp/test_time
// Exit code 0 means every check passed.
#include <cstdio>
#include <cmath>
#include <string>
#include <vector>
#include "../gcode_time.h"
using namespace gcode_time;

static std::string square_gcode(int F_mm_min, int loops){
    // a 50mm square extruding at feedrate F, then travel back
    std::string gcode = "G21\nG90\nM83\n; LAYER 0 Z0.200\nG1 Z0.200 F1200\n";
    char line[128];
    double e_per_segment = 1.5; // mm E per 50mm segment (arbitrary)
    for (int loop=0;loop<loops;++loop){
        snprintf(line,sizeof line,"G1 X50.000 Y0.000 E%.5f F%d\n", e_per_segment, F_mm_min);
        gcode+=line;
        snprintf(line,sizeof line,"G1 X50.000 Y50.000 E%.5f F%d\n", e_per_segment, F_mm_min);
        gcode+=line;
        snprintf(line,sizeof line,"G1 X0.000 Y50.000 E%.5f F%d\n", e_per_segment, F_mm_min);
        gcode+=line;
        snprintf(line,sizeof line,"G1 X0.000 Y0.000 E%.5f F%d\n", e_per_segment, F_mm_min);
        gcode+=line;
        gcode += "G0 X10.000 Y10.000 F9000\n";
    }
    return gcode;
}

// The same Result whichever way the text is fed: whole, or in chunks of any size (a line may be split anywhere).
//  This is what lets the mt feeder hand a partially fed G-code to the Estimator past GCodeProcessor's move cap.
static bool same_result(const Result& left, const Result& right){
    return left.total_s==right.total_s && left.moves==right.moves && left.filament_mm==right.filament_mm && left.first_layer_s==right.first_layer_s
        && left.extrude_s==right.extrude_s && left.travel_s==right.travel_s && left.layer_s==right.layer_s && left.role_s==right.role_s;
}
// The verdict word of a comparison, for the printed lines below.
static const char* same_word(bool equal){
    if (equal) return "same";
    return "DIFFERENT";
}
static bool check_chunked(const Limits& limits){
    std::string gcode = square_gcode(1200, 20) + ";_EXTRUSION_ROLE:3\n; LAYER 1 Z0.400\nG1 Z0.400\nG1 X5.000 Y5.000 E0.20000 F3000";   // no trailing newline
    Result whole = estimate(gcode, limits);
    bool ok = true;
    for (size_t step : {size_t(1), size_t(7), size_t(64), size_t(1000), gcode.size()}) {
        Estimator estimator(limits);
        for (size_t i=0;i<gcode.size();i+=step) estimator.feed(gcode.data()+i, std::min(step, gcode.size()-i));
        Result chunked = estimator.end();
        bool equal = same_result(whole, chunked);
        printf("chunk step %zu: %s (total=%.6f moves=%ld layers=%zu)\n", step, same_word(equal), chunked.total_s, chunked.moves, chunked.layer_s.size());
        ok = ok && equal;
    }
    return ok;
}
// Every number form the fast decimal path declines must still be read as strtod reads it: the exotic spellings below and their
//  canonical twins have to give the same estimate.
static bool check_token_forms(const Limits& limits){
    const char* head = "G90\nM83\n; LAYER 0 Z0.200\nG1 Z0.200 F1200\n";
    std::string exotic = std::string(head) +
        "G1 X1e2 Y0.000 E1.50000 F1200\n"          // exponent -> strtod
        "G1 X100.000 Y 50 E+1.5 F1200\n"           // leading space, explicit plus
        "G1 x0. y50.000 e1.50000 F1200\n"          // lowercase, trailing dot
        "G1 X.000 Y-0.000 E1.5000000000000000 F1200\n"   // leading dot, negative zero, 17 digits -> strtod
        "G1 X0.000 Y0.000 E1.50000 F1.2e3\n";      // exponent feedrate
    std::string canonical = std::string(head) +
        "G1 X100.000 Y0.000 E1.50000 F1200\n"
        "G1 X100.000 Y50.000 E1.50000 F1200\n"
        "G1 X0.000 Y50.000 E1.50000 F1200\n"
        "G1 X0.000 Y0.000 E1.50000 F1200\n"
        "G1 X0.000 Y0.000 E1.50000 F1200\n";
    Result exotic_result = estimate(exotic, limits);
    Result canonical_result = estimate(canonical, limits);
    bool equal = same_result(exotic_result, canonical_result);
    printf("token forms: %s (total=%.6f vs %.6f, moves=%ld vs %ld, filament=%.6f vs %.6f)\n", same_word(equal),
           exotic_result.total_s, canonical_result.total_s, exotic_result.moves, canonical_result.moves,
           exotic_result.filament_mm, canonical_result.filament_mm);
    return equal;
}
int main(){
    Limits limits;
    bool ok = check_chunked(limits) && check_token_forms(limits);
    Result slow = estimate(square_gcode(1200, 20), limits);   // 20 mm/s
    Result fast = estimate(square_gcode(6000, 20), limits);   // 100 mm/s
    printf("slow(20mm/s): total=%.3fs moves=%ld filament=%.3fmm layer0=%.3fs\n", slow.total_s, slow.moves, slow.filament_mm, slow.first_layer_s);
    printf("fast(100mm/s): total=%.3fs moves=%ld filament=%.3fmm\n", fast.total_s, fast.moves, fast.filament_mm);
    printf("total>0=%d  faster_is_less=%d  filament_equal=%d\n",
           slow.total_s>0.0, fast.total_s < slow.total_s, (int)(std::abs(slow.filament_mm-fast.filament_mm)<1e-6));
    // manual sanity: 20 loops * 200mm/loop = 4000mm extrude at ~20mm/s -> ~200s+ (plus accel). Print time plausible.
    ok = ok && slow.total_s > 0.0 && fast.total_s < slow.total_s && std::abs(slow.filament_mm-fast.filament_mm) < 1e-6;
    if (!ok) {
        printf("test_time: FAILED\n");
        return 1;
    }
    printf("test_time: all checks passed\n");
    return 0;
}
