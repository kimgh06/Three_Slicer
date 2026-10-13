// Stage-10: faithful transcription of the OrcaSlicer GCodeProcessor time algorithm (see gcode_time.h
// for exact source-line citations). Constants, planner passes, trapezoid math and process_G1 block
// generation are copied verbatim; only apply_config/config-typed access is replaced by param-injected
// Limits (single Normal time mode). The parser feeds it G0/G1/G2/G3 moves from the emitted g-code.
#include "gcode_time.h"
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <cctype>
#include <string>
#include <algorithm>

namespace gcode_time {

enum { AX=0, AY=1, AZ=2, AE=3 };
static inline float sqrf(float x){ return x*x; }

// ---- helpers: GCodeProcessor.cpp L146-175 (verbatim) ----
static float estimated_acceleration_distance(float initial_rate, float target_rate, float acceleration){
    if (acceleration == 0.0f) return 0.0f;
    return (sqrf(target_rate) - sqrf(initial_rate)) / (2.0f * acceleration);
}
static float intersection_distance(float initial_rate, float final_rate, float acceleration, float distance){
    if (acceleration == 0.0f) return 0.0f;
    return (2.0f * acceleration * distance - sqrf(initial_rate) + sqrf(final_rate)) / (4.0f * acceleration);
}
static float speed_from_distance(float initial_feedrate, float distance, float acceleration){
    const float value = std::max(0.0f, sqrf(initial_feedrate) + 2.0f * acceleration * distance);
    return std::sqrt(value);
}
static float max_allowable_speed(float acceleration, float target_velocity, float distance){
    const float value = std::max(0.0f, sqrf(target_velocity) - 2.0f * acceleration * distance);
    return std::sqrt(value);
}
static float acceleration_time_from_distance(float initial_feedrate, float distance, float acceleration){
    if (acceleration != 0.0f) return (speed_from_distance(initial_feedrate, distance, acceleration) - initial_feedrate) / acceleration;
    return 0.0f;
}

// ---- Trapezoid + TimeBlock: GCodeProcessor.hpp L565-620, .cpp L261-290 (verbatim) ----
struct FeedrateProfile { float entry=0, cruise=0, exit=0; };
struct Trapezoid {
    float accelerate_until=0, decelerate_after=0, cruise_feedrate=0;
    float acceleration_distance() const { return accelerate_until; }
    float cruise_distance() const { return decelerate_after - accelerate_until; }
    float deceleration_distance(float distance) const { return distance - decelerate_after; }
    float acceleration_time(float entry_feedrate, float acceleration) const {
        return acceleration_time_from_distance(entry_feedrate, acceleration_distance(), acceleration);
    }
    float cruise_time() const {
        if (cruise_feedrate != 0.0f) return cruise_distance() / cruise_feedrate;
        return 0.0f;
    }
    float deceleration_time(float distance, float acceleration) const {
        return acceleration_time_from_distance(cruise_feedrate, deceleration_distance(distance), -acceleration);
    }
};
struct TimeBlock {
    struct Flags { bool recalculate=false, nominal_length=false; };
    int   move_type=0;      // 0=noop 1=extrude 2=travel 3=retract 4=unretract
    int   role=0;           // ExtrusionRole int (from ;_EXTRUSION_ROLE tag) else -1
    int   layer_id=0;
    float distance=0, acceleration=0, max_entry_speed=0, safe_feedrate=0;
    Flags flags;
    FeedrateProfile feedrate_profile;
    Trapezoid trapezoid;
    void calculate_trapezoid(){
        float accelerate_distance = std::max(0.0f, estimated_acceleration_distance(feedrate_profile.entry, feedrate_profile.cruise, acceleration));
        const float decelerate_distance = std::max(0.0f, estimated_acceleration_distance(feedrate_profile.cruise, feedrate_profile.exit, -acceleration));
        float cruise_distance = distance - accelerate_distance - decelerate_distance;
        if (cruise_distance < 0.0f) {
            accelerate_distance = std::clamp(intersection_distance(feedrate_profile.entry, feedrate_profile.exit, acceleration, distance), 0.0f, distance);
            cruise_distance = 0.0f;
            trapezoid.cruise_feedrate = speed_from_distance(feedrate_profile.entry, accelerate_distance, acceleration);
        } else
            trapezoid.cruise_feedrate = feedrate_profile.cruise;
        trapezoid.accelerate_until = accelerate_distance;
        trapezoid.decelerate_after = accelerate_distance + cruise_distance;
    }
    float time() const {
        return trapezoid.acceleration_time(feedrate_profile.entry, acceleration) +
               trapezoid.cruise_time() + trapezoid.deceleration_time(distance, acceleration);
    }
};

// ---- planner passes: GCodeProcessor.cpp L332-413 (verbatim) ----
static void planner_forward_pass_kernel(const TimeBlock& prev, TimeBlock& curr){
    if (!prev.flags.nominal_length && prev.feedrate_profile.entry < curr.feedrate_profile.entry) {
        const float new_entry_speed = max_allowable_speed(-prev.acceleration, prev.feedrate_profile.entry, prev.distance);
        if (new_entry_speed < curr.feedrate_profile.entry) {
            curr.feedrate_profile.entry = new_entry_speed;
            curr.flags.recalculate = true;
        }
    }
}
static void planner_reverse_pass_kernel(TimeBlock& curr, const TimeBlock& next){
    const float max_entry_speed = curr.max_entry_speed;
    if (curr.feedrate_profile.entry != max_entry_speed || next.flags.recalculate) {
        float new_entry_speed;
        if (curr.flags.nominal_length)
            new_entry_speed = max_entry_speed;
        else
            new_entry_speed = std::min(max_entry_speed, max_allowable_speed(-curr.acceleration, next.feedrate_profile.entry, curr.distance));
        if (curr.feedrate_profile.entry != new_entry_speed) {
            curr.feedrate_profile.entry = new_entry_speed;
            curr.flags.recalculate = true;
        }
    }
}
static void recalculate_trapezoids(std::vector<TimeBlock>& blocks){
    TimeBlock* curr = nullptr;
    TimeBlock* next = nullptr;
    for (size_t i = 0; i < blocks.size(); ++i) {
        TimeBlock& block = blocks[i];
        curr = next;
        next = &block;
        if (curr != nullptr) {
            if (curr->flags.recalculate || next->flags.recalculate) {
                curr->feedrate_profile.exit = next->feedrate_profile.entry;
                curr->calculate_trapezoid();
                curr->flags.recalculate = false;
            }
        }
    }
    if (next != nullptr) {
        next->feedrate_profile.exit = next->safe_feedrate;
        next->calculate_trapezoid();
        next->flags.recalculate = false;
    }
}

// ---- single-machine state (GCodeProcessor.hpp TimeMachine::State) ----
struct State {
    float feedrate=0, safe_feedrate=0;
    float axis_feedrate[4]={0,0,0,0}, abs_axis_feedrate[4]={0,0,0,0};
    float enter_direction[3]={0,0,0}, exit_direction[3]={0,0,0};
};

// ---- process_G1 block generation: GCodeProcessor.cpp L5007-5231 (verbatim, single Normal mode) ----
// Appends a TimeBlock for one move. delta_pos[X,Y,Z,E], m_feedrate in mm/s.
static void add_move(std::vector<TimeBlock>& blocks, State& curr, State& prev,
                     const float delta_pos[4], float m_feedrate, const Limits& limits,
                     int move_type, int role, int layer_id)
{
    auto is_extrusion_only_move = [](const float delta[4]){ return delta[AX]==0.f && delta[AY]==0.f && delta[AZ]==0.f && delta[AE]!=0.f; };
    float sq_xyz = sqrf(delta_pos[AX])+sqrf(delta_pos[AY])+sqrf(delta_pos[AZ]);
    float distance;
    if (sq_xyz > 0.0f)
        distance = std::sqrt(sq_xyz);
    else
        distance = std::abs(delta_pos[AE]);
    if (distance == 0.0f) return;
    float inv_distance = 1.0f / distance;

    // curr.feedrate = minimum_(travel_)feedrate(m_feedrate)
    float minimum_feedrate;
    if (delta_pos[AE] == 0.0f) {
        if (limits.min_travel_rate > 0.f)
            minimum_feedrate = std::max(m_feedrate, limits.min_travel_rate);
        else
            minimum_feedrate = m_feedrate;
    } else {
        if (limits.min_extrude_rate > 0.f)
            minimum_feedrate = std::max(m_feedrate, limits.min_extrude_rate);
        else
            minimum_feedrate = m_feedrate;
    }
    curr.feedrate = minimum_feedrate;

    curr.enter_direction[0]=delta_pos[AX];
    curr.enter_direction[1]=delta_pos[AY];
    curr.enter_direction[2]=delta_pos[AZ];
    float norm = std::sqrt(sqrf(curr.enter_direction[0])+sqrf(curr.enter_direction[1])+sqrf(curr.enter_direction[2]));
    if (!is_extrusion_only_move(delta_pos) && norm > 0.f) {
        curr.enter_direction[0]/=norm;
        curr.enter_direction[1]/=norm;
        curr.enter_direction[2]/=norm;
    }
    curr.exit_direction[0]=curr.enter_direction[0];
    curr.exit_direction[1]=curr.enter_direction[1];
    curr.exit_direction[2]=curr.enter_direction[2];

    TimeBlock block;
    block.move_type=move_type;
    block.role=role;
    block.distance=distance;
    block.layer_id=layer_id;

    // centripetal accel limit on cruise (L5055-5079)
    if ((prev.exit_direction[0]!=0.f || prev.exit_direction[1]!=0.f) &&
        (curr.enter_direction[0]!=0.f || curr.enter_direction[1]!=0.f)) {
        float exit_xy[2]={prev.exit_direction[0],prev.exit_direction[1]};
        float exit_norm=std::sqrt(sqrf(exit_xy[0])+sqrf(exit_xy[1]));
        if(exit_norm>0){
            exit_xy[0]/=exit_norm;
            exit_xy[1]/=exit_norm;
        }
        float enter_xy[2]={curr.enter_direction[0],curr.enter_direction[1]};
        float enter_norm=std::sqrt(sqrf(enter_xy[0])+sqrf(enter_xy[1]));
        if(enter_norm>0){
            enter_xy[0]/=enter_norm;
            enter_xy[1]/=enter_norm;
        }
        float norm_diff = std::sqrt(sqrf(enter_xy[0]-exit_xy[0])+sqrf(enter_xy[1]-exit_xy[1]));
        if (norm_diff < 0.5f && norm_diff > 0.00001f) {
            float dot=exit_xy[0]*enter_xy[0]+exit_xy[1]*enter_xy[1];
            float cross=exit_xy[0]*enter_xy[1]-exit_xy[1]*enter_xy[0];
            float angle=(float)atan2((double)cross,(double)dot);
            float sin_theta_2=std::sqrt((1.0f-std::cos(angle))*0.5f);
            if (sin_theta_2 > 0.f) {
                float radius=std::sqrt(sqrf(delta_pos[AX])+sqrf(delta_pos[AY]))*0.5f/sin_theta_2;
                curr.feedrate = std::min(curr.feedrate, std::sqrt(limits.accel_print * radius));
            }
        }
    }

    // cruise feedrate: clamp to per-axis max feedrate (L5081-5103)
    float min_feedrate_factor = 1.0f;
    for (int axis=AX; axis<=AE; ++axis) {
        curr.axis_feedrate[axis] = curr.feedrate * delta_pos[axis] * inv_distance;
        curr.abs_axis_feedrate[axis] = std::abs(curr.axis_feedrate[axis]);
        if (curr.abs_axis_feedrate[axis] != 0.0f) {
            float axis_max = limits.max_speed[axis];
            if (axis_max != 0.0f) min_feedrate_factor = std::min(min_feedrate_factor, axis_max / curr.abs_axis_feedrate[axis]);
        }
    }
    curr.feedrate *= min_feedrate_factor;
    block.feedrate_profile.cruise = curr.feedrate;
    if (min_feedrate_factor < 1.0f)
        for (int axis=AX; axis<=AE; ++axis) {
            curr.axis_feedrate[axis]*=min_feedrate_factor;
            curr.abs_axis_feedrate[axis]*=min_feedrate_factor;
        }

    // acceleration (L5105-5119)
    float acceleration;
    if (move_type==2/*travel*/)
        acceleration = limits.accel_travel;
    else if (is_extrusion_only_move(delta_pos))
        acceleration = limits.accel_retract;
    else
        acceleration = limits.accel_print;
    for (int axis=AX; axis<=AE; ++axis) {
        float axis_max_acc = limits.max_accel[axis];
        if (axis_max_acc>0.f && acceleration * std::abs(delta_pos[axis]) * inv_distance > axis_max_acc)
            acceleration = axis_max_acc / (std::abs(delta_pos[axis]) * inv_distance);
    }
    block.acceleration = acceleration;

    // safe (exit) feedrate from per-axis jerk (L5121-5130)
    curr.safe_feedrate = block.feedrate_profile.cruise;
    for (int axis=AX; axis<=AE; ++axis) {
        float axis_max_jerk = limits.max_jerk[axis];
        if (curr.abs_axis_feedrate[axis] > axis_max_jerk) curr.safe_feedrate = std::min(curr.safe_feedrate, axis_max_jerk);
    }
    block.feedrate_profile.exit = curr.safe_feedrate;

    static const float PREV_THRESH = 0.0001f;
    // entry feedrate via jerk junction (L5134-5214)
    float vmax_junction = curr.safe_feedrate;
    if (!blocks.empty() && prev.feedrate > PREV_THRESH) {
        bool prev_speed_larger = prev.feedrate > block.feedrate_profile.cruise;
        float smaller_speed_factor;
        if (prev_speed_larger) {
            smaller_speed_factor = block.feedrate_profile.cruise / prev.feedrate;
            vmax_junction = block.feedrate_profile.cruise;
        } else {
            smaller_speed_factor = prev.feedrate / block.feedrate_profile.cruise;
            vmax_junction = prev.feedrate;
        }
        float v_factor = 1.0f;
        bool limited = false;
        for (int axis=AX; axis<=AE; ++axis) {
            if (axis == AX) {
                float exit_v[3]={prev.feedrate*prev.exit_direction[0], prev.feedrate*prev.exit_direction[1], prev.feedrate*prev.exit_direction[2]};
                if (prev_speed_larger) {
                    exit_v[0]*=smaller_speed_factor;
                    exit_v[1]*=smaller_speed_factor;
                    exit_v[2]*=smaller_speed_factor;
                }
                float entry_v[3]={block.feedrate_profile.cruise*curr.enter_direction[0], block.feedrate_profile.cruise*curr.enter_direction[1], block.feedrate_profile.cruise*curr.enter_direction[2]};
                float jerk_v[3]={std::abs(entry_v[0]-exit_v[0]), std::abs(entry_v[1]-exit_v[1]), std::abs(entry_v[2]-exit_v[2])};
                float max_xyz_jerk_v[3]={limits.max_jerk[AX], limits.max_jerk[AY], limits.max_jerk[AZ]};
                for (int k=0;k<3;k++) if (jerk_v[k] > max_xyz_jerk_v[k]) {
                    v_factor *= max_xyz_jerk_v[k] / jerk_v[k];
                    jerk_v[0]*=v_factor;
                    jerk_v[1]*=v_factor;
                    jerk_v[2]*=v_factor;
                    limited = true;
                }
            } else if (axis == AY || axis == AZ) {
                continue;
            } else {
                float v_exit = prev.axis_feedrate[axis];
                float v_entry = curr.axis_feedrate[axis];
                if (prev_speed_larger) v_exit *= smaller_speed_factor;
                if (limited) {
                    v_exit *= v_factor;
                    v_entry *= v_factor;
                }
                float jerk;
                if (v_exit > v_entry) {
                    if ((v_entry > 0.0f) || (v_exit < 0.0f))
                        jerk = v_exit - v_entry;
                    else
                        jerk = std::max(v_exit, -v_entry);
                } else {
                    if ((v_entry < 0.0f) || (v_exit > 0.0f))
                        jerk = v_entry - v_exit;
                    else
                        jerk = std::max(-v_exit, v_entry);
                }
                float axis_max_jerk = limits.max_jerk[axis];
                if (jerk > axis_max_jerk) {
                    v_factor *= axis_max_jerk / jerk;
                    limited = true;
                }
            }
        }
        if (limited) vmax_junction *= v_factor;
        float vmax_junction_threshold = vmax_junction * 0.99f;
        if (prev.safe_feedrate > vmax_junction_threshold && curr.safe_feedrate > vmax_junction_threshold)
            vmax_junction = curr.safe_feedrate;
    }
    float v_allowable = max_allowable_speed(-acceleration, curr.safe_feedrate, block.distance);
    block.feedrate_profile.entry = std::min(vmax_junction, v_allowable);
    block.max_entry_speed = vmax_junction;
    block.flags.nominal_length = (block.feedrate_profile.cruise <= v_allowable);
    block.flags.recalculate = true;
    block.safe_feedrate = curr.safe_feedrate;
    block.calculate_trapezoid();
    prev = curr;
    blocks.push_back(block);
}

// ---- tiny g-code parser + driver ----
// ---- line parser --------------------------------------------------------------------------------------------------------
// One scan per line, no per-line allocation. It answers exactly what the previous per-axis scan (parse_axis, one pass over the
//  line per letter) answered: for each axis the first token "<letter><number>" whose number parses, tokens counted only at the
//  start of the line or after a space/tab, nothing past a ';'. Measured before this rewrite: the transcribed estimate of a
//  58.6MB G-code took 3.2s serial after the last layer (mt), with the parser doing a substr per line and 5-7 scans per line.
enum { PX=0, PY=1, PZ=2, PE=3, PF=4, PI=5, PJ=6, PN=7 };
struct AxisVals { double values[PN]; bool has[PN]; };

static const double kPow10[23] = { 1e0,1e1,1e2,1e3,1e4,1e5,1e6,1e7,1e8,1e9,1e10,1e11,1e12,1e13,1e14,1e15,1e16,1e17,1e18,1e19,1e20,1e21,1e22 };

// Decimal fast path with strtod's answer: [+-]digits[.digits] with at most 15 significant digits and at most 22 fraction digits,
//  not followed by anything strtod would keep reading (a digit, '.', 'e', 'E', 'x', 'X'). An integer below 2^53 and a power of ten
//  up to 1e22 are both exact doubles, and one IEEE division of two exact doubles is correctly rounded — the same value strtod returns
//  (Clinger's fast path). Anything else — exponents, hex, inf/nan, leading spaces, more digits — takes strtod itself.
static bool fast_decimal(const char* text_begin, const char* text_end, double& out, const char*& end) {
    const char* cursor = text_begin;
    bool negative = false;
    if (cursor < text_end && (*cursor == '+' || *cursor == '-')) {
        negative = (*cursor == '-');
        ++cursor;
    }
    unsigned long long mantissa = 0;
    int digits = 0, fraction_digits = 0;
    bool any_digit = false;
    while (cursor < text_end && *cursor >= '0' && *cursor <= '9') {
        if (digits < 15) {
            mantissa = mantissa * 10 + (unsigned)(*cursor - '0');
            ++digits;
        } else return false;
        ++cursor;
        any_digit = true;
    }
    if (cursor < text_end && *cursor == '.') {
        ++cursor;
        while (cursor < text_end && *cursor >= '0' && *cursor <= '9') {
            if (digits < 15) {
                mantissa = mantissa * 10 + (unsigned)(*cursor - '0');
                ++digits;
                ++fraction_digits;
            } else return false;
            ++cursor;
            any_digit = true;
        }
    }
    if (!any_digit) return false;
    if (cursor < text_end) {
        char next_char = *cursor;
        if (next_char == '.' || next_char == 'e' || next_char == 'E' || next_char == 'x' || next_char == 'X' || (next_char >= '0' && next_char <= '9')) return false;
    }
    double value = (double)mantissa / kPow10[fraction_digits];
    if (negative) value = -value;
    out = value;
    end = cursor;
    return true;
}

static bool parse_number(const char* text_begin, const char* text_end, double& out) {
    const char* end = nullptr;
    if (fast_decimal(text_begin, text_end, out, end)) return true;
    char terminated[64];
    size_t length = (size_t)(text_end - text_begin);
    if (length > sizeof terminated - 1) length = sizeof terminated - 1;   // strtod needs a terminator; a token is short
    memcpy(terminated, text_begin, length);
    terminated[length] = '\0';
    char* stop = nullptr;
    out = std::strtod(terminated, &stop);
    return stop != terminated;
}

static int axis_index(char letter) {
    switch (letter) {
        case 'X': case 'x': return PX;
        case 'Y': case 'y': return PY;
        case 'Z': case 'z': return PZ;
        case 'E': case 'e': return PE;
        case 'F': case 'f': return PF;
        case 'I': case 'i': return PI;
        case 'J': case 'j': return PJ;
        default: return -1;
    }
}

static void parse_axes(const char* line_begin, const char* line_end, AxisVals& out) {
    for (int k = 0; k < PN; ++k) out.has[k] = false;
    for (const char* cursor = line_begin; cursor < line_end; ++cursor) {
        char letter = *cursor;
        if (letter == ';') break;
        int axis = axis_index(letter);
        if (axis < 0 || out.has[axis]) continue;
        if (cursor != line_begin && cursor[-1] != ' ' && cursor[-1] != '\t') continue;
        double value;
        if (parse_number(cursor + 1, line_end, value)) {
            out.values[axis] = value;
            out.has[axis] = true;
        }
    }
}

static inline bool starts(const char* text, size_t length, const char* literal, size_t literal_length) { return length >= literal_length && memcmp(text, literal, literal_length) == 0; }
static inline bool gword(const char* text, size_t length, char digit) {   // "G<digit>" not followed by an alphanumeric ("G1" but not "G10")
    return length >= 2 && text[0] == 'G' && text[1] == digit && (length < 3 || !std::isalnum((unsigned char)text[2]));
}

struct Estimator::Impl {
    Limits limits;
    Result result;
    std::vector<TimeBlock> blocks;
    State curr, prev;
    double pos[4] = {0,0,0,0};          // absolute X,Y,Z,E
    double m_feedrate = 0;              // mm/s (from F mm/min)
    bool e_relative = true;             // kernel emits M83
    bool xyz_absolute = true;           // kernel emits G90
    int  layer_id = -1;                 // -1 = preamble; increments on "; LAYER"
    int  cur_role = -1;
    std::string carry;                  // a line split across feeds

    explicit Impl(const Limits& machineLimits) : limits(machineLimits) {}

    void line(const char* text, size_t len) {
        if (len == 0) return;
        const char* text_end = text + len;
        // markers
        if (starts(text, len, "; LAYER ", 8) || starts(text, len, "; LAYER\t", 8)) {
            ++layer_id;
            result.layer_seconds.push_back(0.0);
            return;
        }
        if (starts(text, len, ";_EXTRUSION_ROLE:", 17)) {
            char role_text[32];
            size_t length = len - 17;
            if (length > sizeof role_text - 1) length = sizeof role_text - 1;
            memcpy(role_text, text + 17, length);
            role_text[length] = '\0';
            cur_role = std::atoi(role_text);
            return;
        }
        // mode changes
        if (starts(text, len, "M83", 3)) {
            e_relative = true;
            return;
        }
        if (starts(text, len, "M82", 3)) {
            e_relative = false;
            return;
        }
        if (starts(text, len, "G91", 3)) {
            xyz_absolute = false;
            return;
        }
        if (starts(text, len, "G90", 3)) {
            xyz_absolute = true;
            return;
        }
        // G92 sets the position without moving: in absolute E mode the next E word counts from it (the kernel writes
        //  G92 E0 after every retraction and at every layer there).
        if (starts(text, len, "G92", 3)) {
            AxisVals axes;
            parse_axes(text, text_end, axes);
            if (axes.has[PE]) pos[AE] = axes.values[PE];
            return;
        }
        // motion: G0 / G1 / G2 / G3
        bool clockwise_arc = gword(text, len, '2');
        bool counter_clockwise_arc = gword(text, len, '3');
        if (!(gword(text, len, '0') || gword(text, len, '1') || clockwise_arc || counter_clockwise_arc)) return;

        AxisVals axes;
        parse_axes(text, text_end, axes);
        if (axes.has[PF]) m_feedrate = axes.values[PF] / 60.0;   // mm/min -> mm/s

        // new absolute position
        double new_x = pos[AX], new_y = pos[AY], new_z = pos[AZ], delta_e = 0.0;
        if (axes.has[PX]) {
            new_x = axes.values[PX];
            if (!xyz_absolute) new_x = pos[AX] + axes.values[PX];
        }
        if (axes.has[PY]) {
            new_y = axes.values[PY];
            if (!xyz_absolute) new_y = pos[AY] + axes.values[PY];
        }
        if (axes.has[PZ]) {
            new_z = axes.values[PZ];
            if (!xyz_absolute) new_z = pos[AZ] + axes.values[PZ];
        }
        if (axes.has[PE]) {
            delta_e = axes.values[PE];
            if (!e_relative) delta_e = axes.values[PE] - pos[AE];
        }

        float delta[4];
        if (clockwise_arc || counter_clockwise_arc) {
            // arc: distance = radius * swept angle (center from I/J relative to start)
            double center_offset_x = 0.0, center_offset_y = 0.0;
            if (axes.has[PI]) center_offset_x = axes.values[PI];
            if (axes.has[PJ]) center_offset_y = axes.values[PJ];
            double center_x = pos[AX] + center_offset_x, center_y = pos[AY] + center_offset_y;
            double radius = std::hypot(pos[AX]-center_x, pos[AY]-center_y);
            double start_angle = std::atan2(pos[AY]-center_y, pos[AX]-center_x);
            double end_angle = std::atan2(new_y-center_y, new_x-center_x);
            double sweep = end_angle - start_angle;
            if (clockwise_arc) {
                if (sweep > 0) sweep -= 2*M_PI;
            } else {
                if (sweep < 0) sweep += 2*M_PI;
            }
            double arc_len = std::abs(sweep) * radius;
            // treat arc as a single planar move of arc length in X (direction chord); good enough for estimate
            delta[AX] = (float)arc_len;
            delta[AY] = 0.f;
            delta[AZ] = 0.f;
            delta[AE] = (float)delta_e;
        } else {
            delta[AX] = (float)(new_x-pos[AX]);
            delta[AY] = (float)(new_y-pos[AY]);
            delta[AZ] = (float)(new_z-pos[AZ]);
            delta[AE] = (float)delta_e;
        }

        // move type (GCodeProcessor.cpp move_type lambda L4876-4891)
        const bool xyz_moved = delta[AX] != 0.f || delta[AY] != 0.f || delta[AZ] != 0.f;
        int move_type = 0;                                              // noop
        if (delta[AE] < 0.f) {                                          // retract / travel
            move_type = 3;
            if (xyz_moved) move_type = 2;
        } else if (delta[AE] > 0.f) {
            move_type = 1;                                              // extrude
            if (delta[AX] == 0.f && delta[AY] == 0.f) {                 // travel / unretract
                move_type = 2;
                if (delta[AZ] == 0.f) move_type = 4;
            }
        } else if (xyz_moved) move_type = 2;                            // travel

        // filament = E of real extrusion moves only (exclude unretract re-prime), to match kernel gw.filament
        if (move_type == 1 && delta[AE] > 0.f) result.filament_mm += delta[AE];

        if (move_type != 0) {
            int role = -1;
            if (move_type == 1) role = cur_role;
            add_move(blocks, curr, prev, delta, (float)m_feedrate, limits, move_type, role, std::max(0, layer_id));
            ++result.moves;
        }
        pos[AX] = new_x;
        pos[AY] = new_y;
        pos[AZ] = new_z;
        if (!e_relative && axes.has[PE]) pos[AE] = axes.values[PE];
    }

    void feed(const char* data, size_t len) {
        const char* cursor = data;
        const char* end = data + len;
        if (!carry.empty()) {
            const char* newline = (const char*)memchr(cursor, '\n', (size_t)(end - cursor));
            if (!newline) {
                carry.append(cursor, (size_t)(end - cursor));
                return;
            }
            carry.append(cursor, (size_t)(newline - cursor));
            line(carry.data(), carry.size());
            carry.clear();
            cursor = newline + 1;
        }
        while (cursor < end) {
            const char* newline = (const char*)memchr(cursor, '\n', (size_t)(end - cursor));
            if (!newline) {
                carry.assign(cursor, (size_t)(end - cursor));
                break;
            }
            line(cursor, (size_t)(newline - cursor));
            cursor = newline + 1;
        }
    }

    Result finish() {
        if (!carry.empty()) {
            line(carry.data(), carry.size());
            carry.clear();
        }
        // planner over all blocks (full look-ahead; firmware uses a 64-block window — documented simplification)
        for (int k = (int)blocks.size()-1; k > 0; --k) planner_reverse_pass_kernel(blocks[k-1], blocks[k]);
        for (size_t k = 0; k+1 < blocks.size(); ++k) planner_forward_pass_kernel(blocks[k], blocks[k+1]);
        recalculate_trapezoids(blocks);

        for (const TimeBlock& block : blocks) {
            double block_time = block.time();
            if (!(block_time==block_time) || block_time<0) block_time=0;   // guard NaN
            result.total_seconds += block_time;
            if (block.layer_id >= 0 && block.layer_id < (int)result.layer_seconds.size()) result.layer_seconds[block.layer_id] += block_time;
            if (block.move_type == 1)
                result.extrude_seconds += block_time;
            else if (block.move_type == 2)
                result.travel_seconds += block_time;
            if (block.role >= 0) result.role_seconds[block.role] += block_time;
        }
        if (!result.layer_seconds.empty()) result.first_layer_seconds = result.layer_seconds.front();
        return std::move(result);
    }
};

Estimator::Estimator(const Limits& limits) : impl_(new Impl(limits)) {}
Estimator::~Estimator() { delete impl_; }
void Estimator::feed(const char* data, size_t len) { impl_->feed(data, len); }
Result Estimator::end() { return impl_->finish(); }

Result estimate(const std::string& gcode, const Limits& limits) {
    Estimator estimator(limits);
    estimator.feed(gcode.data(), gcode.size());
    return estimator.end();
}

} // namespace gcode_time
