// =============================================================================
// slicer_core.cpp — the browser-only slicing mini kernel (track C, stage 3)
//
//  stage 1 (hollow shell) -> stage 2 (solid shell, skirt/brim, ASCII, z_hop, seam, worker progress)
//  -> stage 3 (support, raft, bed, multiple objects, monotonic)
//  -> stage 4 (path and G-code level):
//    · infill patterns: rectilinear/grid/triangles/zigzag (continuous path)/gyroid (sine approximation, z phase)
//    · cooling: fan ramp (M106 close -> full, linear) + slowdown for small layers (slow_down_layer_time)
//    · arc fitting: approximate consecutive segments with arcs -> G2/G3 (enable_arc_fitting)
//    · seam position: back/nearest/aligned/random (deterministic LCG)
//    · spiral (vase): a single outer wall rising continuously in z (spiral_mode)
//
//  -> stage 5 (quality / approximation features):
//    · gap fill (type7): the leftover of fill's morphological open (thin gaps) -> single-width center line approximation
//    · thin wall, Arachne-lite (type8): regions narrower than 2w -> one center line instead of walls + local width flow correction
//    · scarf seam (seam_slope_type=external/all): outer wall start z/flow ramp-up + end overlap ramp-down, ; scarf
//    · pressure advance (enable_pressure_advance): M900 K<v> in the preamble (noted as a comment for Klipper)
//    · tree-lite support (support_style=tree_lite): downward taper (-0.5mm per layer, minimum pillar r1.5mm) + union
//    · bridge (type9): unsupported bottom solid -> fan 100% + bridge_speed slowdown
//  -> stage 6 (closing the parity gap):
//    · ironing (type10, ironing_type): a low-flow second pass over exposed top solid (spacing/flow%/speed)
//    · wall-avoiding travel (reduce_crossing_wall): route around island boundaries + the stats.wall_crossings cross-check
//    · PressureEqualizer-lite (max_volumetric_extrusion_rate_slope): limits the flow change rate between adjacent segments (speed only)
//    · multi-material basics (extruder_count/mm_group_split): sliced per group + T0/T1 + prime tower (type11)
//  -> stage 7 (real port): wall_generator=arachne -> variable-width walls from the real ported OrcaSlicer Arachne WallToolPaths
//    (via arachne_bridge). Per-segment width -> E calculation (set_e_per_mm_width) + the widths[] toolpath array.
//    classic remains the default (backwards compatible). ⚠ Only the CGAL planarity recovery is stubbed; the rest of Arachne is upstream.
//  -> stage 8 (more real ports): the real OrcaSlicer Fill patterns (gyroid TPMS/honeycomb/3dhoneycomb/crosshatch/
//    concentric, via fill_bridge — gyroid is replaced by the real TPMS and the old sine approximation is preserved as gyroid_approx) +
//    the real PressureEqualizer (pe_bridge, opt-in via pe_lite=false).
//  -> stage 9 (full integration): the real PE fully working — with emit_pe_tags the kernel emits the OrcaSlicer tags (;_EXTRUSION_ROLE/
//    ;_EXTRUDE_SET_SPEED/;_EXTRUDE_END) so the real PE inserts per-segment F ramps (more G1 lines, E preserved), and pe_strip_tags
//    removes the tags at the end. + the TreeSupport core MST (tree_bridge, branch merging) ported — the full pipeline's PrintObject coupling is not.
//  -> stage 10 (upstream time estimate): the ported GCodeProcessor trapezoidal planner (gcode_time.{h,cpp} — the upstream algorithm transcribed
//    verbatim + machine limit parameters injected) parses the emitted g-code to produce stats.time_estimate (total/per layer/per role). The viewer
//    shows the estimate. The full GCodeProcessor and WipeTower are gated on the config subsystem (the real PrintConfig.hpp) — noted in the README.
//
//  ⚠ It is still a mini kernel. Unimplemented/approximate limits -> would need a full libslic3r port:
//    the complete Arachne skeleton (variable width), organic tree support, a proper wipe tower, precise PressureEqualizer,
//    complete wall avoidance, non-planar.
//
//  Pipeline (multi-pass): STL -> [p1] intersect, chain, union, walls, surface detection -> [p1.6] support
//    -> [p2] solid/sparse (patterns) split -> raft -> cooling/slowdown/seam/arc -> G-code (SPECS §6.2)
//  Coordinates: the model is moved so XY is centered on the origin and minZ=0. The G-code is shifted by +(bed/2) to stay positive.
// =============================================================================
// The sections that used to live here were extracted verbatim into their own files (pure code moves).
// Each carries its original section comment at the top of the file it moved to:
//   params · stl_parse · slice_planes · clip_util · geom_helpers   — parameters, STL, plane cuts, clipper helpers
//   gcode_writer · emit · emit_layer                               — the GcodeWriter writer and the toolpath emit helpers
//   layer_data · slice_mm · stream_sink · stage_cache              — layer data, multi-material, streaming sink, cache
//   pass1 · surfaces · support · preamble · raft · pass2 · finish  — the slice() phases (slice_ctx.h is the shared context)
//   bindings                                                      — the embind block (declares slice() via slice_api.h)
#include "clipper.hpp"
#include "pe_bridge.h"        // stage 8: bridge to the real ported OrcaSlicer PressureEqualizer (segment splitting)
#include "gcode_time.h"       // stage 10: the ported GCodeProcessor time estimation algorithm (upstream trapezoidal planner)
#include "gcodeproc_bridge.h" // stage 13: boundary bridge to the real ported GCodeProcessor itself (time_engine=full)
#include "treesupport_bridge.h" // stages 17/18: boundary bridge to the real organic TreeSupport (generate_tree_support_3D)
#include "clip_util.h"
#include "emit.h"
#include "emit_layer.h"
#include "geom_helpers.h"
#include "layer_data.h"
#include "params.h"
#include "contour_phase.h"
#include "selector_bridge.h"  // stage 20 -> MMU painting: the painted facet states decide whether a layer is multi-tool
#include "slice_api.h"
#include "cooling_bridge.h"
#include "custom_gcode.h"
#include "slice_ctx.h"
#include "slice_planes.h"
#include "stage_cache.h"
#include "stl_parse.h"
#include "stream_sink.h"
#include <emscripten/bind.h>
#include <emscripten/val.h>
#include <emscripten/emscripten.h>  // emscripten_get_now() — phase timing
#include <atomic>
#include <condition_variable>
#include <deque>
#include <memory>
#include <mutex>     // (mt) time estimate overlap queue — only used in __EMSCRIPTEN_PTHREADS__ builds
#include <thread>    // (mt) PASS 1 layers in parallel — only used in __EMSCRIPTEN_PTHREADS__ builds
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <string>
#include <vector>

using namespace ClipperLib;
namespace em = emscripten;

// slice(Uint8Array stl, string paramsJson, function onProgress) → { gcode, stats, layers[] }
// =============================================================================
em::val slice(em::val stl_bytes, std::string params_json, em::val onProgress) {
  auto report = [&](int done, int total){ if (!onProgress.isUndefined() && !onProgress.isNull()) onProgress(done, total); };
  Params params = parse_params(params_json);
  if (params.spiral_mode) params.wall_loops = 1;                 // vase: a single outer wall
  g_segment_tool = 0;                                      // the toolpath tool channel is thread_local and outlives a slice
  // G002: cancel flag — the UI writes 1 via SAB. Reset to 0 on entry; the loops poll it per iteration.
  auto* cancelFlag = (std::atomic<unsigned>*)(uintptr_t)treesupport_bridge::cancel_addr();
  cancelFlag->store(0);
  auto isCanceled = [cancelFlag]{ return cancelFlag->load(std::memory_order_relaxed) != 0; };
  // G003 incremental: reuse decision (viewer first, layerKey as the second line of defense). Not supported for MM.
  const std::string layerKey = make_layer_key(params);
  const bool reuseGeometry = params.reuse_stages >= 1 && g_stage_cache.valid && params.extruder_count < 2;
  const bool reuseSupport  = params.reuse_stages >= 2 && g_stage_cache.valid && g_stage_cache.layerKey == layerKey && params.extruder_count < 2;
  std::vector<Triangle> ownedTriangles;
  if (!reuseGeometry) {
    std::vector<uint8_t> bytes = em::convertJSArrayToNumberVector<uint8_t>(stl_bytes);
    ownedTriangles = parse_stl(bytes);
  }
  std::vector<Triangle>* triangleSource = nullptr;
  if (reuseGeometry) {
    triangleSource = &g_stage_cache.triangles;
  } else {
    triangleSource = &ownedTriangles;
  }
  std::vector<Triangle>& triangles = *triangleSource;

  em::val result = em::val::object();
  if (triangles.empty()) {
    result.set("error", std::string("STL parse failed or 0 triangles"));
    return result;
  }

  // Model preparation (bbox -> center/seat -> over_bed) -> pass1.cpp
  ModelPrep modelPrep = prepare_model(triangles, params, reuseGeometry);
  double centerX = modelPrep.centerX, centerY = modelPrep.centerY, height = modelPrep.height;
  bool over_bed = modelPrep.over_bed;

  const double lineWidth = params.line_width;
  double sparse_spacing = 0.0;
  if (params.infill_density > 1e-4) sparse_spacing = lineWidth / params.infill_density;
  const double solid_spacing   = lineWidth;   // solid = 100% fill
  double support_spacing;
  if (params.support_density > 1e-4) support_spacing = lineWidth / params.support_density;
  else support_spacing = lineWidth*3.0;

  // Multi-material (stretch goal): with two or more groups, branch to the separate-slice + tool change + prime
  //  tower path. Either boundary form gets there — mm_group_splits carries N groups, mm_group_split just one.
  auto usable = [&](int boundary){ return boundary > 0 && boundary < (int)triangles.size(); };
  bool hasGroups = usable(params.mm_group_split);
  for (double boundary : params.mm_group_splits) if (usable((int)boundary)) hasGroups = true;
  // Painting is the other way a model becomes multi-tool, and the only way a SINGLE object can be: there is no
  //  triangle boundary to split on, only painted facets saying "this area is Extruder2". States are scanned from 2
  //  because state 1 is Extruder1 == T0 — painting the tool the object already prints with adds no second tool.
  //  This used to be gated on !enable_support, because slice_multimaterial emitted no support and routing a
  //  support-enabled slice there dropped it silently. It now runs the same support_run pass the single-material
  //  path does, so the gate is gone and painting a material no longer costs the support.
  //  What remains is the AMBIGUITY the gate also papered over: one selector serves both brushes, and upstream's
  //  EnforcerBlockerType makes BLOCKER and Extruder2 the same integer 2 (selector_bridge.h). The material brush
  //  therefore reads state 2 as "print with T1"; a support blocker painted on the same model is indistinguishable.
  //  Upstream avoids this by keeping supported_facets and mmu_segmentation_facets as SEPARATE annotations per
  //  volume (Model.hpp:869-879) — splitting the selector the same way is what makes both brushes usable at once.
  bool hasPaintedTools = false;
  for (int state = 2; state <= selector_bridge::STATE_EXTRUDER_MAX && state-1 < params.extruder_count; ++state)
    if (params.extruder_count >= 2 && selector_bridge::painted_count(state) > 0) {
      hasPaintedTools = true;
      break;
    }
  // A per-feature filament id is the third way a single object needs two tools (after triangle groups and paint):
  //  "print the outer wall with filament 2". Ids of 0 (Default) and 1 (the default extruder, T0) add no second tool,
  //  so only 2 and above route here — which is what keeps every existing single-material slice off this path.
  const bool hasFeatureTools = params.outer_wall_filament_id >= 2 || params.inner_wall_filament_id >= 2 ||
                               params.sparse_infill_filament_id >= 2 || params.top_surface_filament_id >= 2 ||
                               params.bottom_surface_filament_id >= 2 || params.internal_solid_filament_id >= 2;
  if (params.extruder_count >= 2 && (hasGroups || hasPaintedTools || hasFeatureTools))
    return slice_multimaterial(triangles, params, onProgress, height, over_bed);

  // A single-material slice on a filament other than the first (every object of the plate on filament 4): that
  //  filament's values replace the scalars, as slice_multimaterial reloads them on a T change. Upstream switches to
  //  the initial extruder after the start block (GCode.cpp:3643), which on a single-extruder machine writes no T,
  //  so none is written here either; the start template loads the filament from initial_extruder.
  const int singleTool = params.single_tool;
  if (singleTool > 0) {
    params.nozzle_temp       = Params::forTool(params.extruder_nozzle_temp, singleTool, params.nozzle_temp);
    params.filament_diameter = Params::forTool(params.extruder_filament_diameter, singleTool, params.filament_diameter);
    params.flow_ratio        = Params::forTool(params.extruder_flow_ratio, singleTool, params.flow_ratio);
    params.retract_length    = Params::forTool(params.extruder_retract_length, singleTool, params.retract_length);
    params.retract_speed     = Params::forTool(params.extruder_retract_speed, singleTool, params.retract_speed);
    params.z_hop             = Params::forTool(params.extruder_z_hop, singleTool, params.z_hop);
  }
  g_segment_tool = singleTool;                             // the preview's tool channel: the filament the model prints with

  // Count the z levels (the progress total)
  const int layerCount = (int)plan_layers(params.first_layer_height, params.layer_height, height).top.size();
  int total = 2*layerCount + 2;   // +2 = the surface and support completion ticks. Previously nothing was reported between PASS1 (50%) and the end of support -> it looked "stuck at 50%".

  // Phase timing (exposed only through stats — no effect on g-code, golden-safe)
  double timeStart = emscripten_get_now(), timePass1 = 0, timePass15 = 0, timeSupport = 0;
  double timeFlush = 0;          // accumulated flush_layer time (the JS boundary: to_f32/layersArray/sink + feeding the estimator) — the rest is G1 formatting

  // ---- PASS 1: per-layer contours, walls and infill regions ----
  //  No inter-layer dependencies (reads: the shared immutable triangles/params, writes: an independent layers[i]) -> layers run in parallel in -pthread builds.
  //  z is precomputed serially exactly like the old accumulating loop (z+=layer_height) — preserving FP accumulation order (golden-safe).
  const bool keepStages = (params.keep_stages || reuseSupport) && params.extruder_count < 2;
  g_keep_island = keepStages;
  // stage 19: tree support z alignment diagnostics (G003: hoisted)
  double treeZMaxResidual = -1.0;
  int treeSupportLayers = 0;
  std::vector<LayerData> layersOwn;
  if (!reuseSupport) layersOwn.resize(layerCount);
  std::vector<LayerData>* layerSource = nullptr;
  if (reuseSupport) {
    layerSource = &g_stage_cache.layers;
  } else {
    layerSource = &layersOwn;
  }
  std::vector<LayerData>& layers = *layerSource;
  // Phase context: exactly the slice()-scope state the moved phase bodies used to capture.
  SliceContext context;
  context.params=&params;
  context.triangles=&triangles;
  context.layers=&layers;
  context.isCanceled=isCanceled;
  context.report=report;
  context.treeZMaxResidual=&treeZMaxResidual;
  context.treeSupportLayers=&treeSupportLayers;
  context.layerCount=layerCount;
  context.total=total;
  context.height=height;
  context.lineWidth=lineWidth;
  context.centerX=centerX;
  context.centerY=centerY;
  context.sparse_spacing=sparse_spacing;
  context.solid_spacing=solid_spacing;
  context.support_spacing=support_spacing;
  if (reuseSupport) {
    // G003: geometry and support settings unchanged — PASS1, surfaces and support all come from the cache; only emission re-runs.
    timePass1 = timePass15 = emscripten_get_now();
    treeSupportLayers = g_stage_cache.treeSupportLayers;
    treeZMaxResidual = g_stage_cache.treeZMaxResidual;
    report(layerCount, total);
    report(layerCount+1, total);
  } else {
    contour_phase::captured = false;
    if (!pass1_run(context)) {
      em::val response=em::val::object();
      // pass1 stopped on purpose, with every layer's loops held for the union outside the kernel (contour_phase.h)
      if (contour_phase::captured) {
        response.set("captured", true);
        response.set("layers", layerCount);
        return response;
      }
      response.set("error", std::string("canceled"));
      return response;
    }

  timePass1 = emscripten_get_now();

  // ---- PASS 1.5: surface detection (this layer's fill − the neighboring contour) ----
  surfaces_run(context);

  timePass15 = emscripten_get_now();
  report(layerCount+1, total);                            // surface detection completion tick (signals entering support generation)

  // ---- PASS 1.6: support (overhang detection -> vertical projection -> interface/base) ----
  support_run(context);

  // ---- Preamble ----
  }                                              // G003: end of the reuseSupport skip block (only PASS1~1.6 is skipped — preamble, raft and emission are shared)

  // Issue 63: with the flattened settings present, the printer's custom start G-code is expanded here, before
  //  anything is emitted, so a template error fails the slice with no feeder or thread started yet.
  const bool customGcode = custom_gcode_active(params);
  CustomStart customStart;
  const CustomStart* startBlock = nullptr;
  if (customGcode) {
    std::string error = custom_gcode_start(params, single_material_facts(params, layers, layerCount, params.bed_center_x(), params.bed_center_y()), customStart);
    if (!error.empty()) {
      custom_gcode_bridge::end();
      em::val response=em::val::object();
      response.set("error", error);
      return response;
    }
    startBlock = &customStart;
  }

  GcodeWriter writer;
  writer.gcode.reserve(1<<17);
  EmitFlags emitFlags = gcode_writer_setup_preamble(writer, params, treeSupportLayers, treeZMaxResidual, startBlock);
  writer.current_tool = singleTool;                      // loaded by the start template, so a support T change returns to it
  bool realPE = emitFlags.realPE, ironOn = emitFlags.ironOn, scarfOn = emitFlags.scarfOn;
  int  seamMode = emitFlags.seamMode;
  SeamContext seamContext;
  // Upstream's cooling filter (cooling_bridge.h) runs with the printer's settings: it then owns the fan and the
  //  layer-time slowdown, and every layer passes through it in print order (flush_layer, flushJob). Not with the PE
  //  tags on: the PE post-process reads the ;_EXTRUDE_SET_SPEED markers the filter removes (ponytail: both together
  //  would need the filter to keep them for the PE pass, as upstream does when its pressure equalizer is on).
  bool cooling = false;
  struct CoolingSession {
    bool active = false;
    ~CoolingSession(){ if (active) cooling_bridge::end(); }
  } coolingSession;
  if (customGcode && !writer.emit_pe_tags) {
    std::vector<unsigned int> tools = { (unsigned int)singleTool };
    for (int tool : { Params::support_tool_of(params.support_filament), Params::support_tool_of(params.support_interface_filament) })
      if (tool >= 0 && std::find(tools.begin(), tools.end(), (unsigned int)tool) == tools.end()) tools.push_back((unsigned int)tool);
    if (cooling_bridge::begin(params.placeholder_config, tools).empty()) {
      cooling = true;
      coolingSession.active = true;
      const cooling_bridge::Markers markers = cooling_bridge::markers((unsigned int)singleTool);
      writer.cooling_markers = true;
      writer.fan_overhang = markers.overhang;
      writer.fan_overhang_external = markers.overhang_external;
      writer.fan_support_interface = markers.support_interface;
      writer.fan_ironing = markers.ironing;
      if (markers.overhang) context.overhangOverlap = markers.overhang_overlap;
    }
  }
  context.cooling = cooling;
  context.reduceInfillRetraction = params.reduce_infill_retraction && params.infill_density > 0;
  // The printer's layer templates (custom_gcode_layer): the writers mark their slots, the serial flush fills them.
  bool layerSlots = customGcode && custom_gcode_layer_slots();
  writer.layer_slots = layerSlots;
  if (layerSlots) custom_gcode_layers_begin();
  std::string layerError;                        // a layer template that fails fails the slice once the layers are done
  // One printed layer's text made final, in print order: its templates expanded, then the cooling filter.
  //  `filamentBefore` is the filament (mm) the print had extruded before this layer.
  auto finishLayer = [&](std::string text, int layer, double z, double filamentBefore) {
    if (layerSlots) {
      const double area = PI * params.filament_diameter * params.filament_diameter / 4.0;
      std::vector<double> volumes((size_t)singleTool + 1, 0.0);
      volumes[(size_t)singleTool] = filamentBefore * area;
      text = custom_gcode_layer(std::move(text), layer, z, singleTool, volumes, layerError);
    }
    if (cooling) text = cooling_bridge::process_layer(std::move(text), layer, (unsigned int)singleTool);
    return text;
  };

  int travelFeed = (int)std::llround(params.travel_speed*60);
  int firstLayerFeed  = (int)std::llround(params.first_layer_speed*60);
  em::val layersArray = em::val::array();

  // Stage 30: streaming setup — streaming (release writer.gcode after emitting each chunk) only when a layer sink is registered and the real PE
  //  (whole-string cross-layer smoothing) is not in use. realPE needs the entire g-code, so it falls back to batch (opt-in, outside the golden path).
  em::val& sink = layer_sink();
  bool streaming = (!sink.isUndefined() && !sink.isNull() && !realPE);
  bool economy   = streaming && params.economy;      // economy: skip toolpaths and the time estimate (r.moves would stay resident in bulk), G-code only
  bool streamTime = streaming && !economy;      // streamed time estimate (chunk feeding) — skipped in economy mode
  gcode_time::Limits timeLimits;
  gcodeproc_bridge::Limits processorLimits;
  setup_time_limits(params, timeLimits, processorLimits);                // machine limits for the time estimate (shared by streaming and batch)
#ifdef __EMSCRIPTEN_PTHREADS__
  // (mt) Overlap targets: streamed full estimates and batch full estimates (realPE is excluded because it needs whole-string post-processing,
  //  and transcribed is a different engine so it keeps the old path). In batch mode the accumulated writer.gcode is sliced and fed at each flush.
  TimeFeeder feeder;
  const bool overlapBatch = !streaming && !realPE && params.time_engine != "transcribed";
  size_t fedOffset = 0;                            // batch overlap: how much of writer.gcode has already been fed
  const gcode_time::Limits* fallback = nullptr;   // batch keeps writer.gcode resident, so the hand-over's kept text costs no new ceiling; streaming stays stream-notime
  if (overlapBatch) fallback = &timeLimits;
  if (streamTime || overlapBatch) feeder.begin(processorLimits, fallback);
  auto feed_batch_tail = [&]{                   // feed everything after the last flush (including the footer)
    std::string chunk = writer.gcode.substr(fedOffset);
    fedOffset = writer.gcode.size();
    if (writer.emit_pe_tags && params.pe_strip_tags) strip_pe_tags(chunk);   // batch feeds the estimator the same tag-stripped input as streaming
    feeder.feed(std::move(chunk));
  };
#else
  if (streamTime) gcodeproc_bridge::estimate_begin(processorLimits, nullptr);
#endif
  // Layer emission: batch accumulates into layersArray; streaming emits a chunk (everything in writer.gcode since the last flush) plus the toolpaths, then releases writer.gcode.
  //  The preamble goes into the first flush chunk and the footer into the last -> concatenating the chunks is byte-identical to the batch writer.gcode.
  // The cooling filter's input is one printed layer's text: what writer.gcode gained since the last flush (coolStart).
  size_t coolStart = 0;
  int printedLayer = 0;
  double filamentFlushed = 0.0;                  // writer.filament as of the last flush: what every earlier layer extruded
  auto flush_layer = [&](double z, int layerIndex, std::vector<float>& toolpath, std::vector<float>& widths) {
    double flushStart = emscripten_get_now();
    struct FlushTimer {
      double& total, start;
      ~FlushTimer(){ total += emscripten_get_now() - start; }
    } flushTimer{timeFlush, flushStart};
    if (cooling || layerSlots) {
      std::string layerText = writer.gcode.substr(coolStart);
      writer.gcode.resize(coolStart);
      writer.gcode += finishLayer(std::move(layerText), printedLayer, z, filamentFlushed);
    }
    filamentFlushed = writer.filament;
    ++printedLayer;
    if (!streaming) {
      em::val layerObject=em::val::object();
      layerObject.set("z",z);
      layerObject.set("paths",to_f32(toolpath));
      layerObject.set("widths",to_f32(widths));
      layersArray.call<void>("push", layerObject);
#ifdef __EMSCRIPTEN_PTHREADS__
      if (overlapBatch) feed_batch_tail();               // feed the estimator worker incrementally at each layer boundary (aligned to '\n')
#endif
      coolStart = writer.gcode.size();
      return;
    }
    std::string chunk;
    chunk.swap(writer.gcode);   // take the accumulated text and empty writer.gcode (freeing the heap)
    coolStart = 0;
    if (writer.emit_pe_tags && params.pe_strip_tags) strip_pe_tags(chunk);   // stateless line filter (chunked == batch)
#ifdef __EMSCRIPTEN_PTHREADS__
    if (streamTime) feeder.feed(chunk);                  // fed as a copy — chunk is also handed to the sink afterwards
#else
    if (streamTime) gcodeproc_bridge::estimate_feed(chunk);
#endif
    em::val paths = em::val::undefined();
    em::val widthArray = em::val::undefined();
    if (economy) {
      paths = em::val::array();
      widthArray = em::val::array();
    } else {
      paths = to_f32(toolpath);
      widthArray = to_f32(widths);
    }
    sink(z, layerIndex, chunk, paths, widthArray);
  };

  // ---- Raft (inserted below the model, shifting the model in z) ----
  coolStart = writer.gcode.size();                       // the preamble is not a layer: the filter starts after it
  int raftLayers = std::max(0, params.raft_layers);
  double zShift = raft_emit(writer, params, layers, lineWidth, raftLayers, travelFeed, firstLayerFeed, seamContext, flush_layer);
  // finalize the phase context for precomputeLayer
  context.raftLayerCount = raftLayers;
  context.zShift = zShift;
  context.ironOn = ironOn;

  timeSupport = emscripten_get_now();
  if (isCanceled()) {   // G002 (no threads up to this point)
    em::val response=em::val::object();
    response.set("error", std::string("canceled"));
    return response;
  }
  report(layerCount+2, total);                            // support generation completion tick

  // ---- PASS 2 precomputation: per-layer geometry separation and infill line generation (split out of the emission loop below) ----
  //  A verbatim move of the computation block from inside the old emission loop — formulas and call order unchanged (verified byte-identical against golden).
  auto precomputeLayer = [&](int i) -> EmitPrecompute { return precompute_layer_emit(context, i); };

#ifdef __EMSCRIPTEN_PTHREADS__
  // (mt) The PASS2 computation runs in parallel — workers precompute up to PRECOMPUTE_WINDOW layers ahead of the consumer (emission).
  //  Safety: while the consumer is on i, in-flight workers are always on k>i (they complete in the order they were claimed), and
  //  the L[j] a worker reads satisfies j >= k−bottom_shell+1 > the early-release point old=i−max(bsl,1)−1 -> no conflict with the release.
  //  The window bounds resident memory (W layers' worth of lines) — keeping the early-release OOM mitigation.
  std::vector<EmitPrecompute> precomputeBuffer(layerCount);
  std::vector<uint8_t> precomputeDone(layerCount, 0);
  std::mutex precomputeMutex;
  std::condition_variable precomputeDoneCondition, precomputeRoomCondition;
  int nextPrecompute = 0, lastConsumedPrecompute = -1;
  unsigned precomputeHardwareThreads = std::thread::hardware_concurrency();
  if (!precomputeHardwareThreads) precomputeHardwareThreads = 4;
  const bool parallelEmit = !params.spiral_mode && !scarfOn && writer.pe_slope <= 0.0 && !writer.emit_pe_tags
                       && !realPE;   // conditions under which G003 parallel emission is possible (otherwise serial fallback)
  //  Arachne walls emit through the writer's own GcodeWriter and the thread_local width state like every other role, so arachne is
  //  not among them: it was, and a 1.13M-facet hybrid plate with arachne walls emitted on one thread (emit 3.2 -> 1.7 s
  //  threaded; G-code, toolpaths and widths byte-identical to st on it and on a 3M-facet arachne model).
  unsigned precomputeThreadsWanted;
  if (parallelEmit) precomputeThreadsWanted = precomputeHardwareThreads / 2;
  else precomputeThreadsWanted = precomputeHardwareThreads - 1;
  unsigned precomputeThreadCount = std::min<unsigned>(std::max(1u, precomputeThreadsWanted), (unsigned)std::max(1, layerCount));
  const int PRECOMPUTE_WINDOW = (int)precomputeThreadCount * 2 + 4;
  auto precomputeWork = [&]{
    for (;;) {
      int k = -1;
      {
        std::unique_lock<std::mutex> lock(precomputeMutex);
        precomputeRoomCondition.wait(lock, [&]{ return nextPrecompute >= layerCount || nextPrecompute <= lastConsumedPrecompute + PRECOMPUTE_WINDOW; });
        if (nextPrecompute >= layerCount) break;
        k = nextPrecompute++;
      }
      EmitPrecompute layerPrecompute = precomputeLayer(k);
      {
        std::lock_guard<std::mutex> lock(precomputeMutex);
        precomputeBuffer[k] = std::move(layerPrecompute);
        precomputeDone[k] = 1;
      }
      precomputeDoneCondition.notify_all();
    }
  };
  std::vector<std::thread> precomputeThreads;
  precomputeThreads.reserve(precomputeThreadCount);
  for (unsigned threadIndex=0; threadIndex<precomputeThreadCount; ++threadIndex) precomputeThreads.emplace_back(precomputeWork);
#endif

  // ---- PASS 2: solid/sparse infill separation + support + emission ----
#ifdef __EMSCRIPTEN_PTHREADS__
  if (parallelEmit) {
    // G003: E1 (a serial dry run — chaining the seam, position, current_feed and fan entry state) -> a writer pool (per-layer G-code/toolpath generation)
    //  -> an ordered flush. E is relative (M83) so it is layer-local, and cross-layer state is fully captured by the entry cursor -> byte-identical to st (serial)
    //  (gates: golden + a large-model cmp). filament is the ordered sum of per-layer partials (only the association order differs — the theoretical %.2f rounding
    //  boundary risk in the footer is covered by golden). The window (flushWindow) bounds residency -> keeping the streaming OOM mitigation.
    struct Cursor {
      double positionX, positionY;
      int currentFeed, lastFan;
      unsigned lastAcceleration, lastTravelAcceleration;
      double lastJerk;
      SeamContext seam;
    };
    struct EmitJob {
      EmitPrecompute precomputed;
      Cursor entry;
      Paths island;
      std::string gcode;
      std::vector<float> toolpath, widths;
      double filament = 0;
      long segments = 0, crossings = 0;
      std::atomic<int> state{0};   // 0=ready 1=dispatched 2=done
    };
    std::vector<std::unique_ptr<EmitJob>> jobs(layerCount);
    for (int k = 0; k < layerCount; ++k) jobs[k] = std::make_unique<EmitJob>();
    std::mutex emitMutex;
    std::condition_variable emitCondition;
    int nextWriterJob = 0, dispatched = 0;
    GcodeWriter base = writer;   // the template GcodeWriter for writers
    base.gcode.clear();
    base.island.clear();
    base.dry_run = false;
    // A writer's totals are its layer's alone: flushJob adds them to writer's. Copied as they stood, every layer re-added
    //  what the raft had already counted (measured on a 20mm cube with 2 raft layers: 9018.83mm of filament, st 1084.41).
    base.filament = 0;
    base.segments = 0;
    base.wall_crossings = 0;
    unsigned writerHardwareThreads = std::thread::hardware_concurrency();
    if (!writerHardwareThreads) writerHardwareThreads = 4;
    unsigned writerCount = std::max(1u, writerHardwareThreads / 2);
    auto writerWork = [&]{
      for (;;) {
        int k = -1;
        {
          std::unique_lock<std::mutex> lock(emitMutex);
          emitCondition.wait(lock, [&]{ return nextWriterJob < dispatched || nextWriterJob >= layerCount; });
          if (nextWriterJob >= layerCount) break;
          k = nextWriterJob++;
        }
        EmitJob& job = *jobs[k];
        GcodeWriter layerWriter = base;
        g_segment_tool = singleTool;   // thread_local: a pool thread keeps the tool the previous slice left on it
        layerWriter.position_x = job.entry.positionX;
        layerWriter.position_y = job.entry.positionY;
        layerWriter.current_feed = job.entry.currentFeed;
        layerWriter.lastFan = job.entry.lastFan;
        layerWriter.last_acceleration = job.entry.lastAcceleration;
        layerWriter.last_travel_acceleration = job.entry.lastTravelAcceleration;
        layerWriter.last_jerk = job.entry.lastJerk;
        layerWriter.island = std::move(job.island);
        SeamContext seam = job.entry.seam;
        LayerData& jobLayer = layers[k];
        emit_layer_any(layerWriter, job.toolpath, job.widths, k, jobLayer, job.precomputed, params, jobLayer.z + zShift, lineWidth, layerCount, raftLayers, travelFeed, seamMode, scarfOn, ironOn, seam);
        job.gcode.swap(layerWriter.gcode);
        job.filament = layerWriter.filament;
        job.segments = layerWriter.segments;
        job.crossings = layerWriter.wall_crossings;
        job.state.store(2, std::memory_order_release);
        emitCondition.notify_all();
      }
    };
    std::vector<std::thread> writerThreads;
    writerThreads.reserve(writerCount);
    for (unsigned threadIndex = 0; threadIndex < writerCount; ++threadIndex) {
      try { writerThreads.emplace_back(writerWork); } catch (...) { break; }
    }
    const int flushWindow = (int)std::max<size_t>(1, writerThreads.size()) * 2 + 2;
    int nextFlush = 0;
    auto flushJob = [&](int k){
      EmitJob& job = *jobs[k];
      if (writerThreads.empty()) {   // fallback when no writer could be spawned (pool exhausted): the main thread generates it itself
        GcodeWriter layerWriter = base;
        layerWriter.position_x=job.entry.positionX;
        layerWriter.position_y=job.entry.positionY;
        layerWriter.current_feed=job.entry.currentFeed;
        layerWriter.lastFan=job.entry.lastFan;
        layerWriter.last_acceleration=job.entry.lastAcceleration;
        layerWriter.last_travel_acceleration=job.entry.lastTravelAcceleration;
        layerWriter.last_jerk=job.entry.lastJerk;
        layerWriter.island = std::move(job.island);
        SeamContext seam = job.entry.seam;
        LayerData& jobLayer = layers[k];
        emit_layer_any(layerWriter, job.toolpath, job.widths, k, jobLayer, job.precomputed, params, jobLayer.z + zShift, lineWidth, layerCount, raftLayers, travelFeed, seamMode, scarfOn, ironOn, seam);
        job.gcode.swap(layerWriter.gcode);
        job.filament = layerWriter.filament;
        job.segments = layerWriter.segments;
        job.crossings = layerWriter.wall_crossings;
        job.state.store(2);
      }
      {
        std::unique_lock<std::mutex> lock(emitMutex);
        emitCondition.wait(lock, [&]{ return job.state.load(std::memory_order_acquire) == 2; });
      }
      // The layer templates and the cooling filter are stateful across layers, so they run here, in print order, on the
      //  layer alone. writer.filament has not taken this layer's yet: it is what the earlier layers extruded.
      if (cooling || layerSlots) job.gcode = finishLayer(std::move(job.gcode), k + raftLayers, layers[k].z + zShift, writer.filament);
      double jobZ = layers[k].z + zShift;
      writer.filament += job.filament;
      writer.segments += job.segments;
      writer.wall_crossings += job.crossings;
      if (!streaming) {
        em::val layerObject = em::val::object();
        layerObject.set("z", jobZ);
        layerObject.set("paths", to_f32(job.toolpath));
        layerObject.set("widths", to_f32(job.widths));
        layersArray.call<void>("push", layerObject);
        writer.gcode += job.gcode;
        if (overlapBatch) feed_batch_tail();
      } else {
        // Text written outside the writers — the preamble, and anything else still in writer.gcode — goes ahead of the layer,
        //  as flush_layer sends it and as the batch branch above appends it. Sending job.gcode alone held the preamble
        //  back until the footer flush, so a streamed mt slice put M83 and the temperatures after the last layer.
        std::string chunk;
        chunk.swap(writer.gcode);
        chunk += job.gcode;
        if (streamTime) feeder.feed(chunk);
        em::val paths = em::val::undefined();
        em::val widthArray = em::val::undefined();
        if (economy) {
          paths = em::val::array();
          widthArray = em::val::array();
        } else {
          paths = to_f32(job.toolpath);
          widthArray = to_f32(job.widths);
        }
        sink(jobZ, k, chunk, paths, widthArray);
      }
      job.gcode = std::string();
      job.toolpath = {};
      job.widths = {};
      job.precomputed = EmitPrecompute{};
      if (!keepStages) {
        int releaseLayer = k - std::max(params.bottom_shell_layers, 1) - 1 - flushWindow;   // release only outside the writer/dry reference window
        if (releaseLayer >= 0) layers[releaseLayer] = LayerData{};
      }
      report(layerCount+2+k+1, total);
    };
    writer.dry_run = true;
    bool dispatchCanceled = false;
    std::vector<float> dryToolpath, dryWidths;   // dry-run dummies (not recorded)
    for (int i = 0; i < layerCount; ++i) {
      if (isCanceled()) {   // G002: stop dispatching new work -> join the existing shutdown path
        dispatchCanceled = true;
        break;
      }
      EmitPrecompute precompute;
      {
        std::unique_lock<std::mutex> lock(precomputeMutex);
        precomputeDoneCondition.wait(lock, [&]{ return precomputeDone[i] != 0; });
        precompute = std::move(precomputeBuffer[i]);
        lastConsumedPrecompute = i;
      }
      precomputeRoomCondition.notify_all();
      LayerData& layerData = layers[i];
      EmitJob& job = *jobs[i];
      job.entry = { writer.position_x, writer.position_y, writer.current_feed, writer.lastFan, writer.last_acceleration, writer.last_travel_acceleration, writer.last_jerk, seamContext };
      if (g_keep_island) job.island = layerData.island;   // G003
      else job.island = std::move(layerData.island);
      emit_layer_any(writer, dryToolpath, dryWidths, i, layerData, precompute, params, layerData.z + zShift, lineWidth, layerCount, raftLayers, travelFeed, seamMode, scarfOn, ironOn, seamContext);
      job.precomputed = std::move(precompute);
      {
        std::lock_guard<std::mutex> lock(emitMutex);
        dispatched = i + 1;
        job.state.store(1);
      }
      emitCondition.notify_all();
      if (i - flushWindow >= nextFlush) {
        flushJob(nextFlush);
        ++nextFlush;
      }
    }
    writer.dry_run = false;
    while (!dispatchCanceled && nextFlush < layerCount) {   // G002: on cancel, never wait for undispatched jobs (avoids a deadlock)
      flushJob(nextFlush);
      ++nextFlush;
    }
    {
      std::lock_guard<std::mutex> lock(emitMutex);
      nextWriterJob = std::max(nextWriterJob, layerCount);
      dispatched = layerCount;
    }
    emitCondition.notify_all();
    for (auto& thread : writerThreads) thread.join();
  } else
#endif
  for (int i=0;i<layerCount;++i) {
    if (isCanceled()) break;   // G002
    if (!keepStages) {
      int releaseLayer = i - std::max(params.bottom_shell_layers, 1) - 1;
      if (releaseLayer >= 0) layers[releaseLayer] = LayerData{};
    }
    EmitPrecompute precompute;
#ifdef __EMSCRIPTEN_PTHREADS__
    {
      std::unique_lock<std::mutex> lock(precomputeMutex);
      precomputeDoneCondition.wait(lock, [&]{ return precomputeDone[i] != 0; });
      precompute = std::move(precomputeBuffer[i]);
      lastConsumedPrecompute = i;
    }
    precomputeRoomCondition.notify_all();
#else
    precompute = precomputeLayer(i);
#endif
    LayerData& layerData = layers[i];
    double layerZ = layerData.z + zShift;
    std::vector<float> toolpath;
    std::vector<float> widths;
    if (params.spiral_mode && !layerData.contour.empty()) {
      // ===== Spiral (vase): a single outer wall with a z ramp — excluded from parallelism, kept inline as before =====
      writer.set_e_per_mm(layerData.thickness, params);
      writer.z = layerZ;
      writer.pe_reset();
      if (g_keep_island) writer.island = layerData.island;   // G003
      else writer.island = std::move(layerData.island);
      seamContext.randomState = 2654435761u * (uint32_t)(i+1);
      g_segment_widths = &widths;
      g_current_segment_width = (float)lineWidth;
      char layerComment[72];
      std::snprintf(layerComment,sizeof layerComment,"; LAYER %d Z%.3f",i,layerZ);
      writer.layer_begin(layerComment);
      writer.set_fan(fan_S(i, params));
      writer.layer_z(layerZ, travelFeed);
      if (i + raftLayers == 1) writer.second_layer_begin();
      double spiralSpeed;
      if (i==0&&raftLayers==0) spiralSpeed = params.first_layer_speed;
      else spiralSpeed = params.print_speed;
      int spiralFeed = (int)std::llround(spiralSpeed*60);
      writer.set_feature((int)FlowRole::OuterWall);
      spiralFeed = role_feeds(params, i==0 && raftLayers==0, i + raftLayers, raftLayers, spiralFeed, spiralFeed, -1.0).of(FlowRole::OuterWall);
      Paths outerWall;
      if (!layerData.walls.empty()) outerWall = layerData.walls[0];
      emit_spiral(writer, toolpath, outerWall, layerZ, layerData.thickness, spiralFeed, travelFeed);
    } else {
      emit_layer_any(writer, toolpath, widths, i, layerData, precompute, params, layerZ, lineWidth, layerCount, raftLayers, travelFeed, seamMode, scarfOn, ironOn, seamContext);
    }
    flush_layer(layerZ, i, toolpath, widths);
    report(layerCount+2+i+1, total);
  }
#ifdef __EMSCRIPTEN_PTHREADS__
  {   // wake the remaining workers -> they exit
    std::lock_guard<std::mutex> lock(precomputeMutex);
    nextPrecompute = std::max(nextPrecompute, layerCount);
  }
  precomputeRoomCondition.notify_all();
  for (auto& thread : precomputeThreads) thread.join();
#endif
  g_segment_widths = nullptr;   // stage 7: stop width tracking (the local widths goes out of scope)
  if (isCanceled()) {          // G002: all threads joined — just clean up the feeder and return canceled
#ifdef __EMSCRIPTEN_PTHREADS__
    if (streamTime || overlapBatch) (void)feeder.finish();
#else
    if (streamTime) (void)gcodeproc_bridge::estimate_end();
#endif
    em::val response = em::val::object();
    response.set("error", std::string("canceled"));
    return response;
  }
  if (!layerError.empty()) {   // a layer template failed (custom_gcode_layer): the slice fails with its typed error
#ifdef __EMSCRIPTEN_PTHREADS__
    if (streamTime || overlapBatch) (void)feeder.finish();
#else
    if (streamTime) (void)gcodeproc_bridge::estimate_end();
#endif
    custom_gcode_bridge::end();
    em::val response = em::val::object();
    response.set("error", layerError);
    return response;
  }

  // ---- Finish ----
  if (customGcode) {
    // Upstream's end block instead of the kernel's heater/fan shutdown: the printer's end G-code owns it.
    writer.raw("; end");
    std::string error = custom_gcode_end(writer, layerCount + raftLayers - 1, writer.z, writer.z, singleTool);
    if (!error.empty()) {
#ifdef __EMSCRIPTEN_PTHREADS__
      if (streamTime || overlapBatch) (void)feeder.finish();
#else
      if (streamTime) (void)gcodeproc_bridge::estimate_end();
#endif
      em::val response = em::val::object();
      response.set("error", error);
      return response;
    }
  } else {
  writer.raw("; end");
  writer.raw("M104 S0");
  writer.raw("M140 S0");
  writer.raw("M107");
  if (!params.machine_end_gcode.empty()) {          // printer profile custom end G-code (absent by default)
    writer.raw("; machine_end_gcode (printer profile)");
    writer.raw_lines(params.machine_end_gcode);
  }
  }                                            // end of the raw path's finish
  if (!params.disable_m73) writer.raw(";_GP_LAST_LINE_M73_PLACEHOLDER");   // upstream's last progress line (GCode.cpp:3957)
  writer.raw_lines(machine_postamble(writer.flavor));  // GCodeWriter::postamble: M2 on Machinekit
  {
    char footerLine[64];
    std::snprintf(footerLine,sizeof footerLine,"; filament used: %.2f mm", writer.filament);
    writer.raw(footerLine);
  }
  {
    std::vector<double> filamentByTool;                // empty: the footer reports the whole print as filament 1
    if (singleTool > 0) {
      filamentByTool.assign(singleTool + 1, 0.0);
      filamentByTool[singleTool] = writer.filament;
    }
    emit_gcode_footer_blocks(writer, params, filamentByTool, 0);
  }

  gcode_time::Result timeEstimate;
  std::string engine_used;
  auto absorb = [&](const gcodeproc_bridge::Result& processorResult){
    timeEstimate.total_seconds=processorResult.total_seconds;
    timeEstimate.first_layer_seconds=processorResult.first_layer_seconds;
    timeEstimate.extrude_seconds=processorResult.extrude_seconds;
    timeEstimate.travel_seconds=processorResult.travel_seconds;
    timeEstimate.filament_mm=processorResult.filament_mm;
    timeEstimate.moves=processorResult.moves;
    timeEstimate.layer_seconds=processorResult.layer_seconds;
    timeEstimate.role_seconds=processorResult.role_seconds;
  };
  if (streaming) {
    // Stage 30: after emitting the closing chunk (; end … filament comments), end the streamed time estimate. The G-code and layers have
    //  already been emitted through the callback and writer.gcode is empty (released per layer). Economy mode skips the time estimate entirely.
    cooling = false;   // the closing chunk is the end block, not a layer: the batch text never cools it either
    layerSlots = false;
    {
      std::vector<float> empty;
      flush_layer(writer.z, layerCount + raftLayers, empty, empty);
    }
    if (streamTime) {
#ifdef __EMSCRIPTEN_PTHREADS__
      gcodeproc_bridge::Result processorResult = feeder.finish();   // (mt) waits for the queue to drain (join) then ends — the result matches a synchronous feed
#else
      gcodeproc_bridge::Result processorResult = gcodeproc_bridge::estimate_end();
#endif
      if (processorResult.ok) {
        absorb(processorResult);
        engine_used = "full-stream";
      } else engine_used = "stream-notime";
    } else engine_used = "economy";
  } else {
    // Batch: the real PressureEqualizer (opt-in) -> strip tags -> estimate the time over the whole g-code (the byte-identical path is unchanged).
#ifdef __EMSCRIPTEN_PTHREADS__
    if (overlapBatch) feed_batch_tail();   // feed the footer — fedOffset is an offset into the unmodified writer.gcode, so this must happen before the strip below
#endif
    if (realPE)
      writer.gcode = pe_bridge::equalize(writer.gcode, params.filament_diameter, params.max_volumetric_extrusion_rate_slope,
                                 params.extrusion_rate_slope_segment_length, params.use_relative_e_distances, params.pe_external_perimeter_only);
    if (writer.emit_pe_tags && params.pe_strip_tags) strip_pe_tags(writer.gcode);
    if (params.time_engine == "transcribed") {
      timeEstimate = gcode_time::estimate(writer.gcode, timeLimits);
      engine_used = "transcribed";
    } else {
#ifdef __EMSCRIPTEN_PTHREADS__
      // (mt) With overlapBatch, finish with what has been fed (parsing already overlapped emission). Non-targets such as realPE keep the old one-shot estimate.
      gcodeproc_bridge::Result processorResult;
      if (overlapBatch) processorResult = feeder.finish();
      else processorResult = gcodeproc_bridge::estimate(writer.gcode, processorLimits);
#else
      gcodeproc_bridge::Result processorResult = gcodeproc_bridge::estimate(writer.gcode, processorLimits);
#endif
      if (processorResult.ok) {
        absorb(processorResult);
        engine_used = "full";
        if (processorResult.transcribed) engine_used = "full-fallback-transcribed";   // handed over inside the feeder, past the move cap
      } else {
        timeEstimate = gcode_time::estimate(writer.gcode, timeLimits);
        engine_used = "full-fallback-transcribed";
      }
    }
  }

  em::val stats = build_stats(context, writer, timeEstimate, engine_used, timeLimits, over_bed, streaming, economy,
                             timeStart, timePass1, timePass15, timeSupport, timeFlush);
  result.set("stats", stats);
  // G003: update the stage cache — keep it when requested (for reuse by the next slice), otherwise invalidate the stale cache with the new geometry.
  if (keepStages && !isCanceled()) {
    if (!reuseSupport) {
      if (!reuseGeometry) g_stage_cache.triangles = std::move(ownedTriangles);
      g_stage_cache.height = height;
      g_stage_cache.centerX = centerX;
      g_stage_cache.centerY = centerY;
      g_stage_cache.over_bed = over_bed;
      g_stage_cache.layerCount = layerCount;
      g_stage_cache.layerKey = layerKey;
      g_stage_cache.layers = std::move(layersOwn);
      g_stage_cache.treeSupportLayers = treeSupportLayers;
      g_stage_cache.treeZMaxResidual = treeZMaxResidual;
    }
    g_stage_cache.valid = true;
  } else if (!reuseSupport && !reuseGeometry) g_stage_cache.valid = false;
  if (!streaming) {   // streaming does not emit resident copies
    result.set("gcode", writer.gcode);
    result.set("layers", layersArray);
  }
  return result;
}
