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
//   gcode_writer · emit · emit_layer                               — the GW writer and the toolpath emit helpers
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
#include "selector_bridge.h"  // stage 20 -> MMU painting: the painted facet states decide whether a layer is multi-tool
#include "slice_api.h"
#include "slice_ctx.h"
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
  Params p = parse_params(params_json);
  if (p.spiral_mode) p.wall_loops = 1;                 // vase: a single outer wall
  g_seg_tool = 0;                                      // the toolpath tool channel is thread_local and outlives a slice
  // G002: cancel flag — the UI writes 1 via SAB. Reset to 0 on entry; the loops poll it per iteration.
  auto* cxp = (std::atomic<unsigned>*)(uintptr_t)treesupport_bridge::cancel_addr();
  cxp->store(0);
  auto CX = [cxp]{ return cxp->load(std::memory_order_relaxed) != 0; };
  // G003 incremental: reuse decision (viewer first, layerKey as the second line of defense). Not supported for MM.
  const std::string lk = make_layer_key(p);
  const bool reuseGeom = p.reuse_stages >= 1 && g_scache.valid && p.extruder_count < 2;
  const bool reuseSup  = p.reuse_stages >= 2 && g_scache.valid && g_scache.layerKey == lk && p.extruder_count < 2;
  std::vector<Tri> trisOwn;
  if (!reuseGeom) {
    std::vector<uint8_t> bytes = em::convertJSArrayToNumberVector<uint8_t>(stl_bytes);
    trisOwn = parse_stl(bytes);
  }
  std::vector<Tri>& tris = reuseGeom ? g_scache.tris : trisOwn;

  em::val result = em::val::object();
  if (tris.empty()) { result.set("error", std::string("STL parse failed or 0 triangles")); return result; }

  // Model preparation (bbox -> center/seat -> over_bed) -> pass1.cpp
  ModelPrep MP = prepare_model(tris, p, reuseGeom);
  double cx = MP.cx, cy = MP.cy, height = MP.height;
  bool over_bed = MP.over_bed;

  const double w = p.line_width;
  const double sparse_spacing  = (p.infill_density > 1e-4) ? (w / p.infill_density) : 0.0;
  const double solid_spacing   = w;   // solid = 100% fill
  const double support_spacing = (p.support_density > 1e-4) ? (w / p.support_density) : (w*3.0);

  // Multi-material (stretch goal): with two or more groups, branch to the separate-slice + tool change + prime
  //  tower path. Either boundary form gets there — mm_group_splits carries N groups, mm_group_split just one.
  auto usable = [&](int b){ return b > 0 && b < (int)tris.size(); };
  bool hasGroups = usable(p.mm_group_split);
  for (double b : p.mm_group_splits) if (usable((int)b)) hasGroups = true;
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
  for (int state = 2; state <= selector_bridge::STATE_EXTRUDER_MAX && state-1 < p.extruder_count; ++state)
    if (p.extruder_count >= 2 && selector_bridge::painted_count(state) > 0) { hasPaintedTools = true; break; }
  // A per-feature filament id is the third way a single object needs two tools (after triangle groups and paint):
  //  "print the outer wall with filament 2". Ids of 0 (Default) and 1 (the default extruder, T0) add no second tool,
  //  so only 2 and above route here — which is what keeps every existing single-material slice off this path.
  const bool hasFeatureTools = p.outer_wall_filament_id >= 2 || p.inner_wall_filament_id >= 2 ||
                               p.sparse_infill_filament_id >= 2 || p.top_surface_filament_id >= 2 ||
                               p.bottom_surface_filament_id >= 2 || p.internal_solid_filament_id >= 2;
  if (p.extruder_count >= 2 && (hasGroups || hasPaintedTools || hasFeatureTools))
    return slice_multimaterial(tris, p, onProgress, height, over_bed);

  // Count the z levels (the progress total)
  int N = 0; for (double z=p.first_layer_height; z<height-1e-4; z+=p.layer_height) ++N;
  int total = 2*N + 2;   // +2 = the surface and support completion ticks. Previously nothing was reported between PASS1 (50%) and the end of support -> it looked "stuck at 50%".

  // Phase timing (exposed only through stats — no effect on g-code, golden-safe)
  double tw0 = emscripten_get_now(), tw_p1 = 0, tw_p15 = 0, tw_sup = 0;
  double t_flush = 0;          // accumulated flush_layer time (the JS boundary: to_f32/layersArr/sink + feeding the estimator) — the rest is G1 formatting

  // ---- PASS 1: per-layer contours, walls and infill regions ----
  //  No inter-layer dependencies (reads: the shared immutable tris/p, writes: an independent L[i]) -> layers run in parallel in -pthread builds.
  //  z is precomputed serially exactly like the old accumulating loop (z+=layer_height) — preserving FP accumulation order (golden-safe).
  const bool keepStages = (p.keep_stages || reuseSup) && p.extruder_count < 2;
  g_keep_island = keepStages;
  double treeZMaxResid = -1.0; int treeSupLayers = 0;   // stage 19: tree support z alignment diagnostics (G003: hoisted)
  std::vector<LayerData> Lown;
  if (!reuseSup) Lown.resize(N);
  std::vector<LayerData>& L = reuseSup ? g_scache.L : Lown;
  // Phase context: exactly the slice()-scope state the moved phase bodies used to capture.
  SliceCtx C; C.p=&p; C.tris=&tris; C.L=&L; C.CX=CX; C.report=report;
  C.treeZMaxResid=&treeZMaxResid; C.treeSupLayers=&treeSupLayers;
  C.N=N; C.total=total; C.height=height; C.w=w; C.cx=cx; C.cy=cy;
  C.sparse_spacing=sparse_spacing; C.solid_spacing=solid_spacing; C.support_spacing=support_spacing;
  if (reuseSup) {
    // G003: geometry and support settings unchanged — PASS1, surfaces and support all come from the cache; only emission re-runs.
    tw_p1 = tw_p15 = emscripten_get_now();
    treeSupLayers = g_scache.treeSupLayers; treeZMaxResid = g_scache.treeZMaxResid;
    report(N, total); report(N+1, total);
  } else {
    if (!pass1_run(C)) { em::val r=em::val::object(); r.set("error", std::string("canceled")); return r; }

  tw_p1 = emscripten_get_now();

  // ---- PASS 1.5: surface detection (this layer's fill − the neighboring contour) ----
  surfaces_run(C);

  tw_p15 = emscripten_get_now();
  report(N+1, total);                            // surface detection completion tick (signals entering support generation)

  // ---- PASS 1.6: support (overhang detection -> vertical projection -> interface/base) ----
  support_run(C);

  // ---- Preamble ----
  }                                              // G003: end of the reuseSup skip block (only PASS1~1.6 is skipped — preamble, raft and emission are shared)

  GW gw; gw.s.reserve(1<<17);
  EmitFlags EF = gw_setup_preamble(gw, p, treeSupLayers, treeZMaxResid);
  bool realPE = EF.realPE, ironOn = EF.ironOn, scarfOn = EF.scarfOn;
  int  seamMode = EF.seamMode;
  SeamCtx seamCtx;

  int fTravel = (int)std::llround(p.travel_speed*60);
  int fFirst  = (int)std::llround(p.first_layer_speed*60);
  em::val layersArr = em::val::array();

  // Stage 30: streaming setup — streaming (release gw.s after emitting each chunk) only when a layer sink is registered and the real PE
  //  (whole-string cross-layer smoothing) is not in use. realPE needs the entire g-code, so it falls back to batch (opt-in, outside the golden path).
  em::val& sink = layer_sink();
  bool streaming = (!sink.isUndefined() && !sink.isNull() && !realPE);
  bool economy   = streaming && p.economy;      // economy: skip toolpaths and the time estimate (r.moves would stay resident in bulk), G-code only
  bool streamTime = streaming && !economy;      // streamed time estimate (chunk feeding) — skipped in economy mode
  gcode_time::Limits glim; gcodeproc_bridge::Limits gl;
  setup_time_limits(p, glim, gl);                // machine limits for the time estimate (shared by streaming and batch)
#ifdef __EMSCRIPTEN_PTHREADS__
  // (mt) Overlap targets: streamed full estimates and batch full estimates (realPE is excluded because it needs whole-string post-processing,
  //  and transcribed is a different engine so it keeps the old path). In batch mode the accumulated gw.s is sliced and fed at each flush.
  TimeFeeder feeder;
  const bool overlapBatch = !streaming && !realPE && p.time_engine != "transcribed";
  size_t fedOff = 0;                            // batch overlap: how much of gw.s has already been fed
  if (streamTime || overlapBatch) feeder.begin(gl);
  auto feed_batch_tail = [&]{                   // feed everything after the last flush (including the footer)
    std::string c = gw.s.substr(fedOff); fedOff = gw.s.size();
    if (gw.emit_pe_tags && p.pe_strip_tags) strip_pe_tags(c);   // batch feeds the estimator the same tag-stripped input as streaming
    feeder.feed(std::move(c));
  };
#else
  if (streamTime) gcodeproc_bridge::estimate_begin(gl);
#endif
  // Layer emission: batch accumulates into layersArr; streaming emits a chunk (everything in gw.s since the last flush) plus the toolpaths, then releases gw.s.
  //  The preamble goes into the first flush chunk and the footer into the last -> concatenating the chunks is byte-identical to the batch gw.s.
  auto flush_layer = [&](double z, int idx, std::vector<float>& tp, std::vector<float>& widths) {
    double tf0 = emscripten_get_now();
    struct TF { double& acc, t0; ~TF(){ acc += emscripten_get_now() - t0; } } tf{t_flush, tf0};
    if (!streaming) {
      em::val Lo=em::val::object(); Lo.set("z",z); Lo.set("paths",to_f32(tp)); Lo.set("widths",to_f32(widths));
      layersArr.call<void>("push", Lo);
#ifdef __EMSCRIPTEN_PTHREADS__
      if (overlapBatch) feed_batch_tail();               // feed the estimator worker incrementally at each layer boundary (aligned to '\n')
#endif
      return;
    }
    std::string chunk; chunk.swap(gw.s);                 // take the accumulated text and empty gw.s (freeing the heap)
    if (gw.emit_pe_tags && p.pe_strip_tags) strip_pe_tags(chunk);   // stateless line filter (chunked == batch)
#ifdef __EMSCRIPTEN_PTHREADS__
    if (streamTime) feeder.feed(chunk);                  // fed as a copy — chunk is also handed to the sink afterwards
#else
    if (streamTime) gcodeproc_bridge::estimate_feed(chunk);
#endif
    em::val paths = economy ? em::val::array() : to_f32(tp);
    em::val wid   = economy ? em::val::array() : to_f32(widths);
    sink(z, idx, chunk, paths, wid);
  };

  // ---- Raft (inserted below the model, shifting the model in z) ----
  int nraft = std::max(0, p.raft_layers);
  double zShift = raft_emit(gw, p, L, w, nraft, fTravel, fFirst, seamCtx, flush_layer);
  C.nraft = nraft; C.zShift = zShift; C.ironOn = ironOn;   // finalize the phase context for compute_pre

  tw_sup = emscripten_get_now();
  if (CX()) { em::val r=em::val::object(); r.set("error", std::string("canceled")); return r; }   // G002 (no threads up to this point)
  report(N+2, total);                            // support generation completion tick

  // ---- PASS 2 precomputation: per-layer geometry separation and infill line generation (split out of the emission loop below) ----
  //  A verbatim move of the computation block from inside the old emission loop — formulas and call order unchanged (verified byte-identical against golden).
  auto compute_pre = [&](int i) -> EmitPre { return compute_pre_layer(C, i); };

#ifdef __EMSCRIPTEN_PTHREADS__
  // (mt) The PASS2 computation runs in parallel — workers precompute up to PRE_WINDOW layers ahead of the consumer (emission).
  //  Safety: while the consumer is on i, in-flight workers are always on k>i (they complete in the order they were claimed), and
  //  the L[j] a worker reads satisfies j >= k−bottom_shell+1 > the early-release point old=i−max(bsl,1)−1 -> no conflict with the release.
  //  The window bounds resident memory (W layers' worth of lines) — keeping the early-release OOM mitigation.
  std::vector<EmitPre> preBuf(N);
  std::vector<uint8_t> preDone(N, 0);
  std::mutex pmu; std::condition_variable cv_done, cv_room;
  int preNext = 0, preConsumed = -1;
  unsigned preHW = std::thread::hardware_concurrency(); if (!preHW) preHW = 4;
  const bool parEmit = !p.spiral_mode && !scarfOn && gw.pe_slope <= 0.0 && !gw.emit_pe_tags
                       && p.wall_generator != "arachne" && !realPE;   // conditions under which G003 parallel emission is possible (otherwise serial fallback)
  unsigned preNT = std::min<unsigned>(std::max(1u, parEmit ? preHW / 2 : preHW - 1), (unsigned)std::max(1, N));
  const int PRE_WINDOW = (int)preNT * 2 + 4;
  auto preWork = [&]{
    for (;;) {
      int k = -1;
      { std::unique_lock<std::mutex> lk(pmu);
        cv_room.wait(lk, [&]{ return preNext >= N || preNext <= preConsumed + PRE_WINDOW; });
        if (preNext >= N) break;
        k = preNext++;
      }
      EmitPre ep = compute_pre(k);
      { std::lock_guard<std::mutex> lk(pmu); preBuf[k] = std::move(ep); preDone[k] = 1; }
      cv_done.notify_all();
    }
  };
  std::vector<std::thread> preThs; preThs.reserve(preNT);
  for (unsigned t=0; t<preNT; ++t) preThs.emplace_back(preWork);
#endif

  // ---- PASS 2: solid/sparse infill separation + support + emission ----
#ifdef __EMSCRIPTEN_PTHREADS__
  if (parEmit) {
    // G003: E1 (a serial dry run — chaining the seam, position, curF and fan entry state) -> a writer pool (per-layer G-code/toolpath generation)
    //  -> an ordered flush. E is relative (M83) so it is layer-local, and cross-layer state is fully captured by the entry cursor -> byte-identical to st (serial)
    //  (gates: golden + a large-model cmp). filament is the ordered sum of per-layer partials (only the association order differs — the theoretical %.2f rounding
    //  boundary risk in the footer is covered by golden). The window (FW) bounds residency -> keeping the streaming OOM mitigation.
    struct Cursor { double px, py; int curF, lastFan; SeamCtx sc; };
    struct EmitJob {
      EmitPre pre; Cursor entry; Paths island;
      std::string gcode; std::vector<float> tp, widths;
      double filament = 0; long segments = 0, crossings = 0;
      std::atomic<int> jst{0};   // 0=ready 1=dispatched 2=done
    };
    std::vector<std::unique_ptr<EmitJob>> jobs(N);
    for (int k = 0; k < N; ++k) jobs[k] = std::make_unique<EmitJob>();
    std::mutex emu; std::condition_variable ecv;
    int wNext = 0, dispatched = 0;
    GW base = gw; base.s.clear(); base.island.clear(); base.dry = false;   // the template GW for writers
    unsigned wHW = std::thread::hardware_concurrency(); if (!wHW) wHW = 4;
    unsigned WN = std::max(1u, wHW / 2);
    auto writerFn = [&]{
      for (;;) {
        int k = -1;
        { std::unique_lock<std::mutex> lk(emu);
          ecv.wait(lk, [&]{ return wNext < dispatched || wNext >= N; });
          if (wNext >= N) break;
          k = wNext++; }
        EmitJob& J = *jobs[k];
        GW g = base;
        g.px = J.entry.px; g.py = J.entry.py; g.curF = J.entry.curF; g.lastFan = J.entry.lastFan;
        g.island = std::move(J.island);
        SeamCtx sc = J.entry.sc;
        LayerData& ldk = L[k];
        emit_layer_any(g, J.tp, J.widths, k, ldk, J.pre, p, ldk.z + zShift, w, N, nraft, fTravel, seamMode, scarfOn, ironOn, sc);
        J.gcode.swap(g.s); J.filament = g.filament; J.segments = g.segments; J.crossings = g.wall_crossings;
        J.jst.store(2, std::memory_order_release);
        ecv.notify_all();
      }
    };
    std::vector<std::thread> wths; wths.reserve(WN);
    for (unsigned t = 0; t < WN; ++t) { try { wths.emplace_back(writerFn); } catch (...) { break; } }
    const int FW = (int)std::max<size_t>(1, wths.size()) * 2 + 2;
    int fl = 0;
    auto flushJob = [&](int k){
      EmitJob& J = *jobs[k];
      if (wths.empty()) {   // fallback when no writer could be spawned (pool exhausted): the main thread generates it itself
        GW g = base; g.px=J.entry.px; g.py=J.entry.py; g.curF=J.entry.curF; g.lastFan=J.entry.lastFan;
        g.island = std::move(J.island); SeamCtx sc = J.entry.sc; LayerData& ldk = L[k];
        emit_layer_any(g, J.tp, J.widths, k, ldk, J.pre, p, ldk.z + zShift, w, N, nraft, fTravel, seamMode, scarfOn, ironOn, sc);
        J.gcode.swap(g.s); J.filament = g.filament; J.segments = g.segments; J.crossings = g.wall_crossings;
        J.jst.store(2);
      }
      { std::unique_lock<std::mutex> lk(emu); ecv.wait(lk, [&]{ return J.jst.load(std::memory_order_acquire) == 2; }); }
      double zk = L[k].z + zShift;
      gw.filament += J.filament; gw.segments += J.segments; gw.wall_crossings += J.crossings;
      if (!streaming) {
        em::val Lo = em::val::object(); Lo.set("z", zk); Lo.set("paths", to_f32(J.tp)); Lo.set("widths", to_f32(J.widths));
        layersArr.call<void>("push", Lo);
        gw.s += J.gcode;
        if (overlapBatch) feed_batch_tail();
      } else {
        if (streamTime) feeder.feed(J.gcode);
        em::val paths = economy ? em::val::array() : to_f32(J.tp);
        em::val wid   = economy ? em::val::array() : to_f32(J.widths);
        sink(zk, k, J.gcode, paths, wid);
      }
      J.gcode = std::string(); J.tp = {}; J.widths = {}; J.pre = EmitPre{};
      if (!keepStages) { int old = k - std::max(p.bottom_shell_layers, 1) - 1 - FW;   // release only outside the writer/dry reference window
        if (old >= 0) L[old] = LayerData{}; }
      report(N+2+k+1, total);
    };
    gw.dry = true;
    bool __cxAborted = false;
    std::vector<float> dtp, dwv;   // dry-run dummies (not recorded)
    for (int i = 0; i < N; ++i) {
      if (CX()) { __cxAborted = true; break; }   // G002: stop dispatching new work -> join the existing shutdown path
      EmitPre pre;
      { std::unique_lock<std::mutex> lk(pmu);
        cv_done.wait(lk, [&]{ return preDone[i] != 0; });
        pre = std::move(preBuf[i]);
        preConsumed = i; }
      cv_room.notify_all();
      LayerData& ld = L[i];
      EmitJob& J = *jobs[i];
      J.entry = { gw.px, gw.py, gw.curF, gw.lastFan, seamCtx };
      J.island = g_keep_island ? ld.island : std::move(ld.island);   // G003
      emit_layer_any(gw, dtp, dwv, i, ld, pre, p, ld.z + zShift, w, N, nraft, fTravel, seamMode, scarfOn, ironOn, seamCtx);
      J.pre = std::move(pre);
      { std::lock_guard<std::mutex> lk(emu); dispatched = i + 1; J.jst.store(1); }
      ecv.notify_all();
      if (i - FW >= fl) { flushJob(fl); ++fl; }
    }
    gw.dry = false;
    while (!__cxAborted && fl < N) { flushJob(fl); ++fl; }   // G002: on cancel, never wait for undispatched jobs (avoids a deadlock)
    { std::lock_guard<std::mutex> lk(emu); wNext = std::max(wNext, N); dispatched = N; }
    ecv.notify_all();
    for (auto& th : wths) th.join();
  } else
#endif
  for (int i=0;i<N;++i) {
    if (CX()) break;   // G002
    if (!keepStages) { int old = i - std::max(p.bottom_shell_layers, 1) - 1;
      if (old >= 0) L[old] = LayerData{}; }
    EmitPre pre;
#ifdef __EMSCRIPTEN_PTHREADS__
    { std::unique_lock<std::mutex> lk(pmu);
      cv_done.wait(lk, [&]{ return preDone[i] != 0; });
      pre = std::move(preBuf[i]);
      preConsumed = i; }
    cv_room.notify_all();
#else
    pre = compute_pre(i);
#endif
    LayerData& ld = L[i];
    double zE = ld.z + zShift;
    std::vector<float> tp;
    std::vector<float> widths;
    if (p.spiral_mode && !ld.contour.empty()) {
      // ===== Spiral (vase): a single outer wall with a z ramp — excluded from parallelism, kept inline as before =====
      gw.set_e_per_mm(ld.h, p); gw.z = zE; gw.pe_reset();
      gw.island = g_keep_island ? ld.island : std::move(ld.island);   // G003
      seamCtx.rng = 2654435761u * (uint32_t)(i+1);
      g_seg_w = &widths; g_seg_w_cur = (float)w;
      char cm[72];
      std::snprintf(cm,sizeof cm,"; LAYER %d Z%.3f",i,zE); gw.layer_begin(cm);
      gw.set_fan(fan_S(i, p));
      std::snprintf(cm,sizeof cm,"G1 Z%.3f F%d",zE,fTravel); gw.raw(cm);
      int fSp = (int)std::llround(((i==0&&nraft==0)?p.first_layer_speed:p.print_speed)*60);
      emit_spiral(gw, tp, ld.walls.empty()?Paths{}:ld.walls[0], zE, ld.h, fSp, fTravel);
    } else {
      emit_layer_any(gw, tp, widths, i, ld, pre, p, zE, w, N, nraft, fTravel, seamMode, scarfOn, ironOn, seamCtx);
    }
    flush_layer(zE, i, tp, widths);
    report(N+2+i+1, total);
  }
#ifdef __EMSCRIPTEN_PTHREADS__
  { std::lock_guard<std::mutex> lk(pmu); preNext = std::max(preNext, N); }   // wake the remaining workers -> they exit
  cv_room.notify_all();
  for (auto& th : preThs) th.join();
#endif
  g_seg_w = nullptr;   // stage 7: stop width tracking (the local widths goes out of scope)
  if (CX()) {          // G002: all threads joined — just clean up the feeder and return canceled
#ifdef __EMSCRIPTEN_PTHREADS__
    if (streamTime || overlapBatch) (void)feeder.finish();
#else
    if (streamTime) (void)gcodeproc_bridge::estimate_end();
#endif
    em::val r = em::val::object(); r.set("error", std::string("canceled")); return r;
  }

  // ---- Finish ----
  gw.raw("; end"); gw.raw("M104 S0"); gw.raw("M140 S0"); gw.raw("M107");
  if (!p.machine_end_gcode.empty()) {          // printer profile custom end G-code (absent by default)
    gw.raw("; machine_end_gcode (printer profile)");
    for (size_t i = 0, n = p.machine_end_gcode.size(); i <= n; ) {
      size_t e = p.machine_end_gcode.find('\n', i);
      if (e == std::string::npos) e = n;
      if (e > i) gw.raw(p.machine_end_gcode.substr(i, e - i).c_str());
      i = e + 1;
    }
  }
  { char h[64]; std::snprintf(h,sizeof h,"; filament used: %.2f mm", gw.filament); gw.raw(h); }
  emit_gcode_footer_blocks(gw, p, {}, 0);

  gcode_time::Result te; std::string engine_used;
  auto absorb = [&](const gcodeproc_bridge::Result& fr){
    te.total_s=fr.total_s; te.first_layer_s=fr.first_layer_s; te.extrude_s=fr.extrude_s; te.travel_s=fr.travel_s;
    te.filament_mm=fr.filament_mm; te.moves=fr.moves; te.layer_s=fr.layer_s; te.role_s=fr.role_s;
  };
  if (streaming) {
    // Stage 30: after emitting the closing chunk (; end … filament comments), end the streamed time estimate. The G-code and layers have
    //  already been emitted through the callback and gw.s is empty (released per layer). Economy mode skips the time estimate entirely.
    { std::vector<float> empty; flush_layer(gw.z, N + nraft, empty, empty); }
    if (streamTime) {
#ifdef __EMSCRIPTEN_PTHREADS__
      gcodeproc_bridge::Result fr = feeder.finish();   // (mt) waits for the queue to drain (join) then ends — the result matches a synchronous feed
#else
      gcodeproc_bridge::Result fr = gcodeproc_bridge::estimate_end();
#endif
      if (fr.ok) { absorb(fr); engine_used = "full-stream"; } else engine_used = "stream-notime";
    } else engine_used = "economy";
  } else {
    // Batch: the real PressureEqualizer (opt-in) -> strip tags -> estimate the time over the whole g-code (the byte-identical path is unchanged).
#ifdef __EMSCRIPTEN_PTHREADS__
    if (overlapBatch) feed_batch_tail();   // feed the footer — fedOff is an offset into the unmodified gw.s, so this must happen before the strip below
#endif
    if (realPE)
      gw.s = pe_bridge::equalize(gw.s, p.filament_diameter, p.max_volumetric_extrusion_rate_slope,
                                 p.extrusion_rate_slope_segment_length, /*relative_e*/true, p.pe_external_perimeter_only);
    if (gw.emit_pe_tags && p.pe_strip_tags) strip_pe_tags(gw.s);
    if (p.time_engine == "transcribed") {
      te = gcode_time::estimate(gw.s, glim); engine_used = "transcribed";
    } else {
#ifdef __EMSCRIPTEN_PTHREADS__
      // (mt) With overlapBatch, finish with what has been fed (parsing already overlapped emission). Non-targets such as realPE keep the old one-shot estimate.
      gcodeproc_bridge::Result fr = overlapBatch ? feeder.finish() : gcodeproc_bridge::estimate(gw.s, gl);
#else
      gcodeproc_bridge::Result fr = gcodeproc_bridge::estimate(gw.s, gl);
#endif
      if (fr.ok) { absorb(fr); engine_used = "full"; }
      else { te = gcode_time::estimate(gw.s, glim); engine_used = "full-fallback-transcribed"; }
    }
  }

  em::val stats = build_stats(C, gw, te, engine_used, glim, over_bed, streaming, economy,
                             tw0, tw_p1, tw_p15, tw_sup, t_flush);
  result.set("stats", stats);
  // G003: update the stage cache — keep it when requested (for reuse by the next slice), otherwise invalidate the stale cache with the new geometry.
  if (keepStages && !CX()) {
    if (!reuseSup) {
      if (!reuseGeom) g_scache.tris = std::move(trisOwn);
      g_scache.height = height; g_scache.cx = cx; g_scache.cy = cy; g_scache.over_bed = over_bed;
      g_scache.N = N; g_scache.layerKey = lk; g_scache.L = std::move(Lown);
      g_scache.treeSupLayers = treeSupLayers; g_scache.treeZMaxResid = treeZMaxResid;
    }
    g_scache.valid = true;
  } else if (!reuseSup && !reuseGeom) g_scache.valid = false;
  if (!streaming) { result.set("gcode", gw.s); result.set("layers", layersArr); }  // streaming does not emit resident copies
  return result;
}
