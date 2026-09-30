// Stage-13 bridge: plain-type interface to the REAL ported GCodeProcessor (7561L). slicer_core.cpp
// includes ONLY this header (no Slic3r/GCodeProcessor/PrintConfig types). Mirrors gcode_time's shape
// so the kernel can swap engines by a `time_engine` param (full=this, transcribed=gcode_time).
#pragma once
#include <string>
#include <vector>
#include <map>
#include "gcode_time.h"   // the transcribed estimator the streamed estimate hands over to past its move cap

namespace gcodeproc_bridge {

// Machine limits (same fields/units as gcode_time::Limits) injected into the PrintConfig the real
// GCodeProcessor consumes, so both engines see identical limits (isolates algorithm differences).
struct Limits {
    float max_speed[4] = {500.f, 500.f, 12.f, 30.f};
    float max_accel[4] = {5000.f, 5000.f, 500.f, 5000.f};
    float max_jerk[4]  = {9.f, 9.f, 0.4f, 2.5f};
    float accel_print   = 5000.f;
    float accel_travel  = 5000.f;
    float accel_retract = 5000.f;
    float min_extrude_rate = 0.f;
    float min_travel_rate  = 0.f;
};

struct Result {
    double total_s = 0.0;
    std::vector<double> layer_s;
    double first_layer_s = 0.0;
    double extrude_s = 0.0, travel_s = 0.0;
    std::map<int, double> role_s;       // ExtrusionRole int -> s
    double filament_mm = 0.0;
    long   moves = 0;
    bool   ok = false;
    bool   transcribed = false;         // the result came from the gcode_time hand-over (see estimate_begin), not from GCodeProcessor
};

// Run the real GCodeProcessor (apply_config -> process_buffer -> finalize) on the g-code and extract
// the time breakdown from GCodeProcessorResult (modes[Normal].time) + per-move aggregation.
Result estimate(const std::string& gcode, const Limits& lim);

// Stage 30 streaming time estimate: the kernel feeds layer chunks as it produces them (process_buffer is a stateful
//  streaming parser — chunks end on '\n' boundaries, so many calls behave exactly like one big feed), which avoids
//  keeping the whole g-code string resident. begin (apply_config once) -> feed (process_buffer + filament accumulation per chunk)
//  -> end (finalize + extract Result). Only one stream at a time (file-static state).
//  `fallback` is the transcribed engine's limits, or null. With it, the fed text is kept until the move cap (MOVES_CAP) is
//  reached; past the cap the kept text and every later chunk go to a gcode_time::Estimator instead, so the estimate still
//  overlaps emission and end() returns a Result with `transcribed` set. Without it (streaming, where the text is released per
//  layer on purpose) the cap ends the estimate as before and end() reports !ok.
void   estimate_begin(const Limits& lim, const gcode_time::Limits* fallback);
void   estimate_feed(const std::string& chunk);
Result estimate_end();

} // namespace gcodeproc_bridge
