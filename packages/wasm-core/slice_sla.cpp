// =============================================================================
// slice_sla.cpp — the SLA (resin) slicing entry point.
//
//  A resin slice is per-layer solid cross-sections, not toolpaths: no walls, no infill, no G-code. What it
//  reuses from the FFF kernel is exactly the machinery that is technology-neutral — parse_stl, prepare_model
//  (centre/seat/over-bed), intersect_triangle_with_plane + chain_polygons (facet-major, like pass1), Clipper, and the layer-sink
//  streaming protocol — so the worker drives it with the same 'progress'/'layer'/'done' messages a kernel
//  slice produces, and the viewer preview consumes the stream unmodified.
//
//  SUPPORTS are upstream end to end: the ported SupportPointGenerator/SupportIslands sampler produces the
//  contact points (slasupport_bridge::generate_support_points), and the ported PrusaSlicer DefaultSupportTree
//  (slasupport_port/ — pinhead pose search, classify, ground routing, cross-bracing, pillar feet, raycast
//  against the actual mesh via libigl) turns them into the tree. The bridge returns the merged support tree
//  as a triangle MESH; its raster view is produced by slicing that mesh with the same sweep the model goes
//  through, so the preview solid and the SL1 masks cannot disagree.
//  The PAD is the ported Pad.cpp (blueprint over the foot band -> walls/brim/wings), standing on the plate
//  with everything above lifted by its height; pad_around_object (embed) wraps the pad around the object's
//  bottom band instead and forces zero elevation (upstream is_zero_elevation).
//  All support/pad regions stay DISJOINT from the model contour (Clipper diff) because the SL1 rasterizer
//  fills even-odd — an overlap would punch a hole.
// =============================================================================
#include "clip_util.h"
#include "params.h"
#include "slasupport_bridge.h"
#include "slice_api.h"
#include "slice_ctx.h"
#include "slice_planes.h"
#include "stl_parse.h"
#include "stream_sink.h"
#include "treesupport_bridge.h"
#include "emit.h"                 // to_f32

#include <emscripten/val.h>
#include <emscripten/emscripten.h>   // emscripten_get_now — phase timing (stats only)
#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <exception>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace em = emscripten;
using namespace ClipperLib;

// ---- Local flat-JSON readers ---------------------------------------------------------------------------------
//  NOT params.cpp's readers on purpose: the kernel parameter reference is GENERATED from the
//  json_*(params_json,"…") call sites in params.cpp, and every row must be classified. The SLA keys live in their own derive
//  (deriveSlaParams) and their own entry point — adding them to params.cpp would put unclassified rows into the
//  FFF table. The quote-prefixed search cannot suffix-collide (initial_layer_height never matches layer_height).
static double sla_json_number(const std::string& json, const char* key, double default_value) {
  std::string pattern = std::string("\"") + key + "\":";
  size_t key_position = json.find(pattern);
  if (key_position == std::string::npos) return default_value;
  const char* value_start = json.c_str() + key_position + pattern.size();
  char* end = nullptr;
  double value = std::strtod(value_start, &end);
  if (end == value_start) return default_value;
  return value;
}
static bool sla_json_bool(const std::string& json, const char* key, bool default_value) {
  std::string pattern = std::string("\"") + key + "\":";
  size_t key_position = json.find(pattern);
  if (key_position == std::string::npos) return default_value;
  const char* value_start = json.c_str() + key_position + pattern.size();
  if (!std::strncmp(value_start, "true", 4))  return true;
  if (!std::strncmp(value_start, "false", 5)) return false;
  if (*value_start == '1') return true;
  if (*value_start == '0') return false;
  return default_value;
}
static std::string sla_json_string(const std::string& json, const char* key, const char* default_value) {
  std::string pattern = std::string("\"") + key + "\":\"";
  size_t key_position = json.find(pattern);
  if (key_position == std::string::npos) return default_value;
  size_t value_start = key_position + pattern.size();
  size_t value_end = json.find('"', value_start);
  if (value_end == std::string::npos) return default_value;
  return json.substr(value_start, value_end - value_start);
}

// Toolpath stream encoding — the same stride-8 contract emit.cpp's push_toolpath_segment writes, tool fixed at 0.
static inline void sla_push_toolpath_segment(std::vector<float>& segments, std::vector<float>& widths,
                                double x0, double y0, double x1, double y1, double z, float role) {
  segments.push_back((float)x0);
  segments.push_back((float)y0);
  segments.push_back((float)z);
  segments.push_back(role);
  segments.push_back((float)x1);
  segments.push_back((float)y1);
  segments.push_back((float)z);
  segments.push_back(role);
  widths.push_back(0.2f);
}
static void push_paths(std::vector<float>& segments, std::vector<float>& widths, const Paths& paths, double z, float role) {
  for (const Path& path : paths) {
    if (path.size() < 3) continue;
    for (size_t k = 0; k < path.size(); ++k) {
      const IntPoint& from = path[k];
      const IntPoint& to = path[(k + 1) % path.size()];
      sla_push_toolpath_segment(segments, widths, from.x() * INV, from.y() * INV, to.x() * INV, to.y() * INV, z, role);
    }
  }
}

static double paths_area_mm2(const Paths& paths) {   // even-odd net area: holes carry negative signed area
  double area = 0;
  for (const Path& path : paths) area += Area(path);
  return std::abs(area) * INV * INV;
}
// Even-odd point test over a whole region (outers and holes together).
static bool point_in_region(const IntPoint& point, const Paths& paths) {
  int inside_count = 0;
  for (const Path& path : paths) if (PointInPolygon(point, path)) ++inside_count;
  return (inside_count & 1) != 0;
}
// Layer-parallel runner for the kernel-side per-layer passes (contours, raster clip, pad clip):
// each index writes only its own slot, so chunk boundaries cannot change the output — mt runs
// byte-identical to st. Threads exist only in the mt build; workers must not touch embind, so
// report() stays with the caller (a phase now finishes in well under a band's width anyway).
// A worker exception (Clipper on degenerate input) is captured and rethrown on the caller —
// escaping a std::thread would terminate.
// `tick(done)` is called on the CALLING thread only, with the shared count of finished layers, after each chunk
//  it completes itself — it is how a phase reports progress (only that thread may reach JS). The layer->chain
//  phase measured 6.3s of a 14s slice on a 3M-facet model with no report inside it, which read as a stall.
static void sla_no_tick(int) {}
template <class Fn, class Tick = void(*)(int)>
static void sla_for_each_layer(int layer_count, const Fn& run_layer, const Tick& tick = sla_no_tick) {
#ifdef __EMSCRIPTEN_PTHREADS__
  const unsigned hardware_threads = std::thread::hardware_concurrency();
  if (layer_count > 3 && hardware_threads > 1) {
    const unsigned thread_count = std::min<unsigned>(hardware_threads - 1, (unsigned)layer_count);
    const int chunk = std::max(1, layer_count / int(thread_count * 8));
    std::atomic<int> next{0}, done{0};
    std::exception_ptr first_error = nullptr;
    std::mutex error_mutex;
    auto work = [&](bool is_caller) {
      try {
        for (;;) {
          const int chunk_begin = next.fetch_add(chunk);
          if (chunk_begin >= layer_count) break;
          const int chunk_end = std::min(layer_count, chunk_begin + chunk);
          for (int i = chunk_begin; i < chunk_end; ++i) run_layer(i);
          done.fetch_add(chunk_end - chunk_begin, std::memory_order_relaxed);
          if (is_caller) tick(done.load(std::memory_order_relaxed));
        }
      } catch (...) {
        std::lock_guard<std::mutex> hold(error_mutex);
        if (!first_error) first_error = std::current_exception();
      }
    };
    std::vector<std::thread> workers;
    workers.reserve(thread_count - 1);
    for (unsigned thread_index = 1; thread_index < thread_count; ++thread_index) {
      try { workers.emplace_back([&]{ work(false); }); }   // pool exhausted -> the caller and existing workers absorb
      catch (...) { break; }
    }
    work(true);
    for (std::thread& worker : workers) worker.join();
    if (first_error) std::rethrow_exception(first_error);
    return;
  }
#endif
  for (int i = 0; i < layer_count; ++i) {
    run_layer(i);
    if ((i & 7) == 7 || i == layer_count - 1) tick(i + 1);
  }
}

static inline IntPoint scaled_int_point(double x, double y) {
  return IntPoint((cInt)std::llround(x * SCALE), (cInt)std::llround(y * SCALE));
}

em::val slice_sla(em::val stl_bytes, std::string params_json, em::val onProgress) {
  auto report = [&](int done, int total) {
    if (!onProgress.isUndefined() && !onProgress.isNull()) onProgress(done, total);
  };
  em::val result = em::val::object();

  // Capability gate: hollowing changes the printed geometry itself (inner walls, drain holes), so a request
  //  for it cannot be answered with a solid slice — that output would be mislabeled hollowed. Typed error,
  //  same code the JS request layer uses; the OpenVDB/MeshBoolean chain it needs is not ported.
  if (sla_json_bool(params_json, "hollowing_enable", false)) {
    result.set("error", std::string("SLA_UNSUPPORTED_HOLLOWING: hollowing is not available in this kernel"));
    return result;
  }

  // Shared keys go through the normal parser (layer_height, bed dims — deriveSlaParams maps the display onto
  //  bed_width/bed_depth); SLA-only keys are read locally, see the note above.
  Params params = parse_params(params_json);
  double layer_height = 0.05;
  if (params.layer_height > 1e-4) layer_height = params.layer_height;
  const double initial_layer_height_setting = sla_json_number(params_json, "initial_layer_height", layer_height);
  double initial_layer_height = layer_height;
  if (initial_layer_height_setting > 1e-4) initial_layer_height = initial_layer_height_setting;
  auto layer_thickness_at = [&](int layer_index) -> double {
    if (layer_index == 0) return initial_layer_height;
    return layer_height;
  };
  auto top_z = [&](int layer_index) -> double {
    if (layer_index == 0) return initial_layer_height;
    return initial_layer_height + layer_index * layer_height;
  };

  // G002-style cancel: same flag the FFF slice polls, reset on entry.
  auto* cancel_flag = (std::atomic<unsigned>*)(uintptr_t)treesupport_bridge::cancel_addr();
  cancel_flag->store(0);
  auto canceled = [cancel_flag] { return cancel_flag->load(std::memory_order_relaxed) != 0; };

  std::vector<uint8_t> bytes = em::convertJSArrayToNumberVector<uint8_t>(stl_bytes);
  std::vector<Triangle> triangles = parse_stl(bytes);
  if (triangles.empty()) {
    result.set("error", std::string("STL parse failed or 0 triangles"));
    return result;
  }

  ModelPrep model_prep = prepare_model(triangles, params, /*reuseGeometry=*/false);
  const double height = model_prep.height;
  if (!(height > 1e-4)) {
    result.set("error", std::string("model has no height to slice"));
    return result;
  }

  int model_layer_count;
  if (height <= initial_layer_height) model_layer_count = 1;
  else model_layer_count = 1 + (int)std::ceil((height - initial_layer_height) / layer_height);
  double time_start = emscripten_get_now();
  double time_contours_done = 0;
  double time_sample_done = 0;
  double time_tree_done = 0;
  double time_raster_done = 0;
  double t_sample_weld = 0, t_sample_slice = 0, t_sample_prepare = 0, t_sample_generate = 0, t_sample_move = 0;

  // ---- Model contours: facet-major plane sweep at each layer's MID height (volume-faithful), chained +
  //      cleaned the way pass1 does it. Mid planes are ascending, so the lower_bound walk matches pass1's.
  std::vector<double> mids(model_layer_count);
  for (int i = 0; i < model_layer_count; ++i) mids[i] = top_z(i) - layer_thickness_at(i) / 2;
  std::vector<std::vector<SliceSegment>> layerSegments(model_layer_count);
  {
    // Facet -> segment sweep. Parallel in mt the way PASS1 is (pass1.cpp): contiguous facet ranges, one bucket set
    //  per range, concatenated in range order — so every layer's segment order is exactly the serial loop's and st
    //  and mt stay byte-identical (test_sla_mt.mjs). The 0 -> 18% progress comes from in here: on a 3M-facet model
    //  this sweep measured 6.7s alone and 16.9s beside two FFF workers (single-threaded, it lost the cores to
    //  their 30 threads), and it reported nothing until it was done — which read as the SLA plate not slicing at
    //  all. Only the calling thread may touch JS, so it sweeps a range itself and reports the shared count as it
    //  goes; the other threads only count.
    const size_t triangle_count = triangles.size();
    std::atomic<size_t> swept{0};
    auto sweep = [&](size_t range_begin, size_t range_end, std::vector<std::vector<SliceSegment>>& out, bool reports_progress) {
      SliceSegment segment;
      size_t local_count = 0;
      for (size_t k = range_begin; k < range_end; ++k) {
        const Triangle& triangle = triangles[k];
        double zmin = std::min({triangle.vertices[0].z, triangle.vertices[1].z, triangle.vertices[2].z});
        double zmax = std::max({triangle.vertices[0].z, triangle.vertices[1].z, triangle.vertices[2].z});
        for (auto it = std::lower_bound(mids.begin(), mids.end(), zmin); it != mids.end() && *it < zmax; ++it)
          if (intersect_triangle_with_plane(triangle, *it, segment)) out[(size_t)(it - mids.begin())].push_back(segment);
        if ((++local_count & 0x3FFF) == 0) {
          swept.fetch_add(0x4000, std::memory_order_relaxed);
          if (reports_progress) report((int)std::min<size_t>(29, swept.load(std::memory_order_relaxed) * 30 / std::max<size_t>(1, triangle_count)), 1000);
        }
      }
      swept.fetch_add(local_count & 0x3FFF, std::memory_order_relaxed);
    };
    unsigned thread_count = 1;
#ifdef __EMSCRIPTEN_PTHREADS__
    {
      const unsigned hardware_threads = std::thread::hardware_concurrency();
      if (triangle_count > 65536 && hardware_threads > 1) thread_count = std::min<unsigned>(hardware_threads, (unsigned)(triangle_count / 32768));
    }
#endif
    if (thread_count > 1) {
      std::vector<std::vector<std::vector<SliceSegment>>> buckets(thread_count, std::vector<std::vector<SliceSegment>>(model_layer_count));
      const size_t triangles_per_range = (triangle_count + thread_count - 1) / thread_count;
      std::vector<std::thread> workers;
      workers.reserve(thread_count - 1);
      unsigned spawned = 1;
      for (unsigned range_index = 1; range_index < thread_count; ++range_index) {
        const size_t range_begin = range_index * triangles_per_range;
        const size_t range_end = std::min(triangle_count, range_begin + triangles_per_range);
        try {
          workers.emplace_back([&, range_index, range_begin, range_end] { sweep(range_begin, range_end, buckets[range_index], false); });
          ++spawned;
        }
        catch (...) { break; }   // pool exhausted: the caller sweeps the ranges nobody took, after its own
      }
      sweep(0, std::min(triangle_count, triangles_per_range), buckets[0], true);
      for (unsigned range_index = spawned; range_index < thread_count; ++range_index)
        sweep(range_index * triangles_per_range, std::min(triangle_count, (range_index + 1) * triangles_per_range), buckets[range_index], true);
      for (std::thread& worker : workers) worker.join();
      for (int i = 0; i < model_layer_count; ++i) {
        size_t total = 0;
        for (auto& bucket : buckets) total += bucket[(size_t)i].size();
        layerSegments[(size_t)i].reserve(total);
        for (auto& bucket : buckets) {
          auto& source = bucket[(size_t)i];
          layerSegments[(size_t)i].insert(layerSegments[(size_t)i].end(), source.begin(), source.end());
          std::vector<SliceSegment>().swap(source);
        }
      }
    } else {
      sweep(0, triangle_count, layerSegments, true);
    }
  }
  // The generator no longer eats these contours — the bridge slices the mesh itself through the real
  // slicer (slice_mesh_ex + slice_closing_radius, upstream's own pipeline); this set is display/raster only.
  const double closing_radius = std::max(0.0, sla_json_number(params_json, "slice_closing_radius", 0.049));
  std::vector<Paths> contours(model_layer_count);
  sla_for_each_layer(model_layer_count, [&](int i) {
    if (canceled()) return;   // cooperative bail; the boundary check below reports the cancel
    Paths loops = chain_polygons(layerSegments[i]);
    contours[i] = SimplifyPolygons(loops, pftNonZero);   // NonZero on oriented loops (slice_planes.h): upstream's Regular mode; coincident shells union instead of cancelling
    if (params.gcode_resolution > 1e-6) CleanPolygons(contours[i], SCALE * params.gcode_resolution);
    contours[i].erase(std::remove_if(contours[i].begin(), contours[i].end(),
                                     [](const Path& path){ return path.size() < 3; }), contours[i].end());
    layerSegments[i].clear();
    layerSegments[i].shrink_to_fit();
  }, [&](int done) { report(30 + std::min(149, done * 150 / std::max(1, model_layer_count)), 1000); });   // chaining: 3% -> 18%
  if (canceled()) {
    result.set("error", std::string("canceled"));
    return result;
  }
  report(180, 1000);   // contours done: 18%

  time_contours_done = emscripten_get_now();
  // ---- Support parameters (upstream SupportTreeConfig names where one exists) --------------------------------
  const bool supports_on = sla_json_bool(params_json, "supports_enable", false);
  const bool pad_on      = sla_json_bool(params_json, "pad_enable", false);
  const bool plate_only  = sla_json_bool(params_json, "support_buildplate_only", false);
  const double pillar_radius  = std::max(0.1, sla_json_number(params_json, "support_pillar_diameter", 1.0) / 2);
  const double tip_radius     = std::max(0.05, sla_json_number(params_json, "support_head_front_diameter", 0.4) / 2);
  const double head_length    = std::max(layer_height, sla_json_number(params_json, "support_head_width", 1.0));
  const double head_penetration = std::max(0.0, sla_json_number(params_json, "support_head_penetration", 0.2));
  const double density   = sla_json_number(params_json, "support_points_density_relative", 100.0);
  const double bridge_length = std::max(1.0, sla_json_number(params_json, "support_max_bridge_length", 15.0));
  const double link_distance = std::max(1.0, sla_json_number(params_json, "support_max_pillar_link_distance", 10.0));
  const double base_radius = std::max(pillar_radius, sla_json_number(params_json, "support_base_diameter", 4.0) / 2);
  const double base_height = std::max(0.0, sla_json_number(params_json, "support_base_height", 1.0));
  // The rest of upstream make_support_cfg (SLAPrint.cpp:50): the bridge slope IS the critical angle.
  const double critical_angle_deg = sla_json_number(params_json, "support_critical_angle", 45.0);
  const double small_pillar_percent = sla_json_number(params_json, "support_small_pillar_diameter_percent", 50.0);
  const double widening  = std::max(0.0, sla_json_number(params_json, "support_pillar_widening_factor", 0.0));
  const double base_safety = std::max(0.0, sla_json_number(params_json, "support_base_safety_distance", 1.0));
  const double max_weight = sla_json_number(params_json, "support_max_weight_on_model", 10.0);
  const int max_bridges  = (int)sla_json_number(params_json, "support_max_bridges_on_pillar", 3.0);
  const double elevation_mm = std::max(0.0, sla_json_number(params_json, "support_object_elevation", 0.0));
  const std::string connection_mode = sla_json_string(params_json, "support_pillar_connection_mode", "dynamic");
  const std::string support_strategy = sla_json_string(params_json, "support_tree_type", "default");
  slasupport_bridge::SupportStrategy bridge_strategy = slasupport_bridge::SupportStrategy::default_tree;
  if (support_strategy == "branching") bridge_strategy = slasupport_bridge::SupportStrategy::branching;
  else if (support_strategy == "organic") bridge_strategy = slasupport_bridge::SupportStrategy::organic;
  const slasupport_bridge::StrategyCapability strategy_capability =
    slasupport_bridge::strategy_capability(bridge_strategy);
  const slasupport_bridge::PadCapability pad_capability = slasupport_bridge::pad_capability();

  // Pad (upstream PadConfig, make_pad_cfg SLAPrint.cpp:135): the pad occupies [0, full_height] on the plate
  //  and everything else — support feet included — stands on TOP of it, exactly upstream's rebase at slicing
  //  time. pad_around_object (embed) builds the pad AROUND the object's bottom band instead: the object is
  //  not elevated (upstream is_zero_elevation forces it to 0) and sits directly on the pad plate.
  const double pad_wall_thickness = std::max(0.0, sla_json_number(params_json, "pad_wall_thickness", 2.0));
  const double pad_wall_height    = std::max(0.0, sla_json_number(params_json, "pad_wall_height", 0.0));
  const double pad_slope    = sla_json_number(params_json, "pad_wall_slope", 90.0);
  const double pad_merge    = sla_json_number(params_json, "pad_max_merge_distance", 50.0);
  const double pad_brim     = sla_json_number(params_json, "pad_brim_size", 1.6);
  const bool   pad_embed    = sla_json_bool(params_json, "pad_around_object", false);
  const bool   pad_everywhere = sla_json_bool(params_json, "pad_around_object_everywhere", false);
  const double pad_object_gap       = std::max(0.0, sla_json_number(params_json, "pad_object_gap", 1.0));
  const double pad_stick_width      = std::max(0.0, sla_json_number(params_json, "pad_object_connector_width", 0.5));
  const double pad_stick_stride     = std::max(0.0, sla_json_number(params_json, "pad_object_connector_stride", 10.0));
  const double pad_stick_penetration = std::max(0.0, sla_json_number(params_json, "pad_object_connector_penetration", 0.3));
  double pad_full_height = 0.0;
  if (pad_on) pad_full_height = pad_wall_thickness + pad_wall_height;
  // PLANNED pad zone. The definitive pad_lift_layers is fixed only after the pad geometry exists: an embed pad may
  //  legitimately come back EMPTY (upstream validate_pad — the ring survives only where supports stand),
  //  and an empty pad must not lift the scene.
  int pad_lift_layers_planned = 0;
  if (pad_on) pad_lift_layers_planned = std::max(1, (int)std::ceil(pad_full_height / layer_height));

  // Elevation: with supports on, the object hangs above the plate — the layer stack grows by the elevation
  //  zone below it and every model contour shifts up. The model's own bottom then reads as one large island,
  //  which is exactly what routes pillars under it (upstream elevates for the same removability reason).
  //  The pad adds its own zone UNDER that: lift = pad layers + elevation layers. Zero-elevation mode
  //  (upstream is_zero_elevation, SLAPrint.cpp:43) is pad_enable && pad_around_object.
  double effective_elevation = elevation_mm;
  if (pad_on && pad_embed) effective_elevation = 0.0;
  int elevation_layers = 0;
  if (supports_on) elevation_layers = (int)std::llround(effective_elevation / layer_height);
  // The support-point generator below is frame-invariant (it consumes model-space slice_z), so it runs on
  //  the PLANNED frame; the definitive pad_lift_layers / lift_layers / layer_count are derived after pad generation.
  const int lift_layers_planned = pad_lift_layers_planned + elevation_layers;
  const int layer_count_planned = model_layer_count + lift_layers_planned;
  static const Paths EMPTY_PATHS;
  auto contour_planned = [&](int layer_index) -> const Paths& {
    if (layer_index >= lift_layers_planned && layer_index - lift_layers_planned < model_layer_count)
      return contours[layer_index - lift_layers_planned];
    return EMPTY_PATHS;
  };

  // ---- 1. Support points: the ported Prusa SupportPointGenerator + SupportIslands (slasupport_bridge).
  //  The prepared layers carry model-space slice_z (elevation zone stripped); the generator returns
  //  object-local, surface-snapped points in that same frame — exactly what the tree call below feeds on.
  slasupport_bridge::PreparedJob prepared;
  std::string support_error;
  if (supports_on && strategy_capability.status != slasupport_bridge::StrategyCapabilityStatus::supported)
    support_error = strategy_capability.code;
  std::string generator_backend = "disabled";
  prepared.callbacks.is_canceled = [&]() { return canceled(); };
  prepared.callbacks.on_progress = [&](const slasupport_bridge::Progress& progress) {
    if (progress.total == 0) return;
    // Band widths follow the MEASURED mt phase shares (support-point generation is the longest
    // phase and used to sit in a 2% band, which read as a frozen bar; the bridge now also ticks
    // its weld/slice/prepare sub-stages so this band moves the whole time).
    if (progress.phase == slasupport_bridge::ProgressPhase::prepare)           // generation: 18% -> 65%
      report(180 + (int)(progress.completed * 470 / progress.total), 1000);
    else if (progress.phase == slasupport_bridge::ProgressPhase::support_tree) // tree: 65% -> 82%
      report(650 + (int)(progress.completed * 170 / progress.total), 1000);
  };
  if (supports_on && strategy_capability.status == slasupport_bridge::StrategyCapabilityStatus::supported && layer_count_planned > 0) {
    std::vector<float> model_soup;
    model_soup.reserve(triangles.size() * 9);
    for (const Triangle& triangle : triangles)
      for (int corner = 0; corner < 3; ++corner) {
        model_soup.push_back(triangle.vertices[corner].x);
        model_soup.push_back(triangle.vertices[corner].y);
        model_soup.push_back(triangle.vertices[corner].z);
      }
    prepared.support_enforcers_only = sla_json_bool(params_json, "support_enforcers_only", false);
    prepared.objects.push_back({"legacy-0", std::move(model_soup), {}});
    prepared.layers.reserve(layer_count_planned);
    for (int layer_index = 0; layer_index < layer_count_planned; ++layer_index) {
      slasupport_bridge::PreparedLayer layer;
      layer.object_id = "legacy-0";
      layer.index = (size_t)layer_index;
      layer.print_z = top_z(layer_index);
      layer.height = layer_thickness_at(layer_index);
      layer.slice_z = layer.print_z - layer.height / 2 - lift_layers_planned * layer_height;
      for (const Path& path : contour_planned(layer_index)) {
        slasupport_bridge::Polygon polygon;
        polygon.reserve(path.size());
        for (const IntPoint& point : path) polygon.push_back({point.x() * INV, point.y() * INV});
        layer.contours.push_back(std::move(polygon));
      }
      prepared.layers.push_back(std::move(layer));
    }
    slasupport_bridge::PointGenerationConfig generator_config;
    generator_config.density_relative = density / 100.0;   // upstream SLAPrintSteps.cpp:717 (percents -> ratio)
    generator_config.head_diameter = tip_radius * 2;
    generator_config.slice_closing_radius = closing_radius;
    generator_backend = "prusa_port";
    slasupport_bridge::GeneratedPoints generated =
      slasupport_bridge::generate_support_points(prepared, generator_config);
    t_sample_weld = generated.t_weld_ms;
    t_sample_slice = generated.t_slice_ms;
    t_sample_prepare = generated.t_prepare_ms;
    t_sample_generate = generated.t_generate_ms;
    t_sample_move = generated.t_move_ms;
    if (generated.ok) prepared.points = std::move(generated.points);
    else if (support_error.empty()) {
      if (generated.error.empty()) support_error = "support point generation failed";
      else support_error = generated.error;
    }
  }
  if (canceled()) {
    result.set("error", std::string("canceled"));
    return result;
  }

  time_sample_done = emscripten_get_now();
  // ---- 2. The real tree (ported DefaultSupportTree via slasupport_bridge): pinhead pose search, classify,
  //         ground routing, cross-bracing, feet — upstream verbatim, raycast against the actual mesh. The
  //         bridge returns the merged support tree as a MESH in GLOBAL z (elevation applied by the config,
  //         upstream semantics).
  std::vector<float> support_mesh;
  std::vector<float> pad_mesh;
  size_t pillar_count = 0;
  if (!prepared.points.empty()) {
    slasupport_bridge::Config tree_config;
    tree_config.strategy = bridge_strategy;
    tree_config.head_front_radius = tip_radius;
    tree_config.head_back_radius = pillar_radius;
    tree_config.head_width = head_length;
    tree_config.head_penetration = head_penetration;
    tree_config.base_radius = base_radius;
    tree_config.base_height = base_height;
    tree_config.max_bridge_length = bridge_length;
    tree_config.max_pillar_link_distance = link_distance;
    tree_config.object_elevation = elevation_layers * layer_height;
    tree_config.buildplate_only = plate_only;
    if (connection_mode == "zigzag") tree_config.pillar_connection_mode = 0;
    else if (connection_mode == "cross") tree_config.pillar_connection_mode = 1;
    else tree_config.pillar_connection_mode = 2;
    tree_config.bridge_slope = critical_angle_deg * PI / 180.0;
    tree_config.head_fallback_radius = 0.01 * small_pillar_percent * pillar_radius;
    tree_config.pillar_widening_factor = widening;
    tree_config.pillar_base_safety_distance = base_safety;
    tree_config.max_weight_on_model = max_weight;
    tree_config.max_bridges_on_pillar = max_bridges;
    tree_config.mesh_steps = 45;   // upstream's output-mesh resolution (SupportTreeBuilder::merged_mesh default)
    report(650, 1000);                                            // sampling done -> entering the tree
    slasupport_bridge::Result tree_result = slasupport_bridge::generate(prepared, tree_config);
    if (tree_result.ok) {
      support_mesh = std::move(tree_result.mesh);
      pillar_count = tree_result.pillars;
    }
    else if (tree_result.error.empty()) support_error = "support tree produced nothing";
    else support_error = tree_result.error;
  }
  if (canceled()) {
    result.set("error", std::string("canceled"));
    return result;
  }

  // ---- 2b. Pad (ported Pad.cpp, upstream SupportTree.cpp:71 driver): blueprint over the foot band while
  //          the feet still stand at z=0, then the pad takes [0, full_height] and the scene above it rises
  //          by pad_lift_layers layers — upstream's rebase at slicing time. With supports off the model itself is the
  //          blueprint.
  std::string pad_error;
  if (pad_on && layer_count_planned > 0) {
    slasupport_bridge::PadParams pad_params;
    pad_params.wall_thickness = pad_wall_thickness;
    pad_params.wall_height = pad_wall_height;
    pad_params.max_merge_distance = pad_merge;
    pad_params.wall_slope_deg = pad_slope;
    pad_params.brim_size = pad_brim;
    pad_params.around_object = pad_embed;
    pad_params.around_object_everywhere = pad_everywhere;
    pad_params.object_gap = pad_object_gap;
    pad_params.stick_width = pad_stick_width;
    pad_params.stick_stride = pad_stick_stride;
    pad_params.stick_penetration = pad_stick_penetration;
    std::vector<float> pad_model_soup;
    // The model joins the blueprint when nothing else reaches the plate (supports off) AND always in embed
    // mode — upstream create_pad samples the object's own bottom band for the ring the pad wraps around.
    if (!supports_on || pad_embed) {
      pad_model_soup.reserve(triangles.size() * 9);
      for (const Triangle& triangle : triangles)
        for (int corner = 0; corner < 3; ++corner) {
          pad_model_soup.push_back(triangle.vertices[corner].x);
          pad_model_soup.push_back(triangle.vertices[corner].y);
          pad_model_soup.push_back(triangle.vertices[corner].z);
        }
    }
    slasupport_bridge::PadResult pad_result =
      slasupport_bridge::generate_pad(pad_model_soup, support_mesh, supports_on, pad_params);
    if (pad_result.ok) pad_mesh = std::move(pad_result.mesh);
    else {
      // Upstream semantics (SLAPrintSteps::generate_pad -> SlicingError): a requested pad that cannot be
      // generated FAILS the slice. Degrading softly here would leave the scene lifted by the pad zone with
      // nothing underneath — a print floating pad-height above the plate.
      std::string pad_failure = "generation failed";
      if (!pad_result.error.empty()) pad_failure = pad_result.error;
      result.set("error", std::string("pad: ") + pad_failure);
      return result;
    }
  }
  // The definitive frame: an empty pad (legal in embed mode — nothing survived the redundancy pass) lifts
  //  nothing; otherwise the planned pad zone stands. Everything downstream reads these, not the planned set.
  int pad_lift_layers = 0;
  if (pad_on && !pad_mesh.empty()) pad_lift_layers = pad_lift_layers_planned;
  const int lift_layers = pad_lift_layers + elevation_layers;
  const int layer_count = model_layer_count + lift_layers;
  auto contour_at = [&](int layer_index) -> const Paths& {
    if (layer_index >= lift_layers && layer_index - lift_layers < model_layer_count)
      return contours[layer_index - lift_layers];
    return EMPTY_PATHS;
  };
  // Everything above the pad rises by the pad zone; the tree stands on the pad top as one piece.
  if (pad_lift_layers > 0)
    for (size_t i = 2; i < support_mesh.size(); i += 3) support_mesh[i] += float(pad_lift_layers * layer_height);
  time_tree_done = emscripten_get_now();

  // ---- 3. Raster view of the tree: slice the support mesh per layer (mid planes, exactly like the model),
  //         kept disjoint from the model contour — the even-odd raster safety every region here observes.
  std::vector<Paths> support(layer_count);
  slasupport_bridge::SupportSliceCacheStats support_slice_cache;
  std::string support_slicer_error;
  double raster_slice_ms = 0;   // the batch mesh sweep
  double raster_clip_ms = 0;    // the per-layer clipper pass
  if (!support_mesh.empty()) {
    std::vector<double> support_mids(layer_count);
    for (int layer_index = 0; layer_index < layer_count; ++layer_index)
      support_mids[layer_index] = top_z(layer_index) - layer_thickness_at(layer_index) / 2;
    const double batch_start = emscripten_get_now();
    slasupport_bridge::SupportSliceBatch sliced =
      slasupport_bridge::slice_support_mesh_fallback(support_mesh, support_mids);
    raster_slice_ms = emscripten_get_now() - batch_start;
    support_slice_cache = sliced.cache;
    support_slicer_error = sliced.error;
    if (sliced.ok) {
      const double clip_start = emscripten_get_now();
      report(820, 1000);   // raster: 82% -> 95%
      sla_for_each_layer(layer_count, [&](int layer_index) {
        Paths loops;
        loops.reserve(sliced.slices[layer_index].size());
        for (const slasupport_bridge::Polygon& polygon : sliced.slices[layer_index]) {
          Path loop;
          loop.reserve(polygon.size());
          for (const slasupport_bridge::Vec2& point : polygon) loop.push_back(scaled_int_point(point.x, point.y));
          loops.push_back(std::move(loop));
        }
        Paths merged = SimplifyPolygons(loops, pftNonZero);
        CleanPolygons(merged, SCALE * 0.005);
        merged.erase(std::remove_if(merged.begin(), merged.end(),
                                    [](const Path& path){ return path.size() < 3; }), merged.end());
        support[layer_index] = clip_paths(merged, contour_at(layer_index), ctDifference);
      });
      raster_clip_ms = emscripten_get_now() - clip_start;
    }
  }

  time_raster_done = emscripten_get_now();
  // ---- Pad raster: slice the ported pad mesh per layer like the supports, disjoint from model + support ------
  std::vector<Paths> pad(layer_count);
  int pad_layers = 0;
  if (!pad_mesh.empty()) {
    std::vector<double> pad_mids(layer_count);
    for (int layer_index = 0; layer_index < layer_count; ++layer_index)
      pad_mids[layer_index] = top_z(layer_index) - layer_thickness_at(layer_index) / 2;
    slasupport_bridge::SupportSliceBatch pad_sliced =
      slasupport_bridge::slice_support_mesh_fallback(pad_mesh, pad_mids);
    if (pad_sliced.ok) {
      report(950, 1000);   // pad raster: 95% -> 97%
      sla_for_each_layer(layer_count, [&](int layer_index) {
        Paths loops;
        loops.reserve(pad_sliced.slices[layer_index].size());
        for (const slasupport_bridge::Polygon& polygon : pad_sliced.slices[layer_index]) {
          Path loop;
          loop.reserve(polygon.size());
          for (const slasupport_bridge::Vec2& point : polygon) loop.push_back(scaled_int_point(point.x, point.y));
          loops.push_back(std::move(loop));
        }
        Paths merged = SimplifyPolygons(loops, pftNonZero);
        CleanPolygons(merged, SCALE * 0.005);
        merged.erase(std::remove_if(merged.begin(), merged.end(),
                                    [](const Path& path){ return path.size() < 3; }), merged.end());
        pad[layer_index] = clip_paths(merged, union_paths(contour_at(layer_index), support[layer_index]), ctDifference);
      });
      for (int layer_index = 0; layer_index < layer_count; ++layer_index)   // the "highest non-empty layer" scan is order-dependent — post-pass
        if (!pad[layer_index].empty()) pad_layers = layer_index + 1;
    } else if (pad_error.empty()) pad_error = pad_sliced.error;
  }

  // ---- Emission: batch (layers array) or streamed through the registered sink, same as slice(). -----------------
  em::val& sink = layer_sink();
  const bool streaming = !sink.isUndefined() && !sink.isNull();
  em::val layers_array = em::val::array();
  double volume = 0;
  long segment_total = 0;
  for (int layer_index = 0; layer_index < layer_count; ++layer_index) {
    if (canceled()) {
      result.set("error", std::string("canceled"));
      return result;
    }
    const double thickness = layer_thickness_at(layer_index);
    const Paths& model = contour_at(layer_index);
    volume += (paths_area_mm2(model) + paths_area_mm2(support[layer_index]) + paths_area_mm2(pad[layer_index])) * thickness;
    std::vector<float> segments;
    std::vector<float> widths;
    const double z = top_z(layer_index);
    push_paths(segments, widths, model,                z, 1.0f);   // model — role 1 (wall)
    push_paths(segments, widths, support[layer_index], z, 5.0f);   // support — role 5
    push_paths(segments, widths, pad[layer_index],     z, 6.0f);   // pad — role 6 (raft colouring)
    segment_total += (long)widths.size();
    if (streaming) sink(z, layer_index, std::string(), to_f32(segments), to_f32(widths));
    else {
      em::val layer_record = em::val::object();
      layer_record.set("z", z);
      layer_record.set("paths", to_f32(segments));
      layer_record.set("widths", to_f32(widths));
      layers_array.call<void>("push", layer_record);
    }
    if ((layer_index & 7) == 0 || layer_index == layer_count - 1) report(970 + (layer_index + 1) * 30 / std::max(1, layer_count), 1000);   // emission: 97% -> 100%
  }

  // ---- Stats: the resin figures + the exposure-fade time model (identical to the JS core it replaces). ----------
  const double exposure = sla_json_number(params_json, "exposure_time", 7.0);
  const double exposure0 = sla_json_number(params_json, "initial_exposure_time", 35.0);
  const double faded = std::max(0.0, sla_json_number(params_json, "faded_layers", 10.0));
  const double overhead = std::max(0.0, sla_json_number(params_json, "sla_layer_overhead", 6.0));
  double time_s = layer_count * overhead;
  for (int i = 0; i < layer_count; ++i) {
    double blend = 1.0;
    if (faded > 0) blend = std::min(1.0, i / faded);
    time_s += exposure0 + (exposure - exposure0) * blend;
  }
  em::val stats = em::val::object();
  stats.set("sla", true);
  stats.set("streamed", streaming);
  stats.set("layers", layer_count);
  stats.set("path_segments", (double)segment_total);
  stats.set("filament_mm", 0.0);
  stats.set("volume_mm3", volume);
  stats.set("resin_ml", volume / 1000.0);
  stats.set("time_estimate", std::round(time_s));
  stats.set("support_points", (double)prepared.points.size());
  std::string point_generator = "disabled";
  if (supports_on) point_generator = generator_backend;
  stats.set("support_point_generator", point_generator);
  if (supports_on)
    stats.set("support_point_parity_status", std::string("ported"));
  stats.set("support_pillars", (double)pillar_count);
  if (supports_on) {
    stats.set("support_strategy", support_strategy);
    const char* capability = "unsupported_upstream";
    if (strategy_capability.status == slasupport_bridge::StrategyCapabilityStatus::supported)
      capability = "supported";
    else if (strategy_capability.status == slasupport_bridge::StrategyCapabilityStatus::dependency_unavailable)
      capability = "dependency_unavailable";
    stats.set("support_strategy_capability", std::string(capability));
    stats.set("support_strategy_code", std::string(strategy_capability.code));
  }
  if (!support_error.empty()) stats.set("support_error", support_error);   // supports failed but the slice stands
  if (!support_slicer_error.empty()) stats.set("support_slicer_error", support_slicer_error);
  if (!pad_error.empty()) stats.set("pad_error", pad_error);               // pad failed but the slice stands
  if (supports_on) {
    const slasupport_bridge::SupportSlicerCapability slicer_capability =
      slasupport_bridge::support_slicer_capability();
    stats.set("support_slicer_backend", std::string(slicer_capability.backend));
    stats.set("support_slicer_parity_status", std::string("blocked_dependency"));
    stats.set("support_slicer_code", std::string(slicer_capability.code));
    stats.set("support_slicer_cache_hits", (double)support_slice_cache.hits);
    stats.set("support_slicer_cache_misses", (double)support_slice_cache.misses);
  }
  stats.set("elevation_layers", elevation_layers);
  // The whole scene (model contours, support mesh) sits lift_layers above the plate: pad zone + elevation.
  // The viewer MUST lift its model overlay by this, not by elevation alone — with a pad the difference is the
  // pad's full height and the preview reads as supports piercing/floating.
  stats.set("lift_layers", lift_layers);
  stats.set("pad_layers", pad_layers);
  if (pad_on) {
    const char* capability = "dependency_unavailable";
    const char* parity_status = "blocked_dependency";
    if (pad_capability.status == slasupport_bridge::PadCapabilityStatus::supported) {
      capability = "supported";
      parity_status = "upstream";
    }
    stats.set("pad_capability", std::string(capability));
    stats.set("pad_code", std::string(pad_capability.code));
    stats.set("pad_backend", std::string(pad_capability.backend));
    stats.set("pad_parity_status", std::string(parity_status));
  }
  stats.set("over_bed", model_prep.over_bed);
  stats.set("t_contours_ms", time_contours_done - time_start);
  stats.set("t_sample_ms", time_sample_done - time_contours_done);
  stats.set("t_sample_weld_ms", t_sample_weld);         // inside t_sample: weld + AABB build
  stats.set("t_sample_slice_ms", t_sample_slice);       // inside t_sample: slice_mesh_ex
  stats.set("t_sample_prepare_ms", t_sample_prepare);   // inside t_sample: prepare_generator_data
  stats.set("t_sample_generate_ms", t_sample_generate); // inside t_sample: generate_support_points proper
  stats.set("t_sample_move_ms", t_sample_move);         // inside t_sample: move_on_mesh_surface
  stats.set("t_tree_ms", time_tree_done - time_sample_done);
  stats.set("t_raster_ms", time_raster_done - time_tree_done);
  stats.set("t_raster_slice_ms", raster_slice_ms);   // inside t_raster: the fallback mesh sweep batch
  stats.set("t_raster_clip_ms", raster_clip_ms);     // inside t_raster: Simplify/Clean/difference per layer
  stats.set("t_emit_ms", emscripten_get_now() - time_raster_done);
  stats.set("layer_height", layer_height);
  stats.set("initial_layer_height", initial_layer_height);
  result.set("stats", stats);
  // The solid meshes ride on the result in BOTH modes — they are what the preview renders (the layer stream
  //  above is the raster's view of the same geometry).
  result.set("support_mesh", to_f32(support_mesh));
  result.set("pad_mesh", to_f32(pad_mesh));
  em::val supportPoints = em::val::array();
  for (size_t i = 0; i < prepared.points.size(); ++i) {
    const slasupport_bridge::SupportPoint& point = prepared.points[i];
    // Model-space z -> the global layer whose mid plane is nearest (the elevation zone shifts the index).
    int layer_index = lift_layers;
    if (model_layer_count > 0) {
      auto it = std::lower_bound(mids.begin(), mids.end(), point.position.z);
      int nearest = std::min((int)(it - mids.begin()), model_layer_count - 1);
      if (nearest > 0 && std::abs(mids[nearest - 1] - point.position.z) <= std::abs(mids[nearest] - point.position.z))
        --nearest;
      layer_index = nearest + lift_layers;
    }
    const char* point_type = "manual";
    if (point.type == slasupport_bridge::PointType::island) point_type = "island";
    else if (point.type == slasupport_bridge::PointType::slope) point_type = "slope";
    em::val record = em::val::object();
    record.set("source_id", (double)point.source_id);
    record.set("object_id", point.object_id);
    record.set("layer", layer_index);
    record.set("x", point.position.x);
    record.set("y", point.position.y);
    record.set("z", point.position.z);
    record.set("head_front_radius", point.head_front_radius);
    record.set("type", std::string(point_type));
    supportPoints.call<void>("push", record);
  }
  result.set("support_points", supportPoints);
  if (!streaming) result.set("layers", layers_array);
  return result;
}
