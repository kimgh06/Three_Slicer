// Stage-8 link/functional test: run the real ported Fill patterns on a 20mm square, print segment
// counts, and check FillGyroid's TPMS z-phase (different z ⇒ different curve).
#include <cstdio>
#include "../fill_bridge.h"
using namespace fill_bridge;

int main() {
    std::vector<MillimetrePath> region = {{{0,0},{20,0},{20,20},{0,20}}};
    for (const char* pattern : {"gyroid","honeycomb","3dhoneycomb","crosshatch","concentric"}) {
        auto polylines = generate_fill(region, pattern, 0.2, 0.42, 0.0, 1.0, 5);
        long segments = 0;
        for (auto& polyline : polylines) segments += (long)polyline.size() - 1;
        printf("%-12s polylines=%zu segments=%ld\n", pattern, polylines.size(), segments);
    }
    // Gyroid TPMS: point set differs between z layers (phase shift along z)
    auto gyroid_low = generate_fill(region, "gyroid", 0.2, 0.42, 0.0, 1.0, 5);
    auto gyroid_high = generate_fill(region, "gyroid", 0.2, 0.42, 0.0, 5.4, 27);
    auto first_point = [](const std::vector<MillimetrePath>& polylines) -> std::pair<double,double> {
        if (polylines.empty()||polylines[0].empty()) return std::pair<double,double>{0,0};
        return polylines[0][0];
    };
    auto low_point = first_point(gyroid_low);
    auto high_point = first_point(gyroid_high);
    int differ = 0;
    if (low_point.first!=high_point.first||low_point.second!=high_point.second) differ = 1;
    printf("gyroid z=1.0 firstpt=(%.3f,%.3f)  z=5.4 firstpt=(%.3f,%.3f)  differ=%d\n",
           low_point.first,low_point.second,high_point.first,high_point.second, differ);
    return 0;
}
