// Stage-13 bridge impl: the ONLY TU where the kernel meets the real GCodeProcessor + PrintConfig.
// Everything Slic3r stays here; gcodeproc_bridge.h exposes plain types only.
#include "gcodeproc_bridge.h"
#include "arachne_port/gcodeproc/GCode/GCodeProcessor.hpp"   // real GCodeProcessor (Print stub via -Igcodeproc/inc)
#include <cmath>
#include <cstdlib>

using namespace Slic3r;

namespace gcodeproc_bridge {

static void set2(ConfigOptionFloats& o, float v) { o.values = { (double)v, (double)v }; }

// Direct E-parse over one chunk, carrying M82/M83 (absolute/relative) + G92 E-reset state across calls
//  so a whole-string parse and a sequence of line-aligned chunk parses yield the same total.
static void parse_filament_chunk(const std::string& g, double& total, double& e_abs, bool& relative) {
    size_t i = 0, n = g.size();
    while (i < n) {
        size_t eol = g.find('\n', i); if (eol == std::string::npos) eol = n;
        const char* s = g.c_str() + i; size_t len = eol - i;
        while (len && (*s==' '||*s=='\t')) { ++s; --len; }
        if (len >= 3 && s[0]=='M' && s[1]=='8' && s[2]=='3') relative = true;
        else if (len >= 3 && s[0]=='M' && s[1]=='8' && s[2]=='2') relative = false;
        else if (len >= 1 && (s[0]=='G')) {
            std::string line(s, len);
            size_t ep = std::string::npos;
            for (size_t k = 1; k < line.size(); ++k) if (line[k]=='E' && (line[k-1]==' '||line[k-1]=='\t')) { ep = k; break; }
            bool isG92 = (line.size()>=3 && line[0]=='G' && line[1]=='9' && line[2]=='2');
            bool hasXY = false;
            for (size_t k = 1; k < line.size(); ++k) if ((line[k]=='X'||line[k]=='Y') && (line[k-1]==' '||line[k-1]=='\t')) { hasXY = true; break; }
            if (ep != std::string::npos) {
                double v = std::atof(line.c_str() + ep + 1);
                if (isG92) { e_abs = v; }
                else if (relative) { if (v > 0 && hasXY) total += v; else if (!hasXY) e_abs += v; }
                else { double d = v - e_abs; if (d > 0 && hasXY) total += d; e_abs = v; }
            }
        }
        i = eol + 1;
    }
}

// Direct E-parse: sum positive extrusion, honoring M82/M83 (absolute/relative) + G92 E resets.
static double parse_filament_mm(const std::string& g) {
    double total = 0.0, e_abs = 0.0; bool relative = false;
    parse_filament_chunk(g, total, e_abs, relative);
    return total;
}
// Inject the machine limits into a PrintConfig IN PLACE (shared by batch estimate + streaming begin).
//  NEVER return PrintConfig by value: StaticPrintConfig keeps an option map of pointers to its own
//  member fields; copying/moving it leaves that map dangling to the source's members → later option
//  lookups in process_buffer read freed memory (observed as a wasm OOB on gap-fill/thin-wall gcode).
static void fill_limits(PrintConfig& cfg, const Limits& lim) {
    set2(cfg.machine_max_speed_x, lim.max_speed[0]); set2(cfg.machine_max_speed_y, lim.max_speed[1]);
    set2(cfg.machine_max_speed_z, lim.max_speed[2]); set2(cfg.machine_max_speed_e, lim.max_speed[3]);
    set2(cfg.machine_max_acceleration_x, lim.max_accel[0]); set2(cfg.machine_max_acceleration_y, lim.max_accel[1]);
    set2(cfg.machine_max_acceleration_z, lim.max_accel[2]); set2(cfg.machine_max_acceleration_e, lim.max_accel[3]);
    set2(cfg.machine_max_jerk_x, lim.max_jerk[0]); set2(cfg.machine_max_jerk_y, lim.max_jerk[1]);
    set2(cfg.machine_max_jerk_z, lim.max_jerk[2]); set2(cfg.machine_max_jerk_e, lim.max_jerk[3]);
    set2(cfg.machine_max_acceleration_extruding, lim.accel_print);
    set2(cfg.machine_max_acceleration_travel,    lim.accel_travel);
    set2(cfg.machine_max_acceleration_retracting, lim.accel_retract);
    set2(cfg.machine_min_extruding_rate, lim.min_extrude_rate);
    set2(cfg.machine_min_travel_rate,    lim.min_travel_rate);
}

// Extract the time/move breakdown from a finalized GCodeProcessor into the plain Result (shared by
//  batch estimate() and streaming estimate_end()). filament_mm is the direct E-parse total.
static Result build_result(GCodeProcessor& gp, double filament_mm) {
    Result out;
    const auto& r = gp.get_result();
    const int NM = (int)PrintEstimatedStatistics::ETimeMode::Normal;
    out.total_s = r.print_statistics.modes[NM].time;
    out.moves   = (long)r.moves.size();
    std::map<long, double> layer_acc;   // key = round(position.z * 1000)
    for (const auto& m : r.moves) {
        const float t = m.time[NM];
        if (m.type == EMoveType::Extrude) { out.extrude_s += t; out.role_s[(int)m.extrusion_role] += t; }
        else if (m.type == EMoveType::Travel) out.travel_s += t;
        if (t > 0.f) layer_acc[(long)std::lround((double)m.position.z() * 1000.0)] += t;
    }
    out.layer_s.reserve(layer_acc.size());
    for (auto& kv : layer_acc) out.layer_s.push_back(kv.second);
    out.first_layer_s = out.layer_s.empty() ? 0.0 : out.layer_s.front();
    out.filament_mm = filament_mm;
    out.ok = out.total_s > 0.0;
    return out;
}

// ---- streaming state (one active stream; file-static like the rest of the bridge) ----
namespace {
    GCodeProcessor* g_gp = nullptr;
    double g_fil_total = 0.0, g_fil_e_abs = 0.0; bool g_fil_relative = false;
    // hand-over past the move cap: the text fed so far (kept only when a fallback was given — in batch mode the whole G-code is
    //  resident in gw.s anyway, so this is at most one more copy of the part before the cap), and the transcribed estimator that
    //  takes over. Measured on a 774k-facet model (2.2M moves, 58.6MB): without the hand-over the feeder's work was discarded at
    //  the cap and the whole text was re-parsed serially after the last layer, 3.2-3.7s of a 6.8s mt slice.
    bool g_keep_text = false; std::string g_kept; gcode_time::Limits g_fb_lim; gcode_time::Estimator* g_fb = nullptr;

    void reset_fallback() { delete g_fb; g_fb = nullptr; g_kept.clear(); g_kept.shrink_to_fit(); g_keep_text = false; }
}

void estimate_begin(const Limits& lim, const gcode_time::Limits* fallback) {
    delete g_gp; g_gp = new GCodeProcessor();
    PrintConfig cfg; fill_limits(cfg, lim);   // in-place (apply_config copies values out; no retained ref)
    g_gp->apply_config(cfg);
    g_fil_total = 0.0; g_fil_e_abs = 0.0; g_fil_relative = false;
    reset_fallback();
    if (fallback) { g_keep_text = true; g_fb_lim = *fallback; }
}
// ponytail: resident move cap — GCodeProcessor keeps ~100B per move resident in result.moves (measured at 4.45M moves,
//  an estimated +1.04GB on its own), and blocks write times back by absolute index, so draining midway is impossible.
//  Past the cap the estimator is released: streaming degrades to "stream-notime", and batch (mt overlap) hands the kept text plus
//  every later chunk to gcode_time::Estimator inside the same feeder thread (estimate_feed below), so the estimate keeps
//  overlapping emission. Reviving GCodeProcessor itself for large models needs port surgery toward incremental move aggregation.
static const size_t MOVES_CAP = 2000000;

void estimate_feed(const std::string& chunk) {
    if (chunk.empty()) return;
    if (g_fb) { g_fb->feed(chunk); return; }
    if (!g_gp) return;
    try { g_gp->process_buffer(chunk); } catch (...) {}
    if (g_gp->get_result().moves.size() > MOVES_CAP) {
        delete g_gp; g_gp = nullptr;
        if (!g_keep_text) return;
        g_fb = new gcode_time::Estimator(g_fb_lim);      // the same input the whole-text fallback used to parse, in the same order
        g_fb->feed(g_kept); g_kept.clear(); g_kept.shrink_to_fit();
        g_fb->feed(chunk);
        return;
    }
    parse_filament_chunk(chunk, g_fil_total, g_fil_e_abs, g_fil_relative);
    if (g_keep_text) g_kept += chunk;
}
Result estimate_end() {
    Result out;
    if (g_fb) {
        gcode_time::Result r = g_fb->end();
        out.total_s = r.total_s; out.layer_s = std::move(r.layer_s); out.first_layer_s = r.first_layer_s;
        out.extrude_s = r.extrude_s; out.travel_s = r.travel_s; out.role_s = std::move(r.role_s);
        out.filament_mm = r.filament_mm; out.moves = r.moves; out.ok = true; out.transcribed = true;
        reset_fallback();
        return out;
    }
    if (!g_gp) { reset_fallback(); return out; }
    try { g_gp->finalize(false); out = build_result(*g_gp, g_fil_total); }
    catch (...) { out.ok = false; }
    delete g_gp; g_gp = nullptr;
    reset_fallback();
    return out;
}

Result estimate(const std::string& gcode, const Limits& lim) {
    // Batch: one-shot process_buffer. Time breakdown notes: calculate_time INSERTS "actual-speed"
    //  render sub-moves (time[Normal]==0) so time sums are correct; layer key = position.z() (populated
    //  on every move regardless of CHANGE_LAYER). Filament = direct E-parse (matches kernel gw.filament).
    Result out;
    try {
        GCodeProcessor gp;
        PrintConfig cfg; fill_limits(cfg, lim);   // in-place — never copy StaticPrintConfig (dangling option map)
        gp.apply_config(cfg);
        gp.process_buffer(gcode);
        gp.finalize(false);
        out = build_result(gp, parse_filament_mm(gcode));
    } catch (...) {
        out.ok = false;
    }
    return out;
}

} // namespace gcodeproc_bridge
