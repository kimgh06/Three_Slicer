// Stage-10: original-source print-time estimation. The full GCodeProcessor (9091 lines) is blocked
// by the config subsystem (real PrintConfig.hpp: ExtruderType/NozzleVolumeType/BedType/FullPrintConfig/
// GCodeWriter/DynamicPrintConfig + calib.hpp — hundreds of options). So this transcribes the actual
// OrcaSlicer time algorithm VERBATIM (GCodeProcessor.cpp: helpers L146-175, Trapezoid/TimeBlock
// L261-290, planner passes L332-413, calculate_time L435-487, process_G1 block-gen L5007-5231) and
// drives it by PARSING the emitted g-code, with machine limits param-injected (the PE pattern).
#pragma once
#include <string>
#include <cstddef>
#include <vector>
#include <map>

namespace gcode_time {

// Machine limits (OrcaSlicer machine_max_* / machine_min_*). Axis order: X,Y,Z,E.
struct Limits {
    float max_speed[4] = {500.f, 500.f, 12.f, 30.f};        // mm/s   (machine_max_speed_*)
    float max_accel[4] = {5000.f, 5000.f, 500.f, 5000.f};   // mm/s^2 (machine_max_acceleration_*)
    float max_jerk[4]  = {9.f, 9.f, 0.4f, 2.5f};            // mm/s   (machine_max_jerk_*)
    float accel_print   = 5000.f;   // extruding accel (mm/s^2)
    float accel_travel  = 5000.f;   // travel accel
    float accel_retract = 5000.f;   // retract accel
    float min_extrude_rate = 0.f;   // machine_min_extruding_rate (0 = none)
    float min_travel_rate  = 0.f;   // machine_min_travel_rate
};

struct Result {
    double total_s = 0.0;                 // total estimated print time (s)
    std::vector<double> layer_s;          // per "; LAYER" time (s)
    double first_layer_s = 0.0;
    double extrude_s = 0.0, travel_s = 0.0; // move-type breakdown (s)
    std::map<int, double> role_s;         // ExtrusionRole int -> s (only when ;_EXTRUSION_ROLE tags present)
    double filament_mm = 0.0;             // sum of positive E deltas (mm) — cross-check vs kernel stat
    long   moves = 0;                     // parsed motion moves
};

// Parse g-code text and estimate print time with the original trapezoidal planner.
Result estimate(const std::string& gcode, const Limits& lim);

// The same estimate fed in pieces: begin (construct) -> feed any number of chunks, split anywhere (a partial trailing line is
//  carried into the next feed) -> end. estimate() is begin + one feed + end, so the two agree to the bit. This is what lets the
//  mt feeder keep parsing while the kernel is still emitting, instead of re-reading the whole text after the last layer.
class Estimator {
public:
    explicit Estimator(const Limits& lim);
    ~Estimator();
    void feed(const char* data, size_t len);
    void feed(const std::string& chunk) { feed(chunk.data(), chunk.size()); }
    Result end();
private:
    struct Impl;
    Impl* impl_;
};

} // namespace gcode_time
