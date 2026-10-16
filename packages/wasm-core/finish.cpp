// finish.cpp — extracted verbatim from slicer_core.cpp (pure code move; no behavior change).
//  Builds the stats object returned by slice(). The values it reads are all already final at the call site.
#include "slice_ctx.h"

#include <emscripten/emscripten.h>
#include <string>

em::val build_stats(const SliceContext& context, const GcodeWriter& writer, const gcode_time::Result& timeEstimate,
                    const std::string& engine_used, const gcode_time::Limits& timeLimits,
                    bool over_bed, bool streaming, bool economy,
                    double phaseStartMs, double pass1EndMs, double surfaceEndMs, double supportEndMs, double flushMs) {
  const int layerCount = context.layerCount;
  const int raftLayerCount = context.raftLayerCount;
  em::val stats = em::val::object();
  stats.set("layers", layerCount + raftLayerCount);          // total emitted layers (raft included) = the length of the layers array
  stats.set("model_layers", layerCount);
  stats.set("raft_layers", raftLayerCount);
  stats.set("path_segments", (double)writer.segments);
  stats.set("filament_mm", writer.filament);
  if (context.params->single_tool > 0) {   // the whole print on one filament other than the first: indexed by tool, as slice_multimaterial reports it
    em::val byTool = em::val::array();
    for (int tool = 0; tool < context.params->single_tool; ++tool) byTool.call<void>("push", 0.0);
    byTool.call<void>("push", writer.filament);
    stats.set("filament_mm_by_tool", byTool);
  }
  stats.set("wall_crossings", (double)writer.wall_crossings);   // number of wall-crossing travels (cross-check for reduce_crossing_wall)
  { double emitEndMs = emscripten_get_now();                    // phase timing (ms) — for deciding what to parallelize
    stats.set("t_pass1_ms",   pass1EndMs  - phaseStartMs);
    stats.set("t_surface_ms", surfaceEndMs - pass1EndMs);
    stats.set("t_support_ms", supportEndMs - surfaceEndMs);
    stats.set("t_emit_ms",    emitEndMs - supportEndMs);
    stats.set("t_flush_ms", flushMs);                    // the JS boundary's share during emit (to_f32/sink/feed)
    }
  // over_bed answers "would this print leave the bed", not "is the MODEL too big" — so the model verdict from
  //  prepare_model (which also carries the height check) is widened by what the emitted extrusions actually did.
  //  Support/skirt/brim/raft reach past the model and were invisible to the old flag; see extrusion_bed_overflow.
  const ExtrusionBedOverflow overflow = extrusion_bed_overflow(writer, *context.params);
  stats.set("over_bed", over_bed || overflow.any());
  stats.set("over_bed_model", over_bed);       // the model-only verdict, kept so the two can be told apart
  stats.set("over_bed_x", overflow.x);             // how far past the bed the toolpaths reach, mm (0 = inside)
  stats.set("over_bed_y", overflow.y);
  stats.set("over_bed_z", overflow.z);   // emitted top layer past printable_height (raft included), mm
  // Upstream time estimate results
  stats.set("time_estimate", timeEstimate.total_seconds);                   // total estimated print time (seconds)
  stats.set("first_layer_time", timeEstimate.first_layer_seconds);
  stats.set("time_extrude", timeEstimate.extrude_seconds);
  stats.set("time_travel", timeEstimate.travel_seconds);
  stats.set("time_filament_mm", timeEstimate.filament_mm);            // filament usage from parsing (to compare against writer.filament)
  stats.set("time_moves", (double)timeEstimate.moves);
  { em::val layerTimes = em::val::array();
    for (size_t k = 0; k < timeEstimate.layer_seconds.size(); ++k) layerTimes.call<void>("push", timeEstimate.layer_seconds[k]);
    stats.set("layer_times", layerTimes); }
  { em::val roleTimes = em::val::object();
    for (auto& roleTime : timeEstimate.role_seconds) roleTimes.set(std::to_string(roleTime.first), roleTime.second);
    stats.set("role_times", roleTimes); }
  stats.set("time_engine", engine_used);                    // stage 13: which time estimation engine ran (full|transcribed|fallback)
  // Echo back the machine limits the estimator actually ran with, so the UI reports what was used instead of
  //  re-deriving it from the settings (which would silently lie whenever a limit is not wired through).
  { em::val machineLimits = em::val::object();
    machineLimits.set("max_speed_xy", timeLimits.max_speed[0]);
    machineLimits.set("max_speed_z", timeLimits.max_speed[2]);
    machineLimits.set("max_speed_e", timeLimits.max_speed[3]);
    machineLimits.set("max_accel_xy", timeLimits.max_accel[0]);
    machineLimits.set("max_accel_z", timeLimits.max_accel[2]);
    machineLimits.set("max_accel_e", timeLimits.max_accel[3]);
    machineLimits.set("jerk_xy", timeLimits.max_jerk[0]);
    machineLimits.set("jerk_z", timeLimits.max_jerk[2]);
    machineLimits.set("jerk_e", timeLimits.max_jerk[3]);
    machineLimits.set("accel_print", timeLimits.accel_print);
    machineLimits.set("accel_travel", timeLimits.accel_travel);
    machineLimits.set("accel_retract", timeLimits.accel_retract);
    stats.set("machine_limits", machineLimits); }
  stats.set("streamed", streaming);                          // stage 30: when true, g-code/layers were emitted via the callback (not in result)
  stats.set("economy", economy);                             // stage 30: whether it finished in economy mode (no toolpaths, no time estimate)
  return stats;
}
