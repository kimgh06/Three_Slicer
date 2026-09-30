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
    return (acceleration == 0.0f) ? 0.0f : (sqrf(target_rate) - sqrf(initial_rate)) / (2.0f * acceleration);
}
static float intersection_distance(float initial_rate, float final_rate, float acceleration, float distance){
    return (acceleration == 0.0f) ? 0.0f : (2.0f * acceleration * distance - sqrf(initial_rate) + sqrf(final_rate)) / (4.0f * acceleration);
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
    return (acceleration != 0.0f) ? (speed_from_distance(initial_feedrate, distance, acceleration) - initial_feedrate) / acceleration : 0.0f;
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
    float cruise_time() const { return (cruise_feedrate != 0.0f) ? cruise_distance() / cruise_feedrate : 0.0f; }
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
    Flags flags; FeedrateProfile feedrate_profile; Trapezoid trapezoid;
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
        const float new_entry_speed = curr.flags.nominal_length ? max_entry_speed :
            std::min(max_entry_speed, max_allowable_speed(-curr.acceleration, next.feedrate_profile.entry, curr.distance));
        if (curr.feedrate_profile.entry != new_entry_speed) {
            curr.feedrate_profile.entry = new_entry_speed;
            curr.flags.recalculate = true;
        }
    }
}
static void recalculate_trapezoids(std::vector<TimeBlock>& blocks){
    TimeBlock* curr = nullptr; TimeBlock* next = nullptr;
    for (size_t i = 0; i < blocks.size(); ++i) {
        TimeBlock& b = blocks[i];
        curr = next; next = &b;
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
                     const float delta_pos[4], float m_feedrate, const Limits& lim,
                     int move_type, int role, int layer_id)
{
    auto is_extrusion_only_move = [](const float d[4]){ return d[AX]==0.f && d[AY]==0.f && d[AZ]==0.f && d[AE]!=0.f; };
    float sq_xyz = sqrf(delta_pos[AX])+sqrf(delta_pos[AY])+sqrf(delta_pos[AZ]);
    float distance = (sq_xyz > 0.0f) ? std::sqrt(sq_xyz) : std::abs(delta_pos[AE]);
    if (distance == 0.0f) return;
    float inv_distance = 1.0f / distance;

    // curr.feedrate = minimum_(travel_)feedrate(m_feedrate)
    curr.feedrate = (delta_pos[AE] == 0.0f)
        ? ((lim.min_travel_rate > 0.f) ? std::max(m_feedrate, lim.min_travel_rate) : m_feedrate)
        : ((lim.min_extrude_rate > 0.f) ? std::max(m_feedrate, lim.min_extrude_rate) : m_feedrate);

    curr.enter_direction[0]=delta_pos[AX]; curr.enter_direction[1]=delta_pos[AY]; curr.enter_direction[2]=delta_pos[AZ];
    float norm = std::sqrt(sqrf(curr.enter_direction[0])+sqrf(curr.enter_direction[1])+sqrf(curr.enter_direction[2]));
    if (!is_extrusion_only_move(delta_pos) && norm > 0.f) {
        curr.enter_direction[0]/=norm; curr.enter_direction[1]/=norm; curr.enter_direction[2]/=norm;
    }
    curr.exit_direction[0]=curr.enter_direction[0]; curr.exit_direction[1]=curr.enter_direction[1]; curr.exit_direction[2]=curr.enter_direction[2];

    TimeBlock block; block.move_type=move_type; block.role=role; block.distance=distance; block.layer_id=layer_id;

    // centripetal accel limit on cruise (L5055-5079)
    if ((prev.exit_direction[0]!=0.f || prev.exit_direction[1]!=0.f) &&
        (curr.enter_direction[0]!=0.f || curr.enter_direction[1]!=0.f)) {
        float v1[2]={prev.exit_direction[0],prev.exit_direction[1]}; float n1=std::sqrt(sqrf(v1[0])+sqrf(v1[1])); if(n1>0){v1[0]/=n1;v1[1]/=n1;}
        float v2[2]={curr.enter_direction[0],curr.enter_direction[1]}; float n2=std::sqrt(sqrf(v2[0])+sqrf(v2[1])); if(n2>0){v2[0]/=n2;v2[1]/=n2;}
        float norm_diff = std::sqrt(sqrf(v2[0]-v1[0])+sqrf(v2[1]-v1[1]));
        if (norm_diff < 0.5f && norm_diff > 0.00001f) {
            float dot=v1[0]*v2[0]+v1[1]*v2[1], cross=v1[0]*v2[1]-v1[1]*v2[0];
            float angle=(float)atan2((double)cross,(double)dot);
            float sin_theta_2=std::sqrt((1.0f-std::cos(angle))*0.5f);
            if (sin_theta_2 > 0.f) {
                float r=std::sqrt(sqrf(delta_pos[AX])+sqrf(delta_pos[AY]))*0.5f/sin_theta_2;
                curr.feedrate = std::min(curr.feedrate, std::sqrt(lim.accel_print * r));
            }
        }
    }

    // cruise feedrate: clamp to per-axis max feedrate (L5081-5103)
    float min_feedrate_factor = 1.0f;
    for (int a=AX; a<=AE; ++a) {
        curr.axis_feedrate[a] = curr.feedrate * delta_pos[a] * inv_distance;
        curr.abs_axis_feedrate[a] = std::abs(curr.axis_feedrate[a]);
        if (curr.abs_axis_feedrate[a] != 0.0f) {
            float axis_max = lim.max_speed[a];
            if (axis_max != 0.0f) min_feedrate_factor = std::min(min_feedrate_factor, axis_max / curr.abs_axis_feedrate[a]);
        }
    }
    curr.feedrate *= min_feedrate_factor;
    block.feedrate_profile.cruise = curr.feedrate;
    if (min_feedrate_factor < 1.0f)
        for (int a=AX; a<=AE; ++a) { curr.axis_feedrate[a]*=min_feedrate_factor; curr.abs_axis_feedrate[a]*=min_feedrate_factor; }

    // acceleration (L5105-5119)
    float acceleration = (move_type==2/*travel*/) ? lim.accel_travel
        : (is_extrusion_only_move(delta_pos) ? lim.accel_retract : lim.accel_print);
    for (int a=AX; a<=AE; ++a) {
        float axis_max_acc = lim.max_accel[a];
        if (axis_max_acc>0.f && acceleration * std::abs(delta_pos[a]) * inv_distance > axis_max_acc)
            acceleration = axis_max_acc / (std::abs(delta_pos[a]) * inv_distance);
    }
    block.acceleration = acceleration;

    // safe (exit) feedrate from per-axis jerk (L5121-5130)
    curr.safe_feedrate = block.feedrate_profile.cruise;
    for (int a=AX; a<=AE; ++a) {
        float axis_max_jerk = lim.max_jerk[a];
        if (curr.abs_axis_feedrate[a] > axis_max_jerk) curr.safe_feedrate = std::min(curr.safe_feedrate, axis_max_jerk);
    }
    block.feedrate_profile.exit = curr.safe_feedrate;

    static const float PREV_THRESH = 0.0001f;
    // entry feedrate via jerk junction (L5134-5214)
    float vmax_junction = curr.safe_feedrate;
    if (!blocks.empty() && prev.feedrate > PREV_THRESH) {
        bool prev_speed_larger = prev.feedrate > block.feedrate_profile.cruise;
        float smaller_speed_factor = prev_speed_larger ? (block.feedrate_profile.cruise / prev.feedrate) : (prev.feedrate / block.feedrate_profile.cruise);
        vmax_junction = prev_speed_larger ? block.feedrate_profile.cruise : prev.feedrate;
        float v_factor = 1.0f; bool limited = false;
        for (int a=AX; a<=AE; ++a) {
            if (a == AX) {
                float exit_v[3]={prev.feedrate*prev.exit_direction[0], prev.feedrate*prev.exit_direction[1], prev.feedrate*prev.exit_direction[2]};
                if (prev_speed_larger) { exit_v[0]*=smaller_speed_factor; exit_v[1]*=smaller_speed_factor; exit_v[2]*=smaller_speed_factor; }
                float entry_v[3]={block.feedrate_profile.cruise*curr.enter_direction[0], block.feedrate_profile.cruise*curr.enter_direction[1], block.feedrate_profile.cruise*curr.enter_direction[2]};
                float jerk_v[3]={std::abs(entry_v[0]-exit_v[0]), std::abs(entry_v[1]-exit_v[1]), std::abs(entry_v[2]-exit_v[2])};
                float max_xyz_jerk_v[3]={lim.max_jerk[AX], lim.max_jerk[AY], lim.max_jerk[AZ]};
                for (int k=0;k<3;k++) if (jerk_v[k] > max_xyz_jerk_v[k]) {
                    v_factor *= max_xyz_jerk_v[k] / jerk_v[k];
                    jerk_v[0]*=v_factor; jerk_v[1]*=v_factor; jerk_v[2]*=v_factor;
                    limited = true;
                }
            } else if (a == AY || a == AZ) {
                continue;
            } else {
                float v_exit = prev.axis_feedrate[a], v_entry = curr.axis_feedrate[a];
                if (prev_speed_larger) v_exit *= smaller_speed_factor;
                if (limited) { v_exit *= v_factor; v_entry *= v_factor; }
                float jerk =
                    (v_exit > v_entry) ?
                    (((v_entry > 0.0f) || (v_exit < 0.0f)) ? (v_exit - v_entry) : std::max(v_exit, -v_entry)) :
                    (((v_entry < 0.0f) || (v_exit > 0.0f)) ? (v_entry - v_exit) : std::max(-v_exit, v_entry));
                float axis_max_jerk = lim.max_jerk[a];
                if (jerk > axis_max_jerk) { v_factor *= axis_max_jerk / jerk; limited = true; }
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
struct AxisVals { double v[PN]; bool has[PN]; };

static const double kPow10[23] = { 1e0,1e1,1e2,1e3,1e4,1e5,1e6,1e7,1e8,1e9,1e10,1e11,1e12,1e13,1e14,1e15,1e16,1e17,1e18,1e19,1e20,1e21,1e22 };

// Decimal fast path with strtod's answer: [+-]digits[.digits] with at most 15 significant digits and at most 22 fraction digits,
//  not followed by anything strtod would keep reading (a digit, '.', 'e', 'E', 'x', 'X'). An integer below 2^53 and a power of ten
//  up to 1e22 are both exact doubles, and one IEEE division of two exact doubles is correctly rounded — the same value strtod returns
//  (Clinger's fast path). Anything else — exponents, hex, inf/nan, leading spaces, more digits — takes strtod itself.
static bool fast_decimal(const char* b, const char* e, double& out, const char*& end) {
    const char* q = b; bool neg = false;
    if (q < e && (*q == '+' || *q == '-')) { neg = (*q == '-'); ++q; }
    unsigned long long mant = 0; int digits = 0, frac = 0; bool any = false;
    while (q < e && *q >= '0' && *q <= '9') { if (digits < 15) { mant = mant * 10 + (unsigned)(*q - '0'); ++digits; } else return false; ++q; any = true; }
    if (q < e && *q == '.') {
        ++q;
        while (q < e && *q >= '0' && *q <= '9') { if (digits < 15) { mant = mant * 10 + (unsigned)(*q - '0'); ++digits; ++frac; } else return false; ++q; any = true; }
    }
    if (!any) return false;
    if (q < e) { char c = *q; if (c == '.' || c == 'e' || c == 'E' || c == 'x' || c == 'X' || (c >= '0' && c <= '9')) return false; }
    double v = (double)mant / kPow10[frac];
    if (neg) v = -v;
    out = v; end = q; return true;
}

static bool parse_number(const char* b, const char* e, double& out) {
    const char* end = nullptr;
    if (fast_decimal(b, e, out, end)) return true;
    char tmp[64]; size_t n = (size_t)(e - b); if (n > sizeof tmp - 1) n = sizeof tmp - 1;   // strtod needs a terminator; a token is short
    memcpy(tmp, b, n); tmp[n] = '\0';
    char* stop = nullptr; out = std::strtod(tmp, &stop);
    return stop != tmp;
}

static int axis_index(char c) {
    switch (c) {
        case 'X': case 'x': return PX; case 'Y': case 'y': return PY; case 'Z': case 'z': return PZ; case 'E': case 'e': return PE;
        case 'F': case 'f': return PF; case 'I': case 'i': return PI; case 'J': case 'j': return PJ; default: return -1;
    }
}

static void parse_axes(const char* b, const char* e, AxisVals& out) {
    for (int k = 0; k < PN; ++k) out.has[k] = false;
    for (const char* q = b; q < e; ++q) {
        char c = *q;
        if (c == ';') break;
        int k = axis_index(c);
        if (k < 0 || out.has[k]) continue;
        if (q != b && q[-1] != ' ' && q[-1] != '\t') continue;
        double v;
        if (parse_number(q + 1, e, v)) { out.v[k] = v; out.has[k] = true; }
    }
}

static inline bool starts(const char* b, size_t len, const char* lit, size_t n) { return len >= n && memcmp(b, lit, n) == 0; }
static inline bool gword(const char* b, size_t len, char d) {   // "G<d>" not followed by an alphanumeric ("G1" but not "G10")
    return len >= 2 && b[0] == 'G' && b[1] == d && (len < 3 || !std::isalnum((unsigned char)b[2]));
}

struct Estimator::Impl {
    Limits lim;
    Result R;
    std::vector<TimeBlock> blocks;
    State curr, prev;
    double pos[4] = {0,0,0,0};          // absolute X,Y,Z,E
    double m_feedrate = 0;              // mm/s (from F mm/min)
    bool e_relative = true;             // kernel emits M83
    bool xyz_absolute = true;           // kernel emits G90
    int  layer_id = -1;                 // -1 = preamble; increments on "; LAYER"
    int  cur_role = -1;
    std::string carry;                  // a line split across feeds

    explicit Impl(const Limits& l) : lim(l) {}

    void line(const char* b, size_t len) {
        if (len == 0) return;
        const char* e = b + len;
        // markers
        if (starts(b, len, "; LAYER ", 8) || starts(b, len, "; LAYER\t", 8)) { ++layer_id; R.layer_s.push_back(0.0); return; }
        if (starts(b, len, ";_EXTRUSION_ROLE:", 17)) { char tmp[32]; size_t n = len - 17; if (n > sizeof tmp - 1) n = sizeof tmp - 1; memcpy(tmp, b + 17, n); tmp[n] = '\0'; cur_role = std::atoi(tmp); return; }
        // mode changes
        if (starts(b, len, "M83", 3)) { e_relative = true; return; }
        if (starts(b, len, "M82", 3)) { e_relative = false; return; }
        if (starts(b, len, "G91", 3)) { xyz_absolute = false; return; }
        if (starts(b, len, "G90", 3)) { xyz_absolute = true; return; }
        // motion: G0 / G1 / G2 / G3
        bool g2 = gword(b, len, '2'), g3 = gword(b, len, '3');
        if (!(gword(b, len, '0') || gword(b, len, '1') || g2 || g3)) return;

        AxisVals a; parse_axes(b, e, a);
        if (a.has[PF]) m_feedrate = a.v[PF] / 60.0;   // mm/min -> mm/s

        // new absolute position
        double nx = pos[AX], ny = pos[AY], nz = pos[AZ], de = 0.0;
        if (a.has[PX]) { nx = a.v[PX]; if (!xyz_absolute) nx = pos[AX] + a.v[PX]; }
        if (a.has[PY]) { ny = a.v[PY]; if (!xyz_absolute) ny = pos[AY] + a.v[PY]; }
        if (a.has[PZ]) { nz = a.v[PZ]; if (!xyz_absolute) nz = pos[AZ] + a.v[PZ]; }
        if (a.has[PE]) { de = a.v[PE]; if (!e_relative) de = a.v[PE] - pos[AE]; }

        float delta[4];
        if (g2 || g3) {
            // arc: distance = radius * swept angle (center from I/J relative to start)
            double ci = 0.0, cj = 0.0; if (a.has[PI]) ci = a.v[PI]; if (a.has[PJ]) cj = a.v[PJ];
            double cx = pos[AX] + ci, cy = pos[AY] + cj;
            double r = std::hypot(pos[AX]-cx, pos[AY]-cy);
            double a0 = std::atan2(pos[AY]-cy, pos[AX]-cx), a1 = std::atan2(ny-cy, nx-cx);
            double sweep = a1 - a0;
            if (g2) { if (sweep > 0) sweep -= 2*M_PI; } else { if (sweep < 0) sweep += 2*M_PI; }
            double arc_len = std::abs(sweep) * r;
            // treat arc as a single planar move of arc length in X (direction chord); good enough for estimate
            delta[AX] = (float)arc_len; delta[AY] = 0.f; delta[AZ] = 0.f; delta[AE] = (float)de;
        } else {
            delta[AX] = (float)(nx-pos[AX]); delta[AY] = (float)(ny-pos[AY]); delta[AZ] = (float)(nz-pos[AZ]); delta[AE] = (float)de;
        }

        // move type (GCodeProcessor.cpp move_type lambda L4876-4891)
        const bool xyz_moved = delta[AX] != 0.f || delta[AY] != 0.f || delta[AZ] != 0.f;
        int mt = 0;                                                     // noop
        if (delta[AE] < 0.f) { mt = 3; if (xyz_moved) mt = 2; }         // retract / travel
        else if (delta[AE] > 0.f) {
            mt = 1;                                                     // extrude
            if (delta[AX] == 0.f && delta[AY] == 0.f) { mt = 2; if (delta[AZ] == 0.f) mt = 4; }   // travel / unretract
        } else if (xyz_moved) mt = 2;                                   // travel

        // filament = E of real extrusion moves only (exclude unretract re-prime), to match kernel gw.filament
        if (mt == 1 && delta[AE] > 0.f) R.filament_mm += delta[AE];

        if (mt != 0) {
            int role = -1; if (mt == 1) role = cur_role;
            add_move(blocks, curr, prev, delta, (float)m_feedrate, lim, mt, role, std::max(0, layer_id));
            ++R.moves;
        }
        pos[AX] = nx; pos[AY] = ny; pos[AZ] = nz;
        if (!e_relative && a.has[PE]) pos[AE] = a.v[PE];
    }

    void feed(const char* data, size_t len) {
        const char* p = data; const char* end = data + len;
        if (!carry.empty()) {
            const char* nl = (const char*)memchr(p, '\n', (size_t)(end - p));
            if (!nl) { carry.append(p, (size_t)(end - p)); return; }
            carry.append(p, (size_t)(nl - p));
            line(carry.data(), carry.size()); carry.clear();
            p = nl + 1;
        }
        while (p < end) {
            const char* nl = (const char*)memchr(p, '\n', (size_t)(end - p));
            if (!nl) { carry.assign(p, (size_t)(end - p)); break; }
            line(p, (size_t)(nl - p));
            p = nl + 1;
        }
    }

    Result finish() {
        if (!carry.empty()) { line(carry.data(), carry.size()); carry.clear(); }
        // planner over all blocks (full look-ahead; firmware uses a 64-block window — documented simplification)
        for (int k = (int)blocks.size()-1; k > 0; --k) planner_reverse_pass_kernel(blocks[k-1], blocks[k]);
        for (size_t k = 0; k+1 < blocks.size(); ++k) planner_forward_pass_kernel(blocks[k], blocks[k+1]);
        recalculate_trapezoids(blocks);

        for (const TimeBlock& b : blocks) {
            double t = b.time();
            if (!(t==t) || t<0) t=0;   // guard NaN
            R.total_s += t;
            if (b.layer_id >= 0 && b.layer_id < (int)R.layer_s.size()) R.layer_s[b.layer_id] += t;
            if (b.move_type == 1) R.extrude_s += t; else if (b.move_type == 2) R.travel_s += t;
            if (b.role >= 0) R.role_s[b.role] += t;
        }
        if (!R.layer_s.empty()) R.first_layer_s = R.layer_s.front();
        return std::move(R);
    }
};

Estimator::Estimator(const Limits& lim) : impl_(new Impl(lim)) {}
Estimator::~Estimator() { delete impl_; }
void Estimator::feed(const char* data, size_t len) { impl_->feed(data, len); }
Result Estimator::end() { return impl_->finish(); }

Result estimate(const std::string& gcode, const Limits& lim) {
    Estimator est(lim);
    est.feed(gcode.data(), gcode.size());
    return est.end();
}

} // namespace gcode_time
