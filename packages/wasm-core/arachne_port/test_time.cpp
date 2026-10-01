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
    std::string g = "G21\nG90\nM83\n; LAYER 0 Z0.200\nG1 Z0.200 F1200\n";
    char buf[128];
    double e = 1.5; // mm E per 50mm segment (arbitrary)
    for (int l=0;l<loops;++l){
        snprintf(buf,sizeof buf,"G1 X50.000 Y0.000 E%.5f F%d\n", e, F_mm_min); g+=buf;
        snprintf(buf,sizeof buf,"G1 X50.000 Y50.000 E%.5f F%d\n", e, F_mm_min); g+=buf;
        snprintf(buf,sizeof buf,"G1 X0.000 Y50.000 E%.5f F%d\n", e, F_mm_min); g+=buf;
        snprintf(buf,sizeof buf,"G1 X0.000 Y0.000 E%.5f F%d\n", e, F_mm_min); g+=buf;
        g += "G0 X10.000 Y10.000 F9000\n";
    }
    return g;
}

// The same Result whichever way the text is fed: whole, or in chunks of any size (a line may be split anywhere).
//  This is what lets the mt feeder hand a partially fed G-code to the Estimator past GCodeProcessor's move cap.
static bool same_result(const Result& a, const Result& b){
    return a.total_s==b.total_s && a.moves==b.moves && a.filament_mm==b.filament_mm && a.first_layer_s==b.first_layer_s
        && a.extrude_s==b.extrude_s && a.travel_s==b.travel_s && a.layer_s==b.layer_s && a.role_s==b.role_s;
}
// The verdict word of a comparison, for the printed lines below.
static const char* same_word(bool eq){
    if (eq) return "same";
    return "DIFFERENT";
}
static bool check_chunked(const Limits& lim){
    std::string g = square_gcode(1200, 20) + ";_EXTRUSION_ROLE:3\n; LAYER 1 Z0.400\nG1 Z0.400\nG1 X5.000 Y5.000 E0.20000 F3000";   // no trailing newline
    Result whole = estimate(g, lim);
    bool ok = true;
    for (size_t step : {size_t(1), size_t(7), size_t(64), size_t(1000), g.size()}) {
        Estimator est(lim);
        for (size_t i=0;i<g.size();i+=step) est.feed(g.data()+i, std::min(step, g.size()-i));
        Result r = est.end();
        bool eq = same_result(whole, r);
        printf("chunk step %zu: %s (total=%.6f moves=%ld layers=%zu)\n", step, same_word(eq), r.total_s, r.moves, r.layer_s.size());
        ok = ok && eq;
    }
    return ok;
}
// Every number form the fast decimal path declines must still be read as strtod reads it: the exotic spellings below and their
//  canonical twins have to give the same estimate.
static bool check_token_forms(const Limits& lim){
    const char* head = "G90\nM83\n; LAYER 0 Z0.200\nG1 Z0.200 F1200\n";
    std::string exotic = std::string(head) +
        "G1 X1e2 Y0.000 E1.50000 F1200\n"          // exponent -> strtod
        "G1 X100.000 Y 50 E+1.5 F1200\n"           // leading space, explicit plus
        "G1 x0. y50.000 e1.50000 F1200\n"          // lowercase, trailing dot
        "G1 X.000 Y-0.000 E1.5000000000000000 F1200\n"   // leading dot, negative zero, 17 digits -> strtod
        "G1 X0.000 Y0.000 E1.50000 F1.2e3\n";      // exponent feedrate
    std::string canon = std::string(head) +
        "G1 X100.000 Y0.000 E1.50000 F1200\n"
        "G1 X100.000 Y50.000 E1.50000 F1200\n"
        "G1 X0.000 Y50.000 E1.50000 F1200\n"
        "G1 X0.000 Y0.000 E1.50000 F1200\n"
        "G1 X0.000 Y0.000 E1.50000 F1200\n";
    Result a = estimate(exotic, lim), b = estimate(canon, lim);
    bool eq = same_result(a, b);
    printf("token forms: %s (total=%.6f vs %.6f, moves=%ld vs %ld, filament=%.6f vs %.6f)\n", same_word(eq), a.total_s, b.total_s, a.moves, b.moves, a.filament_mm, b.filament_mm);
    return eq;
}
int main(){
    Limits lim;
    bool ok = check_chunked(lim) && check_token_forms(lim);
    Result slow = estimate(square_gcode(1200, 20), lim);   // 20 mm/s
    Result fast = estimate(square_gcode(6000, 20), lim);   // 100 mm/s
    printf("slow(20mm/s): total=%.3fs moves=%ld filament=%.3fmm layer0=%.3fs\n", slow.total_s, slow.moves, slow.filament_mm, slow.first_layer_s);
    printf("fast(100mm/s): total=%.3fs moves=%ld filament=%.3fmm\n", fast.total_s, fast.moves, fast.filament_mm);
    printf("total>0=%d  faster_is_less=%d  filament_equal=%d\n",
           slow.total_s>0.0, fast.total_s < slow.total_s, (int)(std::abs(slow.filament_mm-fast.filament_mm)<1e-6));
    // manual sanity: 20 loops * 200mm/loop = 4000mm extrude at ~20mm/s -> ~200s+ (plus accel). Print time plausible.
    ok = ok && slow.total_s > 0.0 && fast.total_s < slow.total_s && std::abs(slow.filament_mm-fast.filament_mm) < 1e-6;
    if (!ok) { printf("test_time: FAILED\n"); return 1; }
    printf("test_time: all checks passed\n");
    return 0;
}
