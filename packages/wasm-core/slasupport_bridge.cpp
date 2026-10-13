// slasupport_bridge.cpp — drives the ported PrusaSlicer DefaultSupportTree (slasupport_port/). Compiled with
//  the SLA include set (Prusa headers win), so no kernel header may be included here besides the bridge's own.
//
//  What this does, in upstream's own order: build an AABBMesh over the model, snap every candidate contact
//  onto the surface (the move_on_mesh_surface logic — up/down raycast, closest-point fallback), hand the
//  points to DefaultSupportTree::execute (pinheads -> classify -> routing -> bracing — all upstream verbatim),
//  then flatten builder.merged_mesh() into a triangle soup shifted up by the elevation so the kernel's global
//  layer frame (elevation zone at the bottom) receives world coordinates.
#include "slasupport_bridge.h"

#include <emscripten/emscripten.h>   // emscripten_get_now — phase timing (stats only)
#include <tbb/stub_parallel.h>       // ParallelScope — lets the tbb stub run real threads (mt only)

#include <libslic3r/AABBMesh.hpp>
#include <libslic3r/SLA/DefaultSupportTree.hpp>
#include <libslic3r/SLA/SupportTree.hpp>
#include <libslic3r/SLA/SupportTreeBuilder.hpp>
#include <libslic3r/SLA/SupportPoint.hpp>
#include <libslic3r/SLA/SupportPointGenerator.hpp>
#include <libslic3r/SLA/SupportIslands/SampleConfigFactory.hpp>
#include <libslic3r/SLA/Pad.hpp>
#include <libslic3r/KDTreeIndirect.hpp>
#include <libslic3r/ClipperUtils.hpp>
#include <libslic3r/TriangleMesh.hpp>        // its_merge_vertices — the soup must be welded before slicing
#include <libslic3r/TriangleMeshSlicer.hpp>  // slice_mesh_ex — the generator's input slicer (upstream's own)

#include <admesh/stl.h>
#include <exception>
#include <algorithm>
#include <cmath>
#include <numeric>
#include <limits>
#include <unordered_map>

using namespace Slic3r;
using namespace Slic3r::sla;

namespace slasupport_bridge {

static indexed_triangle_set soup_to_its(const std::vector<float>& soup) {
  indexed_triangle_set its;
  const size_t triangle_count = soup.size() / 9;
  its.vertices.reserve(triangle_count * 3);
  its.indices.reserve(triangle_count);
  for (size_t triangle = 0; triangle < triangle_count; ++triangle) {
    for (int corner = 0; corner < 3; ++corner)
      its.vertices.emplace_back(soup[triangle * 9 + corner * 3], soup[triangle * 9 + corner * 3 + 1], soup[triangle * 9 + corner * 3 + 2]);
    its.indices.emplace_back(int(triangle * 3), int(triangle * 3 + 1), int(triangle * 3 + 2));
  }
  return its;
}

static Vec3d transformed(const Transform& transform, const Vec3& point) {
  const auto& matrix = transform.matrix;
  return Vec3d(
    matrix[0] * point.x + matrix[4] * point.y + matrix[8]  * point.z + matrix[12],
    matrix[1] * point.x + matrix[5] * point.y + matrix[9]  * point.z + matrix[13],
    matrix[2] * point.x + matrix[6] * point.y + matrix[10] * point.z + matrix[14]);
}

static std::vector<float> merged_mesh(const PreparedJob& job) {
  std::vector<float> soup;
  for (const PreparedObject& object : job.objects) {
    soup.reserve(soup.size() + object.mesh.size());
    for (std::size_t i = 0; i < object.mesh.size(); i += 3) {
      const Vec3d point = transformed(object.transform,
        Vec3{object.mesh[i], object.mesh[i + 1], object.mesh[i + 2]});
      soup.push_back(float(point.x()));
      soup.push_back(float(point.y()));
      soup.push_back(float(point.z()));
    }
  }
  return soup;
}

// The move_on_mesh_surface logic (SupportPointGenerator.cpp): project up and down, take the closer hit; a miss
//  on both sides falls back to the closest surface point.
static Vec3f snap_to_surface(const AABBMesh& surface_mesh, const Vec3d& point) {
  const Vec3d up(0., 0., 1.);
  const Vec3d down(0., 0., -1.);
  auto hit_up = surface_mesh.query_ray_hit(point, up);
  auto hit_down = surface_mesh.query_ray_hit(point, down);
  const bool hits_up = hit_up.is_hit();
  const bool hits_down = hit_down.is_hit();
  if (hits_up || hits_down) {
    const AABBMesh::hit_result* closer_hit = &hit_down;
    if (!hits_down || (hits_up && hit_up.distance() < hit_down.distance())) closer_hit = &hit_up;
    if (closer_hit->distance() < 2.0)
      return (point + closer_hit->distance() * closer_hit->direction()).cast<float>();
  }
  int triangle_index;
  Vec3d closest;
  surface_mesh.squared_distance(point, triangle_index, closest);
  return closest.cast<float>();
}

// ---- Automatic support-point generation (ported Prusa SupportPointGenerator + SupportIslands) --------------

namespace {
struct BridgeCanceled {};
} // namespace

// Upstream SLAPrintSteps.cpp:121 prepare_permanent_support_points, verbatim logic: keep only manual_add
// points near the surface, drop overlapped ones through a KD-tree pass, sort by z.
static void prepare_permanent_support_points_port(
    Slic3r::sla::SupportPoints &permanent_supports,
    const Slic3r::sla::SupportPoints &object_supports,
    const AABBMesh &emesh) {
  using Slic3r::sla::SupportPoint;
  using Slic3r::sla::SupportPointType;
  permanent_supports.clear(); // previous supports are irelevant
  for (const SupportPoint &p : object_supports) {
    if (p.type != SupportPointType::manual_add)
      continue;
    // (upstream applies object_trafo here; the caller hands points already in generation space)
    double dist_sq = emesh.squared_distance(p.pos.cast<double>());
    if (dist_sq >= double(p.head_front_radius) * double(p.head_front_radius))
      continue; // skip points outside the mesh
    permanent_supports.push_back(p);
  }

  // Prevent overlapped permanent supports
  auto point_accessor = [&permanent_supports](size_t idx, size_t dim) -> float & {
    return permanent_supports[idx].pos[dim]; };
  std::vector<size_t> indices(permanent_supports.size());
  std::iota(indices.begin(), indices.end(), 0);
  KDTreeIndirect<3, float, decltype(point_accessor)> tree(point_accessor, indices);
  for (Slic3r::sla::SupportPoint &p : permanent_supports) {
    if (p.head_front_radius < 0.f)
      continue; // already marked for erase
    std::vector<size_t> near_indices = find_nearby_points(tree, p.pos, p.head_front_radius);
    if (near_indices.size() <= 1)
      continue; // only support itself
    size_t index = &p - &permanent_supports.front();
    for (size_t near_index : near_indices) {
      if (near_index == index)
        continue;
      const Slic3r::sla::SupportPoint &p_near = permanent_supports[near_index];
      if ((p.pos - p_near.pos).squaredNorm() > double(p.head_front_radius) * double(p.head_front_radius))
        continue;
      permanent_supports[near_index].head_front_radius = -1.0f; // mark for erase
    }
  }
  permanent_supports.erase(std::remove_if(permanent_supports.begin(), permanent_supports.end(),
      [](const Slic3r::sla::SupportPoint &p) { return p.head_front_radius < 0.f; }), permanent_supports.end());
  std::sort(permanent_supports.begin(), permanent_supports.end(),
      [](const Slic3r::sla::SupportPoint &p1, const Slic3r::sla::SupportPoint &p2) { return p1.pos.z() < p2.pos.z(); });
}

GeneratedPoints generate_support_points(const PreparedJob& job, const PointGenConfig& point_config) {
  GeneratedPoints out;
  const ValidationResult checked = validate(job);
  if (!checked.ok) {
    out.error = checked.error;
    return out;
  }

  // Upstream SLAPrintSteps.cpp:716 config mapping.
  Slic3r::sla::SupportPointGeneratorConfig generator_config;
  generator_config.density_relative = float(point_config.density_relative);
  generator_config.head_diameter = float(point_config.head_diameter);
  generator_config.island_configuration = Slic3r::sla::SampleConfigFactory::apply_density(
      Slic3r::sla::SampleConfigFactory::create(generator_config.head_diameter),
      generator_config.density_relative);

  Slic3r::sla::ThrowOnCancel cancel = [&job]() {
    if (job.callbacks.is_canceled && job.callbacks.is_canceled()) throw BridgeCanceled{};
  };

  try {
    for (const PreparedObject& object : job.objects) {
      // This object's prepared layers, in index order.
      std::vector<const PreparedLayer*> object_layers;
      for (const PreparedLayer& layer : job.layers)
        if (layer.object_id == object.id) object_layers.push_back(&layer);
      std::sort(object_layers.begin(), object_layers.end(),
                [](const PreparedLayer* left, const PreparedLayer* right) { return left->index < right->index; });
      if (object_layers.empty()) continue;

      // The object mesh in generation (plate) space — for slicing, the surface snap, and the permanent-point
      // checks. Vertices are welded because the slicer walks shared edges (an unwelded soup has none).
      const std::size_t object_index = &object - job.objects.data();
      // Sample-phase sub-stage ticks on a 0..1000-per-object scale. The weld/slice/prepare stretch
      // used to be SILENT (only generate's per-layer status reported), which parked the UI progress
      // bar for the longest phase of an SLA slice; generate's 0..100 maps onto 350..1000 below.
      const auto stage_tick = [&job, object_index, object_total = job.objects.size()](std::size_t value) {
        if (job.callbacks.on_progress)
          job.callbacks.on_progress({ProgressPhase::prepare,
                                     object_index * 1000 + value, object_total * 1000});
      };

      const double weld_start = emscripten_get_now();
      std::vector<float> soup;
      soup.reserve(object.mesh.size());
      for (std::size_t i = 0; i < object.mesh.size(); i += 3) {
        const Vec3d point = transformed(object.transform,
          Vec3{object.mesh[i], object.mesh[i + 1], object.mesh[i + 2]});
        soup.push_back(float(point.x()));
        soup.push_back(float(point.y()));
        soup.push_back(float(point.z()));
      }
      indexed_triangle_set its = soup_to_its(soup);
      its_merge_vertices(its);
      AABBMesh surface_mesh{its};
      out.t_weld_ms += emscripten_get_now() - weld_start;
      stage_tick(50);

      // The generator's input slices come from the REAL slicer with the profile's gap-closing radius —
      // exactly upstream's pipeline (SLAPrintSteps slice_model -> get_model_slices), not from the kernel's
      // display contours: the borderline overhangs the sampler reacts to live in that difference.
      std::vector<float> heights;
      heights.reserve(object_layers.size());
      for (const PreparedLayer* layer : object_layers) heights.push_back(float(layer->slice_z));
      Slic3r::MeshSlicingParamsEx slicing_params;
      slicing_params.closing_radius = float(point_config.slice_closing_radius);
      const double slice_start = emscripten_get_now();
      std::vector<Slic3r::ExPolygons> slices;
      {
        // mt builds: slice_mesh_ex's internal tbb::parallel_for splits across the pthread pool inside
        // this scope (per-layer slots, deterministic — byte-identical to the serial st run). st builds
        // and no-thread environments run exactly the code they always did. The cancel passed in must
        // NOT throw — a throw inside a worker std::thread terminates; the boundary check right after
        // preserves the cancellation semantics (a canceled slice produces no output either way).
        tbb_stub::ParallelScope parallel_scope;
        slices = Slic3r::slice_mesh_ex(its, heights, slicing_params, []{});
      }
      cancel();
      out.t_slice_ms += emscripten_get_now() - slice_start;
      stage_tick(180);

      Slic3r::sla::StatusFunction status = [&stage_tick](int percent) {
        stage_tick(350 + std::size_t(std::max(0, std::min(100, percent))) * 650 / 100);
      };

      const double prepare_start = emscripten_get_now();
      Slic3r::sla::SupportPointGeneratorData data;
      {
        // The five prepare passes are execution::for_each(ex_tbb, …) over independent layer slots —
        // parallel via the SLA group's ExecutionTBB shadow inside this scope (mt), serial otherwise.
        // generate_support_points below stays OUTSIDE any scope: its result collection is
        // mutex-appended, so a parallel run would make the point ORDER thread-dependent.
        tbb_stub::ParallelScope parallel_scope;
        data = Slic3r::sla::prepare_generator_data(
            std::move(slices), heights, {}, cancel, status);
      }
      out.t_prepare_ms += emscripten_get_now() - prepare_start;
      stage_tick(350);

      // Permanent (manual) points of this object enter the generator's density accounting…
      Slic3r::sla::SupportPoints authored;
      for (const SupportPoint& point : job.points) {
        if (point.object_id != object.id || !(point.permanent || point.manual)) continue;
        const Vec3d position = transformed(object.transform, point.position);
        Slic3r::sla::SupportPoint authored_point;
        authored_point.pos = position.cast<float>();
        authored_point.head_front_radius = float(point.head_front_radius);
        authored_point.type = Slic3r::sla::SupportPointType::manual_add;
        authored.push_back(authored_point);
      }
      prepare_permanent_support_points_port(data.permanent_supports, authored, surface_mesh);

      const double generate_start = emscripten_get_now();
      Slic3r::sla::LayerSupportPoints layer_points =
          Slic3r::sla::generate_support_points(data, generator_config, cancel, status);
      out.t_generate_ms += emscripten_get_now() - generate_start;

      // Maximal move of support point to mesh surface, no more than height of layer (upstream :768).
      double allowed_move;
      if (heights.size() > 1)
        allowed_move = double(heights[1] - heights[0]) + std::numeric_limits<float>::epsilon();
      else
        allowed_move = double(std::numeric_limits<float>::epsilon());
      const double move_start = emscripten_get_now();
      Slic3r::sla::SupportPoints surface_points =
          Slic3r::sla::move_on_mesh_surface(layer_points, surface_mesh, allowed_move, cancel);
      out.t_move_ms += emscripten_get_now() - move_start;

      // …and are appended AFTER the move so their authored 3d position survives (upstream :776).
      surface_points.insert(surface_points.end(),
                            data.permanent_supports.begin(), data.permanent_supports.end());

      // Back to object-local coordinates for the bridge schema.
      Eigen::Matrix4d matrix;
      for (int column = 0; column < 4; ++column)
        for (int row = 0; row < 4; ++row) matrix(row, column) = object.transform.matrix[column * 4 + row];
      const Eigen::Matrix4d inverse = matrix.inverse();
      const std::size_t generated_count = surface_points.size() - data.permanent_supports.size();
      for (std::size_t i = 0; i < surface_points.size(); ++i) {
        const Slic3r::sla::SupportPoint& surface_point = surface_points[i];
        const Eigen::Vector4d local = inverse * Eigen::Vector4d(surface_point.pos.x(), surface_point.pos.y(), surface_point.pos.z(), 1.0);
        SupportPoint point;
        point.source_id = out.points.size();
        point.object_id = object.id;
        point.position = {local.x(), local.y(), local.z()};
        point.head_front_radius = surface_point.head_front_radius;
        if (surface_point.type == Slic3r::sla::SupportPointType::island) point.type = PointType::island;
        else if (surface_point.type == Slic3r::sla::SupportPointType::slope) point.type = PointType::slope;
        else point.type = PointType::manual_add;
        point.permanent = i >= generated_count;
        point.manual = point.permanent;
        out.points.push_back(std::move(point));
      }
    }
  } catch (const BridgeCanceled&) {
    out.error = "support point generation canceled";
    return out;
  } catch (const std::exception& exception) {
    out.error = std::string("exception: ") + exception.what();
    return out;
  } catch (...) {
    out.error = "unknown exception";
    return out;
  }

  out.ok = true;
  return out;
}

// ---- Pad (ported Pad.cpp driven the way upstream SupportTree.cpp:71 drives it) -----------------------------

PadResult generate_pad(const std::vector<float>& model_mesh,
                       const std::vector<float>& support_mesh,
                       bool supports_enabled,
                       const PadParams& params) {
  PadResult out;
  out.capability = pad_capability();

  Slic3r::sla::PadConfig pad_config;
  pad_config.wall_thickness_mm = params.wall_thickness;
  pad_config.wall_height_mm    = params.wall_height;
  pad_config.max_merge_dist_mm = params.max_merge_distance;
  pad_config.wall_slope        = params.wall_slope_deg * M_PI / 180.0;
  pad_config.brim_size_mm      = params.brim_size;
  if (params.around_object) {
    // Upstream builtin_pad_cfg (SLAPrint.cpp:117): embed is on exactly when pad_enable && pad_around_object.
    pad_config.embed_object.enabled             = true;
    pad_config.embed_object.everywhere          = params.around_object_everywhere;
    pad_config.embed_object.object_gap_mm       = params.object_gap;
    pad_config.embed_object.stick_width_mm      = params.stick_width;
    pad_config.embed_object.stick_stride_mm     = params.stick_stride;
    pad_config.embed_object.stick_penetration_mm = params.stick_penetration;
  }
  const std::string invalid = pad_config.validate();
  if (!invalid.empty()) {
    out.error = invalid;
    return out;
  }
  out.full_height = pad_config.full_height();

  // Upstream samples the blueprint over [zstart, zstart + full_height + sampling] where zstart is the
  // ground MINUS the plate thickness in embed mode (SupportTree.cpp create_pad: the object sits at ground
  // and the pad plate extends below it, so the model band sampled is the object's own bottom). The inputs
  // here are in the print frame, so ground is 0.
  constexpr float PadSamplingLayerHeight = 0.1f;
  float zstart = 0.f;
  if (params.around_object) zstart = -float(params.wall_thickness);
  std::vector<float> heights;
  for (float height = zstart; height < zstart + float(out.full_height + PadSamplingLayerHeight + 1e-6); height += PadSamplingLayerHeight)
    heights.push_back(height);

  try {
    Slic3r::ExPolygons model_contours;
    if ((!supports_enabled || params.around_object) && !model_mesh.empty()) {
      indexed_triangle_set model_its = soup_to_its(model_mesh);
      Slic3r::sla::pad_blueprint(model_its, model_contours, heights);
    }
    Slic3r::ExPolygons support_contours;
    if (!support_mesh.empty()) {
      indexed_triangle_set support_its = soup_to_its(support_mesh);
      Slic3r::sla::pad_blueprint(support_its, support_contours, heights);
    }
    // Upstream validate_pad (SLAPrint.cpp:154): an EMPTY pad is legal exactly when embed is on and the pad
    // is not forced everywhere — the ring survives only where supports stand, so a supportless embed keeps
    // nothing and the object simply prints on the plate. Everywhere else, empty means failure.
    const bool empty_is_legal = params.around_object && !params.around_object_everywhere;
    if (model_contours.empty() && support_contours.empty()) {
      if (empty_is_legal) {
        out.ok = true;
        return out;
      }
      out.error = "pad: nothing reaches the plate to stand on";
      return out;
    }

    indexed_triangle_set pad;
    Slic3r::sla::create_pad(support_contours, model_contours, pad, pad_config);
    if (pad.indices.empty()) {
      if (empty_is_legal) {
        out.ok = true;
        return out;
      }
      out.error = "pad: empty geometry";
      return out;
    }

    // Pad.cpp emits z in [-full_height, 0] (top face on the ground); stand it on the plate instead.
    const float lift = float(out.full_height);
    out.mesh.reserve(pad.indices.size() * 9);
    for (const auto& face : pad.indices)
      for (int corner = 0; corner < 3; ++corner) {
        const auto& vertex = pad.vertices[face(corner)];
        out.mesh.push_back(vertex.x());
        out.mesh.push_back(vertex.y());
        out.mesh.push_back(vertex.z() + lift);
      }
  } catch (const std::exception& exception) {
    out.error = std::string("exception: ") + exception.what();
    return out;
  } catch (...) {
    out.error = "unknown exception";
    return out;
  }

  out.ok = true;
  return out;
}

Result generate(const PreparedJob& job, const Config& bridge_config) {
  Result out;
  out.capability = strategy_capability(bridge_config.strategy);
  if (out.capability.status != StrategyCapabilityStatus::supported) {
    out.error = out.capability.code;
    return out;
  }
  const ValidationResult checked = validate(job);
  if (!checked.ok) {
    out.error = checked.error;
    return out;
  }
  const std::vector<slasupport_bridge::SupportPoint> filtered_points =
    filter_support_points_by_modifiers(job.points, job.layers, job.support_enforcers_only);
  out.point_order.reserve(filtered_points.size());
  for (const slasupport_bridge::SupportPoint& point : filtered_points) out.point_order.push_back(point.source_id);
  if (job.callbacks.on_progress)
    job.callbacks.on_progress({ProgressPhase::validation, 1, 1});
  if (job.callbacks.is_canceled && job.callbacks.is_canceled()) {
    out.error = "support tree canceled";
    return out;
  }
  if (filtered_points.empty()) {
    out.error = "points: empty";
    return out;
  }

  const std::vector<float> model = merged_mesh(job);

  indexed_triangle_set its = soup_to_its(model);

  SupportTreeConfig tree_config;
  tree_config.enabled                     = true;
  tree_config.head_front_radius_mm        = bridge_config.head_front_radius;
  tree_config.head_back_radius_mm         = bridge_config.head_back_radius;
  tree_config.head_fallback_radius_mm     = bridge_config.head_fallback_radius;
  tree_config.head_width_mm               = bridge_config.head_width;
  tree_config.head_penetration_mm         = bridge_config.head_penetration;
  tree_config.base_radius_mm              = bridge_config.base_radius;
  tree_config.base_height_mm              = bridge_config.base_height;
  tree_config.max_bridge_length_mm        = bridge_config.max_bridge_length;
  tree_config.max_pillar_link_distance_mm = bridge_config.max_pillar_link_distance;
  tree_config.object_elevation_mm         = bridge_config.object_elevation;
  tree_config.ground_facing_only          = bridge_config.buildplate_only;
  tree_config.bridge_slope                = bridge_config.bridge_slope;
  tree_config.pillar_widening_factor      = bridge_config.pillar_widening_factor;
  // Upstream make_support_cfg: a zero base safety distance means "use the kernel's own safety distance".
  if (bridge_config.pillar_base_safety_distance < 1e-9)
    tree_config.pillar_base_safety_distance_mm = SupportTreeConfig::safety_distance_mm;
  else
    tree_config.pillar_base_safety_distance_mm = bridge_config.pillar_base_safety_distance;
  tree_config.max_bridges_on_pillar       = (unsigned)std::max(0, bridge_config.max_bridges_on_pillar);
  tree_config.max_weight_on_model_support = bridge_config.max_weight_on_model;
  if (bridge_config.pillar_connection_mode == 0) tree_config.pillar_connection_mode = PillarConnectionMode::zigzag;
  else if (bridge_config.pillar_connection_mode == 1) tree_config.pillar_connection_mode = PillarConnectionMode::cross;
  else tree_config.pillar_connection_mode = PillarConnectionMode::dynamic;

  SupportPoints support_points;
  support_points.reserve(job.points.size());
  {
    AABBMesh snap_mesh{its};
    std::unordered_map<std::string, const PreparedObject*> objects;
    for (const PreparedObject& object : job.objects) objects.emplace(object.id, &object);
    for (const slasupport_bridge::SupportPoint& point : filtered_points) {
      Vec3 local = point.position;
      local.z += point.elevation;
      const Vec3d position = transformed(objects.at(point.object_id)->transform, local);
      Slic3r::sla::SupportPoint support_point;
      support_point.pos = snap_to_surface(snap_mesh, position);
      support_point.head_front_radius = float(point.head_front_radius);
      if (point.type == PointType::island) support_point.type = SupportPointType::island;
      else if (point.type == PointType::slope) support_point.type = SupportPointType::slope;
      else support_point.type = SupportPointType::manual_add;
      support_points.push_back(support_point);
    }
  }
  if (job.callbacks.on_progress)
    job.callbacks.on_progress({ProgressPhase::prepare, filtered_points.size(), filtered_points.size()});

  SupportableMesh supportable_mesh{its, support_points, tree_config};
  JobController controller;
  if (job.callbacks.on_progress) {
    auto on_progress = job.callbacks.on_progress;
    controller.statuscb = [on_progress](unsigned percent, const std::string&) {
      on_progress({ProgressPhase::support_tree, percent, 100});
    };
  }
  if (job.callbacks.is_canceled) controller.stopcondition = job.callbacks.is_canceled;
  SupportTreeBuilder builder{controller};
  try {
    // Upstream quirk (DefaultSupportTree.cpp `return pc == ABORT`): execute returns TRUE only when ABORTED.
    if (DefaultSupportTree::execute(builder, supportable_mesh)) {
      out.error = "support tree aborted";
      return out;
    }
  } catch (const std::exception& exception) {
    out.error = std::string("exception: ") + exception.what();
    return out;
  } catch (...) {
    out.error = "unknown exception";
    return out;
  }

  const indexed_triangle_set& merged = builder.merged_mesh((size_t)std::max(6, bridge_config.mesh_steps));
  out.mesh.reserve(merged.indices.size() * 9);
  const float lift = float(bridge_config.object_elevation);
  for (const auto& face : merged.indices)
    for (int corner = 0; corner < 3; ++corner) {
      const auto& vertex = merged.vertices[face(corner)];
      out.mesh.push_back(vertex.x());
      out.mesh.push_back(vertex.y());
      out.mesh.push_back(vertex.z() + lift);
    }
  out.pillars = builder.pillarcount();
  out.heads   = support_points.size();
  out.ok      = true;
  if (job.callbacks.on_progress)
    job.callbacks.on_progress({ProgressPhase::complete, 1, 1});
  return out;
}

} // namespace slasupport_bridge
