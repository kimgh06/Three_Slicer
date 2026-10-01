// finish.cpp — extracted verbatim from slicer_core.cpp (pure code move; no behavior change).
//  Builds the stats object returned by slice(). The values it reads are all already final at the call site.
#include "slice_ctx.h"

#include <emscripten/emscripten.h>
#include <string>

em::val build_stats(const SliceCtx& C, const GW& gw, const gcode_time::Result& te,
                    const std::string& engine_used, const gcode_time::Limits& glim,
                    bool over_bed, bool streaming, bool economy,
                    double tw0, double tw_p1, double tw_p15, double tw_sup, double t_flush) {
  const int N = C.N, nraft = C.nraft;
  em::val stats = em::val::object();
  stats.set("layers", N + nraft);          // total emitted layers (raft included) = the length of the layers array
  stats.set("model_layers", N);
  stats.set("raft_layers", nraft);
  stats.set("path_segments", (double)gw.segments);
  stats.set("filament_mm", gw.filament);
  if (C.p->single_tool > 0) {   // the whole print on one filament other than the first: indexed by tool, as slice_multimaterial reports it
    em::val byTool = em::val::array();
    for (int tool = 0; tool < C.p->single_tool; ++tool) byTool.call<void>("push", 0.0);
    byTool.call<void>("push", gw.filament);
    stats.set("filament_mm_by_tool", byTool);
  }
  stats.set("wall_crossings", (double)gw.wall_crossings);   // number of wall-crossing travels (cross-check for reduce_crossing_wall)
  { double tw_end = emscripten_get_now();                    // phase timing (ms) — for deciding what to parallelize
    stats.set("t_pass1_ms",   tw_p1  - tw0);
    stats.set("t_surface_ms", tw_p15 - tw_p1);
    stats.set("t_support_ms", tw_sup - tw_p15);
    stats.set("t_emit_ms",    tw_end - tw_sup);
    stats.set("t_flush_ms", t_flush);                    // the JS boundary's share during emit (to_f32/sink/feed)
    }
  // over_bed answers "would this print leave the bed", not "is the MODEL too big" — so the model verdict from
  //  prepare_model (which also carries the height check) is widened by what the emitted extrusions actually did.
  //  Support/skirt/brim/raft reach past the model and were invisible to the old flag; see extrusion_bed_overflow.
  const GWBedOverflow over = extrusion_bed_overflow(gw, *C.p);
  stats.set("over_bed", over_bed || over.any());
  stats.set("over_bed_model", over_bed);       // the model-only verdict, kept so the two can be told apart
  stats.set("over_bed_x", over.x);             // how far past the bed the toolpaths reach, mm (0 = inside)
  stats.set("over_bed_y", over.y);
  stats.set("over_bed_z", over.z);   // emitted top layer past printable_height (raft included), mm
  // Upstream time estimate results
  stats.set("time_estimate", te.total_s);                   // total estimated print time (seconds)
  stats.set("first_layer_time", te.first_layer_s);
  stats.set("time_extrude", te.extrude_s);
  stats.set("time_travel", te.travel_s);
  stats.set("time_filament_mm", te.filament_mm);            // filament usage from parsing (to compare against gw.filament)
  stats.set("time_moves", (double)te.moves);
  { em::val lt=em::val::array(); for (size_t k=0;k<te.layer_s.size();++k) lt.call<void>("push", te.layer_s[k]);
    stats.set("layer_times", lt); }
  { em::val rt=em::val::object(); for (auto& kv:te.role_s) rt.set(std::to_string(kv.first), kv.second);
    stats.set("role_times", rt); }
  stats.set("time_engine", engine_used);                    // stage 13: which time estimation engine ran (full|transcribed|fallback)
  // Echo back the machine limits the estimator actually ran with, so the UI reports what was used instead of
  //  re-deriving it from the settings (which would silently lie whenever a limit is not wired through).
  { em::val ml=em::val::object();
    ml.set("max_speed_xy", glim.max_speed[0]); ml.set("max_speed_z", glim.max_speed[2]); ml.set("max_speed_e", glim.max_speed[3]);
    ml.set("max_accel_xy", glim.max_accel[0]); ml.set("max_accel_z", glim.max_accel[2]); ml.set("max_accel_e", glim.max_accel[3]);
    ml.set("jerk_xy", glim.max_jerk[0]); ml.set("jerk_z", glim.max_jerk[2]); ml.set("jerk_e", glim.max_jerk[3]);
    ml.set("accel_print", glim.accel_print); ml.set("accel_travel", glim.accel_travel); ml.set("accel_retract", glim.accel_retract);
    stats.set("machine_limits", ml); }
  stats.set("streamed", streaming);                          // stage 30: when true, g-code/layers were emitted via the callback (not in result)
  stats.set("economy", economy);                             // stage 30: whether it finished in economy mode (no toolpaths, no time estimate)
  return stats;
}
